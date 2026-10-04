// Types and helpers shared by the admin dashboard components.

export type Policy = { enabled: boolean; newChatsPerDay: number; warmupDays: number; warmupNewChatsPerDay: number; coldMessagesPerContact: number };
export type Protection = {
  enabled: boolean;
  newChatsToday: number;
  // null: no limit (protection is off)
  newChatLimit: number | null;
  warmingUp: boolean;
  warmupDays: number;
  warmupDay: number | null;
  warmupDaysLeft: number;
  warmupEndsAt: number | null;
  restricted: boolean;
};
export type NumberInfo = {
  id: string;
  name: string;
  locationId: string;
  status: string;
  phone?: string;
  qr?: string | null;
  lastError?: string | null;
  slot: number | null;
  isDefault: boolean;
  linkedAt: string | null;
  restrictedUntil: number | null;
  protection: Protection;
  policy: Policy;
  overrides: Partial<Policy>;
  warmupFrom: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignMode: 'unassigned' | 'always';
};
export type Location = { locationId: string; limit: number; ghl: { connected: boolean; problem: string | null }; numbers: NumberInfo[] };
export type Check = { id: string; level: 'ok' | 'warn' | 'error'; message: string };
export type BridgeEvent = { at: string; level: 'info' | 'warn' | 'error'; message: string; detail?: string };
export type SettingsView = {
  saved: { defaultNumberLimit: number | null; failoverWaitSeconds: number | null; sendGapSeconds: number | null; protection: Partial<Policy> };
  current: { numberLimit: number; failoverWaitSeconds: number; sendGapSeconds: number; alertWebhookUrl: string | null; protection: Policy };
  builtIn: { numberLimit: number; failoverWaitSeconds: number; sendGapSeconds: number; protection: Policy };
};
export type SystemInfo = {
  uptimeSeconds: number;
  node: string;
  memory: { rssBytes: number; heapUsedBytes: number };
  host: { totalMemBytes: number; freeMemBytes: number; load: number[]; cpus: number };
  disk: { freeBytes: number; totalBytes: number } | null;
  sessions: { total: number; live: number };
};
export type PendingSync = {
  count: number;
  oldestAt: string | null;
  items: { locationId: string | null; slot: number | null; phone: string; direction: string; attempts: number; nextAt: string; lastError: string }[];
};
export type Overview = {
  urls: { callbackUrl: string; deliveryUrl: string; subaccountUrl: string };
  checks: Check[];
  worker: null | {
    build: string;
    commit: string | null;
    startedAt: string;
    providerId: string | null;
    inboundType: string;
    protection: Policy;
    settings?: SettingsView;
    system?: SystemInfo;
    pendingSync?: PendingSync;
    locations: Location[];
    events: BridgeEvent[];
  };
};
export type Run = <T>(action: () => Promise<T>) => Promise<T | undefined>;

export const STATUS_LABELS: Record<string, string> = {
  connected: 'connected',
  qr: 'scan QR',
  starting: 'starting',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  disconnected: 'disconnected',
  logged_out: 'logged out',
  qr_expired: 'QR expired',
  conflict: 'conflict',
  error: 'error'
};
export const DOWN = new Set(['logged_out', 'qr_expired', 'disconnected', 'conflict', 'error']);

export function formatPhone(digits?: string | null) {
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length === 12) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
}

export const when = (ms: number | string) => new Date(ms).toLocaleString();
export const day = (ms: number | string) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function bytes(n: number) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

export function duration(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// One line for the number list.
export function protectionText(n: NumberInfo) {
  const p = n.protection;
  if (p.restricted && n.restrictedUntil) return `Restricted by WhatsApp until ${when(n.restrictedUntil)}`;
  if (!p.enabled) return `Protection off · ${p.newChatsToday} new chats today`;
  const today = `${p.newChatsToday}/${p.newChatLimit} new chats today`;
  return p.warmingUp ? `Warming up · day ${p.warmupDay} of ${p.warmupDays} · ${today}` : today;
}

export async function call(url: string, method: string, body?: object) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) window.location.href = '/admin/login';
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
