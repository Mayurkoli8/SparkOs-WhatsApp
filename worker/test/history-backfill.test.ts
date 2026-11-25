import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidHistoryBackfillDays, MAX_HISTORY_BACKFILL_DAYS, normalizeHistoryProgress } from '../src/history-backfill';

test('history backfill accepts whole-day windows within the supported range', () => {
  for (const days of [1, 4, 5, MAX_HISTORY_BACKFILL_DAYS]) assert.equal(isValidHistoryBackfillDays(days), true);
});

test('history backfill rejects values outside the supported range or non-integers', () => {
  for (const days of [0, -1, MAX_HISTORY_BACKFILL_DAYS + 1, 1.5, '5', null]) assert.equal(isValidHistoryBackfillDays(days), false);
});

test('history sync progress accepts percentages and rejects invalid values', () => {
  assert.equal(normalizeHistoryProgress(0), 0);
  assert.equal(normalizeHistoryProgress(68.4), 68);
  assert.equal(normalizeHistoryProgress(100), 100);
  for (const progress of [-1, 101, Infinity, '50', null]) assert.equal(normalizeHistoryProgress(progress), undefined);
});
