export const MAX_HISTORY_BACKFILL_DAYS = 30;

export function isValidHistoryBackfillDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_HISTORY_BACKFILL_DAYS;
}
