/** Progress output of the deploy scripts. Never give it a secret: everything it prints may end up in a terminal log. */
export interface Logger {
  /** A new stage of work. */
  step(title: string): void;
  /** A detail of the current stage. */
  info(message: string): void;
  /** Something the operator should look at; the run goes on. */
  warn(message: string): void;
  /** Text printed as it is (reports, instructions). */
  raw(text: string): void;
}

export const consoleLogger: Logger = {
  step: (title) => console.log(`\n==> ${title}`),
  info: (message) => console.log(`    ${message}`),
  warn: (message) => console.log(`    WARNING: ${message}`),
  raw: (text) => console.log(text),
};
