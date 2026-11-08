"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_NUMBER_LIMIT = void 0;
exports.builtInPolicy = builtInPolicy;
exports.defaultPolicy = defaultPolicy;
exports.effectivePolicy = effectivePolicy;
exports.assigneeFor = assigneeFor;
exports.numberState = numberState;
exports.numbersOf = numbersOf;
exports.defaultNumberLimit = defaultNumberLimit;
exports.limitFor = limitFor;
exports.setLimit = setLimit;
exports.nextSlot = nextSlot;
exports.claimSlot = claimSlot;
exports.setDefault = setDefault;
exports.promoteDefault = promoteDefault;
exports.assignSlotsAndDefaults = assignSlotsAndDefaults;
const config_1 = require("./config");
const store_1 = require("./store");
// A sub-account's WhatsApp numbers: permanent slots (#1, #2…), exactly one default sender, and a size limit.
exports.DEFAULT_NUMBER_LIMIT = Number(process.env.NUMBERS_PER_SUBACCOUNT || 5);
const setFields = (value) => Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined && v !== null));
// Protection settings resolve per field: the number's own override, else the admin default, else the environment.
function builtInPolicy() {
    return {
        enabled: true,
        newChatsPerDay: config_1.NEW_CHATS_PER_DAY,
        warmupDays: config_1.WARMUP_DAYS,
        warmupNewChatsPerDay: config_1.WARMUP_NEW_CHATS_PER_DAY,
        coldMessagesPerContact: config_1.COLD_MESSAGES_PER_CONTACT
    };
}
function defaultPolicy() {
    return { ...builtInPolicy(), ...setFields(store_1.registry.settings.protectionDefaults) };
}
function effectivePolicy(instance) {
    return { ...defaultPolicy(), ...setFields(instance.protection) };
}
// The user a contact should be assigned to after talking with this number, or null to leave the contact as it is.
// Contacts that already belong to someone else are only taken over in "always" mode.
function assigneeFor(number, currentAssignee) {
    const wanted = number.assignedUserId;
    if (!wanted || currentAssignee === wanted)
        return null;
    if (currentAssignee && number.assignMode !== 'always')
        return null;
    return wanted;
}
// Warm-up counts from the link date, or from the day the admin restarted it.
function numberState(instance) {
    const from = instance.warmupFrom || instance.linkedAt;
    return { linkedAt: from ? Date.parse(from) : null, restrictedUntil: instance.restrictedUntil ?? null };
}
const bySlot = (a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity) || a.createdAt.localeCompare(b.createdAt);
function numbersOf(locationId) {
    return Object.values(store_1.registry.instances)
        .filter(i => i.locationId === locationId)
        .sort(bySlot);
}
function defaultNumberLimit() {
    return store_1.registry.settings.defaultNumberLimit ?? exports.DEFAULT_NUMBER_LIMIT;
}
function limitFor(locationId) {
    return store_1.registry.settings.limits?.[locationId] ?? defaultNumberLimit();
}
async function setLimit(locationId, limit) {
    store_1.registry.settings.limits = { ...store_1.registry.settings.limits, [locationId]: Math.max(0, Math.floor(limit)) };
    await (0, store_1.save)();
}
// Slots are never reused, even after the highest number is deleted, so a saved {WA#2} cannot silently move.
function nextSlot(locationId) {
    return Math.max(0, store_1.registry.settings.slotCounters?.[locationId] ?? 0, ...numbersOf(locationId).map(n => n.slot ?? 0)) + 1;
}
function claimSlot(locationId) {
    const slot = nextSlot(locationId);
    store_1.registry.settings.slotCounters = { ...store_1.registry.settings.slotCounters, [locationId]: slot };
    return slot;
}
function setDefault(id) {
    const target = store_1.registry.instances[id];
    if (!target)
        throw new Error('Number not found');
    for (const number of numbersOf(target.locationId))
        number.isDefault = number.id === id;
}
// After the default number is removed, the connected (else lowest) number takes over.
function promoteDefault(locationId) {
    const numbers = numbersOf(locationId);
    if (!numbers.length || numbers.some(n => n.isDefault))
        return;
    (numbers.find(n => n.status === 'connected') ?? numbers[0]).isDefault = true;
}
// Older data has no slots or defaults: number them by age and pick a default per sub-account.
function assignSlotsAndDefaults() {
    let changed = false;
    const locations = new Set(Object.values(store_1.registry.instances).map(i => i.locationId));
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
        if ((store_1.registry.settings.slotCounters?.[locationId] ?? 0) < highest) {
            store_1.registry.settings.slotCounters = { ...store_1.registry.settings.slotCounters, [locationId]: highest };
            changed = true;
        }
        const defaults = numbers.filter(n => n.isDefault);
        if (defaults.length !== 1) {
            for (const number of numbers)
                number.isDefault = false;
            (defaults[0] ?? numbers.find(n => n.status === 'connected') ?? numbersOf(locationId)[0]).isDefault = true;
            changed = true;
        }
    }
    return changed;
}
