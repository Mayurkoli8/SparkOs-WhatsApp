import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidHistoryBackfillDays, MAX_HISTORY_BACKFILL_DAYS } from '../src/history-backfill';

test('history backfill accepts whole-day windows within the supported range', () => {
  for (const days of [1, 4, 5, MAX_HISTORY_BACKFILL_DAYS]) assert.equal(isValidHistoryBackfillDays(days), true);
});

test('history backfill rejects values outside the supported range or non-integers', () => {
  for (const days of [0, -1, MAX_HISTORY_BACKFILL_DAYS + 1, 1.5, '5', null]) assert.equal(isValidHistoryBackfillDays(days), false);
});
