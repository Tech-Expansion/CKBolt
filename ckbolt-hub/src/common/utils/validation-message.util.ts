import type { ZodIssue } from "zod";
import { VALIDATION_MESSAGE } from "../constants/http.constants";

const issueText = (issue: ZodIssue, fallbackField: string): string => {
  const field = issue.path.length > 0 ? issue.path.join(VALIDATION_MESSAGE.PATH_SEPARATOR) : fallbackField;
  return `${field}${VALIDATION_MESSAGE.FIELD_SEPARATOR}${issue.message}`;
};

/**
 * One plain message for a list of validation issues: "Invalid request. quoteId: Invalid uuid; amount: Required."
 * `fallbackField` names the value when an issue has no path (a route parameter, or the whole body).
 */
export function formatValidationIssues(issues: readonly ZodIssue[], fallbackField: string): string {
  const details = issues.map((issue) => issueText(issue, fallbackField)).join(VALIDATION_MESSAGE.ISSUE_SEPARATOR);
  return details ? `${VALIDATION_MESSAGE.PREFIX} ${details}${VALIDATION_MESSAGE.END}` : VALIDATION_MESSAGE.PREFIX;
}
