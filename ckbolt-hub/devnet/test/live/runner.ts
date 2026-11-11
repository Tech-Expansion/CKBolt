import { describeError } from "../../../src/common/utils/error.util";

export interface CheckResult {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
}

/** Runs named checks one after another, prints PASS or FAIL for each and keeps the results for the summary. */
export class CheckRunner {
  readonly results: CheckResult[] = [];
  private currentSection = "";

  section(title: string): void {
    this.currentSection = title;
    console.log(`\n== ${title}`);
  }

  /** Runs one check; a thrown error is a failure. Returns whether it passed, so later checks can depend on it. */
  async check(name: string, run: () => Promise<string | void>): Promise<boolean> {
    try {
      const detail = (await run()) ?? "";
      this.record(name, true, detail);
      return true;
    } catch (error) {
      this.record(name, false, describeError(error));
      return false;
    }
  }

  get failed(): CheckResult[] {
    return this.results.filter((result) => !result.ok);
  }

  printSummary(): void {
    const failed = this.failed;
    console.log(`\n${this.results.length - failed.length} passed, ${failed.length} failed, ${this.results.length} checks`);
    for (const failure of failed) console.log(`  FAIL [${failure.section}] ${failure.name}: ${failure.detail}`);
  }

  private record(name: string, ok: boolean, detail: string): void {
    this.results.push({ section: this.currentSection, name, ok, detail });
    const suffix = ok ? (detail ? ` (${detail})` : "") : `: ${detail}`;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${suffix}`);
  }
}
