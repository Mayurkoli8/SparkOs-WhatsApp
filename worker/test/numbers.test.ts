import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, registry, type InstanceRecord } from '../src/store';
import { assignSlotsAndDefaults, claimSlot, limitFor, nextSlot, numbersOf, promoteDefault, setDefault } from '../src/numbers';

const instance = (id: string, locationId: string, createdAt: string, extra: Partial<InstanceRecord> = {}): InstanceRecord => ({
  id,
  name: id,
  locationId,
  status: 'disconnected',
  createdAt,
  ...extra
});

beforeEach(async () => {
  await loadRegistry();
  registry.instances = {};
  registry.settings = {};
});

test('existing numbers get stable slots by age and one default per sub-account', () => {
  registry.instances = {
    late: instance('late', 'L1', '2026-10-03T00:00:00Z'),
    early: instance('early', 'L1', '2026-10-01T00:00:00Z', { status: 'connected' }),
    other: instance('other', 'L2', '2026-10-02T00:00:00Z')
  };
  assert.equal(assignSlotsAndDefaults(), true);
  assert.deepEqual(numbersOf('L1').map(n => [n.id, n.slot, n.isDefault]), [['early', 1, true], ['late', 2, false]]);
  assert.deepEqual(numbersOf('L2').map(n => [n.id, n.slot, n.isDefault]), [['other', 1, true]]);
  assert.equal(assignSlotsAndDefaults(), false, 'running it again changes nothing');
});

test('new numbers take the next slot and slots are never reused', () => {
  registry.instances = {
    a: instance('a', 'L1', '2026-10-01T00:00:00Z', { slot: 1, isDefault: true }),
    c: instance('c', 'L1', '2026-10-02T00:00:00Z', { slot: 3 })
  };
  assert.equal(nextSlot('L1'), 4);
  assert.equal(nextSlot('L9'), 1);
});

test('deleting the highest number does not free its slot for the next one', () => {
  registry.instances = { a: instance('a', 'L1', '2026-10-01T00:00:00Z', { slot: 1, isDefault: true }) };
  assert.equal(claimSlot('L1'), 2);
  registry.instances.b = instance('b', 'L1', '2026-10-02T00:00:00Z', { slot: 2 });
  delete registry.instances.b;
  assert.equal(claimSlot('L1'), 3);
});

test('numbers created before slot counters existed still never have their slot reused', () => {
  registry.instances = {
    a: instance('a', 'L1', '2026-10-01T00:00:00Z', { slot: 1, isDefault: true }),
    b: instance('b', 'L1', '2026-10-02T00:00:00Z', { slot: 2 })
  };
  assignSlotsAndDefaults();
  delete registry.instances.b;
  assert.equal(claimSlot('L1'), 3);
});

test('setting a default clears the previous one; deleting the default promotes another', () => {
  registry.instances = {
    a: instance('a', 'L1', '2026-10-01T00:00:00Z', { slot: 1, isDefault: true }),
    b: instance('b', 'L1', '2026-10-02T00:00:00Z', { slot: 2 })
  };
  setDefault('b');
  assert.deepEqual(numbersOf('L1').map(n => n.isDefault), [false, true]);
  delete registry.instances.b;
  promoteDefault('L1');
  assert.equal(registry.instances.a.isDefault, true);
});

test('each sub-account has a number limit, 5 unless set', () => {
  assert.equal(limitFor('L1'), 5);
  registry.settings.limits = { L1: 8 };
  assert.equal(limitFor('L1'), 8);
});
