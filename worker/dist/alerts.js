"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlertGate = void 0;
exports.alertKey = alertKey;
exports.sendAlert = sendAlert;
exports.sendTestAlert = sendTestAlert;
exports.startAlerts = startAlerts;
const events_1 = require("./events");
const safe_fetch_1 = require("./safe-fetch");
const store_1 = require("./store");
// Problems are pushed to the admin's webhook (a HighLevel workflow "Inbound Webhook" trigger, Slack, Zapier…) so a
// disconnected or restricted number is noticed right away instead of on the next dashboard visit.
class AlertGate {
    quietMs;
    perHour;
    last = new Map();
    sent = [];
    constructor(quietMs = 30 * 60_000, perHour = 20) {
        this.quietMs = quietMs;
        this.perHour = perHour;
    }
    allow(key, now) {
        const previous = this.last.get(key);
        if (previous !== undefined && now - previous < this.quietMs)
            return false;
        this.sent = this.sent.filter(at => now - at < 3600_000);
        if (this.sent.length >= this.perHour)
            return false;
        this.last.set(key, now);
        this.sent.push(now);
        if (this.last.size > 1000)
            this.last.delete(this.last.keys().next().value);
        return true;
    }
}
exports.AlertGate = AlertGate;
// Repeats that differ only in phone numbers, counts or times count as the same alert.
function alertKey(event) {
    return `${event.locationId ?? ''}|${event.instanceId ?? ''}|${event.message.replace(/[+*\d][\d*:.TZ-]*/g, '#').slice(0, 100)}`;
}
const gate = new AlertGate();
function numberFor(instanceId) {
    const instance = instanceId ? store_1.registry.instances[instanceId] : undefined;
    return instance ? { slot: instance.slot ?? null, name: instance.name } : null;
}
function alertBody(event) {
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
function sendAlert(event) {
    const url = store_1.registry.settings.alertWebhookUrl;
    if (!url || !gate.allow(alertKey(event), Date.now()))
        return;
    (0, safe_fetch_1.postPublicJson)(url, alertBody(event)).catch(err => events_1.log.warn({ err: err instanceof Error ? err.message : err }, 'Alert webhook failed'));
}
async function sendTestAlert() {
    const url = store_1.registry.settings.alertWebhookUrl;
    if (!url)
        throw new Error('Set an alert webhook URL first');
    await (0, safe_fetch_1.postPublicJson)(url, alertBody({ level: 'info', message: 'Test alert from SparkWA', at: new Date().toISOString() }));
}
function startAlerts() {
    (0, events_1.onEvent)(event => {
        if (event.level === 'error')
            sendAlert(event);
    });
}
