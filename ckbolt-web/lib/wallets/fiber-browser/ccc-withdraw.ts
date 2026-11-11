import { ccc } from "@ckb-ccc/connector-react";
import type { CellDepDto, Script } from "@/lib/hub/contract";
import { CKB_RPC_ERROR_CODE } from "@/lib/wallets/fiber-byo/constants";
import type { CkbAddressNetwork } from "./ckb-address";
import { toHexBytes } from "./hex";
import { wipeKeys, type NodeKeys } from "./keys";
import { sameScript } from "./scripts";
import { withdrawErrors, WithdrawError, type WithdrawReceipt } from "./withdraw";
import { CKB_DECIMALS } from "./constants";

/**
 * "Withdraw" on the node page: one CKB transaction that moves every plain CKB cell at the node's address to the
 * visitor's address, minus the fee, signed in the page with the node's CKB key through CCC's private-key signer. Pay's
 * on-chain send is the same with an exact amount and the change back to the node's own lock. Loaded on demand, so the
 * node page does not carry CCC until it is needed.
 */

/** CCC's client for the CKB RPC the node itself uses (BrowserNodeConfig.ckbRpcUrl), and no other. */
export function cccNodeClient(rpcUrl: string, network: CkbAddressNetwork): ccc.Client {
  const config = { url: rpcUrl, fallbacks: [] };
  return network === "mainnet" ? new ccc.ClientPublicMainnet(config) : new ccc.ClientPublicTestnet(config);
}

export interface WithdrawRequest {
  /** The client of the node's CKB RPC (cccNodeClient). */
  client: ccc.Client;
  /** The node's keys, wiped once the transaction is signed (or the attempt fails). */
  keys: NodeKeys;
  /** The node's own lock (node_info's default_funding_lock_script): the key must sign for it. */
  nodeLock: Script;
  /** Where all the CKB goes. */
  to: Script;
}

const toScript = (script: ccc.Script): Script => ({ codeHash: script.codeHash, hashType: script.hashType, args: script.args });

/** Errors a CKB node (or CCC's client, for it) answered with, as opposed to the network failing. */
const isClientError = (e: unknown): e is ccc.ErrorClientBase | ccc.JsonRpcError => e instanceof ccc.ErrorClientBase || e instanceof ccc.JsonRpcError;

/** Every plain cell of the signer in, one output to `to` that takes all of it but the fee ("send max"). */
async function buildWithdrawal(signer: ccc.Signer, to: Script): Promise<{ tx: ccc.Transaction; fee: bigint }> {
  // Transaction.from sizes the output to its lock's occupied capacity; the fee step adds the rest of the inputs to it.
  const tx = ccc.Transaction.from({ outputs: [{ lock: to }] });
  try {
    // Plain cells only (no type script, no data), as the balance on the page counts them: tokens stay where they are.
    if ((await tx.completeInputsAll(signer)) === 0) throw withdrawErrors.nothing();
    await tx.completeFeeChangeToOutput(signer, 0);
    return { tx, fee: await tx.getFee(signer.client) };
  } catch (e) {
    if (e instanceof WithdrawError) throw e;
    if (e instanceof ccc.ErrorTransactionInsufficientCapacity) {
      throw withdrawErrors.tooLittle(ccc.fixedPointToString(ccc.fixedPointFrom(tx.outputs[0].occupiedSize), CKB_DECIMALS));
    }
    throw withdrawErrors.buildFailed(e);
  }
}

/** Bytes of a secp256k1 signature in the witness's lock, as CCC's private-key signer writes it. */
const SECP256K1_SIGNATURE_BYTES = 65;

/**
 * The node's own lock as a signer that cannot sign: it collects the node's cells and prepares the transaction as the
 * key's signer will (the secp256k1 cell deps and a 65-byte witness placeholder), so the fee it computes before the
 * password is typed is the fee the signed transaction pays.
 */
class NodeLockPreview extends ccc.SignerCkbScriptReadonly {
  constructor(client: ccc.Client, private readonly lock: Script) {
    super(client, lock);
  }

  override async prepareTransaction(txLike: ccc.TransactionLike): Promise<ccc.Transaction> {
    const tx = ccc.Transaction.from(txLike);
    await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.Secp256k1Blake160);
    await tx.prepareSighashAllWitness(this.lock, SECP256K1_SIGNATURE_BYTES, this.client);
    return tx;
  }
}

/**
 * Pay's on-chain send: plain cells of the signer in until they cover `amount` and the fee, one output of exactly
 * `amount` to `to`, and the rest back to `changeLock` (the node's own lock). Refuses with a WithdrawError when the node
 * holds too little for it, or when the rest would be too little for a cell of its own.
 */
export async function buildExactSend(signer: ccc.Signer, to: Script, amount: bigint, changeLock: Script): Promise<{ tx: ccc.Transaction; fee: bigint }> {
  const tx = ccc.Transaction.from({ outputs: [{ lock: to, capacity: amount }] });
  // The output must be a cell of its own: as much as its lock occupies, at least.
  const least = ccc.fixedPointFrom(tx.outputs[0].occupiedSize);
  if (amount < least) throw withdrawErrors.belowCell(ccc.fixedPointToString(least, CKB_DECIMALS));
  try {
    // Plain cells only (no type script, no data), as the balance on the page counts them: tokens stay where they are.
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeChangeToLock(signer, changeLock);
    return { tx, fee: await tx.getFee(signer.client) };
  } catch (e) {
    if (e instanceof WithdrawError) throw e;
    if (e instanceof ccc.ErrorTransactionInsufficientCapacity) throw e.isForChange ? withdrawErrors.noChange() : withdrawErrors.notEnough();
    throw withdrawErrors.buildFailed(e);
  }
}

export interface SendPreviewRequest {
  client: ccc.Client;
  nodeLock: Script;
  to: Script;
  /** Shannons the address receives. */
  amount: bigint;
}

/** The fee of Pay's on-chain send, built from the node's cells without its key, before the visitor confirms it. */
export async function previewSend({ client, nodeLock, to, amount }: SendPreviewRequest): Promise<{ fee: bigint }> {
  const { fee } = await buildExactSend(new NodeLockPreview(client, nodeLock), to, amount, nodeLock);
  return { fee };
}

/** A node that already holds this transaction in its pool: it went out. */
const isAlreadySent = (e: unknown): boolean =>
  e instanceof ccc.ErrorClientDuplicatedTransaction || (isClientError(e) && e.code === CKB_RPC_ERROR_CODE.POOL_REJECTED_DUPLICATED_TRANSACTION);

async function broadcast(client: ccc.Client, signed: ccc.Transaction): Promise<string> {
  const txHash = signed.hash();
  try {
    return await client.sendTransaction(signed);
  } catch (e) {
    if (isAlreadySent(e)) return txHash;
    throw isClientError(e) ? withdrawErrors.rejected(e) : withdrawErrors.unconfirmed(e, txHash);
  }
}

/**
 * Builds, signs and sends the withdrawal. The keys are wiped right after signing, or when anything before fails; CCC's
 * signer keeps its own hex copy of the CKB key, which only goes out of reach with the signer (JavaScript strings cannot
 * be overwritten). Rejects with a WithdrawError that says which step failed.
 */
export async function withdrawAll({ client, keys, nodeLock, to }: WithdrawRequest): Promise<WithdrawReceipt> {
  let signed: ccc.Transaction;
  let fee: bigint;
  try {
    const signer = new ccc.SignerCkbPrivateKey(client, toHexBytes(keys.ckbKey));
    const own = await signer.getRecommendedAddressObj();
    if (!sameScript(toScript(own.script), nodeLock)) throw withdrawErrors.keyMismatch();
    const built = await buildWithdrawal(signer, to);
    fee = built.fee;
    try {
      signed = await signer.signTransaction(built.tx);
    } catch (e) {
      throw withdrawErrors.buildFailed(e);
    }
  } finally {
    wipeKeys(keys);
  }
  const txHash = await broadcast(client, signed);
  return { txHash, amount: signed.outputs[0].capacity, fee };
}

export interface SendAmountRequest extends WithdrawRequest {
  /** Shannons the address receives exactly; the rest goes back to the node's lock. */
  amount: bigint;
}

/**
 * Pay's on-chain send: builds, signs and sends exactly `amount` to `to`, with the change back to the node's own lock.
 * The keys are wiped right after signing, or when anything before fails, as in withdrawAll. Rejects with a WithdrawError.
 */
export async function sendAmount({ client, keys, nodeLock, to, amount }: SendAmountRequest): Promise<WithdrawReceipt> {
  let signed: ccc.Transaction;
  let fee: bigint;
  try {
    const signer = new ccc.SignerCkbPrivateKey(client, toHexBytes(keys.ckbKey));
    const own = await signer.getRecommendedAddressObj();
    if (!sameScript(toScript(own.script), nodeLock)) throw withdrawErrors.keyMismatch();
    const built = await buildExactSend(signer, to, amount, nodeLock);
    fee = built.fee;
    try {
      signed = await signer.signTransaction(built.tx);
    } catch (e) {
      throw withdrawErrors.buildFailed(e);
    }
  } finally {
    wipeKeys(keys);
  }
  const txHash = await broadcast(client, signed);
  return { txHash, amount: signed.outputs[0].capacity, fee };
}

/* ------------------------------------------------------------------------------------- a token on chain */

/** A token the node may hold on chain, as the hub's whitelist describes it: its type script and its code's cell deps. */
export interface WithdrawToken {
  symbol: string;
  script: Script;
  cellDeps: readonly CellDepDto[];
}

export interface TokenWithdrawRequest extends WithdrawRequest {
  token: WithdrawToken;
}

/** A token withdrawal that went out: its hash, the token's base units the address receives, and the fee in shannons. */
export interface TokenWithdrawReceipt {
  txHash: string;
  amount: bigint;
  fee: bigint;
}

/** A UDT cell's data: the amount as a 16-byte little-endian integer. */
const UDT_AMOUNT_BYTES = 16;

/** The token's code as cell deps: an out point as is, a Type ID through the cell that carries it now. */
async function tokenCodeDeps(client: ccc.Client, token: WithdrawToken): Promise<ccc.CellDepLike[]> {
  const deps: ccc.CellDepLike[] = [];
  for (const dep of token.cellDeps) {
    if ("typeId" in dep) {
      const cell = await client.findSingletonCellByType(dep.typeId);
      if (!cell) throw withdrawErrors.tokenCodeMissing(token.symbol);
      deps.push({ outPoint: cell.outPoint, depType: "code" });
    } else {
      deps.push({ outPoint: dep.outPoint, depType: dep.depType === "dep_group" ? "depGroup" : "code" });
    }
  }
  return deps;
}

/**
 * The node's cells of exactly this token, and their total. The indexer matches a type script's args (and a lock's) by
 * prefix, so another token of the same issuer, or a longer lock, would come back too: each cell is checked in full.
 */
async function nodeTokenCells(signer: ccc.Signer, nodeLock: Script, script: Script): Promise<{ cells: ccc.Cell[]; total: bigint }> {
  const cells: ccc.Cell[] = [];
  let total = BigInt(0);
  for await (const cell of signer.findCells({ script }, true)) {
    const type = cell.cellOutput.type;
    if (!type || !sameScript(toScript(type), script) || !sameScript(toScript(cell.cellOutput.lock), nodeLock)) continue;
    cells.push(cell);
    total += ccc.udtBalanceFrom(cell.outputData);
  }
  return { cells, total };
}

/**
 * Every cell of the token at the node in, one cell to `to` with all of it, the CKB those cells held back to the node as
 * plain CKB (with more of the node's plain CKB when the new cell's lock needs more, and for the fee).
 */
async function buildTokenWithdrawal(signer: ccc.Signer, to: Script, token: WithdrawToken, nodeLock: Script) {
  try {
    const { cells, total } = await nodeTokenCells(signer, nodeLock, token.script);
    if (total === BigInt(0)) throw withdrawErrors.noToken(token.symbol);
    const tx = ccc.Transaction.from({
      outputs: [{ lock: to, type: token.script }],
      outputsData: [ccc.numLeToBytes(total, UDT_AMOUNT_BYTES)],
    });
    for (const cell of cells) tx.addInput({ previousOutput: cell.outPoint, cellOutput: cell.cellOutput, outputData: cell.outputData });
    tx.addCellDeps(await tokenCodeDeps(signer.client, token));
    await tx.completeFeeChangeToLock(signer, nodeLock);
    return { tx, amount: total, fee: await tx.getFee(signer.client) };
  } catch (e) {
    if (e instanceof WithdrawError) throw e;
    if (e instanceof ccc.ErrorTransactionInsufficientCapacity) throw withdrawErrors.tokenNeedsCkb(token.symbol);
    throw withdrawErrors.buildFailed(e);
  }
}

export interface TokenPreviewRequest {
  client: ccc.Client;
  nodeLock: Script;
  to: Script;
  token: WithdrawToken;
}

/** What a token withdrawal would send and its fee, built from the node's cells without its key. */
export async function previewTokenWithdrawal({ client, nodeLock, to, token }: TokenPreviewRequest): Promise<{ amount: bigint; fee: bigint }> {
  const { amount, fee } = await buildTokenWithdrawal(new NodeLockPreview(client, nodeLock), to, token, nodeLock);
  return { amount, fee };
}

/**
 * Builds, signs and sends a withdrawal of all the node's on-chain `token` to `to`. The keys are wiped right after
 * signing, or when anything before fails, as in withdrawAll. Rejects with a WithdrawError.
 */
export async function withdrawTokenAll({ client, keys, nodeLock, to, token }: TokenWithdrawRequest): Promise<TokenWithdrawReceipt> {
  let signed: ccc.Transaction;
  let built: { amount: bigint; fee: bigint };
  try {
    const signer = new ccc.SignerCkbPrivateKey(client, toHexBytes(keys.ckbKey));
    const own = await signer.getRecommendedAddressObj();
    if (!sameScript(toScript(own.script), nodeLock)) throw withdrawErrors.keyMismatch();
    const { tx, amount, fee } = await buildTokenWithdrawal(signer, to, token, nodeLock);
    built = { amount, fee };
    try {
      signed = await signer.signTransaction(tx);
    } catch (e) {
      throw withdrawErrors.buildFailed(e);
    }
  } finally {
    wipeKeys(keys);
  }
  const txHash = await broadcast(client, signed);
  return { txHash, ...built };
}
