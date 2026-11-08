"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = void 0;
exports.onEvent = onEvent;
exports.recordEvent = recordEvent;
exports.recentEvents = recentEvents;
exports.loadEvents = loadEvents;
exports.flushEvents = flushEvents;
exports.maskPhone = maskPhone;
exports.errorText = errorText;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const pino_1 = __importDefault(require("pino"));
const config_1 = require("./config");
exports.log = (0, pino_1.default)({ level: process.env.LOG_LEVEL || 'info' });
// A short, persisted activity log so the dashboard can show why a message did or did not sync.
// Never put message bodies or tokens in here; phone numbers go through maskPhone().
const MAX_EVENTS = 300;
const EVENTS_FILE = node_path_1.default.join(config_1.DATA_DIR, 'events.json');
let events = [];
let saveTimer = null;
const listeners = [];
function onEvent(listener) {
    listeners.push(listener);
}
function recordEvent(level, message, context = {}) {
    const event = { at: new Date().toISOString(), level, message, ...context };
    if (event.detail)
        event.detail = event.detail.slice(0, 600);
    events.push(event);
    if (events.length > MAX_EVENTS)
        events.splice(0, events.length - MAX_EVENTS);
    exports.log[level](context, message);
    scheduleSave();
    for (const listener of listeners) {
        try {
            listener(event);
        }
        catch (err) {
            exports.log.warn({ err }, 'event listener failed');
        }
    }
}
function recentEvents(limit = 100) {
    return events.slice(-limit).reverse();
}
async function loadEvents() {
    try {
        const parsed = JSON.parse(await promises_1.default.readFile(EVENTS_FILE, 'utf8'));
        events = Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) : [];
    }
    catch {
        events = [];
    }
}
async function flushEvents() {
    if (saveTimer)
        clearTimeout(saveTimer);
    saveTimer = null;
    await promises_1.default.writeFile(EVENTS_FILE, JSON.stringify(events), 'utf8').catch(() => { });
}
function scheduleSave() {
    if (saveTimer)
        return;
    saveTimer = setTimeout(() => void flushEvents(), 2000);
    saveTimer.unref?.();
}
function maskPhone(phone) {
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits)
        return 'unknown';
    if (digits.length < 7)
        return '***';
    return `+${digits.slice(0, 2)}${'*'.repeat(digits.length - 6)}${digits.slice(-4)}`;
}
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
