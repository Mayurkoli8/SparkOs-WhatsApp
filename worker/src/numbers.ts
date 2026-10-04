import { registry, save, type InstanceRecord } from './store';

// A sub-account's WhatsApp numbers: permanent slots (#1, #2…), exactly one default sender, and a size limit.
export const DEFAULT_NUMBER_LIMIT = Number(process.env.NUMBERS_PER_SUBACCOUNT || 5);

const bySlot = (a: InstanceRecord, b: InstanceRecord) => (a.slot ?? Infinity) - (b.slot ?? Infinity) || a.createdAt.localeCompare(b.createdAt);

export function numbersOf(locationId: string) {
  return Object.values(registry.instances)
    .filter(i => i.locationId === locationId)
    .sort(bySlot);
}

export function limitFor(locationId: string) {
  return registry.settings.limits?.[locationId] ?? DEFAULT_NUMBER_LIMIT;
}

export async function setLimit(locationId: string, limit: number) {
  registry.settings.limits = { ...registry.settings.limits, [locationId]: Math.max(0, Math.floor(limit)) };
  await save();
}

// Slots are never reused, even after the highest number is deleted, so a saved {WA#2} cannot silently move.
export function nextSlot(locationId: string) {
  return Math.max(0, registry.settings.slotCounters?.[locationId] ?? 0, ...numbersOf(locationId).map(n => n.slot ?? 0)) + 1;
}

export function claimSlot(locationId: string) {
  const slot = nextSlot(locationId);
  registry.settings.slotCounters = { ...registry.settings.slotCounters, [locationId]: slot };
  return slot;
}

export function setDefault(id: string) {
  const target = registry.instances[id];
  if (!target) throw new Error('Number not found');
  for (const number of numbersOf(target.locationId)) number.isDefault = number.id === id;
}

// After the default number is removed, the connected (else lowest) number takes over.
export function promoteDefault(locationId: string) {
  const numbers = numbersOf(locationId);
  if (!numbers.length || numbers.some(n => n.isDefault)) return;
  (numbers.find(n => n.status === 'connected') ?? numbers[0]).isDefault = true;
}

// Older data has no slots or defaults: number them by age and pick a default per sub-account.
export function assignSlotsAndDefaults() {
  let changed = false;
  const locations = new Set(Object.values(registry.instances).map(i => i.locationId));
  for (const locationId of locations) {
    const numbers = numbersOf(locationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let next = Math.max(0, ...numbers.map(n => n.slot ?? 0)) + 1;
    for (const number of numbers) {
      if (!number.slot) {
        number.slot = next++;
        changed = true;
      }
    }
    const highest = Math.max(0, ...numbers.map(n => n.slot ?? 0));
    if ((registry.settings.slotCounters?.[locationId] ?? 0) < highest) {
      registry.settings.slotCounters = { ...registry.settings.slotCounters, [locationId]: highest };
      changed = true;
    }
    const defaults = numbers.filter(n => n.isDefault);
    if (defaults.length !== 1) {
      for (const number of numbers) number.isDefault = false;
      (defaults[0] ?? numbers.find(n => n.status === 'connected') ?? numbersOf(locationId)[0]).isDefault = true;
      changed = true;
    }
  }
  return changed;
}
