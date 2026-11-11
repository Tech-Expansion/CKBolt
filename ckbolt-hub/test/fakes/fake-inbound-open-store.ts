import type { InboundOpen, InboundOpenStore } from "../../src/application/ports/inbound-open-store.port";

/** Oldest first, then by id: the SQLite store's order. */
const byAskedAtThenId = (a: InboundOpen, b: InboundOpen): number =>
  a.askedAt - b.askedAt || (a.temporaryChannelId < b.temporaryChannelId ? -1 : a.temporaryChannelId > b.temporaryChannelId ? 1 : 0);

/**
 * In-memory InboundOpenStore with the same semantics as the SQLite one: one open per temporary channel id (recording it
 * again replaces it), listings at or before a time, oldest first, copies out. Share one instance between two services
 * to play a hub restart over the same database.
 */
export class FakeInboundOpenStore implements InboundOpenStore {
  private readonly byTemporaryId = new Map<string, InboundOpen>();

  record(open: InboundOpen): void {
    this.byTemporaryId.set(open.temporaryChannelId, { ...open });
  }

  listAskedBy(askedBy: number, peer?: string): InboundOpen[] {
    return [...this.byTemporaryId.values()]
      .filter((open) => open.askedAt <= askedBy && (peer === undefined || open.peer === peer))
      .sort(byAskedAtThenId)
      .map((open) => ({ ...open }));
  }

  forget(temporaryChannelId: string): void {
    this.byTemporaryId.delete(temporaryChannelId);
  }

  /** Test helper: every open on record, oldest first. */
  all(): InboundOpen[] {
    return this.listAskedBy(Number.POSITIVE_INFINITY);
  }
}
