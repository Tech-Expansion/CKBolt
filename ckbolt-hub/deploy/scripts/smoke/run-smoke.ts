import { TESTNET_RUSD_TYPE_SCRIPT } from "../../../src/common/constants/assets.constants";
import { FIBER_MIN_FINAL_EXPIRY_DELTA_MS } from "../../../src/common/constants/protocol.constants";
import { SWAP_DIRECTION, SWAP_STATE, TERMINAL_SWAP_STATES } from "../../../src/common/constants/swap.constants";
import { describeError } from "../../../src/common/utils/error.util";
import { preimageMatches, randomPreimage, sha256Hex, without0x } from "../../../src/common/utils/hex.util";
import { formatBaseUnits } from "../../../src/common/utils/pricing.util";
import type { Direction, FiberAssetId } from "../../../src/domain/types";
import type { LegDto, SwapDto, SwapEventDto } from "../../../src/interfaces/http/contract/responses";
import { activeServices, waitOptions, type DeployContext } from "../lib/context";
import { FNN_FINAL_PAYMENT_STATES, SERVICE, type ServiceName } from "../lib/constants";
import type { HubApi } from "../lib/hub-api";
import { waitFor } from "../lib/poll";
import type { SmokeDirection } from "../lib/settings";

/**
 * testnet:smoke: one real swap each way on Mutinynet and CKB testnet, without any wallet of the operator's.
 * - BTC to CKB (ln_to_fiber): fnn-demo makes the payout invoice for a preimage this script creates (as a user's wallet
 *   does), lnd-demo pays the hub's Lightning hold invoice.
 * - CKB to BTC (fiber_to_ln): the payout is an invoice of the Mutinynet faucet's node (its /api/bolt11), fnn-demo pays
 *   the hub's Fiber hold invoice.
 * Each run prints the evidence: payment hash, preimage and sha256(preimage) == payment hash, both nodes' view, the hub's
 * events.
 */

const SMOKE_INVOICE_DESCRIPTION = "ckbolt testnet:smoke payout";
/** How much of a long invoice the log shows. */
const INVOICE_PREVIEW_CHARS = 40;
const EVENT_INDENT = "      ";

/** Hex as the hub's helpers compare it: lower case, no 0x. */
const plainHex = (hex: string): string => without0x(hex).toLowerCase();

export interface SmokeOptions {
  direction: SmokeDirection;
  asset: FiberAssetId;
  sats: bigint;
}

export interface SmokeEvidence {
  direction: Direction;
  swap: SwapDto | null;
  /** The preimage the swap revealed, and whether sha256(preimage) is its payment hash. */
  preimageMatches: boolean;
  /** One line per node or party: what it reports about the payment. */
  observations: string[];
  events: SwapEventDto[];
  error: string | null;
}

export const smokeSucceeded = (evidence: SmokeEvidence): boolean =>
  evidence.error === null && evidence.swap?.state === SWAP_STATE.SUCCEEDED && evidence.preimageMatches;

const legText = (leg: LegDto): string => `${formatBaseUnits(BigInt(leg.amount), leg.decimals)} ${leg.asset}`;

const udtOf = (asset: FiberAssetId) => (asset === "RUSD" ? TESTNET_RUSD_TYPE_SCRIPT : null);

/** "BTC to RUSD (ln_to_fiber)", "CKB to BTC (fiber_to_ln)": the direction with the Fiber asset swapped. */
const swapTitle = (direction: Direction, asset: string): string =>
  `${direction === SWAP_DIRECTION.LN_TO_FIBER ? `BTC to ${asset}` : `${asset} to BTC`} (${direction})`;

const directionsOf = (direction: SmokeDirection): Direction[] =>
  direction === "both" ? [SWAP_DIRECTION.LN_TO_FIBER, SWAP_DIRECTION.FIBER_TO_LN] : [direction];

/** The demo nodes a direction pays and receives with. */
const NODES_BY_DIRECTION: Readonly<Record<Direction, readonly ServiceName[]>> = {
  ln_to_fiber: [SERVICE.LND_DEMO, SERVICE.FNN_DEMO],
  fiber_to_ln: [SERVICE.FNN_DEMO],
};

export async function runSmoke(ctx: DeployContext, options: SmokeOptions): Promise<SmokeEvidence[]> {
  const directions = directionsOf(options.direction);
  const active = await activeServices(ctx);
  const missing = [...new Set(directions.flatMap((direction) => NODES_BY_DIRECTION[direction]))].filter((service) => !active.has(service));
  if (missing.length > 0) {
    throw new Error(`testnet:smoke pays with the demo nodes (${missing.join(", ")}): set COMPOSE_PROFILES=demo in the server's .env and fund them`);
  }
  const hub = await ctx.hubApi();
  const evidence: SmokeEvidence[] = [];
  for (const direction of directions) {
    const run = direction === SWAP_DIRECTION.LN_TO_FIBER ? lnToFiber : fiberToLn;
    ctx.logger.step(`${swapTitle(direction, options.asset)}, ${options.sats} sats, ${options.asset}`);
    evidence.push(await run(ctx, hub, options));
  }
  return evidence;
}

/** Polls the swap until it succeeds or fails. */
function waitForEnd(ctx: DeployContext, hub: HubApi, swapId: string): Promise<SwapDto> {
  return waitFor(
    `swap ${swapId} to end`,
    async () => {
      const swap = await hub.swap(swapId);
      return TERMINAL_SWAP_STATES.includes(swap.state) ? swap : undefined;
    },
    waitOptions(ctx, true, ctx.settings.smoke.timeoutMs),
  );
}

const emptyEvidence = (direction: Direction): SmokeEvidence => ({
  direction,
  swap: null,
  preimageMatches: false,
  observations: [],
  events: [],
  error: null,
});

/** Fills the swap's end, its events and the preimage check; any error ends up in the evidence. */
async function finish(hub: HubApi, evidence: SmokeEvidence, ending: Promise<SwapDto>): Promise<void> {
  const swap = await ending;
  evidence.swap = swap;
  evidence.preimageMatches = swap.preimage !== null && preimageMatches(plainHex(swap.preimage), plainHex(swap.paymentHash));
  evidence.events = await hub.swapEvents(swap.id);
}

async function lnToFiber(ctx: DeployContext, hub: HubApi, options: SmokeOptions): Promise<SmokeEvidence> {
  const evidence = emptyEvidence(SWAP_DIRECTION.LN_TO_FIBER);
  try {
    const quote = await hub.createQuote({ direction: SWAP_DIRECTION.LN_TO_FIBER, asset: options.asset, side: "pay", amount: options.sats.toString() });
    ctx.logger.info(`quote ${quote.id}: pay ${legText(quote.pay)}, receive ${legText(quote.receive)}`);
    const preimage = randomPreimage();
    const paymentHash = sha256Hex(preimage);
    const payee = ctx.fiber[SERVICE.FNN_DEMO];
    const payoutInvoice = await payee.newInvoice({
      amount: BigInt(quote.receive.amount),
      udtTypeScript: udtOf(options.asset),
      preimage,
      expirySeconds: ctx.settings.fiber.invoiceExpirySeconds,
      finalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
      description: SMOKE_INVOICE_DESCRIPTION,
    });
    const swap = await hub.createSwap({ quoteId: quote.id, payoutInvoice });
    if (plainHex(swap.paymentHash) !== paymentHash) throw new Error(`the hub's swap uses hash ${swap.paymentHash}, not the payout invoice's ${paymentHash}`);
    ctx.logger.info(`swap ${swap.id}: lnd-demo pays the hold invoice ${swap.pay.invoice.slice(0, INVOICE_PREVIEW_CHARS)}...`);
    evidence.observations.push(`payout invoice made by fnn-demo for a preimage this script created; both legs use hash ${paymentHash}`);

    const { payFeeLimitSats, payTimeoutSeconds } = ctx.settings.lightning;
    const paying = ctx.lnd[SERVICE.LND_DEMO]
      .payInvoice(swap.pay.invoice, { feeLimitSats: payFeeLimitSats, timeoutSeconds: payTimeoutSeconds, callTimeoutMs: ctx.settings.smoke.timeoutMs })
      .then(
        (payment) => `lnd-demo: payment ${payment.status}, fee ${payment.fee_sat} sats, preimage ${payment.payment_preimage || "(none)"}`,
        (error: unknown) => `lnd-demo: payinvoice ended with ${describeError(error)}`,
      );
    await finish(hub, evidence, waitForEnd(ctx, hub, swap.id));
    evidence.observations.push(await paying);
    evidence.observations.push(`fnn-demo: payout invoice ${(await payee.getInvoice(paymentHash)).status}`);
    const revealed = evidence.swap?.preimage;
    if (revealed && plainHex(revealed) !== preimage) throw new Error("the hub revealed a preimage other than the one this script created");
    if (revealed) evidence.observations.push("the revealed preimage is the one this script created");
  } catch (error) {
    evidence.error = describeError(error);
  }
  return evidence;
}

async function fiberToLn(ctx: DeployContext, hub: HubApi, options: SmokeOptions): Promise<SmokeEvidence> {
  const evidence = emptyEvidence(SWAP_DIRECTION.FIBER_TO_LN);
  try {
    const quote = await hub.createQuote({ direction: SWAP_DIRECTION.FIBER_TO_LN, asset: options.asset, side: "receive", amount: options.sats.toString() });
    ctx.logger.info(`quote ${quote.id}: pay ${legText(quote.pay)}, receive ${legText(quote.receive)}`);
    const payoutInvoice = await ctx.mutinynetFaucet.invoice(BigInt(quote.receive.amount));
    const swap = await hub.createSwap({ quoteId: quote.id, payoutInvoice });
    ctx.logger.info(`swap ${swap.id}: fnn-demo pays the hold invoice ${swap.pay.invoice.slice(0, INVOICE_PREVIEW_CHARS)}...`);
    evidence.observations.push(`payout invoice made by the Mutinynet faucet's node (/api/bolt11), hash ${swap.paymentHash}`);

    const payer = ctx.fiber[SERVICE.FNN_DEMO];
    await payer.sendPayment(swap.pay.invoice);
    await finish(hub, evidence, waitForEnd(ctx, hub, swap.id));
    const payment = await waitFor(
      "fnn-demo's payment to end",
      async () => {
        const current = await payer.getPayment(swap.paymentHash);
        return FNN_FINAL_PAYMENT_STATES.includes(current.status) ? current : undefined;
      },
      waitOptions(ctx, true, ctx.settings.smoke.timeoutMs),
    );
    evidence.observations.push(`fnn-demo: payment ${payment.status}${payment.failed_error ? ` (${payment.failed_error})` : ""}`);
  } catch (error) {
    evidence.error = describeError(error);
  }
  return evidence;
}

/** The evidence as the report prints it. */
export function renderEvidence(evidence: SmokeEvidence): string {
  const { swap } = evidence;
  const fiberLeg = evidence.direction === SWAP_DIRECTION.LN_TO_FIBER ? swap?.receive : swap?.pay;
  const title = swapTitle(evidence.direction, fiberLeg?.asset ?? "Fiber");
  const lines = [`${title}: ${smokeSucceeded(evidence) ? "PASSED" : "FAILED"}`];
  if (swap) {
    lines.push(
      `  swap          ${swap.id} (${swap.state}${swap.refunded ? ", refunded" : ""}${swap.failureReason ? `: ${swap.failureReason}` : ""})`,
      `  paid          ${legText(swap.pay)}`,
      `  received      ${legText(swap.receive)}`,
      `  payment hash  ${swap.paymentHash}`,
      `  preimage      ${swap.preimage ?? "(not revealed)"}`,
      `  sha256(preimage) == payment hash: ${evidence.preimageMatches ? "yes" : "no"}`,
    );
  }
  lines.push(...evidence.observations.map((line) => `  ${line}`));
  if (evidence.events.length > 0) {
    lines.push("  hub events:");
    lines.push(...evidence.events.map((event) => `${EVENT_INDENT}${event.at}  ${event.type}  ${event.detail}`));
  }
  if (evidence.error) lines.push(`  error: ${evidence.error}`);
  return lines.join("\n");
}
