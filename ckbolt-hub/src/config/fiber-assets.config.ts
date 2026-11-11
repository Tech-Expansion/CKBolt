import { z } from "zod";
import {
  ASSET_DISPLAY_NAME_MAX_LENGTH,
  ASSET_ID_PATTERN,
  CELL_DEP_TYPES,
  FIBER_ASSET_MAX_DECIMALS,
  RESERVED_ASSET_IDS,
  TESTNET_RUSD_TYPE_SCRIPT,
  UDT_USD_RULES,
  type KnownUdtId,
} from "../common/constants/assets.constants";
import { toHexQuantity } from "../common/utils/amount.util";
import { iconUrlProblem } from "../common/utils/icon-url.util";
import { sameScript } from "../common/utils/script.util";
import { knownUdtAssets, type UdtScripts } from "../domain/assets";
import type { AssetTerms } from "../domain/pricing";
import type { CkbNetwork, FiberAsset } from "../domain/types";

/**
 * The UDTs the hub serves on its CKB network (CKB is built in), from FIBER_ASSETS: a JSON list with, per UDT, what the
 * asset is (id, symbol, name, decimals, type script, the cell deps fnn's udt_whitelist needs, USD rule) and the hub's
 * terms for it (fee, option premium, Lightning bounds, inbound channel amount, the auto-accept amount a browser node
 * whitelists, channels nodes may open to the hub with their own tokens) and how the web app shows it (display name,
 * icon). Without FIBER_ASSETS the legacy variables UDT_RUSD_SCRIPT, UDT_CWBTC_SCRIPT and FIBER_INBOUND_RUSD_AMOUNT
 * configure RUSD and CWBTC as before (RUSD falling back to Fiber's testnet whitelist script on testnet).
 */

const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x[0-9a-fA-F]*$/;
const HEX_QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const WHOLE_NUMBER = /^\d+$/;
const MAX_SYMBOL_LENGTH = 16;
const MAX_NAME_LENGTH = 64;
/** Control characters (C0, DEL, C1) and the Unicode line and paragraph separators, which a shown name must not carry. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A JSON value held in an env variable. */
export const jsonText = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be JSON" });
    return z.NEVER;
  }
});

/** Hex in lower case, as fnn writes and matches it (its udt_whitelist matches `args` against lower-case hex). */
const toLowerHex = (hex: string): string => hex.toLowerCase();

/**
 * A CKB script in the hub's JSON form: `{"codeHash":"0x<32 bytes>","hashType":"type","args":"0x..."}`. Hex of either
 * case is accepted and normalised to lower case, so a whitelist generated from it matches what fnn compares.
 */
export const scriptSchema = z.object({
  codeHash: z.string().regex(HEX_32_BYTES, "must be 0x and 32 bytes of hex").transform(toLowerHex),
  hashType: z.enum(["type", "data", "data1", "data2"]),
  args: z.string().regex(HEX_BYTES, "must be 0x and hex").transform(toLowerHex),
});

/** A script inside FIBER_ASSETS, where a misspelt key is refused rather than ignored. */
const strictScript = scriptSchema.strict();

/** An out-point index: a whole number, or CKB's hex quantity ("0x0"). Normalised to the hex quantity. */
const outPointIndex = z
  .union([z.number().int().nonnegative().safe(), z.string().regex(HEX_QUANTITY, "must be a hex quantity such as 0x0")])
  .transform((index) => (typeof index === "number" ? toHexQuantity(index) : index.toLowerCase()));

/** A cell dep as CKB names it (`outPoint` + `depType`), or by type id as fnn's whitelist may (`typeId`). */
const cellDepSchema = z.union([
  z
    .object({
      outPoint: z.object({ txHash: z.string().regex(HEX_32_BYTES, "must be 0x and 32 bytes of hex").transform(toLowerHex), index: outPointIndex }).strict(),
      depType: z.enum(CELL_DEP_TYPES),
    })
    .strict(),
  z.object({ typeId: strictScript }).strict(),
]);

/** A whole number in JSON: a decimal string (any size) or a safe integer. */
const jsonWholeNumber = z
  .union([z.string().regex(WHOLE_NUMBER, "must be a whole number"), z.number().int().nonnegative().safe()])
  .transform((value) => BigInt(value));
const jsonBaseUnits = jsonWholeNumber.pipe(z.bigint().positive());
const basisPoints = z.number().int().nonnegative();

/** An icon the web app shows for the asset: an https URL or a small inline SVG (iconUrlProblem says why one is refused). */
const iconUrl = z.string().superRefine((value, ctx) => {
  const problem = iconUrlProblem(value);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});

/**
 * Channels a node may open to the hub's fnn in the UDT, funded with its own tokens: fnn-hub's udt_whitelist auto-accepts
 * one funded with at least `minAmount` (its auto_accept_amount; deploy/scripts generate the whitelist from this).
 */
const peerChannels = z.object({ minAmount: jsonBaseUnits }).strict();

const udtAssetEntrySchema = z
  .object({
    id: z
      .string()
      .regex(ASSET_ID_PATTERN, "must be 2 to 16 upper-case letters or digits, starting with a letter")
      .refine((id) => !RESERVED_ASSET_IDS.includes(id), (id) => ({ message: `${id} is reserved` })),
    symbol: z.string().trim().min(1).max(MAX_SYMBOL_LENGTH),
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(ASSET_DISPLAY_NAME_MAX_LENGTH)
      .refine((value) => !CONTROL_CHARACTERS.test(value), "must not contain control characters")
      .optional(),
    iconUrl: iconUrl.optional(),
    decimals: z.number().int().min(0).max(FIBER_ASSET_MAX_DECIMALS),
    usdRule: z.enum(UDT_USD_RULES),
    typeScript: strictScript,
    cellDeps: z.array(cellDepSchema).min(1, "must list the cell deps fnn's udt_whitelist needs"),
    feeBps: basisPoints.optional(),
    optionPremiumBps: basisPoints.optional(),
    minSats: jsonWholeNumber.optional(),
    maxSats: jsonWholeNumber.pipe(z.bigint().positive()).optional(),
    inboundAmount: jsonBaseUnits.optional(),
    autoAcceptAmount: jsonBaseUnits.optional(),
    peerChannels: peerChannels.optional(),
  })
  .strict()
  .refine((entry) => entry.autoAcceptAmount === undefined || entry.inboundAmount !== undefined, {
    message: "needs inboundAmount: it is what a browser node whitelists to take the hub's inbound channels",
    path: ["autoAcceptAmount"],
  })
  .refine((entry) => entry.autoAcceptAmount === undefined || entry.inboundAmount === undefined || entry.autoAcceptAmount <= entry.inboundAmount, {
    message: "must be at most inboundAmount, or a browser node does not accept the hub's channel on its own",
    path: ["autoAcceptAmount"],
  });

export type UdtAssetEntry = z.infer<typeof udtAssetEntrySchema>;

/** Every id and every type script once: the registry finds an asset by either. */
function refuseDuplicates(entries: readonly UdtAssetEntry[], ctx: z.RefinementCtx): void {
  entries.forEach((entry, index) => {
    const earlier = entries.slice(0, index);
    if (earlier.some((other) => other.id === entry.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "id"], message: `${entry.id} is listed twice` });
    }
    if (earlier.some((other) => sameScript(other.typeScript, entry.typeScript))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "typeScript"], message: `another asset already has this type script` });
    }
  });
}

/** FIBER_ASSETS: the JSON list of UDTs the hub serves, each entry checked, ids and type scripts unique. */
export const fiberAssetsJson = jsonText.pipe(z.array(udtAssetEntrySchema).superRefine(refuseDuplicates));

/** Channels nodes may open to the hub's fnn in a UDT with their own tokens. */
export interface PeerChannelTerms {
  /** The least funding fnn-hub accepts on its own (its udt_whitelist auto_accept_amount), base units. */
  minAmount: bigint;
}

/** One UDT the hub serves and its own settings. */
export interface UdtAssetSettings {
  asset: FiberAsset;
  /** The terms the asset sets itself; the global pricing values apply to the rest. */
  terms: Partial<AssetTerms>;
  /** What one inbound channel in the asset is funded with, base units; undefined: none offered. */
  inboundAmount?: bigint;
  /** The auto_accept_amount a browser node whitelists to take the hub's inbound channels in the asset (≤ inboundAmount). */
  autoAcceptAmount?: bigint;
  /** Set when nodes may open channels to the hub in the asset with their own tokens. */
  peerChannels?: PeerChannelTerms;
}

/** Only the terms an entry sets, so the global values fill in the rest. */
function ownTerms({ feeBps, optionPremiumBps, minSats, maxSats }: UdtAssetEntry): Partial<AssetTerms> {
  const terms: Partial<AssetTerms> = {};
  if (feeBps !== undefined) terms.feeBps = feeBps;
  if (optionPremiumBps !== undefined) terms.optionPremiumBps = optionPremiumBps;
  if (minSats !== undefined) terms.minSats = minSats;
  if (maxSats !== undefined) terms.maxSats = maxSats;
  return terms;
}

/** The display name and icon an entry sets, only those it sets. */
const ownDisplay = ({ displayName, iconUrl }: UdtAssetEntry): Pick<FiberAsset, "displayName" | "iconUrl"> => ({
  ...(displayName === undefined ? {} : { displayName }),
  ...(iconUrl === undefined ? {} : { iconUrl }),
});

/** A FIBER_ASSETS entry as the asset and its settings; the auto-accept amount defaults to the inbound amount. */
export const fromFiberAssetsEntry = (entry: UdtAssetEntry): UdtAssetSettings => ({
  asset: {
    id: entry.id,
    symbol: entry.symbol,
    name: entry.name,
    decimals: entry.decimals,
    udtTypeScript: { ...entry.typeScript },
    usdRule: entry.usdRule,
    cellDeps: entry.cellDeps,
    ...ownDisplay(entry),
  },
  terms: ownTerms(entry),
  inboundAmount: entry.inboundAmount,
  autoAcceptAmount: entry.autoAcceptAmount ?? entry.inboundAmount,
  ...(entry.peerChannels === undefined ? {} : { peerChannels: { minAmount: entry.peerChannels.minAmount } }),
});

/** What the legacy variables say: UDT_RUSD_SCRIPT, UDT_CWBTC_SCRIPT, and FIBER_INBOUND_RUSD_AMOUNT by asset. */
export interface LegacyAssetVariables {
  network: CkbNetwork;
  udtScripts: UdtScripts;
  inboundAmounts: Partial<Record<KnownUdtId, bigint>>;
}

/**
 * The UDTs the hub served before FIBER_ASSETS, with the global terms: RUSD from its script (on testnet Fiber's whitelist
 * script when none is set) and CWBTC when its script is set; none on mainnet. A browser node auto-accepts the inbound
 * amount itself.
 */
export function legacyUdtAssetSettings({ network, udtScripts, inboundAmounts }: LegacyAssetVariables): UdtAssetSettings[] {
  if (network === "mainnet") return [];
  const rusd = udtScripts.RUSD ?? (network === "testnet" ? TESTNET_RUSD_TYPE_SCRIPT : undefined);
  return knownUdtAssets({ ...udtScripts, RUSD: rusd }).map((asset) => {
    const inboundAmount = inboundAmounts[asset.id as KnownUdtId];
    return { asset, terms: {}, inboundAmount, autoAcceptAmount: inboundAmount };
  });
}
