// Work that failed for a reason that may pass (HighLevel down, a token being renewed) waits here and is retried with
// growing gaps. The queue is saved to disk by its owner, so it survives restarts.
export type PendingItem<T> = { id: string; payload: T; attempts: number; firstFailedAt: number; nextAt: number; lastError: string };

// 30 s, 1, 2, 5, 10, 20, 30 min, 1, 2, 4 h, then every 8 h.
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000];
// An item is given up by age, not by attempts, so extra manual retries never shorten its life.
export const GIVE_UP_AFTER_MS = 24 * 3600_000;

export class RetryQueue<T> {
  private items = new Map<string, PendingItem<T>>();

  constructor(
    private readonly capacity = 1000,
    private readonly maxAgeMs = GIVE_UP_AFTER_MS
  ) {}

  get size() {
    return this.items.size;
  }

  has(id: string) {
    return this.items.has(id);
  }

  // Returns the item that had to make room, if the queue was full.
  add(id: string, payload: T, now: number, error: string): PendingItem<T> | undefined {
    if (this.items.has(id)) return undefined;
    this.items.set(id, { id, payload, attempts: 1, firstFailedAt: now, nextAt: now + RETRY_DELAYS_MS[0], lastError: error });
    if (this.items.size <= this.capacity) return undefined;
    const oldest = this.list()[0];
    this.items.delete(oldest.id);
    return oldest;
  }

  list() {
    return [...this.items.values()].sort((a, b) => a.firstFailedAt - b.firstFailedAt);
  }

  due(now: number) {
    return this.list().filter(item => item.nextAt <= now);
  }

  failed(id: string, now: number, error: string): 'retrying' | 'gave-up' | 'unknown' {
    const item = this.items.get(id);
    if (!item) return 'unknown';
    item.attempts++;
    item.lastError = error;
    if (now - item.firstFailedAt >= this.maxAgeMs) {
      this.items.delete(id);
      return 'gave-up';
    }
    item.nextAt = now + RETRY_DELAYS_MS[Math.min(item.attempts, RETRY_DELAYS_MS.length) - 1];
    return 'retrying';
  }

  // Not an attempt: the item could not even be tried (e.g. its WhatsApp number is offline).
  postpone(id: string, now: number, ms: number) {
    const item = this.items.get(id);
    if (item) item.nextAt = now + ms;
  }

  retryAllNow(now: number) {
    for (const item of this.items.values()) item.nextAt = now;
  }

  succeeded(id: string) {
    this.items.delete(id);
  }

  toJSON() {
    return this.list();
  }

  load(data: PendingItem<T>[]) {
    this.items = new Map((Array.isArray(data) ? data : []).filter(item => item?.id).map(item => [item.id, item]));
  }
}
