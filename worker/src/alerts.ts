import { log, onEvent, type BridgeEvent } from './events';
import { postPublicJson } from './safe-fetch';
import { registry } from './store';

// Problems are pushed to the admin's webhook (a HighLevel workflow "Inbound Webhook" trigger, Slack, Zapier…) so a
// disconnected or restricted number is noticed right away instead of on the next dashboard visit.
export class AlertGate {
  private last = new Map<string, number>();
  private sent: number[] = [];

  constructor(
    private readonly quietMs = 30 * 60_000,
    private readonly perHour = 20
  ) {}

  allow(key: string, now: number) {
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < this.quietMs) return false;
    this.sent = this.sent.filter(at => now - at < 3600_000);
    if (this.sent.length >= this.perHour) return false;
    this.last.set(key, now);
    this.sent.push(now);
    if (this.last.size > 1000) this.last.delete(this.last.keys().next().value as string);
    return true;
  }
}

// Repeats that differ only in phone numbers, counts or times count as the same alert.
export function alertKey(event: Pick<BridgeEvent, 'locationId' | 'instanceId' | 'message'>) {
  return `${event.locationId ?? ''}|${event.instanceId ?? ''}|${event.message.replace(/[+*\d][\d*:.TZ-]*/g, '#').slice(0, 100)}`;
}

const gate = new AlertGate();

function numberFor(instanceId?: string) {
  const instance = instanceId ? registry.instances[instanceId] : undefined;
  return instance ? { slot: instance.slot ?? null, name: instance.name } : null;
}

function alertBody(event: Pick<BridgeEvent, 'level' | 'message' | 'detail' | 'locationId' | 'instanceId' | 'at'>) {
  return {
    source: 'SparkWA',
    level: event.level,
    message: event.message,
    detail: event.detail ?? null,
    locationId: event.locationId ?? null,
    number: numberFor(event.instanceId),
    at: event.at
  };
}

export function sendAlert(event: BridgeEvent) {
  const url = registry.settings.alertWebhookUrl;
  if (!url || !gate.allow(alertKey(event), Date.now())) return;
  postPublicJson(url, alertBody(event)).catch(err => log.warn({ err: err instanceof Error ? err.message : err }, 'Alert webhook failed'));
}

export async function sendTestAlert() {
  const url = registry.settings.alertWebhookUrl;
  if (!url) throw new Error('Set an alert webhook URL first');
  await postPublicJson(url, alertBody({ level: 'info', message: 'Test alert from SparkWA', at: new Date().toISOString() }));
}

export function startAlerts() {
  onEvent(event => {
    if (event.level === 'error') sendAlert(event);
  });
}
