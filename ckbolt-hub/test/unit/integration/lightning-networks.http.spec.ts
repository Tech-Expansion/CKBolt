import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { authenticatedLndGrpc } from "lightning";
import request from "supertest";
import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import { CLOCK, FIBER, PRICE_SOURCES, SWAP_STORE } from "../../../src/application/ports/tokens";
import { SWAP_ENGINE, type SwapEngine } from "../../../src/application/swaps/swap-engine.contract";
import { SwapSchedulerService } from "../../../src/application/swaps/swap-scheduler.service";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { FIBER_MAX_TLC_EXPIRY_LIMIT_MS, MSAT_PER_SAT } from "../../../src/common/constants/protocol.constants";
import { SWAP_STATE } from "../../../src/common/constants/swap.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import type { BtcNetwork, Hex32 } from "../../../src/domain/types";
import type { SwapDto } from "../../../src/interfaces/http/contract/responses";
import { FakeClock, FakeFiberNetwork, FakePriceSource, type FakeFiberNode } from "../../fakes";
import { spyOnLogger } from "../api/api.fixtures";
import { confirmedEvent, confirmedPaymentResult, LndPackageSimulator } from "../lightning/lnd-package.simulator";
import { API_PATH, expectApiError, HUB_FIBER_CHANNELS, INTEGRATION_ENV, startHubApp, SWAP_SATS } from "./integration.fixtures";

/**
 * The hub on the real LightningModule and LND adapter: env -> HubConfig -> LightningModule -> LndLightningAdapter ->
 * swap engine -> HTTP. Only the `lightning` package underneath is replaced, by the LND v0.21.4 simulator of the
 * adapter's own tests, so BOLT11 prefixes, decoding, max_paths and connection shutdown run as in production.
 *
 * Covers: testnet4 hubs accept "lntb" invoices (testnet3 and testnet4 share the prefix) and signet hubs accept
 * "lntbs" (Mutinynet), each refusing the other; amountless BOLT11 payouts; LN_MAX_PAYMENT_PARTS reaching SendPaymentV2;
 * the LND connections closing last on shutdown.
 */

/** The simulator the mocked `lightning` package answers from; set per test. */
const mockLndPackage: { sim: LndPackageSimulator | null } = { sim: null };

jest.mock("lightning", () => {
  const actual = jest.requireActual<Record<string, unknown>>("lightning");
  const simulator = (): LndPackageSimulator => {
    if (!mockLndPackage.sim) throw new Error("test setup: no LND simulator");
    return mockLndPackage.sim;
  };
  const viaSimulator = (name: string) => (args: unknown) => (simulator().rpc as unknown as Record<string, (a: unknown) => unknown>)[name]?.(args);
  const rpcNames = [
    "cancelHodlInvoice",
    "createHodlInvoice",
    "createInvoice",
    "decodePaymentRequest",
    "getChainBalance",
    "getChannelBalance",
    "getInvoice",
    "getPayment",
    "getWalletInfo",
    "settleHodlInvoice",
    "subscribeToInvoices",
    "subscribeToPastPayment",
    "subscribeToPayViaRequest",
  ];
  return {
    ...actual,
    authenticatedLndGrpc: jest.fn(() => ({ lnd: simulator().lnd })),
    ...Object.fromEntries(rpcNames.map((name) => [name, viaSimulator(name)])),
  };
});

const HUB_LND_ENV = { LND_GRPC_HOST: "hub-lnd:10009", LND_TLS_CERT_BASE64: "aHViLWNlcnQ=", LND_MACAROON_HEX: "0201686562" };
const PAYOUT_CLTV = 40;
const MAX_PAYMENT_PARTS = 3;

interface LndHub {
  app: INestApplication;
  config: HubConfig;
  sim: LndPackageSimulator;
  fiber: FakeFiberNetwork;
  hubFiber: FakeFiberNode;
  userFiber: FakeFiberNode;
  engine: SwapEngine;
  http(): ReturnType<typeof request>;
}

async function startLndHub(network: BtcNetwork, timingProfile: string): Promise<LndHub> {
  const sim = new LndPackageSimulator();
  sim.network = network;
  mockLndPackage.sim = sim;
  const config = loadHubConfig({
    ...INTEGRATION_ENV,
    DEMO_ENABLED: "false",
    BTC_NETWORK: network,
    TIMING_PROFILE: timingProfile,
    LN_MAX_PAYMENT_PARTS: String(MAX_PAYMENT_PARTS),
    ...HUB_LND_ENV,
  });
  const clock = new FakeClock();
  const fiber = new FakeFiberNetwork(config.ckb.network, clock);
  const hubFiber = fiber.node("hub");
  hubFiber.setChannels(HUB_FIBER_CHANNELS);
  const app = await startHubApp(config, [
    [CLOCK, clock],
    [FIBER, hubFiber],
    [PRICE_SOURCES, [new FakePriceSource("coingecko", clock), new FakePriceSource("binance", clock)]],
  ]);
  return {
    app,
    config,
    sim,
    fiber,
    hubFiber,
    userFiber: fiber.node("user"),
    engine: app.get<SwapEngine>(SWAP_ENGINE),
    http: () => request(app.getHttpServer()),
  };
}

/** A BOLT11 invoice of another node with the given human-readable prefix, which the simulated LND can decode. */
function payoutInvoice(hub: LndHub, prefix: string, sats: bigint | null = SWAP_SATS): { invoice: string; preimage: Hex32; paymentHash: Hex32 } {
  const preimage = randomBytes(32).toString("hex");
  const paymentHash = sha256Hex(preimage);
  const mtokens = sats === null ? "0" : (sats * MSAT_PER_SAT).toString();
  return { invoice: hub.sim.addPayable({ hash: paymentHash, mtokens, cltvDelta: PAYOUT_CLTV, prefix }), preimage, paymentHash };
}

async function quoteFiberToLn(hub: LndHub): Promise<string> {
  const res = await hub.http().post(API_PATH.QUOTES).send({ direction: "fiber_to_ln", asset: "CKB", side: "receive", amount: SWAP_SATS.toString() }).expect(201);
  return res.body.id as string;
}

const postSwap = (hub: LndHub, quoteId: string, invoice: string) => hub.http().post(API_PATH.SWAPS).send({ quoteId, payoutInvoice: invoice });

describe("Lightning networks through the real LND adapter", () => {
  let hub: LndHub | undefined;

  beforeEach(() => spyOnLogger());

  afterEach(async () => {
    await hub?.app.close();
    hub = undefined;
    mockLndPackage.sim = null;
    jest.restoreAllMocks();
  });

  it("connects LIGHTNING with the LND credentials from the environment", async () => {
    hub = await startLndHub("regtest", "regtest");
    expect(authenticatedLndGrpc).toHaveBeenCalledWith({ cert: HUB_LND_ENV.LND_TLS_CERT_BASE64, macaroon: HUB_LND_ENV.LND_MACAROON_HEX, socket: HUB_LND_ENV.LND_GRPC_HOST });
    expect((await hub.http().get(API_PATH.HEALTH).expect(200)).body.lightning).toMatchObject({ reachable: true, network: "regtest", synced: true });
  });

  describe.each<[BtcNetwork, string, string, string]>([
    // [hub network, timing profile, accepted prefix, refused prefix (the other test network)]
    ["testnet4", "testnet", "lntb", "lntbs"],
    ["signet", "mutinynet", "lntbs", "lntb"],
  ])("a %s hub", (network, profile, accepted, refused) => {
    it(`accepts a "${accepted}" payout invoice and runs the fiber_to_ln swap to the end`, async () => {
      hub = await startLndHub(network, profile);
      const lnd = hub;
      expect((await lnd.http().get(API_PATH.HEALTH).expect(200)).body.lightning.network).toBe(network);
      const payout = payoutInvoice(lnd, accepted);
      lnd.sim.onPay = (stream) => {
        lnd.sim.setPayment(payout.paymentHash, confirmedPaymentResult(payout.paymentHash, payout.preimage));
        stream.emit("confirmed", confirmedEvent(payout.paymentHash, payout.preimage));
      };

      const created = await postSwap(lnd, await quoteFiberToLn(lnd), payout.invoice);
      expect(created.status).toBe(201);
      const swap = created.body as SwapDto;
      expect(swap).toMatchObject({ state: SWAP_STATE.PENDING, paymentHash: payout.paymentHash, receive: { network: "lightning", amount: SWAP_SATS.toString() } });

      await lnd.userFiber.payInvoice({ invoice: swap.pay.invoice, maxFeeAmount: 0n, tlcExpiryLimitMs: FIBER_MAX_TLC_EXPIRY_LIMIT_MS });
      for (let pass = 0; pass < 6; pass += 1) await lnd.engine.processOpenSwaps();

      const done = (await lnd.http().get(API_PATH.swap(swap.id)).expect(200)).body as SwapDto;
      expect(done).toMatchObject({ state: SWAP_STATE.SUCCEEDED, preimage: payout.preimage });
      expect((await lnd.hubFiber.getInvoice(payout.paymentHash))?.state).toBe("Paid");
      expect(lnd.sim.payCalls).toHaveLength(1);
      expect(lnd.sim.lastPayCall().args).toMatchObject({
        request: payout.invoice,
        max_paths: MAX_PAYMENT_PARTS,
        max_fee: Number((SWAP_SATS * BigInt(lnd.config.swaps.lnMaxFeeBps) + 9_999n) / 10_000n),
      });
    });

    it(`refuses a "${refused}" payout invoice with 422 invoice_invalid naming both networks, before asking LND`, async () => {
      hub = await startLndHub(network, profile);
      const payout = payoutInvoice(hub, refused);

      const message = expectApiError(await postSwap(hub, await quoteFiberToLn(hub), payout.invoice), 422, API_ERROR_CODE.INVOICE_INVALID);

      expect(message).toContain(network);
      expect(message).toContain(refused === "lntbs" ? "signet" : "testnet");
      expect(hub.sim.rpc.decodePaymentRequest).not.toHaveBeenCalled();
      expect(hub.hubFiber.calls).not.toContain("createHoldInvoice");
    });

    it("refuses a regtest (lnbcrt) and a mainnet (lnbc) invoice too", async () => {
      hub = await startLndHub(network, profile);
      for (const prefix of ["lnbcrt", "lnbc"]) {
        expectApiError(await postSwap(hub, await quoteFiberToLn(hub), payoutInvoice(hub, prefix).invoice), 422, API_ERROR_CODE.INVOICE_INVALID);
      }
    });

    it(`refuses an amountless "${accepted}" invoice with 422 invoice_invalid`, async () => {
      hub = await startLndHub(network, profile);
      const amountless = payoutInvoice(hub, accepted, null);

      const message = expectApiError(await postSwap(hub, await quoteFiberToLn(hub), amountless.invoice), 422, API_ERROR_CODE.INVOICE_INVALID);

      expect(message).toMatch(/no amount/i);
      expect(hub.hubFiber.calls).not.toContain("createHoldInvoice");
    });
  });

  it("a string that is no BOLT11 invoice is 400 invoice_invalid", async () => {
    hub = await startLndHub("testnet4", "testnet");
    expectApiError(await postSwap(hub, await quoteFiberToLn(hub), "lnxyz1notaninvoice"), 400, API_ERROR_CODE.INVOICE_INVALID);
  });

  it("shutdown: the scheduler stops, then the HTTP server closes, then the database and the LND connections close", async () => {
    hub = await startLndHub("regtest", "regtest");
    const { app, sim } = hub;
    const order: string[] = [];
    const stopScheduler = SwapSchedulerService.prototype.onModuleDestroy;
    jest.spyOn(SwapSchedulerService.prototype, "onModuleDestroy").mockImplementation(async function (this: SwapSchedulerService) {
      await stopScheduler.call(this);
      order.push("scheduler stopped");
    });
    app.getHttpServer().on("close", () => order.push("http closed"));
    const store = app.get<SwapStore>(SWAP_STORE);
    const closeStore = store.close.bind(store);
    jest.spyOn(store, "close").mockImplementation(() => {
      order.push("database closed");
      closeStore();
    });
    sim.services.default.close.mockImplementation(() => order.push("lnd closed"));
    const invoiceStream = sim.invoiceStreams[0];
    expect(invoiceStream?.listenerCount("invoice_updated")).toBe(1);

    await app.close();
    hub = undefined;

    expect(order.slice(0, 2)).toEqual(["scheduler stopped", "http closed"]);
    expect(order.slice(2).sort()).toEqual(["database closed", "lnd closed"]);
    expect(sim.services.invoices.close).toHaveBeenCalled();
    expect(sim.services.router.close).toHaveBeenCalled();
    expect(invoiceStream?.listenerCount("invoice_updated")).toBe(0);
  });
});
