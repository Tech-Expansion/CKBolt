import { LiquidityService } from "../../../src/application/pricing/liquidity.service";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, type FakeFiberNode, type FakeLightningNode } from "../../fakes";
import { channel, expectHubError, RUSD_SCRIPT, silenceWarnings } from "./pricing.fixtures";

describe("LiquidityService", () => {
  let lightning: FakeLightningNode;
  let fiber: FakeFiberNode;
  let service: LiquidityService;

  beforeEach(() => {
    const clock = new FakeClock();
    lightning = new FakeLightningNetwork("regtest", clock).node("hub", { channelLocalSats: 250_000n, channelRemoteSats: 9_000_000n, onchainSats: 7_000_000n });
    fiber = new FakeFiberNetwork("devnet", clock).node("hub");
    service = new LiquidityService(lightning, fiber);
    silenceWarnings();
  });

  afterEach(() => jest.restoreAllMocks());

  it("reads LIGHTNING.getBalances and FIBER.listChannels", async () => {
    await service.snapshot();

    expect(lightning.calls).toContain("getBalances");
    expect(fiber.calls).toContain("listChannels");
  });

  it("counts only the Lightning channels' local balance: not remote, not on-chain", async () => {
    expect((await service.snapshot()).lightningSats).toBe(250_000n);
  });

  it("passes the Fiber channels through for the domain to filter by asset and readiness", async () => {
    const channels = [
      channel({ localBalance: 10n }),
      channel({ localBalance: 20n, ready: false }),
      channel({ localBalance: 30n, udtTypeScript: RUSD_SCRIPT }),
    ];
    fiber.setChannels(channels);

    const snapshot = await service.snapshot();

    expect(snapshot.fiberChannels).toHaveLength(3);
    expect(snapshot.fiberChannels.map((c) => [c.localBalance, c.ready, c.udtTypeScript])).toEqual([
      [10n, true, null],
      [20n, false, null],
      [30n, true, RUSD_SCRIPT],
    ]);
  });

  it("follows balance changes between calls", async () => {
    lightning.setBalances({ channelLocalSats: 1n });

    expect((await service.snapshot()).lightningSats).toBe(1n);
  });

  it("throws a 503 HubError when the Lightning node cannot be read", async () => {
    lightning.failNext = "getBalances";

    await expectHubError(() => service.snapshot(), 503, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
  });

  it("throws a 503 HubError when the Fiber node cannot be read", async () => {
    fiber.failNext = "listChannels";

    await expectHubError(() => service.snapshot(), 503, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
  });
});
