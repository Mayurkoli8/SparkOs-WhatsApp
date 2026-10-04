import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWaTag, parseRouteToken, parseWaTag, routeCandidates, type RouteNumber } from '../src/routing';

const numbers: RouteNumber[] = [
  { id: 'a', slot: 1, name: 'Sales', phone: '919000000001', isDefault: false },
  { id: 'b', slot: 2, name: 'Support', phone: '919000000002', isDefault: true },
  { id: 'c', slot: 3, name: 'Backup', phone: '919000000003', isDefault: false }
];

test('parseRouteToken understands slot, name and phone tokens and strips them', () => {
  assert.deepEqual(parseRouteToken('Hi {WA#2} there'), { token: { kind: 'slot', value: '2' }, text: 'Hi there' });
  assert.deepEqual(parseRouteToken('{ WA#3 }Hello'), { token: { kind: 'slot', value: '3' }, text: 'Hello' });
  assert.deepEqual(parseRouteToken('Hello {WA:Sales}'), { token: { kind: 'name', value: 'Sales' }, text: 'Hello' });
  assert.deepEqual(parseRouteToken('{wa:+91 90000 00002} ok'), { token: { kind: 'phone', value: '919000000002' }, text: 'ok' });
  assert.deepEqual(parseRouteToken('No token here'), { token: null, text: 'No token here' });
});

test('wa tags are formatted and parsed consistently', () => {
  assert.equal(formatWaTag('919000000002'), 'wa: +919000000002');
  assert.equal(parseWaTag(['vip', 'wa: +919000000002']), '919000000002');
  assert.equal(parseWaTag(['WA:+919000000003']), '919000000003');
  assert.equal(parseWaTag(['customer']), null);
});

test('routeCandidates: an explicit token wins, then the contact tag, then the default, then the rest', () => {
  assert.deepEqual(routeCandidates(numbers, { token: { kind: 'slot', value: '3' } }).map(n => n.id), ['c', 'b', 'a']);
  assert.deepEqual(routeCandidates(numbers, { token: { kind: 'name', value: 'sales' } }).map(n => n.id), ['a', 'b', 'c']);
  assert.deepEqual(routeCandidates(numbers, { taggedPhone: '919000000003' }).map(n => n.id), ['c', 'b', 'a']);
  assert.deepEqual(routeCandidates(numbers, {}).map(n => n.id), ['b', 'a', 'c']);
});

test('routeCandidates: an unknown token is reported, an unknown tag falls back to the default', () => {
  assert.throws(() => routeCandidates(numbers, { token: { kind: 'slot', value: '9' } }), /No WhatsApp number #9/);
  assert.deepEqual(routeCandidates(numbers, { taggedPhone: '15550000000' }).map(n => n.id), ['b', 'a', 'c']);
});

test('without a default the lowest slot leads', () => {
  const noDefault = numbers.map(n => ({ ...n, isDefault: false }));
  assert.deepEqual(routeCandidates(noDefault, {}).map(n => n.id), ['a', 'b', 'c']);
});
