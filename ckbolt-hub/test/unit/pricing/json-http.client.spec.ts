import { buildUrl, FetchJsonHttpClient } from "../../../src/infrastructure/prices/json-http.client";
import { PriceSourceError } from "../../../src/infrastructure/prices/price-source.error";
import { hubConfig } from "./pricing.fixtures";

const URL_UNDER_TEST = new URL("https://api.example.test/v1/price?symbol=BTC");

const jsonResponse = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

describe("FetchJsonHttpClient", () => {
  let fetchMock: jest.SpyInstance;

  const client = (httpTimeoutMs = 5_000) => new FetchJsonHttpClient(hubConfig({ pricing: { httpTimeoutMs } }));

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, "fetch");
  });

  afterEach(() => jest.restoreAllMocks());

  it("GETs the URL and returns its JSON body", async () => {
    fetchMock.mockResolvedValue(jsonResponse('{"price":"80000.1"}'));

    await expect(client().getJson(URL_UNDER_TEST)).resolves.toEqual({ price: "80000.1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(String(URL_UNDER_TEST));
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks for JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse("{}"));

    await client().getJson(URL_UNDER_TEST);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("accept")).toBe("application/json");
  });

  it("sets the abort timeout from config.pricing.httpTimeoutMs", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(jsonResponse("{}"));

    await client(1_234).getJson(URL_UNDER_TEST);

    expect(timeout).toHaveBeenCalledWith(1_234);
  });

  it("gives up on a source that does not answer in time", async () => {
    fetchMock.mockImplementation(
      (_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();

    await expect(client(30).getJson(URL_UNDER_TEST)).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.each([400, 404, 429, 451, 500, 503])("rejects HTTP %d with a PriceSourceError naming the host and status", async (status) => {
    fetchMock.mockResolvedValue(jsonResponse('{"error":"no"}', status));

    const error = await client().getJson(URL_UNDER_TEST).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PriceSourceError);
    expect((error as Error).message).toContain("api.example.test");
    expect((error as Error).message).toContain(String(status));
  });

  it("rejects a body that is not JSON with a PriceSourceError", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Access denied</html>", { status: 200 }));

    await expect(client().getJson(URL_UNDER_TEST)).rejects.toBeInstanceOf(PriceSourceError);
  });

  it("passes on a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(client().getJson(URL_UNDER_TEST)).rejects.toThrow("fetch failed");
  });
});

describe("buildUrl", () => {
  it("sets each query parameter on the base URL", () => {
    const url = buildUrl("https://api.example.test/price", { symbol: "BTC-USDT", ids: "bitcoin,nervos-network" });

    expect(url.origin + url.pathname).toBe("https://api.example.test/price");
    expect(url.searchParams.get("symbol")).toBe("BTC-USDT");
    expect(url.searchParams.get("ids")).toBe("bitcoin,nervos-network");
  });

  it("encodes values so they cannot inject other parameters", () => {
    const url = buildUrl("https://api.example.test/price", { symbol: "BTC&admin=1" });

    expect(url.searchParams.get("symbol")).toBe("BTC&admin=1");
    expect(url.searchParams.has("admin")).toBe(false);
  });
});
