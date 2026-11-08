import { FAILOVER_WAIT_MS, SEND_INTERVAL_MS } from './config';
import { builtInPolicy, DEFAULT_NUMBER_LIMIT, defaultNumberLimit, defaultPolicy } from './numbers';
import type { ProtectionPolicy } from './protection';
import { registry, save, type Settings } from './store';

// Validation for everything the admin can change. Values outside these ranges are refused, never clamped.
export class InputError extends Error {}

type PolicyNumber = Exclude<keyof ProtectionPolicy, 'enabled'>;
const POLICY_FIELDS: Record<PolicyNumber, { label: string; min: number; max: number }> = {
  newChatsPerDay: { label: 'New chats per day', min: 0, max: 1000 },
  warmupDays: { label: 'Warm-up days', min: 0, max: 90 },
  warmupNewChatsPerDay: { label: 'New chats per day while warming up', min: 0, max: 1000 },
  coldMessagesPerContact: { label: 'Messages to a contact who has not replied', min: 1, max: 50 }
};

// null puts a field back to its default; fields that are not given stay as they are.
export type PolicyPatch = { [K in keyof ProtectionPolicy]?: ProtectionPolicy[K] | null };
export type SettingsPatch = {
  defaultNumberLimit?: number | null;
  failoverWaitSeconds?: number | null;
  sendGapSeconds?: number | null;
  alertWebhookUrl?: string | null;
  protectionDefaults?: PolicyPatch;
};

const isBlank = (value: unknown) => value === null || (typeof value === 'string' && value.trim() === '');

function numberIn(value: unknown, label: string, min: number, max: number, whole: boolean) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || (whole && !Number.isInteger(n)) || n < min || n > max) {
    throw new InputError(`${label} must be a ${whole ? 'whole number' : 'number'} from ${min} to ${max}`);
  }
  return n;
}

export function parsePolicyPatch(input: unknown): PolicyPatch {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('protection must be an object');
  const source = input as Record<string, unknown>;
  const patch: PolicyPatch = {};
  if (source.enabled !== undefined) {
    if (source.enabled !== null && typeof source.enabled !== 'boolean') throw new InputError('enabled must be true, false or null');
    patch.enabled = source.enabled;
  }
  for (const [key, { label, min, max }] of Object.entries(POLICY_FIELDS) as [PolicyNumber, (typeof POLICY_FIELDS)[PolicyNumber]][]) {
    if (source[key] === undefined) continue;
    patch[key] = isBlank(source[key]) ? null : numberIn(source[key], label, min, max, true);
  }
  return patch;
}

export function applyPolicyPatch(current: Partial<ProtectionPolicy> | undefined, patch: PolicyPatch): Partial<ProtectionPolicy> | undefined {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return Object.keys(next).length ? (next as Partial<ProtectionPolicy>) : undefined;
}

function webhookUrl(value: unknown) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') throw new InputError('Alert webhook must be a URL');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InputError('Alert webhook must be a URL');
  }
  if (url.protocol !== 'https:') throw new InputError('Alert webhook must be an https:// URL');
  return url.toString();
}

export function parseSettingsPatch(input: unknown): SettingsPatch {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('settings must be an object');
  const source = input as Record<string, unknown>;
  const patch: SettingsPatch = {};
  const optional = (key: 'defaultNumberLimit' | 'failoverWaitSeconds' | 'sendGapSeconds', label: string, min: number, max: number, whole: boolean) => {
    if (source[key] !== undefined) patch[key] = isBlank(source[key]) ? null : numberIn(source[key], label, min, max, whole);
  };
  optional('defaultNumberLimit', 'Numbers per sub-account', 0, 100, true);
  optional('failoverWaitSeconds', 'Failover wait', 0, 900, true);
  optional('sendGapSeconds', 'Gap between messages', 0, 120, false);
  if (source.alertWebhookUrl !== undefined) patch.alertWebhookUrl = webhookUrl(source.alertWebhookUrl);
  if (source.protectionDefaults !== undefined) patch.protectionDefaults = parsePolicyPatch(source.protectionDefaults);
  return patch;
}

const POLICY_WORDS: Record<keyof ProtectionPolicy, string> = {
  enabled: 'protection',
  warmupDays: 'warm-up days',
  warmupNewChatsPerDay: 'new chats a day while warming up',
  newChatsPerDay: 'new chats a day',
  coldMessagesPerContact: 'messages without a reply'
};

// Plain words for the activity log.
export function describePolicyPatch(patch: PolicyPatch) {
  return Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${POLICY_WORDS[key as keyof ProtectionPolicy]} ${value === null ? 'back to default' : value === true ? 'on' : value === false ? 'off' : value}`);
}

// The webhook URL itself is never logged: it often carries a secret token.
export function describeSettingsPatch(patch: SettingsPatch) {
  const parts: string[] = [];
  const value = (v: number | null | undefined, unit = '') => (v === null ? 'back to default' : `${v}${unit}`);
  if (patch.failoverWaitSeconds !== undefined) parts.push(`failover wait ${value(patch.failoverWaitSeconds, ' s')}`);
  if (patch.sendGapSeconds !== undefined) parts.push(`gap between messages ${value(patch.sendGapSeconds, ' s')}`);
  if (patch.defaultNumberLimit !== undefined) parts.push(`numbers per sub-account ${value(patch.defaultNumberLimit)}`);
  if (patch.alertWebhookUrl !== undefined) parts.push(patch.alertWebhookUrl ? 'alert webhook set' : 'alert webhook removed');
  if (patch.protectionDefaults) parts.push(...describePolicyPatch(patch.protectionDefaults).map(p => `default ${p}`));
  return parts.join(', ');
}

export async function updateSettings(patch: SettingsPatch) {
  const settings: Settings = registry.settings;
  for (const key of ['defaultNumberLimit', 'failoverWaitSeconds', 'sendGapSeconds', 'alertWebhookUrl'] as const) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null) delete settings[key];
    else (settings as Record<string, unknown>)[key] = patch[key];
  }
  if (patch.protectionDefaults) {
    settings.protectionDefaults = applyPolicyPatch(settings.protectionDefaults, patch.protectionDefaults);
    if (!settings.protectionDefaults) delete settings.protectionDefaults;
  }
  await save();
}

export function failoverWaitMs() {
  return registry.settings.failoverWaitSeconds !== undefined ? registry.settings.failoverWaitSeconds * 1000 : FAILOVER_WAIT_MS;
}

export function sendGapMs() {
  return registry.settings.sendGapSeconds !== undefined ? registry.settings.sendGapSeconds * 1000 : SEND_INTERVAL_MS;
}

// What the admin sees: the values in force, what the admin saved, and the environment defaults behind them.
export function settingsView() {
  const settings = registry.settings;
  return {
    saved: {
      defaultNumberLimit: settings.defaultNumberLimit ?? null,
      failoverWaitSeconds: settings.failoverWaitSeconds ?? null,
      sendGapSeconds: settings.sendGapSeconds ?? null,
      protection: settings.protectionDefaults ?? {}
    },
    current: {
      numberLimit: defaultNumberLimit(),
      failoverWaitSeconds: failoverWaitMs() / 1000,
      sendGapSeconds: sendGapMs() / 1000,
      alertWebhookUrl: registry.settings.alertWebhookUrl || null,
      protection: defaultPolicy()
    },
    builtIn: {
      numberLimit: DEFAULT_NUMBER_LIMIT,
      failoverWaitSeconds: FAILOVER_WAIT_MS / 1000,
      sendGapSeconds: SEND_INTERVAL_MS / 1000,
      protection: builtInPolicy()
    }
  };
}
