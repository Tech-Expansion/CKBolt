import type { ChannelOpen, ChannelOpenLog } from "../../src/application/ports/channel-open-log.port";
import type { ChannelOpenKind } from "../../src/common/constants/channel-opens.constants";

/**
 * In-memory ChannelOpenLog with the SQLite log's semantics: opens of a kind after a time (not at it), oldest first,
 * copies out; forgetBefore deletes every kind's opens from before a time. Share one instance between two services to
 * play a hub restart over the same database.
 */
export class FakeChannelOpenLog implements ChannelOpenLog {
  private opens: ChannelOpen[] = [];

  record(open: ChannelOpen): void {
    this.opens.push({ ...open });
  }

  listAfter(kind: ChannelOpenKind, after: number): ChannelOpen[] {
    return this.opens
      .filter((open) => open.kind === kind && open.openedAt > after)
      .sort((a, b) => a.openedAt - b.openedAt)
      .map((open) => ({ ...open }));
  }

  forgetBefore(before: number): void {
    this.opens = this.opens.filter((open) => open.openedAt >= before);
  }

  /** Test helper: every open on record, oldest first. */
  all(): ChannelOpen[] {
    return [...this.opens].sort((a, b) => a.openedAt - b.openedAt).map((open) => ({ ...open }));
  }
}
