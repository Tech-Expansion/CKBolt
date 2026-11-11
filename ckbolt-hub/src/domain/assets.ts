import {
  ASSET_METADATA,
  CKB_ASSET,
  KNOWN_UDT_IDS,
  TESTNET_RUSD_CELL_DEPS,
  TESTNET_RUSD_TYPE_SCRIPT,
  type KnownUdtId,
} from "../common/constants/assets.constants";
import { sameAssetScript, sameScript } from "../common/utils/script.util";
import type { CellDep, CkbNetwork, FiberAsset, FiberAssetId, Script } from "./types";

export interface AssetRegistry {
  get(id: FiberAssetId): FiberAsset | null;
  list(): FiberAsset[];
  /** The asset whose UDT type script equals `script` (null script = CKB), or null if the hub does not serve it. */
  byTypeScript(script: Script | null): FiberAsset | null;
}

/**
 * Assets the hub serves: CKB, always first, then the configured UDTs in their configured order (HubConfig.ckb.udtAssets,
 * from FIBER_ASSETS or the legacy variables). Mainnet is out of scope for stage 3: there the hub serves CKB only.
 */
export function createAssetRegistry(network: CkbNetwork, udtAssets: readonly FiberAsset[] = []): AssetRegistry {
  const assets: FiberAsset[] = [{ ...CKB_ASSET }, ...(network === "mainnet" ? [] : udtAssets)];

  return {
    get: (id) => assets.find((a) => a.id === id) ?? null,
    list: () => [...assets],
    byTypeScript: (script) => assets.find((a) => sameAssetScript(a.udtTypeScript, script)) ?? null,
  };
}

/** UDT type scripts by known asset id: what the legacy variables UDT_RUSD_SCRIPT and UDT_CWBTC_SCRIPT configure. */
export type UdtScripts = Partial<Record<KnownUdtId, Script>>;

/** The cell deps the hub knows for a known UDT's script: RUSD's on testnet; none otherwise (FIBER_ASSETS names them). */
const knownCellDeps = (script: Script): CellDep[] => (sameScript(script, TESTNET_RUSD_TYPE_SCRIPT) ? [...TESTNET_RUSD_CELL_DEPS] : []);

/** The known UDTs (ASSET_METADATA) these scripts configure, RUSD before CWBTC: the assets of the legacy variables. */
export function knownUdtAssets(scripts: UdtScripts): FiberAsset[] {
  return KNOWN_UDT_IDS.flatMap((id) => {
    const script = scripts[id];
    return script ? [{ id, ...ASSET_METADATA[id], udtTypeScript: script, cellDeps: knownCellDeps(script) }] : [];
  });
}
