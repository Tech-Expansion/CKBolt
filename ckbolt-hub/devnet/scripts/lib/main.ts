import { describeError } from "../../../src/common/utils/error.util";

/** Runs an entry script; a failure prints one readable line and sets a non-zero exit code. */
export function runMain(name: string, main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(`\n${name} failed: ${describeError(error)}`);
    process.exitCode = 1;
  });
}
