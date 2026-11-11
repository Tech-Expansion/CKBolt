import { createHash, randomBytes } from "node:crypto";
import type { BrowserContext, Page, Route } from "@playwright/test";
import type { Network } from "../../../lib/bolt11";
import {
  SWAP_EVENT,
  type FiberAssetId,
  type FiberNodeDto,
  type InboundChannelDto,
  type LightningInboundChannelDto,
  type LightningNodeDto,
  type LnChannelState,
  type SwapDto,
} from "../../../lib/hub/contract";
import { demoFiberInvoice } from "../../../lib/payment-request";
import { FakeHub, hubAsset, lightningInvoice, RATE } from "../fakes/hub";
import {
  CWBTC_FIBER_ASSET,
  CWBTC_INBOUND_AMOUNT,
  CWBTC_PEER_CHANNELS,
  deliverHubUdtChannel,
  FakeCkbRpc,
  HUB_FIBER_NODE,
  type FakeUdtOpen,
} from "./fiber-node";

/*
 * The CKBolt hub for the live swap card's specs: tests/e2e/fakes/hub.ts (REST API v1, every request recorded, swaps
 * moved along by the test) plus what a run needs on top:
 * - every swap's payment hash is sha256 of a preimage the test knows, so "Swap complete" can show the preimage and the
 *   page can check it against the hash; for ln_to_fiber the hold invoice carries that hash, as the hub's would;
 * - the hub's Fiber node (GET /v1/fiber/node, its inbound channels) for the browser node tab;
 * - the hub's Lightning node (GET /v1/lightning/node) and the channels it opens to wallets, for the Lightning dialog;
 * - the steps of a swap as the hub's engine takes them, with their events;
 * - cWBTC as a third asset (`serveCwbtc`), with its whitelist entry in GET /v1/fiber/node, and, with
 *   `openUdtChannels`, the token channels the browser node asks for opened into the node that asked (its fake fnn takes
 *   them by its UDT whitelist, support/fiber-node.ts `deliverHubUdtChannel`);
 * - `peerChannels` on a token (`allowOwnChannels`): nodes may open their own channel to the hub in it, which the hub's
 *   fnn would accept by itself, so nothing reaches this fake for it (the node's open_channel is in the fake node).
 * `isolate()` keeps the whole browser context off the network: nothing reaches a real hub, relay, RPC or price API.
 */

/** Seconds the hold invoice of a swap stays payable, as the fake's own hold invoices. */
const HOLD_INVOICE_EXPIRY_SECONDS = 150;
const HOLD_INVOICE_MEMO = "CKBolt hold invoice";

/** lnd-hub on Mutinynet, as GET /v1/lightning/node answers: 30,000-sat channels to wallets, 20,000 on their side. */
export const HUB_LIGHTNING_NODE: LightningNodeDto = {
  pubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  network: "signet",
  uris: ["0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798@203.0.113.10:9735"],
  inbound: { enabled: true, capacitySats: "30000", pushSats: "20000" },
};

const LIGHTNING_PUBKEY_IN_PATH = /\/0[23][0-9a-f]{64}$/i;

export class LiveHub extends FakeHub {
  fiberNode: FiberNodeDto = structuredClone(HUB_FIBER_NODE);
  /** GET /v1/lightning/node; null answers 404, as a hub without the route would. */
  lightningNode: LightningNodeDto | null = structuredClone(HUB_LIGHTNING_NODE);
  /** The channels lnd-hub has with each wallet, by its pubkey (GET /v1/lightning/inbound-channels/:pubkey). */
  readonly lightningChannels = new Map<string, LightningInboundChannelDto[]>();
  /** Answers of POST /v1/lightning/inbound-channels, used in order; then 202 and a channel opening. */
  readonly lightningAnswers: { status: number; body: unknown }[] = [];
  /** The bodies of POST /v1/lightning/inbound-channels. */
  readonly lightningBodies: unknown[] = [];
  /** The bodies of POST /v1/fiber/inbound-channels: the channels the browser node asked the hub for. */
  readonly fiberChannelBodies: { nodeId: string; asset: string }[] = [];
  /** The channels fnn-hub has with each node, by its id (GET /v1/fiber/inbound-channels/:nodeId); none by default. */
  readonly fiberInboundChannels = new Map<string, InboundChannelDto[]>();
  /** Answers of POST /v1/fiber/inbound-channels by asset, used once each (a 409, a 429); otherwise 202 and an open. */
  readonly fiberAnswers = new Map<string, { status: number; body: unknown }>();
  /**
   * When set, a token channel the browser node asks for (POST /v1/fiber/inbound-channels with a UDT) is opened into
   * the node's document right after the 202, as the hub's fnn would; its outcome lands in `udtOpens`.
   */
  openUdtChannels = false;
  readonly udtOpens: FakeUdtOpen[] = [];
  /** The preimage of each swap's payment hash, by swap id. */
  private readonly preimages = new Map<string, string>();

  constructor() {
    super();
    // The fake's documented hook for the hold invoice of the next swap: the payment hash becomes one whose preimage
    // the test knows, and a Lightning hold invoice carries it.
    this.holdInvoice = (swap) => this.lockToKnownPreimage(swap);
  }

  override async install(target: Page | BrowserContext) {
    await super.install(target);
    // Registered after the fake's own route, so it answers these paths first.
    await target.route("**/api/hub/v1/fiber/**", (route) => this.fiberRoute(route));
    await target.route("**/api/hub/v1/lightning/**", (route) => this.lightningRoute(route));
  }

  /**
   * cWBTC as the hub serves it once its FIBER_ASSETS lists it: in GET /v1/assets (both ways, 1:1 with BTC), in GET
   * /v1/fiber/node with its type script and whitelist entry, and inbound channels of 10 cWBTC.
   */
  serveCwbtc() {
    if (!this.assets.some((a) => a.id === "CWBTC")) this.assets.push(hubAsset("CWBTC"));
    if (!this.fiberNode.assets.some((a) => a.id === "CWBTC")) this.fiberNode.assets.push(structuredClone(CWBTC_FIBER_ASSET));
    this.fiberNode.inbound.amounts.CWBTC = CWBTC_INBOUND_AMOUNT;
    return this;
  }

  /**
   * The hub lets nodes open their own channel to it in `asset` (FIBER_ASSETS `peerChannels`): GET /v1/fiber/node gives the
   * asset's `peerChannels`, cWBTC's by default (at least 0.01 cWBTC, 84 epochs assumed).
   */
  allowOwnChannels(asset: FiberAssetId = "CWBTC", peerChannels: { minAmount: string; assumedCommitmentDelayEpochs: number } = CWBTC_PEER_CHANNELS) {
    const entry = this.fiberNode.assets.find((a) => a.id === asset);
    if (!entry) throw new Error(`the hub does not serve ${asset}`);
    entry.peerChannels = { ...peerChannels };
    return this;
  }

  /** Sets the one channel lnd-hub has with the wallet `pubkey`, as the hub would list it. */
  setLightningChannel(pubkey: string, state: LnChannelState, walletBalanceSats = HUB_LIGHTNING_NODE.inbound.pushSats) {
    const { capacitySats } = HUB_LIGHTNING_NODE.inbound;
    const hubBalanceSats = (BigInt(capacitySats) - BigInt(walletBalanceSats)).toString();
    this.lightningChannels.set(pubkey, [{ channelPoint: `${"ab".repeat(32)}:0`, state, capacitySats, hubBalanceSats, walletBalanceSats }]);
  }

  /** The preimage of the current swap's payment hash. */
  get preimage(): string {
    const swap = this.current;
    return this.preimages.get(swap.id)!;
  }

  get current(): SwapDto {
    if (!this.swap) throw new Error("no swap yet");
    return this.swap;
  }

  /* --------------------------------------------------------------------------------- the hub's engine */

  /** The user's payment arrived and is held. */
  holdPayment() {
    this.advance({ state: "incoming_accepted" }, [SWAP_EVENT.INCOMING_ACCEPTED, "Your payment is held."]);
  }

  /** The hub is paying the user's payout invoice. */
  startPayout() {
    this.advance({ state: "outgoing_in_flight" }, [SWAP_EVENT.PAYOUT_STARTED, "Paying your invoice."]);
  }

  /** The payout went through and revealed the preimage; the hub settled the held payment. */
  settle() {
    this.advance({ state: "succeeded", preimage: this.preimage }, [SWAP_EVENT.PAYOUT_SUCCEEDED, "Paid out."], [SWAP_EVENT.SETTLED, "Settled."]);
  }

  /** The payout failed: the swap fails, and the hold is cancelled once `refunded`. */
  failPayout(reason: string, refunded: boolean) {
    this.advance({ state: "failed", failureReason: reason, refunded }, [SWAP_EVENT.PAYOUT_FAILED, reason]);
  }

  /**
   * BTC to CKB or RUSD: the swap takes the payment hash of the payout invoice the node made (0x or bare), as the real hub
   * does, and its Lightning hold invoice carries that hash. The fake drew its own when it created the swap.
   */
  useNodeHash(hash: string) {
    const swap = this.current;
    swap.paymentHash = hash.replace(/^0x/, "").toLowerCase();
    if (swap.pay.network !== "lightning") return;
    swap.pay.invoice = lightningInvoice({
      sats: Number(swap.pay.amount),
      network: (this.health.lightning.network ?? "signet") as Network,
      hash: Buffer.from(swap.paymentHash, "hex"),
      expirySeconds: HOLD_INVOICE_EXPIRY_SECONDS,
      description: HOLD_INVOICE_MEMO,
    });
  }

  /** Nothing was paid before the quote ran out: the hub cancels the swap. */
  cancel(reason: string) {
    this.advance({ state: "failed", failureReason: reason, refunded: true }, [SWAP_EVENT.EXPIRED, reason]);
  }

  private lockToKnownPreimage(swap: SwapDto): string {
    const preimage = randomBytes(32);
    const hash = createHash("sha256").update(preimage).digest();
    swap.paymentHash = hash.toString("hex");
    this.preimages.set(swap.id, preimage.toString("hex"));
    if (swap.pay.network !== "lightning") return demoFiberInvoice("testnet", BigInt(swap.pay.amount));
    return lightningInvoice({
      sats: Number(swap.pay.amount),
      network: (this.health.lightning.network ?? "signet") as Network,
      hash,
      expirySeconds: HOLD_INVOICE_EXPIRY_SECONDS,
      description: HOLD_INVOICE_MEMO,
    });
  }

  private lightningRoute(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/hub/, "");
    const pubkey = path.match(LIGHTNING_PUBKEY_IN_PATH)?.[0].slice(1) ?? null;
    const key = `${request.method()} ${pubkey ? path.replace(LIGHTNING_PUBKEY_IN_PATH, "/:pubkey") : path}`;
    this.requests.push(key);
    const notFound = { status: 404, json: { error: { code: "not_found", message: "This is not a CKBolt hub API path." } } };
    switch (key) {
      case "GET /v1/lightning/node":
        return this.lightningNode ? route.fulfill({ json: this.lightningNode }) : route.fulfill(notFound);
      case "GET /v1/lightning/inbound-channels/:pubkey":
        return route.fulfill({ json: { data: this.lightningChannels.get(pubkey!) ?? [] } });
      case "POST /v1/lightning/inbound-channels": {
        const body = request.postDataJSON() as { pubkey: string };
        this.lightningBodies.push(body);
        const answer = this.lightningAnswers.shift();
        if (answer) return route.fulfill({ status: answer.status, json: answer.body });
        const { capacitySats, pushSats } = HUB_LIGHTNING_NODE.inbound;
        this.setLightningChannel(body.pubkey, "opening");
        return route.fulfill({ status: 202, json: { pubkey: body.pubkey, capacitySats, pushSats, fundingTxid: "ab".repeat(32) } });
      }
      default:
        return route.fulfill(notFound);
    }
  }

  private async fiberRoute(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/hub/, "");
    this.requests.push(`${request.method()} ${path.replace(/\/0[23][0-9a-f]{64}$/i, "/:nodeId")}`);
    if (request.method() === "GET" && path === "/v1/fiber/node") return route.fulfill({ json: this.fiberNode });
    if (request.method() === "GET" && path.startsWith("/v1/fiber/inbound-channels/")) {
      const nodeId = path.slice("/v1/fiber/inbound-channels/".length).toLowerCase();
      return route.fulfill({ json: { data: this.fiberInboundChannels.get(nodeId) ?? [] } });
    }
    if (request.method() === "POST" && path === "/v1/fiber/inbound-channels") {
      const body = request.postDataJSON() as { nodeId: string; asset: FiberAssetId };
      this.fiberChannelBodies.push(body);
      const answer = this.fiberAnswers.get(body.asset);
      if (answer) {
        this.fiberAnswers.delete(body.asset);
        return route.fulfill({ status: answer.status, json: answer.body });
      }
      const fundingAmount = this.fiberNode.inbound.amounts[body.asset] ?? "0";
      const udt = this.fiberNode.assets.find((a) => a.id === body.asset)?.udtTypeScript ?? null;
      await route.fulfill({ status: 202, json: { nodeId: body.nodeId, asset: body.asset, fundingAmount, temporaryChannelId: `0x${randomBytes(32).toString("hex")}` } });
      // The hub's open_channel reaches the node after the answer; a CKB channel waits for the app's accept_channel.
      if (this.openUdtChannels && udt) this.udtOpens.push(await deliverHubUdtChannel(request.frame(), { udt, amount: fundingAmount }));
      return;
    }
    return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "This is not a CKBolt hub API path." } } });
  }
}

/** Hosts a test page may load from: the server under test only. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Keeps a browser context off the network: every request to another host is refused (a relay, an RPC, a CDN), the
 * reference prices (/api/rate) are fixed, and the public CKB RPC the node page reads is faked. Call it before the hub's
 * install: routes registered later answer first, so the hub and the RPC fake still answer their own paths.
 */
export async function isolate(context: BrowserContext) {
  await context.route((url) => !LOCAL_HOSTS.has(url.hostname), (route) => route.abort("blockedbyclient"));
  await new FakeCkbRpc().install(context);
  await context.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
}
