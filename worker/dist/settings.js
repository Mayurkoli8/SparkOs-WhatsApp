"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputError = void 0;
exports.parsePolicyPatch = parsePolicyPatch;
exports.applyPolicyPatch = applyPolicyPatch;
exports.parseSettingsPatch = parseSettingsPatch;
exports.describePolicyPatch = describePolicyPatch;
exports.describeSettingsPatch = describeSettingsPatch;
exports.updateSettings = updateSettings;
exports.failoverWaitMs = failoverWaitMs;
exports.sendGapMs = sendGapMs;
exports.settingsView = settingsView;
const config_1 = require("./config");
const numbers_1 = require("./numbers");
const store_1 = require("./store");
// Validation for everything the admin can change. Values outside these ranges are refused, never clamped.
class InputError extends Error {
}
exports.InputError = InputError;
const POLICY_FIELDS = {
    newChatsPerDay: { label: 'New chats per day', min: 0, max: 1000 },
    warmupDays: { label: 'Warm-up days', min: 0, max: 90 },
    warmupNewChatsPerDay: { label: 'New chats per day while warming up', min: 0, max: 1000 },
    coldMessagesPerContact: { label: 'Messages to a contact who has not replied', min: 1, max: 50 }
};
const isBlank = (value) => value === null || (typeof value === 'string' && value.trim() === '');
function numberIn(value, label, min, max, whole) {
    const n = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || (whole && !Number.isInteger(n)) || n < min || n > max) {
        throw new InputError(`${label} must be a ${whole ? 'whole number' : 'number'} from ${min} to ${max}`);
    }
    return n;
}
function parsePolicyPatch(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
        throw new InputError('protection must be an object');
    const source = input;
    const patch = {};
    if (source.enabled !== undefined) {
        if (source.enabled !== null && typeof source.enabled !== 'boolean')
            throw new InputError('enabled must be true, false or null');
        patch.enabled = source.enabled;
    }
    for (const [key, { label, min, max }] of Object.entries(POLICY_FIELDS)) {
        if (source[key] === undefined)
            continue;
        patch[key] = isBlank(source[key]) ? null : numberIn(source[key], label, min, max, true);
    }
    return patch;
}
function applyPolicyPatch(current, patch) {
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null)
            delete next[key];
        else if (value !== undefined)
            next[key] = value;
    }
    return Object.keys(next).length ? next : undefined;
}
function webhookUrl(value) {
    if (isBlank(value))
        return null;
    if (typeof value !== 'string')
        throw new InputError('Alert webhook must be a URL');
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new InputError('Alert webhook must be a URL');
    }
    if (url.protocol !== 'https:')
        throw new InputError('Alert webhook must be an https:// URL');
    return url.toString();
}
function parseSettingsPatch(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
        throw new InputError('settings must be an object');
    const source = input;
    const patch = {};
    const optional = (key, label, min, max, whole) => {
        if (source[key] !== undefined)
            patch[key] = isBlank(source[key]) ? null : numberIn(source[key], label, min, max, whole);
    };
    optional('defaultNumberLimit', 'Numbers per sub-account', 0, 100, true);
    optional('failoverWaitSeconds', 'Failover wait', 0, 900, true);
    optional('sendGapSeconds', 'Gap between messages', 0, 120, false);
    if (source.alertWebhookUrl !== undefined)
        patch.alertWebhookUrl = webhookUrl(source.alertWebhookUrl);
    if (source.protectionDefaults !== undefined)
        patch.protectionDefaults = parsePolicyPatch(source.protectionDefaults);
    return patch;
}
const POLICY_WORDS = {
    enabled: 'protection',
    warmupDays: 'warm-up days',
    warmupNewChatsPerDay: 'new chats a day while warming up',
    newChatsPerDay: 'new chats a day',
    coldMessagesPerContact: 'messages without a reply'
};
// Plain words for the activity log.
function describePolicyPatch(patch) {
    return Object.entries(patch)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${POLICY_WORDS[key]} ${value === null ? 'back to default' : value === true ? 'on' : value === false ? 'off' : value}`);
}
// The webhook URL itself is never logged: it often carries a secret token.
function describeSettingsPatch(patch) {
    const parts = [];
    const value = (v, unit = '') => (v === null ? 'back to default' : `${v}${unit}`);
    if (patch.failoverWaitSeconds !== undefined)
        parts.push(`failover wait ${value(patch.failoverWaitSeconds, ' s')}`);
    if (patch.sendGapSeconds !== undefined)
        parts.push(`gap between messages ${value(patch.sendGapSeconds, ' s')}`);
    if (patch.defaultNumberLimit !== undefined)
        parts.push(`numbers per sub-account ${value(patch.defaultNumberLimit)}`);
    if (patch.alertWebhookUrl !== undefined)
        parts.push(patch.alertWebhookUrl ? 'alert webhook set' : 'alert webhook removed');
    if (patch.protectionDefaults)
        parts.push(...describePolicyPatch(patch.protectionDefaults).map(p => `default ${p}`));
    return parts.join(', ');
}
async function updateSettings(patch) {
    const settings = store_1.registry.settings;
    for (const key of ['defaultNumberLimit', 'failoverWaitSeconds', 'sendGapSeconds', 'alertWebhookUrl']) {
        if (patch[key] === undefined)
            continue;
        if (patch[key] === null)
            delete settings[key];
        else
            settings[key] = patch[key];
    }
    if (patch.protectionDefaults) {
        settings.protectionDefaults = applyPolicyPatch(settings.protectionDefaults, patch.protectionDefaults);
        if (!settings.protectionDefaults)
            delete settings.protectionDefaults;
    }
    await (0, store_1.save)();
}
function failoverWaitMs() {
    return store_1.registry.settings.failoverWaitSeconds !== undefined ? store_1.registry.settings.failoverWaitSeconds * 1000 : config_1.FAILOVER_WAIT_MS;
}
function sendGapMs() {
    return store_1.registry.settings.sendGapSeconds !== undefined ? store_1.registry.settings.sendGapSeconds * 1000 : config_1.SEND_INTERVAL_MS;
}
// What the admin sees: the values in force, what the admin saved, and the environment defaults behind them.
function settingsView() {
    const settings = store_1.registry.settings;
    return {
        saved: {
            defaultNumberLimit: settings.defaultNumberLimit ?? null,
            failoverWaitSeconds: settings.failoverWaitSeconds ?? null,
            sendGapSeconds: settings.sendGapSeconds ?? null,
            protection: settings.protectionDefaults ?? {}
        },
        current: {
            numberLimit: (0, numbers_1.defaultNumberLimit)(),
            failoverWaitSeconds: failoverWaitMs() / 1000,
            sendGapSeconds: sendGapMs() / 1000,
            alertWebhookUrl: store_1.registry.settings.alertWebhookUrl || null,
            protection: (0, numbers_1.defaultPolicy)()
        },
        builtIn: {
            numberLimit: numbers_1.DEFAULT_NUMBER_LIMIT,
            failoverWaitSeconds: config_1.FAILOVER_WAIT_MS / 1000,
            sendGapSeconds: config_1.SEND_INTERVAL_MS / 1000,
            protection: (0, numbers_1.builtInPolicy)()
        }
    };
}
