import type { BtcNetwork, CkbNetwork } from "../../domain/types";

/** How a reason names a chain the hub cannot map to a network. */
const UNKNOWN_CHAIN = "a chain the hub does not know";

/** The plain sentences of a degraded health report, one per problem. The only place they are written. */
export const HEALTH_REASON = {
  lightningUnreachable: (): string => "The hub's Lightning node does not answer.",

  lightningNotSynced: (): string => "The hub's Lightning node is not synced to the chain yet.",

  /** `nodeNetwork` null: the node names a chain the hub does not know (the same in fiberWrongNetwork). */
  lightningWrongNetwork: (nodeNetwork: BtcNetwork | null, configured: BtcNetwork): string =>
    `The hub's Lightning node runs on ${nodeNetwork ?? UNKNOWN_CHAIN}, but the hub is set up for ${configured}.`,

  fiberUnreachable: (): string => "The hub's Fiber node does not answer.",

  fiberWrongNetwork: (nodeNetwork: CkbNetwork | null, configured: CkbNetwork): string =>
    `The hub's Fiber node runs on ${nodeNetwork === null ? UNKNOWN_CHAIN : `CKB ${nodeNetwork}`}, but the hub is set up for CKB ${configured}.`,
} as const;
