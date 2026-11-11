/**
 * "Report a problem" (phase-3c plan F9.1, decision D4): where testers report problems. NEXT_PUBLIC_FEEDBACK_URL names
 * the place at build time; without it, a new issue on the public repo, which holds the web app and the hub. The link
 * carries `title` and `body` query parameters, which GitHub's new-issue form fills in, so a report names the swap it is
 * about.
 */

/** Where reports go when NEXT_PUBLIC_FEEDBACK_URL is not set: a new issue on github.com/Tech-Expansion/CKBolt, the public repo. */
export const FEEDBACK_DEFAULT_URL = "https://github.com/Tech-Expansion/CKBolt/issues/new";

/** Query parameters of the report form (GitHub's new-issue form reads both). */
export const FEEDBACK_PARAM = { TITLE: "title", BODY: "body" } as const;

/**
 * Under the swap id: the report is public, and anyone with a swap's id can read that swap from the hub (its invoices
 * included). The team needs the id, so it stays, and the reporter is told before posting.
 */
const SWAP_ID_PUBLIC = "This report and its swap id are public; testnet swaps hold no real value.";

export const FEEDBACK_COPY = {
  LINK: "Report a problem",
  TITLE: "Problem with the testnet demo",
  TITLE_SWAP: (swapId: string) => `Problem with swap ${swapId}`,
  SWAP_ID_PUBLIC,
  /** The report's starting text: the swap id when there is one, then what the team needs to know. */
  BODY: (swapId: string | null) =>
    [
      ...(swapId ? [`Swap id: ${swapId}`, SWAP_ID_PUBLIC, ""] : []),
      "What happened:",
      "",
      "What you expected:",
      "",
      "Browser, Lightning wallet and Fiber node:",
      "",
    ].join("\n"),
} as const;

/** The configured report page when it is an http(s) URL, else the default. */
export function feedbackBaseUrl(configured: string | undefined = process.env.NEXT_PUBLIC_FEEDBACK_URL): string {
  const text = configured?.trim();
  if (!text) return FEEDBACK_DEFAULT_URL;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : FEEDBACK_DEFAULT_URL;
  } catch {
    return FEEDBACK_DEFAULT_URL;
  }
}

/**
 * The report link, with the title and body filled in and URL-encoded (spaces as %20, which every form reads); query
 * parameters the configured URL already has are kept.
 */
export function feedbackUrl(swapId: string | null = null, base: string = feedbackBaseUrl()): string {
  const url = new URL(base);
  url.searchParams.set(FEEDBACK_PARAM.TITLE, swapId ? FEEDBACK_COPY.TITLE_SWAP(swapId) : FEEDBACK_COPY.TITLE);
  url.searchParams.set(FEEDBACK_PARAM.BODY, FEEDBACK_COPY.BODY(swapId));
  // URLSearchParams writes a space as "+" and a literal "+" as "%2B", so this changes spaces only.
  url.search = url.searchParams.toString().replace(/\+/g, "%20");
  return url.toString();
}
