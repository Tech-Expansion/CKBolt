import { fiberErrorMessage } from "./errors";
import type { BrowserFiberNode } from "./node-port";
import type { PeerChannelPlan } from "./peer-channel";
import { MS_PER_SECOND } from "@/lib/hub/constants";
import { PEER_CONNECT_TIMING } from "./constants";

/**
 * Opening a channel with a peer the node may not be connected to yet. fnn takes connect_peer at once but lists the peer
 * only once it is connected, and refuses open_channel until the peer has sent its Init message, so the node dials only
 * when the peer is not listed, waits until list_peers shows it, and tries open_channel once more on that refusal.
 */

export interface PeerConnectDeps {
  pollMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const browserPeerConnectDeps = (): PeerConnectDeps => ({
  ...PEER_CONNECT_TIMING,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

export const PEER_CONNECT_MESSAGE = {
  TIMEOUT: (seconds: number) => `The node did not connect within ${seconds} seconds. Check its address, then try again.`,
} as const;

/** fnn's refusals of an open_channel to a peer that is not (yet) ready, such as "waiting for peer to send Init message". */
const PEER_NOT_READY = /init message|not connected|peer not found|no peer/i;

export const isPeerNotReady = (error: unknown): boolean => PEER_NOT_READY.test(fiberErrorMessage(error));

type PeerNode = Pick<BrowserFiberNode, "listPeers" | "connectPeer" | "openChannel">;

const isListed = async (node: PeerNode, peerId: string): Promise<boolean> => (await node.listPeers()).includes(peerId);

/** Resolves once list_peers shows `peerId`; throws a sentence for the visitor after `timeoutMs`. */
export async function waitForPeer(node: PeerNode, peerId: string, deps: PeerConnectDeps): Promise<void> {
  const deadline = deps.now() + deps.timeoutMs;
  while (!(await isListed(node, peerId))) {
    if (deps.now() >= deadline) throw new Error(PEER_CONNECT_MESSAGE.TIMEOUT(Math.round(deps.timeoutMs / MS_PER_SECOND)));
    await deps.sleep(deps.pollMs);
  }
}

/** Connects to the plan's peer unless it is already a peer, waits for it, then opens and funds the channel. */
export async function connectAndOpenChannel(
  node: PeerNode,
  plan: PeerChannelPlan,
  deps: PeerConnectDeps = browserPeerConnectDeps(),
): Promise<{ temporaryChannelId: string }> {
  if (!(await isListed(node, plan.peerId))) {
    await node.connectPeer(plan.address);
    await waitForPeer(node, plan.peerId, deps);
  }
  const open = () => node.openChannel({ peerId: plan.peerId, fundingAmount: plan.fundingAmount, isPublic: false, udtTypeScript: plan.udtTypeScript });
  try {
    return await open();
  } catch (error) {
    if (!isPeerNotReady(error)) throw error;
    // Listed, but its Init has not arrived yet: give it a moment, once.
    await waitForPeer(node, plan.peerId, deps);
    await deps.sleep(deps.pollMs);
    return open();
  }
}
