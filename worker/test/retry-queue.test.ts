import test from 'node:test';
import assert from 'node:assert/strict';
import { GIVE_UP_AFTER_MS, RETRY_DELAYS_MS, RetryQueue } from '../src/retry-queue';

const T0 = Date.UTC(2026, 9, 5, 12);

test('a failed item becomes due after the first delay', () => {
  const queue = new RetryQueue<string>();
  queue.add('m1', 'payload', T0, 'HTTP 503');
  assert.equal(queue.due(T0).length, 0);
  assert.deepEqual(queue.due(T0 + RETRY_DELAYS_MS[0]).map(i => i.payload), ['payload']);
});

test('each failure waits longer, up to the longest delay', () => {
  const queue = new RetryQueue<string>();
  queue.add('m1', 'p', T0, 'e0');
  let now = T0;
  for (let i = 1; i < RETRY_DELAYS_MS.length; i++) {
    now += RETRY_DELAYS_MS[i - 1];
    assert.equal(queue.failed('m1', now, `e${i}`), 'retrying');
    assert.equal(queue.due(now + RETRY_DELAYS_MS[i] - 1).length, 0);
  }
  now += RETRY_DELAYS_MS.at(-1)!;
  assert.equal(queue.failed('m1', now, 'again'), 'retrying');
  assert.equal(queue.list()[0].nextAt, now + RETRY_DELAYS_MS.at(-1)!, 'stays at the longest delay');
});

test('an item is given up after a day, however many times it was retried by hand', () => {
  const queue = new RetryQueue<string>();
  queue.add('m1', 'p', T0, 'e0');
  for (let i = 0; i < 50; i++) assert.equal(queue.failed('m1', T0 + i * 1000, 'manual retry'), 'retrying');
  assert.equal(queue.failed('m1', T0 + GIVE_UP_AFTER_MS, 'still failing'), 'gave-up');
  assert.equal(queue.size, 0);
});

test('success removes an item, and adding the same message twice keeps the first', () => {
  const queue = new RetryQueue<string>();
  queue.add('m1', 'first', T0, 'e');
  queue.add('m1', 'second', T0 + 5, 'e');
  assert.deepEqual(queue.list().map(i => i.payload), ['first']);
  assert.equal(queue.has('m1'), true);
  queue.succeeded('m1');
  assert.equal(queue.size, 0);
  assert.equal(queue.has('m1'), false);
});

test('a full queue drops the oldest item and reports it', () => {
  const queue = new RetryQueue<string>(2);
  queue.add('a', 'A', T0, 'e');
  queue.add('b', 'B', T0 + 1, 'e');
  assert.equal(queue.add('c', 'C', T0 + 2, 'e')?.id, 'a');
  assert.deepEqual(queue.list().map(i => i.id), ['b', 'c']);
});

test('postponing does not use up an attempt; retryAllNow makes everything due', () => {
  const queue = new RetryQueue<string>();
  queue.add('a', 'A', T0, 'e');
  queue.postpone('a', T0, 120_000);
  assert.equal(queue.list()[0].attempts, 1);
  assert.equal(queue.due(T0 + 119_999).length, 0);
  queue.retryAllNow(T0);
  assert.equal(queue.due(T0).length, 1);
});

test('the queue survives a save and load', () => {
  const queue = new RetryQueue<{ n: number }>();
  queue.add('a', { n: 1 }, T0, 'e');
  const copy = new RetryQueue<{ n: number }>();
  copy.load(JSON.parse(JSON.stringify(queue.toJSON())));
  assert.deepEqual(copy.list(), queue.list());
  copy.load('garbage' as never);
  assert.equal(copy.size, 0);
});
