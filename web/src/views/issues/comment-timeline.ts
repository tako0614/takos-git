import { batch, createSignal } from "solid-js";
import type { Page } from "../../api/client.ts";
import type { IssueCommentDto } from "../../api/types.ts";

/** Issue-local timeline state, shared by page reads and acknowledged writes. */
export function createCommentTimeline() {
  const [items, setItems] = createSignal<IssueCommentDto[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const reads = new Map<symbol, Map<string, IssueCommentDto | null>>();

  // Match listComments' ORDER BY created_at ASC, id ASC. A locally posted row
  // can already be visible while older, unloaded rows arrive on a later page.
  const ordered = (rows: Iterable<IssueCommentDto>) => [...rows].sort((a, b) =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const record = (id: string, comment: IssueCommentDto | null) => {
    for (const changes of reads.values()) changes.set(id, comment);
  };

  return {
    items,
    cursor,
    beginRead() {
      const read = Symbol("comment read");
      reads.set(read, new Map());
      return read;
    },
    accept(read: symbol, page: Page<IssueCommentDto>, reset: boolean) {
      const changes = reads.get(read);
      if (!changes) return;
      const next = new Map((reset ? [] : items()).map((item) => [item.id, item]));
      for (const item of page.items) next.set(item.id, item);
      // Only writes ACKed after this read began override its snapshot. Once
      // the read finishes, the next read is authoritative again.
      for (const [id, comment] of changes) {
        if (comment) next.set(id, comment);
        else next.delete(id);
      }
      batch(() => {
        setItems(ordered(next.values()));
        setCursor(page.nextCursor);
      });
    },
    finishRead(read: symbol) {
      reads.delete(read);
    },
    acknowledge(comment: IssueCommentDto) {
      record(comment.id, comment);
      setItems((prev) => {
        const next = new Map(prev.map((item) => [item.id, item]));
        next.set(comment.id, comment);
        return ordered(next.values());
      });
    },
    remove(id: string) {
      record(id, null);
      setItems((prev) => prev.filter((item) => item.id !== id));
    },
    reset() {
      reads.clear();
      batch(() => {
        setItems([]);
        setCursor(null);
      });
    },
  };
}
