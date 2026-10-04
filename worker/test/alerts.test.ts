import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertGate, alertKey } from '../src/alerts';

const T0 = Date.UTC(2026, 9, 5, 12);

test('the same alert is sent once per quiet period', () => {
  const gate = new AlertGate(30 * 60_000, 20);
  assert.equal(gate.allow('k', T0), true);
  assert.equal(gate.allow('k', T0 + 60_000), false);
  assert.equal(gate.allow('other', T0 + 60_000), true);
  assert.equal(gate.allow('k', T0 + 30 * 60_000), true);
});

test('no more than the hourly cap of alerts is sent', () => {
  const gate = new AlertGate(0, 3);
  assert.deepEqual([1, 2, 3, 4].map(i => gate.allow(`k${i}`, T0 + i)), [true, true, true, false]);
  assert.equal(gate.allow('k5', T0 + 3600_001), true);
});

test('alert keys group repeats that differ only in numbers', () => {
  const a = alertKey({ locationId: 'L1', message: 'HighLevel message not delivered to WhatsApp: +91******1234 is not registered on WhatsApp' });
  const b = alertKey({ locationId: 'L1', message: 'HighLevel message not delivered to WhatsApp: +44******9876 is not registered on WhatsApp' });
  assert.equal(a, b);
  assert.notEqual(a, alertKey({ locationId: 'L2', message: 'HighLevel message not delivered to WhatsApp: +44******9876 is not registered on WhatsApp' }));
});
