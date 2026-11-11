import { describeError } from "../../../src/common/utils/error.util";

/** Runs an entry script; a failure prints one readable line and sets a non-zero exit code. */
export function runMain(name: string, main: () => Promise<number | void>): void {
  main().then(
    (exitCode) => {
      if (typeof exitCode === "number") process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(`\n${name} failed: ${describeError(error)}`);
      process.exitCode = 1;
    },
  );
}
