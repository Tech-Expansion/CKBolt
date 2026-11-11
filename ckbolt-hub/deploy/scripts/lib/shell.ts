/** POSIX shell helpers for the commands the scripts run on the server. */

/** Characters that need no quoting in a POSIX shell word. */
const SAFE_SHELL_WORD = /^[A-Za-z0-9_\/.,:=@%+-]+$/;
const SINGLE_QUOTE = "'";
const ESCAPED_SINGLE_QUOTE = `'\\''`;

/** One shell word that stands for `value` exactly: unchanged when safe, single-quoted otherwise. */
export function shellQuote(value: string): string {
  if (SAFE_SHELL_WORD.test(value)) return value;
  return `${SINGLE_QUOTE}${value.split(SINGLE_QUOTE).join(ESCAPED_SINGLE_QUOTE)}${SINGLE_QUOTE}`;
}

/** A command line from its words, each quoted as needed. */
export const shellJoin = (words: readonly string[]): string => words.map(shellQuote).join(" ");

/**
 * The remote command that runs `script` with sh on the server. The script travels base64-encoded inside the command,
 * so no quoting survives two shells and the Windows command line, and the command's stdin stays free for data (a JSON
 * body, an archive). It needs only sh, printf and base64 on the server.
 */
export function remoteShCommand(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `sh -c "$(printf %s ${encoded} | base64 -d)"`;
}

/** `script` run in `dir`: it stops when the directory is missing. */
export const inDirectory = (dir: string, script: string): string => `cd ${shellQuote(dir)} && ${script}`;
