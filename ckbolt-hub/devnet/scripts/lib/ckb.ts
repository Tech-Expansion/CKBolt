import { ccc } from "@ckb-ccc/core";
import { TESTNET_SCRIPTS } from "@ckb-ccc/core/advanced";
import type { Script } from "../../../src/domain/types";
import { CKB_DATA_HASH_TYPE, CKB_GENESIS, XUDT_AMOUNT_BYTES } from "./devnet.constants";

/** A cell to create. Capacity defaults to the cell's occupied capacity (what a UDT cell needs). */
export interface CkbOutput {
  lock: Script;
  capacity?: bigint;
  type?: Script;
  /** Cell data as 0x hex. */
  data?: string;
}

/** A contract cell in the devnet genesis, referenced by data hash. */
export interface GenesisContract {
  codeHash: string;
  hashType: typeof CKB_DATA_HASH_TYPE;
  outPoint: { txHash: string; index: number };
}

const toCccScript = (script: Script): ccc.ScriptLike => script;
const fromCccScript = (script: ccc.Script): Script => ({
  codeHash: script.codeHash,
  hashType: script.hashType as Script["hashType"],
  args: script.args,
});

/** The xUDT amount as cell data: a little-endian u128 (no xUDT extension data). */
export const xudtAmountData = (amount: bigint): string => ccc.hexFrom(ccc.numLeToBytes(amount, XUDT_AMOUNT_BYTES));

/**
 * The CKB devnet through CCC: balances from the node's indexer, and signed transfers and xUDT issues from genesis keys.
 * System script locations are read from the genesis block, so they always match devnet/ckb/dev.toml.
 */
export class CkbChain {
  private constructor(
    private readonly owner: ccc.Owner<ccc.ClientPublicTestnet>,
    readonly xudt: GenesisContract,
  ) {}

  static async connect(rpcUrl: string): Promise<CkbChain> {
    const genesis = await readGenesisBlock(rpcUrl);
    const xudt = xudtContract(genesis);
    const owner = ccc.ClientPublicTestnet.open({ urls: [rpcUrl], scripts: devnetScripts(genesis, xudt) });
    return new CkbChain(owner, xudt);
  }

  /** Connects, runs `work` and disconnects, also when `work` fails. */
  static async use<T>(rpcUrl: string, work: (ckb: CkbChain) => Promise<T>): Promise<T> {
    const ckb = await CkbChain.connect(rpcUrl);
    try {
      return await work(ckb);
    } finally {
      await ckb.close();
    }
  }

  async close(): Promise<void> {
    await this.owner.dispose();
  }

  signer(privateKey: string): ccc.Signer {
    return new ccc.SignerCkbPrivateKey(this.client, privateKey);
  }

  async lockOf(signer: ccc.Signer): Promise<Script> {
    return fromCccScript((await signer.getRecommendedAddressObj()).script);
  }

  /** The xUDT type script whose owner (the only one who can mint) is `ownerLock`. */
  xudtTypeOwnedBy(ownerLock: Script): Script {
    return { codeHash: this.xudt.codeHash, hashType: this.xudt.hashType, args: ccc.Script.from(toCccScript(ownerLock)).hash() };
  }

  /** Plain CKB (cells without type or data) under a lock, in shannons. */
  async capacityOf(lock: Script): Promise<bigint> {
    return this.client.getBalance([toCccScript(lock)]);
  }

  async xudtBalanceOf(lock: Script, xudtType: Script): Promise<bigint> {
    let total = 0n;
    for await (const cell of this.client.findCellsByLock(toCccScript(lock), toCccScript(xudtType), true)) {
      total += ccc.udtBalanceFrom(cell.outputData);
    }
    return total;
  }

  /** Builds, signs and sends a transaction paying `outputs` from the signer's cells; returns its hash. */
  async send(signer: ccc.Signer, outputs: readonly CkbOutput[]): Promise<string> {
    const tx = ccc.Transaction.from({
      outputs: outputs.map(({ lock, type, capacity }) => ({ lock: toCccScript(lock), type: type && toCccScript(type), capacity })),
      outputsData: outputs.map(({ data }) => data ?? "0x"),
    });
    if (outputs.some(({ type }) => type?.codeHash === this.xudt.codeHash)) {
      await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.XUdt);
    }
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer);
    return signer.sendTransaction(tx);
  }

  async waitCommitted(txHash: string, timeoutMs: number): Promise<void> {
    const response = await this.client.waitTransaction(txHash, 1, timeoutMs);
    if (response?.status !== "committed") throw new Error(`CKB transaction ${txHash} was not committed (${response?.status ?? "unknown"})`);
  }

  private get client(): ccc.ClientPublicTestnet {
    return this.owner.value;
  }
}

async function readGenesisBlock(rpcUrl: string): Promise<ccc.ClientBlock> {
  const owner = ccc.ClientPublicTestnet.open({ urls: [rpcUrl] });
  try {
    const block = await owner.value.getBlockByNumber(0);
    if (!block) throw new Error(`The CKB node at ${rpcUrl} returned no genesis block`);
    return block;
  } finally {
    await owner.dispose();
  }
}

function genesisTransaction(genesis: ccc.ClientBlock, index: number): ccc.Transaction {
  const tx = genesis.transactions[index];
  if (!tx) throw new Error(`The genesis block has no transaction ${index}; is this the devnet/ckb/dev.toml chain?`);
  return tx;
}

/** Type-id code hash of a genesis system cell (secp256k1, multisig, Nervos DAO). */
function typeIdCodeHash(genesis: ccc.ClientBlock, outputIndex: number): string {
  const type = genesisTransaction(genesis, CKB_GENESIS.CELLBASE_TX).outputs[outputIndex]?.type;
  if (!type) throw new Error(`Genesis output ${outputIndex} has no type script; is this the devnet/ckb/dev.toml chain?`);
  return type.hash();
}

function xudtContract(genesis: ccc.ClientBlock): GenesisContract {
  const cellbase = genesisTransaction(genesis, CKB_GENESIS.CELLBASE_TX);
  const binary = cellbase.outputsData[CKB_GENESIS.XUDT_CELL];
  if (!binary) throw new Error("The genesis block has no xUDT cell; is this the devnet/ckb/dev.toml chain?");
  return {
    codeHash: ccc.hashCkb(binary),
    hashType: CKB_DATA_HASH_TYPE,
    outPoint: { txHash: cellbase.hash(), index: CKB_GENESIS.XUDT_CELL },
  };
}

/**
 * Script info for CCC. CCC asks for every known script while it collects a signer's cells; the ones the dev chain does
 * not have (anyone-can-pay, JoyID, ...) keep their testnet info and simply match no cell here.
 */
function devnetScripts(genesis: ccc.ClientBlock, xudt: GenesisContract): Record<ccc.KnownScript, ccc.ScriptInfoLike> {
  const cellbaseHash = genesisTransaction(genesis, CKB_GENESIS.CELLBASE_TX).hash();
  const depGroupHash = genesisTransaction(genesis, CKB_GENESIS.DEP_GROUP_TX).hash();
  const depGroup = (index: number) => [{ cellDep: { outPoint: { txHash: depGroupHash, index }, depType: "depGroup" as const } }];
  const code = (txHash: string, index: number) => [{ cellDep: { outPoint: { txHash, index }, depType: "code" as const } }];
  return {
    ...TESTNET_SCRIPTS,
    [ccc.KnownScript.Secp256k1Blake160]: {
      codeHash: typeIdCodeHash(genesis, CKB_GENESIS.SECP256K1_BLAKE160_CELL),
      hashType: "type",
      cellDeps: depGroup(CKB_GENESIS.SECP256K1_BLAKE160_DEP_GROUP),
    },
    [ccc.KnownScript.Secp256k1Multisig]: {
      codeHash: typeIdCodeHash(genesis, CKB_GENESIS.SECP256K1_MULTISIG_CELL),
      hashType: "type",
      cellDeps: depGroup(CKB_GENESIS.SECP256K1_MULTISIG_DEP_GROUP),
    },
    [ccc.KnownScript.NervosDao]: {
      codeHash: typeIdCodeHash(genesis, CKB_GENESIS.NERVOS_DAO_CELL),
      hashType: "type",
      cellDeps: code(cellbaseHash, CKB_GENESIS.NERVOS_DAO_CELL),
    },
    [ccc.KnownScript.XUdt]: {
      codeHash: xudt.codeHash,
      hashType: xudt.hashType,
      cellDeps: code(xudt.outPoint.txHash, xudt.outPoint.index),
    },
  };
}
