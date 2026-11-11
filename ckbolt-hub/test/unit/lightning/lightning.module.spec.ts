import "reflect-metadata";
import { Inject, Injectable, Module, type Type } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { authenticatedLndGrpc, type AuthenticatedLnd } from "lightning";
import type { LightningPort } from "../../../src/application/ports/lightning.port";
import { CLOCK, DEMO_LIGHTNING, HUB_CONFIG, LIGHTNING } from "../../../src/application/ports/tokens";
import { HubConfigModule } from "../../../src/config/config.module";
import { loadHubConfig, type HubConfig, type LndConnection } from "../../../src/config/hub.config";
import { LightningModule } from "../../../src/infrastructure/lightning/lightning.module";
import { LndLightningAdapter } from "../../../src/infrastructure/lightning/lnd-lightning.adapter";
import { LnInvoiceWrongNetworkError } from "../../../src/infrastructure/lightning/lnd.errors";
import { lndRpc } from "../../../src/infrastructure/lightning/lnd.rpc";
import { FakeClock } from "../../fakes";
import { PAYMENT_HASH } from "./lightning.fixtures";

jest.mock("lightning", () => ({ ...jest.requireActual<object>("lightning"), authenticatedLndGrpc: jest.fn() }));

const mockedAuthenticatedLndGrpc = authenticatedLndGrpc as jest.MockedFunction<typeof authenticatedLndGrpc>;

const HUB_LND: LndConnection = { grpcHost: "hub-lnd:10009", tlsCertBase64: "aHViLWNlcnQ=", macaroonHex: "0201686562" };
const DEMO_LND: LndConnection = { grpcHost: "demo-lnd:10009", tlsCertBase64: "ZGVtby1jZXJ0", macaroonHex: "0201646d6f" };

type ServiceMap = Record<"default" | "invoices" | "router", { close: jest.Mock }>;

/** The gRPC service objects handed out per socket, so tests can check they get closed. */
const servicesBySocket = new Map<string, ServiceMap>();

function hubConfig(patch: { network?: HubConfig["bitcoin"]["network"]; lnd?: LndConnection; demo?: Partial<HubConfig["demo"]> } = {}): HubConfig {
  const defaults = loadHubConfig({});
  return {
    ...defaults,
    bitcoin: { network: patch.network ?? "regtest" },
    lnd: patch.lnd ?? HUB_LND,
    demo: { ...defaults.demo, ...patch.demo },
  };
}

@Injectable()
class SwapLikeService {
  constructor(
    @Inject(LIGHTNING) readonly hub: LightningPort,
    @Inject(DEMO_LIGHTNING) readonly demo: LightningPort | null,
  ) {}
}

@Module({ providers: [SwapLikeService] })
class FeatureModule {}

describe("LightningModule", () => {
  let clock: FakeClock;
  let moduleRef: TestingModule | undefined;

  const compile = async (config: HubConfig, extraImports: Type<unknown>[] = []): Promise<TestingModule> => {
    moduleRef = await Test.createTestingModule({ imports: [HubConfigModule, LightningModule, ...extraImports] })
      .overrideProvider(HUB_CONFIG)
      .useValue(config)
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    await moduleRef.init();
    return moduleRef;
  };

  beforeEach(() => {
    clock = new FakeClock();
    moduleRef = undefined;
    servicesBySocket.clear();
    mockedAuthenticatedLndGrpc.mockReset();
    mockedAuthenticatedLndGrpc.mockImplementation(({ socket }) => {
      const services: ServiceMap = { default: { close: jest.fn() }, invoices: { close: jest.fn() }, router: { close: jest.fn() } };
      servicesBySocket.set(String(socket), services);
      return { lnd: services as unknown as AuthenticatedLnd };
    });
  });

  afterEach(async () => {
    await moduleRef?.close();
    jest.restoreAllMocks();
  });

  it("provides LIGHTNING as the LND adapter connected with config.lnd", async () => {
    const app = await compile(hubConfig());
    expect(app.get(LIGHTNING)).toBeInstanceOf(LndLightningAdapter);
    expect(mockedAuthenticatedLndGrpc).toHaveBeenCalledWith({ cert: HUB_LND.tlsCertBase64, macaroon: HUB_LND.macaroonHex, socket: HUB_LND.grpcHost });
  });

  it("gives the adapter the configured Bitcoin network: it refuses another network's invoice before asking LND", async () => {
    const decode = jest.spyOn(lndRpc, "decodePaymentRequest");
    const app = await compile(hubConfig({ network: "signet" }));
    await expect(app.get<LightningPort>(LIGHTNING).decodeInvoice("lnbcrt1pinvoice")).rejects.toBeInstanceOf(LnInvoiceWrongNetworkError);
    expect(decode).not.toHaveBeenCalled();
  });

  it("gives the adapter the injected CLOCK", async () => {
    const createHodlInvoice = jest.spyOn(lndRpc, "createHodlInvoice").mockResolvedValue({ request: "lnbcrt1phold", id: PAYMENT_HASH } as never);
    const app = await compile(hubConfig());
    await app.get<LightningPort>(LIGHTNING).createHoldInvoice({ paymentHash: PAYMENT_HASH, amountSats: 1_000n, expirySeconds: 120, cltvExpiry: 144, memo: "swap" });
    expect(createHodlInvoice.mock.calls[0]?.[0]).toMatchObject({ expires_at: new Date(clock.now() + 120_000).toISOString() });
  });

  it("provides DEMO_LIGHTNING as null when the demo is off, without connecting to the demo node", async () => {
    const app = await compile(hubConfig({ demo: { enabled: false, lnd: DEMO_LND } }));
    expect(app.get(DEMO_LIGHTNING)).toBeNull();
    expect(mockedAuthenticatedLndGrpc).toHaveBeenCalledTimes(1);
  });

  it("provides DEMO_LIGHTNING from config.demo.lnd when the demo is on", async () => {
    const app = await compile(hubConfig({ demo: { enabled: true, lnd: DEMO_LND } }));
    const demo = app.get(DEMO_LIGHTNING);
    expect(demo).toBeInstanceOf(LndLightningAdapter);
    expect(demo).not.toBe(app.get(LIGHTNING));
    expect(mockedAuthenticatedLndGrpc).toHaveBeenCalledWith({ cert: DEMO_LND.tlsCertBase64, macaroon: DEMO_LND.macaroonHex, socket: DEMO_LND.grpcHost });
  });

  it("is global: a feature module injects LIGHTNING and DEMO_LIGHTNING without importing it", async () => {
    const app = await compile(hubConfig({ demo: { enabled: true, lnd: DEMO_LND } }), [FeatureModule]);
    const service = app.get(SwapLikeService);
    expect(service.hub).toBe(app.get(LIGHTNING));
    expect(service.demo).toBe(app.get(DEMO_LIGHTNING));
  });

  it("fails at start-up when the hub node has no macaroon", async () => {
    await expect(compile(hubConfig({ lnd: { grpcHost: "hub-lnd:10009", tlsCertBase64: "aHViLWNlcnQ=" } }))).rejects.toThrow(/hub-lnd:10009.*macaroon/);
  });

  it("fails at start-up when the demo is on and the demo node has no certificate", async () => {
    const demo = { enabled: true, lnd: { grpcHost: "demo-lnd:10009", macaroonHex: "02" } };
    await expect(compile(hubConfig({ demo }))).rejects.toThrow(/demo-lnd:10009.*TLS certificate/);
  });

  it("closes the gRPC channels of both nodes when the application shuts down", async () => {
    const app = await compile(hubConfig({ demo: { enabled: true, lnd: DEMO_LND } }));
    await app.close();
    moduleRef = undefined;
    for (const socket of [HUB_LND.grpcHost, DEMO_LND.grpcHost]) {
      const services = servicesBySocket.get(socket)!;
      for (const service of Object.values(services)) expect(service.close).toHaveBeenCalled();
    }
  });

  it("shuts down cleanly with the demo off", async () => {
    const app = await compile(hubConfig());
    await expect(app.close()).resolves.toBeUndefined();
    moduleRef = undefined;
    expect(servicesBySocket.get(HUB_LND.grpcHost)!.default.close).toHaveBeenCalled();
  });
});
