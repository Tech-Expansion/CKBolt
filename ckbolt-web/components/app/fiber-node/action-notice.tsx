import { StatusNotice } from "../status";
import type { NodeAction } from "./use-node-action";

/**
 * The last node action's notice or error, announced politely; `testId` prefixes their test ids. With `of`, only when the
 * last action is one of these (by key), so a result shows next to the control that asked for it.
 */
export function ActionNotice({
  action,
  testId,
  of,
}: {
  action: Pick<NodeAction, "notice" | "error" | "lastKey">;
  testId: string;
  of?: (key: string) => boolean;
}) {
  const shown = !of || (action.lastKey !== null && of(action.lastKey));
  if (!shown) return null;
  return (
    <div aria-live="polite">
      {action.notice && (
        <StatusNotice tone="ok" role="status" data-testid={`${testId}-notice`}>
          {action.notice}
        </StatusNotice>
      )}
      {action.error && (
        <StatusNotice tone="error" data-testid={`${testId}-error`}>
          {action.error}
        </StatusNotice>
      )}
    </div>
  );
}
