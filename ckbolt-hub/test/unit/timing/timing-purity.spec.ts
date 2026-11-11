import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkLnToFiberPayout,
  lnPayoutCltvLimit,
  lnSettleDeadlineHeight,
  planFiberToLn,
  planLnToFiber,
} from "../../../src/domain/timing/timing.policy";
import { failsAtOnDefaultChannel, hours, minutes, profile } from "./timing.fixtures";

/**
 * Coding rules for the domain (CONTRIBUTING.md, hub rules 1 and 2): pure functions with no Nest, no I/O and no clock reads, and no
 * magic numbers in the timing code (protocol facts are named constants; tunables come from the profile).
 */
describe("timing: purity and coding rules", () => {
  const TIMING_DIR = join(__dirname, "../../../src/domain/timing");
  const NOW = Date.UTC(2026, 9, 23, 12);

  const callEveryFunction = () => {
    const p = Object.freeze(profile("mutinynet"));
    return [
      planLnToFiber(p, Object.freeze({ payoutFinalExpiryDeltaMs: minutes(160) })),
      checkLnToFiberPayout(p, Object.freeze({ earliestHtlcExpiryHeight: 1_861, currentHeight: 1_000, plannedTlcExpiryLimitMs: minutes(410) })),
      planFiberToLn(p, Object.freeze({ payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: hours(6) })),
      lnPayoutCltvLimit(p, Object.freeze({ heldTlcFailsAt: failsAtOnDefaultChannel(NOW + hours(6)), now: NOW, payoutCltvExpiry: 80 })),
      lnSettleDeadlineHeight(p, 150),
    ];
  };

  afterEach(() => jest.restoreAllMocks());

  it("never reads the clock: time is always passed in", () => {
    const dateNow = jest.spyOn(Date, "now");
    const perfNow = jest.spyOn(performance, "now");

    callEveryFunction();

    expect(dateNow).not.toHaveBeenCalled();
    expect(perfNow).not.toHaveBeenCalled();
  });

  it("does not mutate the profile or the inputs (frozen objects are accepted) and is deterministic", () => {
    expect(callEveryFunction()).toEqual(callEveryFunction());
  });

  const sources = readdirSync(TIMING_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .map((file) => ({ file, text: readFileSync(join(TIMING_DIR, file), "utf8") }));

  const codeOnly = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');

  it.each(sources.map((s) => [s.file, s.text] as const))("%s imports no framework, I/O or outer layer", (_file, text) => {
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

    for (const source of imports) {
      expect(source).not.toMatch(/^@nestjs|^node:|^fs$|^path$|^http|infrastructure|interfaces|application/);
    }
    expect(codeOnly(text)).not.toMatch(/Date\.now|new Date|process\.|Math\.random|console\./);
  });

  it.each(sources.map((s) => [s.file, s.text] as const))("%s has no magic numbers (only 0 and 1)", (_file, text) => {
    const literals = codeOnly(text).match(/(?<![\w.])\d[\d_]*(?:\.\d+)?(?![\w])/g) ?? [];

    expect(literals.filter((n) => n !== "0" && n !== "1")).toEqual([]);
  });
});
