import { FIBER_RPC_HTTP } from "../../../src/common/constants/fiber-rpc.constants";
import { describeError } from "../../../src/common/utils/error.util";
import { loadHubConfig } from "../../../src/config/hub.config";
import { createDemoFiber, createHubFiber } from "../../../src/infrastructure/fiber/fiber.factory";
import { FiberRpcTransportError } from "../../../src/infrastructure/fiber/fiber-rpc.errors";
import { wireNodeInfo } from "./fiber.fixtures";

/**
 * Security review D1, the hub's side: should fnn's RPC ever need a Biscuit token, the hub sends FIBER_RPC_TOKEN (and
 * DEMO_FIBER_RPC_TOKEN to the demo wallet's node) as `Authorization: Bearer <token>` on every call, and nothing without
 * one. Checked from the environment through the config and the adapter factory to the HTTP request the hub makes.
 */

const HUB_RPC_URL = "http://fnn-hub:8227/";
const DEMO_RPC_URL = "http://fnn-demo:8227/";
const HUB_TOKEN = "EoQKCAoGCAESAhgBEgYIARICGAEaIK-hub-biscuit";
const DEMO_TOKEN = "EoQKCAoGCAESAhgBEgYIARICGAEaIK-demo-biscuit";

type FetchInit = { headers?: Record<string, string> };

describe("FIBER_RPC_TOKEN reaches fnn as a Bearer token (D1)", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: wireNodeInfo() }), { status: 200 }));
  });

  afterEach(() => jest.restoreAllMocks());

  /** The headers of every request the hub sent to `url`. */
  const headersSentTo = (url: string): Record<string, string>[] =>
    fetchSpy.mock.calls.filter(([target]) => String(target) === url).map(([, init]) => (init as FetchInit).headers ?? {});
  const authorizationOf = (headers: Record<string, string>): string | undefined =>
    Object.entries(headers).find(([name]) => name.toLowerCase() === FIBER_RPC_HTTP.AUTHORIZATION_HEADER.toLowerCase())?.[1];

  it("is read from the environment into the hub's Fiber connection", () => {
    expect(loadHubConfig({ FIBER_RPC_TOKEN: HUB_TOKEN }).fiber.authToken).toBe(HUB_TOKEN);
    expect(loadHubConfig({}).fiber.authToken).toBeUndefined();
  });

  it("is sent as Authorization: Bearer <token> on every call to the hub's node", async () => {
    const fiber = createHubFiber(loadHubConfig({ FIBER_RPC_URL: HUB_RPC_URL, FIBER_RPC_TOKEN: HUB_TOKEN }));
    await fiber.getInfo();
    await fiber.getInfo();
    const sent = headersSentTo(HUB_RPC_URL);
    expect(sent).toHaveLength(2);
    for (const headers of sent) expect(authorizationOf(headers)).toBe(`Bearer ${HUB_TOKEN}`);
  });

  it.each([
    ["unset", {}],
    ["empty", { FIBER_RPC_TOKEN: "" }],
  ])("sends no Authorization header when FIBER_RPC_TOKEN is %s", async (_name, env) => {
    const fiber = createHubFiber(loadHubConfig({ FIBER_RPC_URL: HUB_RPC_URL, ...env }));
    await fiber.getInfo();
    const [headers] = headersSentTo(HUB_RPC_URL);
    expect(headers).toBeDefined();
    expect(authorizationOf(headers ?? {})).toBeUndefined();
  });

  it("sends each node its own token: DEMO_FIBER_RPC_TOKEN to the demo wallet's node, never the hub's", async () => {
    const config = loadHubConfig({
      FIBER_RPC_URL: HUB_RPC_URL,
      FIBER_RPC_TOKEN: HUB_TOKEN,
      DEMO_ENABLED: "true",
      DEMO_LND_GRPC_HOST: "127.0.0.1:10010",
      DEMO_FIBER_RPC_URL: DEMO_RPC_URL,
      DEMO_FIBER_RPC_TOKEN: DEMO_TOKEN,
    });
    await createHubFiber(config).getInfo();
    await createDemoFiber(config)?.getInfo();
    expect(headersSentTo(HUB_RPC_URL).map(authorizationOf)).toEqual([`Bearer ${HUB_TOKEN}`]);
    expect(headersSentTo(DEMO_RPC_URL).map(authorizationOf)).toEqual([`Bearer ${DEMO_TOKEN}`]);
  });

  it("sends the demo node no token when only the hub's is set", async () => {
    const config = loadHubConfig({
      FIBER_RPC_URL: HUB_RPC_URL,
      FIBER_RPC_TOKEN: HUB_TOKEN,
      DEMO_ENABLED: "true",
      DEMO_LND_GRPC_HOST: "127.0.0.1:10010",
      DEMO_FIBER_RPC_URL: DEMO_RPC_URL,
    });
    await createDemoFiber(config)?.getInfo();
    expect(headersSentTo(DEMO_RPC_URL).map(authorizationOf)).toEqual([undefined]);
  });

  it("never puts the token in an error the hub logs or answers with", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND fnn-hub") }));
    const fiber = createHubFiber(loadHubConfig({ FIBER_RPC_URL: HUB_RPC_URL, FIBER_RPC_TOKEN: HUB_TOKEN }));
    const error = await fiber.getInfo().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(FiberRpcTransportError);
    expect(describeError(error)).not.toContain(HUB_TOKEN);
    expect((error as Error).message).not.toContain(HUB_TOKEN);
  });
});
