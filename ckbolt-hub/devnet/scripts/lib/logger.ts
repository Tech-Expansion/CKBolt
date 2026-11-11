/** Progress output of the devnet scripts. */
export interface Logger {
  /** A new stage of work. */
  step(title: string): void;
  /** A detail of the current stage. */
  info(message: string): void;
}

export const consoleLogger: Logger = {
  step: (title) => console.log(`\n==> ${title}`),
  info: (message) => console.log(`    ${message}`),
};
