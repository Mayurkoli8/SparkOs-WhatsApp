import fs from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import { DATA_DIR } from './config';

export const log = pino({ level: process.env.LOG_LEVEL || 'info' });

export type EventLevel = 'info' | 'warn' | 'error';
export type BridgeEvent = {
  at: string;
  level: EventLevel;
  message: string;
  locationId?: string;
  instanceId?: string;
  detail?: string;
};

// A short, persisted activity log so the dashboard can show why a message did or did not sync.
// Never put message bodies or tokens in here; phone numbers go through maskPhone().
const MAX_EVENTS = 300;
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
let events: BridgeEvent[] = [];
let saveTimer: NodeJS.Timeout | null = null;
const listeners: ((event: BridgeEvent) => void)[] = [];

export function onEvent(listener: (event: BridgeEvent) => void) {
  listeners.push(listener);
}

export function recordEvent(level: EventLevel, message: string, context: Omit<BridgeEvent, 'at' | 'level' | 'message'> = {}) {
  const event: BridgeEvent = { at: new Date().toISOString(), level, message, ...context };
  if (event.detail) event.detail = event.detail.slice(0, 600);
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  log[level](context, message);
  scheduleSave();
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn({ err }, 'event listener failed');
    }
  }
}

export function recentEvents(limit = 100) {
  return events.slice(-limit).reverse();
}

export async function loadEvents() {
  try {
    const parsed = JSON.parse(await fs.readFile(EVENTS_FILE, 'utf8'));
    events = Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) : [];
  } catch {
    events = [];
  }
}

export async function flushEvents() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await fs.writeFile(EVENTS_FILE, JSON.stringify(events), 'utf8').catch(() => {});
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => void flushEvents(), 2000);
  saveTimer.unref?.();
}

export function maskPhone(phone?: string | null) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return 'unknown';
  if (digits.length < 7) return '***';
  return `+${digits.slice(0, 2)}${'*'.repeat(digits.length - 6)}${digits.slice(-4)}`;
}

export function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
