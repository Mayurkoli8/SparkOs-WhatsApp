import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtectionBook, typingDelayMs, type ProtectionPolicy } from '../src/protection';

const policy: ProtectionPolicy = { newChatsPerDay: 3, warmupDays: 7, warmupNewChatsPerDay: 1, coldMessagesPerContact: 2 };
const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 9, 5, 12);
const established = { linkedAt: T0 - 30 * DAY, restrictedUntil: null };

test('contacts who wrote first are always allowed', () => {
  const book = new ProtectionBook(policy);
  book.markInbound('n1', '911', T0);
  for (let i = 0; i < 10; i++) assert.equal(book.check('n1', '911', established, T0).allowed, true);
});

test('new conversations are capped per day and the cap resets after 24 hours', () => {
  const book = new ProtectionBook(policy);
  for (const c of ['a', 'b', 'c']) {
    assert.equal(book.check('n1', c, established, T0).allowed, true);
    book.recordSend('n1', c, T0);
  }
  const blocked = book.check('n1', 'd', established, T0);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /3 new conversations/);
  assert.equal(book.check('n1', 'd', established, T0 + DAY + 1).allowed, true);
});

test('a contact already started today does not count twice', () => {
  const book = new ProtectionBook(policy);
  book.recordSend('n1', 'a', T0);
  assert.equal(book.stats('n1', established, T0).newChatsToday, 1);
  assert.equal(book.check('n1', 'a', established, T0).allowed, true);
  book.recordSend('n1', 'a', T0);
  assert.equal(book.stats('n1', established, T0).newChatsToday, 1);
});

test('contacts who never reply only get a few messages', () => {
  const book = new ProtectionBook(policy);
  book.recordSend('n1', 'a', T0);
  book.recordSend('n1', 'a', T0 + 1000);
  const blocked = book.check('n1', 'a', established, T0 + 2000);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /has not replied/);
  book.markInbound('n1', 'a', T0 + 3000);
  assert.equal(book.check('n1', 'a', established, T0 + 4000).allowed, true);
});

test('newly linked numbers warm up with a lower cap', () => {
  const book = new ProtectionBook(policy);
  const fresh = { linkedAt: T0 - 2 * DAY, restrictedUntil: null };
  book.recordSend('n1', 'a', T0);
  const blocked = book.check('n1', 'b', fresh, T0);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /warming up/);
  assert.equal(book.stats('n1', fresh, T0).newChatLimit, 1);
});

test('a restricted number may continue chats but not start new ones', () => {
  const book = new ProtectionBook(policy);
  book.markInbound('n1', 'warm', T0);
  const restricted = { linkedAt: T0 - 30 * DAY, restrictedUntil: T0 + DAY };
  assert.equal(book.check('n1', 'warm', restricted, T0).allowed, true);
  const cold = book.check('n1', 'cold', restricted, T0);
  assert.equal(cold.allowed, false);
  assert.match(cold.reason!, /restricted/);
  assert.equal(book.check('n1', 'cold', restricted, T0 + DAY + 1).allowed, true);
});

test('the book survives a save and load', () => {
  const book = new ProtectionBook(policy);
  book.markInbound('n1', 'warm', T0);
  book.recordSend('n1', 'cold', T0);
  const copy = new ProtectionBook(policy);
  copy.load(JSON.parse(JSON.stringify(book.toJSON())));
  assert.equal(copy.check('n1', 'warm', established, T0).allowed, true);
  assert.equal(copy.stats('n1', established, T0).newChatsToday, 1);
});

test('typing delay grows with the message but stays human-sized', () => {
  assert.ok(typingDelayMs('ok', () => 0) >= 800);
  assert.ok(typingDelayMs('x'.repeat(5000), () => 0.99) <= 6000);
  assert.ok(typingDelayMs('x'.repeat(100), () => 0) > typingDelayMs('x', () => 0));
});
