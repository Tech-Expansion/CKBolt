import { ccc } from "@ckb-ccc/connector-react";
import { CKB_RPC_ERROR_CODE, CKB_TESTNET_ADDRESS_PREFIX, TYPE_ID_CODE_HASH, UDT_AMOUNT_BYTES, type SendableUdt } from "./constants";
import {
  accountUnreadableError,
  buildFailedError,
  chainRejectedError,
  ckbAddressNetwork,
  FUNDING_FAILURE,
  FundingError,
  unconfirmedSendError,
  walletSigningError,
  type CkbNetwork,
  type FundingToken,
  type FundingTransfer,
} from "./funding";

/**
 * "Fund my Fiber node" on the chain: reads what the connected CCC wallet holds and sends one transfer to the node's
 * address (fiber-browser-wallet.md section 2.1, way A). The wallet signs; nothing here holds a key.
 */
export interface FundingTransport {
  /**
   * The CKB network the wallet's account is on. A CKB wallet says so by its own address, which may stay on mainnet
   * although CCC asked for testnet; other wallets (EVM, Bitcoin) get a CKB address on the network CCC asked for.
   */
  accountNetwork(): Promise<CkbNetwork>;
  /** What the wallet holds of a token, in base units, across its addresses. */
  readBalance(token: FundingToken): Promise<bigint>;
  /**
   * Builds the transfer, has the wallet sign it, sends it to CKB testnet and resolves with the transaction hash.
   * Rejects with a FundingError that says which step failed.
   */
  send(transfer: FundingTransfer): Promise<string>;
}

const TYPE_ID_HASH_TYPE = "type";
const CODE_DEP_TYPE = "code";

/** The transport for a CCC signer (JoyID, MetaMask, UTXO Global and the rest). */
export function cccFundingTransport(signer: ccc.Signer): FundingTransport {
  return {
    accountNetwork: () => accountNetwork(signer),
    readBalance: (token) => readBalance(signer, token),
    send: (transfer) => sendFunding(signer, transfer),
  };
}

async function accountNetwork(signer: ccc.Signer): Promise<CkbNetwork> {
  if (signer.client.addressPrefix !== CKB_TESTNET_ADDRESS_PREFIX) return "mainnet";
  return ckbAddressNetwork(await signer.getInternalAddress()) ?? "testnet";
}

async function assertTestnet(signer: ccc.Signer): Promise<void> {
  let network: CkbNetwork;
  try {
    network = await accountNetwork(signer);
  } catch (e) {
    throw accountUnreadableError(e);
  }
  if (network !== "testnet") {
    throw new FundingError(FUNDING_FAILURE.WRONG_NETWORK, "Your CKB wallet is not on CKB testnet. Switch it to testnet: only test CKB funds a node here.");
  }
}

async function readBalance(signer: ccc.Signer, token: FundingToken): Promise<bigint> {
  if (!token.udt) return signer.getBalance();
  let total = BigInt(0);
  for await (const cell of signer.findCells({ script: token.udt.script }, true)) total += ccc.udtBalanceFrom(cell.outputData);
  return total;
}

async function recipientLock(signer: ccc.Signer, to: string): Promise<ccc.Script> {
  try {
    return (await ccc.Address.fromString(to, signer.client)).script;
  } catch {
    throw new FundingError(FUNDING_FAILURE.WRONG_NETWORK, "This address is not on the wallet's network. Use the node's CKB testnet address (ckt1…).");
  }
}

/** The cell that holds the UDT's code, found by its Type ID, as a cell dep. */
async function udtCodeDep(client: ccc.Client, udt: SendableUdt, symbol: string): Promise<ccc.CellDepLike> {
  const cell = await client.findSingletonCellByType({ codeHash: TYPE_ID_CODE_HASH, hashType: TYPE_ID_HASH_TYPE, args: udt.codeTypeIdArgs });
  if (!cell) throw new FundingError(FUNDING_FAILURE.TOKEN_UNAVAILABLE, `The ${symbol} script cannot be found on CKB testnet right now. Try again later.`);
  return { outPoint: cell.outPoint, depType: CODE_DEP_TYPE };
}

const udtData = (units: bigint) => ccc.numLeToBytes(units, UDT_AMOUNT_BYTES);

/** A UDT transfer to `lock`, its inputs and its change back to the wallet; capacity and fee are added after. */
async function udtTransfer(signer: ccc.Signer, lock: ccc.Script, token: FundingToken & { udt: SendableUdt }, units: bigint): Promise<ccc.Transaction> {
  const type = token.udt.script;
  const tx = ccc.Transaction.from({ outputs: [{ lock, type }], outputsData: [udtData(units)] });
  tx.addCellDeps(await udtCodeDep(signer.client, token.udt, token.symbol));
  await tx.completeInputsByUdt(signer, type);
  const change = (await tx.getInputsUdtBalance(signer.client, type)) - tx.getOutputsUdtBalance(type);
  if (change > ccc.Zero) {
    const { script: changeLock } = await signer.getRecommendedAddressObj();
    tx.addOutput({ lock: changeLock, type }, udtData(change));
  }
  return tx;
}

/** Why the transfer could not be put together: the wallet running short, or CKB testnet not answering. */
function buildError(e: unknown, token: FundingToken): FundingError {
  if (e instanceof FundingError) return e;
  if (e instanceof ccc.ErrorTransactionInsufficientCoin) {
    return new FundingError(FUNDING_FAILURE.NOT_ENOUGH_TOKEN, `Your wallet does not hold that much ${token.symbol}.`);
  }
  if (e instanceof ccc.ErrorTransactionInsufficientCapacity) {
    const why = token.udt ? `for the ${token.symbol} cell's capacity and the fee` : "for this amount and the fee";
    return new FundingError(FUNDING_FAILURE.NOT_ENOUGH_CKB, `Your wallet does not hold enough CKB ${why}.`);
  }
  return buildFailedError(e);
}

async function buildFunding(signer: ccc.Signer, lock: ccc.Script, { token, units }: FundingTransfer): Promise<ccc.Transaction> {
  try {
    const tx = token.udt
      ? await udtTransfer(signer, lock, { ...token, udt: token.udt }, units)
      : ccc.Transaction.from({ outputs: [{ lock, capacity: units }] });
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer);
    return tx;
  } catch (e) {
    throw buildError(e, token);
  }
}

/** Errors a CKB node (or CCC's client, for it) answered with, as opposed to the wallet refusing or the network failing. */
const isClientError = (e: unknown): e is ccc.ErrorClientBase | ccc.JsonRpcError => e instanceof ccc.ErrorClientBase || e instanceof ccc.JsonRpcError;

/** The wallet signs; anything it throws here, other than an error from the chain it read, is its own answer. */
async function signFunding(signer: ccc.Signer, tx: ccc.Transaction): Promise<ccc.Transaction> {
  try {
    return await signer.signTransaction(tx);
  } catch (e) {
    throw isClientError(e) ? buildFailedError(e) : walletSigningError(e);
  }
}

/** A node that already holds this transaction in its pool: it went out, so the transfer is sent. */
const isAlreadySent = (e: unknown): boolean =>
  e instanceof ccc.ErrorClientDuplicatedTransaction || (isClientError(e) && e.code === CKB_RPC_ERROR_CODE.POOL_REJECTED_DUPLICATED_TRANSACTION);

/** Sends the signed transfer to CKB testnet: the same as the signer's sendTransaction, with each failure told apart. */
async function broadcast(client: ccc.Client, signed: ccc.Transaction): Promise<string> {
  const txHash = signed.hash();
  try {
    return await client.sendTransaction(signed);
  } catch (e) {
    if (isAlreadySent(e)) return txHash;
    throw isClientError(e) ? chainRejectedError(e) : unconfirmedSendError(e, txHash);
  }
}

async function sendFunding(signer: ccc.Signer, transfer: FundingTransfer): Promise<string> {
  await assertTestnet(signer);
  const lock = await recipientLock(signer, transfer.to);
  const tx = await buildFunding(signer, lock, transfer);
  const signed = await signFunding(signer, tx);
  return broadcast(signer.client, signed);
}
