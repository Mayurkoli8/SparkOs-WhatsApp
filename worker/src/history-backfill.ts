export const MAX_HISTORY_BACKFILL_DAYS = 30;

export function isValidHistoryBackfillDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_HISTORY_BACKFILL_DAYS;
}

export function normalizeHistoryProgress(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return Math.round(value);
}
