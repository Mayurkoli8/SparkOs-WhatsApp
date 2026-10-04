"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.protection = void 0;
exports.loadProtection = loadProtection;
exports.flushProtection = flushProtection;
exports.loadPendingSync = loadPendingSync;
exports.flushPendingSync = flushPendingSync;
exports.pendingSyncSummary = pendingSyncSummary;
exports.retryPendingNow = retryPendingNow;
exports.authDir = authDir;
exports.updateInstance = updateInstance;
exports.isLive = isLive;
exports.startInstance = startInstance;
exports.resumeInstances = resumeInstances;
exports.deleteInstance = deleteInstance;
exports.shutdown = shutdown;
exports.handleProviderOutbound = handleProviderOutbound;
exports.sendDirect = sendDirect;
exports.recheckRestriction = recheckRestriction;
exports.startBackgroundJobs = startBackgroundJobs;
exports.sessionCounts = sessionCounts;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const qrcode_1 = __importDefault(require("qrcode"));
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const config_1 = require("./config");
const events_1 = require("./events");
const ghl = __importStar(require("./ghl"));
const numbers_1 = require("./numbers");
const protection_1 = require("./protection");
const retry_queue_1 = require("./retry-queue");
const routing_1 = require("./routing");
const safe_fetch_1 = require("./safe-fetch");
const settings_1 = require("./settings");
const store_1 = require("./store");
const wa_message_1 = require("./wa-message");
const baileysLogger = events_1.log.child({ module: 'baileys' }, { level: process.env.BAILEYS_LOG_LEVEL || 'warn' });
class BoundedMap extends Map {
    limit;
    constructor(limit) {
        super();
        this.limit = limit;
    }
    set(key, value) {
        if (this.has(key))
            this.delete(key);
        super.set(key, value);
        if (this.size > this.limit)
            this.delete(this.keys().next().value);
        return this;
    }
}
const sessions = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const replacedCount = new Map();
const instanceLocks = new Map();
let shuttingDown = false;
// WhatsApp message id -> the HighLevel message it delivers, so receipts can update the GHL status.
const deliveries = new BoundedMap(5000);
// Copies of what we sent; Baileys needs them to re-encrypt when a recipient asks for a retry.
const sentMessages = new BoundedMap(1000);
const seenMessages = new BoundedMap(5000);
// assignedTo: the contact's HighLevel owner as last seen (or set) by the bridge.
const contactCache = new BoundedMap(5000);
const numberCache = new BoundedMap(5000);
// Phone-typed messages we mirrored into GHL; if GHL ever echoes one to the delivery URL it must not be re-sent.
const mirroredGhlIds = new BoundedMap(5000);
const recentPhoneSends = new BoundedMap(1000);
const mirrorChecked = new Set();
const mirrorDisabled = new Set();
const chatQueues = new Map();
const sendQueues = new Map();
// Number id + contact phone -> the contact's messages we have not marked as read yet (read before replying, like a person).
const unread = new BoundedMap(5000);
// Location + contact id -> the number their "wa:" tag points at, so the tag is only rewritten when it changes.
const tagCache = new BoundedMap(5000);
// HighLevel message ids already handed to WhatsApp, so a repeated delivery webhook never sends a message twice.
const handledDeliveries = new BoundedMap(5000);
const CONTACT_CACHE_MS = 6 * 3600_000;
const TAG_CACHE_MS = 15 * 60_000;
const OFFLINE_WINDOW_MS = 48 * 3600_000;
const ECHO_WINDOW_MS = 2 * 60_000;
const RESTRICTION_FALLBACK_MS = 24 * 3600_000;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Every check passes the number's own policy (effectivePolicy); the built-in one is only the fallback.
exports.protection = new protection_1.ProtectionBook((0, numbers_1.builtInPolicy)());
const PROTECTION_FILE = node_path_1.default.join(config_1.DATA_DIR, 'protection.json');
let protectionTimer = null;
async function loadProtection() {
    try {
        exports.protection.load(JSON.parse(await promises_1.default.readFile(PROTECTION_FILE, 'utf8')));
    }
    catch {
        // first run
    }
}
async function flushProtection() {
    if (protectionTimer)
        clearTimeout(protectionTimer);
    protectionTimer = null;
    exports.protection.prune(Date.now());
    const tmp = `${PROTECTION_FILE}.tmp`;
    await promises_1.default.writeFile(tmp, JSON.stringify(exports.protection.toJSON()), 'utf8').then(() => promises_1.default.rename(tmp, PROTECTION_FILE)).catch(() => undefined);
}
function saveProtectionSoon() {
    if (protectionTimer)
        return;
    protectionTimer = setTimeout(() => void flushProtection(), 5000);
    protectionTimer.unref?.();
}
const pendingSync = new retry_queue_1.RetryQueue(1000);
const PENDING_FILE = node_path_1.default.join(config_1.DATA_DIR, 'pending-sync.json');
let pendingTimer = null;
const queuedNotice = new Map();
async function loadPendingSync() {
    try {
        pendingSync.load(JSON.parse(await promises_1.default.readFile(PENDING_FILE, 'utf8')));
    }
    catch {
        // nothing waiting
    }
}
async function flushPendingSync() {
    if (pendingTimer)
        clearTimeout(pendingTimer);
    pendingTimer = null;
    const tmp = `${PENDING_FILE}.tmp`;
    await promises_1.default.writeFile(tmp, JSON.stringify(pendingSync.toJSON()), 'utf8').then(() => promises_1.default.rename(tmp, PENDING_FILE)).catch(() => undefined);
}
function savePendingSoon() {
    if (pendingTimer)
        return;
    pendingTimer = setTimeout(() => void flushPendingSync(), 3000);
    pendingTimer.unref?.();
}
function pendingSyncSummary() {
    const items = pendingSync.list();
    return {
        count: items.length,
        oldestAt: items[0] ? new Date(items[0].firstFailedAt).toISOString() : null,
        items: items.slice(0, 20).map(item => ({
            locationId: store_1.registry.instances[item.payload.instanceId]?.locationId ?? null,
            slot: store_1.registry.instances[item.payload.instanceId]?.slot ?? null,
            phone: (0, events_1.maskPhone)(item.payload.phone),
            direction: item.payload.direction,
            attempts: item.attempts,
            firstFailedAt: new Date(item.firstFailedAt).toISOString(),
            nextAt: new Date(item.nextAt).toISOString(),
            lastError: item.lastError
        }))
    };
}
function retryPendingNow() {
    pendingSync.retryAllNow(Date.now());
    void processPendingSync();
    return pendingSync.size;
}
function authDir(id) {
    return node_path_1.default.join(config_1.DATA_DIR, 'auth', id);
}
function updateInstance(id, patch) {
    const current = store_1.registry.instances[id];
    if (!current)
        return;
    store_1.registry.instances[id] = { ...current, ...patch, updatedAt: new Date().toISOString() };
    void (0, store_1.save)();
}
function isLive(id) {
    return sessions.has(id) && store_1.registry.instances[id]?.status === 'connected';
}
async function hasPairedCreds(id) {
    try {
        const creds = JSON.parse(await promises_1.default.readFile(node_path_1.default.join(authDir(id), 'creds.json'), 'utf8'));
        return Boolean(creds?.me?.id);
    }
    catch {
        return false;
    }
}
// Start/stop operations for one instance run one at a time, so a double-clicked "Restart" cannot leave two sockets alive.
function withInstanceLock(id, task) {
    const run = (instanceLocks.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
    instanceLocks.set(id, run);
    void run.finally(() => instanceLocks.get(id) === run && instanceLocks.delete(id)).catch(() => undefined);
    return run;
}
function startInstance(id, options = {}) {
    return withInstanceLock(id, () => openSession(id, options.fresh === true));
}
function detachSession(id) {
    const previous = sessions.get(id);
    // Remove it from the map *before* ending it: the old socket's close event is then ignored instead of
    // deleting the new socket and scheduling yet another reconnect (which left two sessions fighting).
    sessions.delete(id);
    if (previous) {
        try {
            previous.sock.end(undefined);
        }
        catch {
            // already closed
        }
    }
    return previous;
}
function clearReconnect(id) {
    const timer = reconnectTimers.get(id);
    if (timer)
        clearTimeout(timer);
    reconnectTimers.delete(id);
}
async function openSession(id, fresh) {
    const meta = store_1.registry.instances[id];
    if (!meta)
        throw new Error('Instance not found');
    clearReconnect(id);
    detachSession(id);
    if (fresh || meta.status === 'logged_out')
        await promises_1.default.rm(authDir(id), { recursive: true, force: true });
    await promises_1.default.mkdir(authDir(id), { recursive: true });
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(authDir(id));
    if (!store_1.registry.instances[id])
        return;
    updateInstance(id, { status: state.creds.me?.id ? 'connecting' : 'starting', qr: null, lastError: null });
    const sock = (0, baileys_1.default)({
        auth: state,
        browser: baileys_1.Browsers.ubuntu('Chrome'),
        logger: baileysLogger,
        // Staying "offline" keeps notifications flowing to the phone.
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // Our own sends must not come back through messages.upsert; every fromMe upsert is then a phone-typed message.
        emitOwnEvents: false,
        getMessage: async (key) => (key.id ? sentMessages.get(key.id) : undefined)
    });
    const session = { sock, creds: state.creds };
    sessions.set(id, session);
    const isCurrent = () => sessions.get(id) === session;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', update => {
        if (!isCurrent())
            return;
        handleConnectionUpdate(id, session, update).catch(err => events_1.log.error({ err, id }, 'connection.update handler failed'));
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (!isCurrent())
            return;
        for (const message of messages)
            queueIncoming(id, sock, message, type);
    });
    sock.ev.on('messages.update', updates => {
        if (isCurrent())
            void syncReceipts(id, updates);
    });
}
// WhatsApp's "reach-out timelock": the number may keep existing chats but cannot start new ones until it ends.
function applyRestriction(id, lock) {
    const meta = store_1.registry.instances[id];
    if (!meta || !lock)
        return;
    const until = lock.isActive ? (lock.timeEnforcementEnds ? new Date(lock.timeEnforcementEnds).getTime() : Date.now() + RESTRICTION_FALLBACK_MS) : null;
    const wasRestricted = Boolean(meta.restrictedUntil && meta.restrictedUntil > Date.now());
    if (!until && !wasRestricted)
        return;
    updateInstance(id, { restrictedUntil: until });
    if (until) {
        (0, events_1.recordEvent)('error', `WhatsApp restricted ${(0, events_1.maskPhone)(meta.phone)} (#${meta.slot}) from starting new chats until ${new Date(until).toISOString()}`, {
            instanceId: id,
            locationId: meta.locationId,
            detail: `reason: ${lock.enforcementType || 'not given'}. Existing chats keep working; new chats from this number are paused and are not moved to other numbers.`
        });
    }
    else {
        (0, events_1.recordEvent)('info', `WhatsApp lifted the restriction on ${(0, events_1.maskPhone)(meta.phone)} (#${meta.slot})`, { instanceId: id, locationId: meta.locationId });
    }
}
// A 463 error ack means WhatsApp refused a message because the number may not start new chats right now.
function markRestrictedFromError(id) {
    const meta = store_1.registry.instances[id];
    if (!meta || (meta.restrictedUntil && meta.restrictedUntil > Date.now()))
        return;
    applyRestriction(id, { isActive: true, timeEnforcementEnds: new Date(Date.now() + RESTRICTION_FALLBACK_MS) });
    sessions.get(id)?.sock
        .fetchAccountReachoutTimelock()
        .then(lock => lock.isActive && applyRestriction(id, lock))
        .catch(() => undefined);
}
async function handleConnectionUpdate(id, session, update) {
    const meta = store_1.registry.instances[id];
    if (!meta)
        return;
    const context = { instanceId: id, locationId: meta.locationId };
    if (update.qr) {
        const dataUrl = await qrcode_1.default.toDataURL(update.qr, { width: 360, margin: 2 });
        if (sessions.get(id) === session)
            updateInstance(id, { status: 'qr', qr: dataUrl, lastError: null });
    }
    if (update.reachoutTimeLock)
        applyRestriction(id, update.reachoutTimeLock);
    if (update.connection === 'open') {
        reconnectAttempts.delete(id);
        replacedCount.delete(id);
        const phone = (0, baileys_1.jidDecode)(session.sock.user?.id)?.user;
        // A different phone scanned into this slot is a new WhatsApp account: it warms up from scratch.
        const newAccount = Boolean(meta.phone && phone && meta.phone !== phone);
        if (newAccount) {
            exports.protection.forget(id);
            saveProtectionSoon();
        }
        updateInstance(id, {
            status: 'connected',
            phone,
            qr: null,
            lastError: null,
            linkedAt: newAccount || !meta.linkedAt ? new Date().toISOString() : meta.linkedAt,
            ...(newAccount ? { warmupFrom: null, restrictedUntil: null } : {})
        });
        (0, events_1.recordEvent)('info', newAccount ? `WhatsApp connected as ${(0, events_1.maskPhone)(phone)}, a different number than before; its warm-up starts now` : `WhatsApp connected as ${(0, events_1.maskPhone)(phone)}`, context);
        // Learn whether WhatsApp currently limits this number before anything is sent from it.
        session.sock
            .fetchAccountReachoutTimelock()
            .then(lock => applyRestriction(id, lock))
            .catch(err => events_1.log.debug({ err, id }, 'reachout timelock check failed'));
    }
    if (update.connection !== 'close')
        return;
    sessions.delete(id);
    if (shuttingDown)
        return;
    const error = update.lastDisconnect?.error;
    const code = error?.output?.statusCode;
    const reason = error?.message || 'Connection closed';
    const paired = Boolean(session.creds.me?.id);
    if (code === baileys_1.DisconnectReason.loggedOut) {
        // The credentials are dead; wipe them so the next start shows a fresh QR instead of failing again.
        await promises_1.default.rm(authDir(id), { recursive: true, force: true });
        updateInstance(id, { status: 'logged_out', qr: null, lastError: 'WhatsApp logged this device out. Click "Reconnect" and scan a new QR code.' });
        (0, events_1.recordEvent)('error', `WhatsApp logged out #${meta.slot} ${meta.name} (${(0, events_1.maskPhone)(meta.phone)}); scan a new QR code to reconnect`, context);
        return;
    }
    if (code === baileys_1.DisconnectReason.forbidden || code === baileys_1.DisconnectReason.multideviceMismatch) {
        const banned = code === baileys_1.DisconnectReason.forbidden;
        updateInstance(id, {
            status: 'error',
            qr: null,
            lastError: banned ? 'WhatsApp blocked this number (403). Check the WhatsApp app on the phone for a ban or review notice.' : `WhatsApp refused the connection (${code}): ${reason}`
        });
        (0, events_1.recordEvent)('error', banned ? `WhatsApp blocked ${(0, events_1.maskPhone)(meta.phone)} (403)` : `WhatsApp refused the connection (${code})`, { ...context, detail: reason });
        return;
    }
    if (!paired && code === baileys_1.DisconnectReason.timedOut) {
        updateInstance(id, { status: 'qr_expired', qr: null, lastError: 'The QR code expired before it was scanned. Click "Reconnect" for a new one.' });
        return;
    }
    if (code === baileys_1.DisconnectReason.connectionReplaced) {
        const count = (replacedCount.get(id) ?? 0) + 1;
        replacedCount.set(id, count);
        (0, events_1.recordEvent)('warn', 'Another session using this WhatsApp login replaced this connection', { ...context, detail: reason });
        if (count > 3) {
            updateInstance(id, {
                status: 'conflict',
                qr: null,
                lastError: 'This WhatsApp login keeps being taken over by another session (a second worker, or another bridge using the same login). Close it, then click "Reconnect".'
            });
            return;
        }
        scheduleReconnect(id, 30_000, reason);
        return;
    }
    if (code === baileys_1.DisconnectReason.restartRequired) {
        // Normal right after a QR scan; the short pause lets saveCreds finish writing the new login first.
        scheduleReconnect(id, 1000, null);
        return;
    }
    const attempt = (reconnectAttempts.get(id) ?? 0) + 1;
    reconnectAttempts.set(id, attempt);
    scheduleReconnect(id, Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5)), reason);
}
function scheduleReconnect(id, delayMs, reason) {
    updateInstance(id, { status: 'reconnecting', lastError: reason });
    clearReconnect(id);
    const timer = setTimeout(() => {
        reconnectTimers.delete(id);
        startInstance(id).catch(err => (0, events_1.recordEvent)('error', `WhatsApp reconnect failed: ${(0, events_1.errorText)(err)}`, { instanceId: id, locationId: store_1.registry.instances[id]?.locationId }));
    }, delayMs);
    reconnectTimers.set(id, timer);
}
async function resumeInstances() {
    for (const instance of Object.values(store_1.registry.instances)) {
        if (instance.status !== 'logged_out' && (await hasPairedCreds(instance.id))) {
            startInstance(instance.id).catch(err => (0, events_1.recordEvent)('error', `Could not resume WhatsApp session: ${(0, events_1.errorText)(err)}`, { instanceId: instance.id, locationId: instance.locationId }));
        }
        else if (instance.status !== 'logged_out') {
            updateInstance(instance.id, { status: 'disconnected', qr: null, lastError: 'Not linked yet. Click "Reconnect" to show a QR code.' });
        }
    }
}
async function deleteInstance(id) {
    await withInstanceLock(id, async () => {
        clearReconnect(id);
        const session = sessions.get(id);
        sessions.delete(id);
        if (session) {
            // Unlink the device on the phone as well, then make sure the socket is gone.
            await Promise.race([session.sock.logout('Removed from the bridge dashboard').catch(() => undefined), delay(5000)]);
            try {
                session.sock.end(undefined);
            }
            catch {
                // already closed
            }
        }
        await promises_1.default.rm(authDir(id), { recursive: true, force: true });
        const locationId = store_1.registry.instances[id]?.locationId;
        delete store_1.registry.instances[id];
        if (locationId)
            (0, numbers_1.promoteDefault)(locationId);
        exports.protection.forget(id);
        saveProtectionSoon();
        await (0, store_1.save)();
    });
}
function shutdown() {
    shuttingDown = true;
    for (const timer of reconnectTimers.values())
        clearTimeout(timer);
    for (const [id, session] of sessions) {
        sessions.delete(id);
        try {
            session.sock.end(undefined);
        }
        catch {
            // already closed
        }
    }
}
function timestampMs(msg) {
    const raw = msg.messageTimestamp;
    if (raw == null)
        return undefined;
    const seconds = typeof raw === 'object' && typeof raw.toNumber === 'function' ? raw.toNumber() : Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
function queueIncoming(instanceId, sock, msg, type) {
    const { key } = msg;
    if (!key.id || !msg.message || !(0, wa_message_1.isDirectChatJid)(key.remoteJid))
        return;
    if (key.fromMe && !config_1.SYNC_PHONE_MESSAGES)
        return;
    // "append" carries messages that arrived while this worker was offline; take recent ones, skip old backlog.
    const sentAt = timestampMs(msg);
    if (type === 'append' && (!sentAt || Date.now() - sentAt > OFFLINE_WINDOW_MS))
        return;
    // The retry queue survives restarts (seenMessages does not), so a message waiting there is never synced twice.
    if (seenMessages.has(key.id) || pendingSync.has(key.id))
        return;
    const content = (0, wa_message_1.extractContent)(msg.message);
    if (!content)
        return;
    seenMessages.set(key.id, true);
    void inChat(`${instanceId}|${key.remoteJid}`, () => syncToGhl(instanceId, sock, msg, content)).catch(err => (0, events_1.recordEvent)('error', 'Failed to sync a WhatsApp message to HighLevel', { instanceId, locationId: store_1.registry.instances[instanceId]?.locationId, detail: describeError(err) }));
}
// Messages of one chat are pushed in order; different chats run in parallel.
function inChat(chatKey, task) {
    const run = (chatQueues.get(chatKey) ?? Promise.resolve()).catch(() => undefined).then(task);
    chatQueues.set(chatKey, run);
    void run.catch(() => undefined).finally(() => chatQueues.get(chatKey) === run && chatQueues.delete(chatKey));
    return run;
}
function describeError(err) {
    return err instanceof ghl.GhlApiError ? `${err.message}: ${err.body}` : (0, events_1.errorText)(err);
}
// HighLevel rejecting the content itself (400/422) will not change on a retry; outages, rate limits, expired or
// revoked tokens and missing installs can, once the admin fixes them.
function worthRetrying(err) {
    return !(err instanceof ghl.GhlApiError && (err.status === 400 || err.status === 422));
}
function phoneSendKey(locationId, digits, text) {
    return `${locationId}|${digits}|${text.trim()}`;
}
async function resolveContact(locationId, phone, displayName) {
    const cacheKey = `${locationId}|${phone}`;
    const hit = contactCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CONTACT_CACHE_MS)
        return { ...hit, cached: true };
    const { contactId, assignedTo } = await ghl.upsertContact(locationId, `+${phone}`, displayName);
    const conversationId = await ghl.findOrCreateConversation(locationId, contactId);
    contactCache.set(cacheKey, { contactId, conversationId, assignedTo, at: Date.now() });
    return { contactId, conversationId, assignedTo, cached: false };
}
// First sight of a WhatsApp message: protection bookkeeping happens once, then the HighLevel push (retried if needed).
async function syncToGhl(instanceId, sock, msg, content) {
    const meta = store_1.registry.instances[instanceId];
    if (!meta)
        return;
    const { locationId } = meta;
    const context = { instanceId, locationId };
    const direction = msg.key.fromMe ? 'outbound' : 'inbound';
    if (direction === 'outbound' && mirrorDisabled.has(locationId))
        return;
    const phone = await (0, wa_message_1.resolvePhone)(msg.key, lid => sock.signalRepository.lidMapping.getPNForLID(lid));
    if (!phone) {
        (0, events_1.recordEvent)('warn', `Skipped a WhatsApp ${direction} message: WhatsApp hid the contact's number behind a private id (LID) and it could not be mapped yet`, context);
        return;
    }
    // Someone who wrote to this number can always be answered from it; a chat typed on the phone counts as a send.
    if (direction === 'inbound') {
        exports.protection.markInbound(instanceId, phone, Date.now());
        rememberUnread(instanceId, phone, msg.key);
    }
    else {
        exports.protection.recordSend(instanceId, phone, Date.now());
    }
    saveProtectionSoon();
    if (!ghl.isConnected(locationId)) {
        (0, events_1.recordEvent)('warn', `WhatsApp message ${direction === 'inbound' ? 'from' : 'to'} ${(0, events_1.maskPhone)(phone)} was not synced: location ${locationId} is not connected to HighLevel yet`, context);
        return;
    }
    if (direction === 'outbound' && content.text.trim())
        recentPhoneSends.set(phoneSendKey(locationId, phone, content.text), Date.now());
    const sentAt = timestampMs(msg);
    try {
        await pushToGhl(instanceId, sock, msg, content, phone, direction, sentAt);
    }
    catch (err) {
        if (!worthRetrying(err))
            throw err;
        const job = { instanceId, phone, direction, sentAt, raw: (0, wa_message_1.serializeMessage)(msg) };
        const dropped = pendingSync.add(msg.key.id, job, Date.now(), describeError(err));
        savePendingSoon();
        // One notice per location every 10 minutes, not one per message, while HighLevel is unreachable.
        if (Date.now() - (queuedNotice.get(locationId) ?? 0) > 10 * 60_000) {
            queuedNotice.set(locationId, Date.now());
            (0, events_1.recordEvent)('warn', `HighLevel did not take a WhatsApp message ${direction === 'inbound' ? 'from' : 'to'} ${(0, events_1.maskPhone)(phone)}; it waits in the retry queue and is synced automatically`, {
                ...context,
                detail: describeError(err)
            });
        }
        if (dropped) {
            (0, events_1.recordEvent)('error', `The retry queue is full, so the oldest waiting WhatsApp message (${(0, events_1.maskPhone)(dropped.payload.phone)}) was dropped`, {
                instanceId: dropped.payload.instanceId,
                locationId: store_1.registry.instances[dropped.payload.instanceId]?.locationId
            });
        }
    }
}
async function pushToGhl(instanceId, sock, msg, content, phone, direction, sentAt) {
    const meta = store_1.registry.instances[instanceId];
    if (!meta)
        return;
    const { locationId } = meta;
    const context = { instanceId, locationId };
    const displayName = direction === 'inbound' ? msg.pushName || undefined : undefined;
    let target = await resolveContact(locationId, phone, displayName);
    void ensureWaTag(locationId, target.contactId, meta.phone);
    void ensureAssignment(meta, phone, target);
    let message = content.text;
    let attachments = [];
    if (content.media) {
        attachments = await uploadMedia(sock, msg, content, locationId, target).catch(err => {
            (0, events_1.recordEvent)('warn', `Could not attach a WhatsApp ${content.media.kind} in HighLevel; sent a text placeholder instead`, { ...context, detail: (0, events_1.errorText)(err) });
            return [];
        });
        if (!message)
            message = (0, wa_message_1.mediaLabel)(content.media);
    }
    const send = () => ghl.addInboundMessageDetectingType(locationId, {
        contactId: target.contactId,
        conversationId: target.conversationId,
        message,
        attachments,
        altId: msg.key.id || undefined,
        direction,
        date: sentAt ? new Date(sentAt).toISOString() : undefined
    });
    let result;
    try {
        result = await send();
    }
    catch (err) {
        // The cached contact or conversation may have been deleted in HighLevel; resolve it again once.
        if (!(err instanceof ghl.GhlApiError) || !target.cached || ![400, 404, 422].includes(err.status))
            throw err;
        contactCache.delete(`${locationId}|${phone}`);
        target = await resolveContact(locationId, phone, displayName);
        result = await send();
    }
    if (direction === 'inbound') {
        (0, events_1.recordEvent)('info', `Synced a WhatsApp message from ${(0, events_1.maskPhone)(phone)} into HighLevel`, context);
        return;
    }
    if (result.messageId)
        mirroredGhlIds.set(result.messageId, true);
    (0, events_1.recordEvent)('info', `Mirrored a message typed on the phone to ${(0, events_1.maskPhone)(phone)} into HighLevel`, context);
    void verifyMirrorDirection(locationId, result.messageId);
}
let retryRunning = false;
async function processPendingSync() {
    if (retryRunning)
        return;
    retryRunning = true;
    try {
        for (const item of pendingSync.due(Date.now()).slice(0, 25))
            await retryOne(item);
    }
    finally {
        retryRunning = false;
    }
}
async function retryOne(item) {
    const { instanceId, phone, direction, sentAt, raw } = item.payload;
    const meta = store_1.registry.instances[instanceId];
    let msg = null;
    try {
        msg = (0, wa_message_1.deserializeMessage)(raw);
    }
    catch {
        // unreadable entry; dropped below
    }
    const content = msg?.message ? (0, wa_message_1.extractContent)(msg.message) : null;
    if (!meta || !msg || !content) {
        pendingSync.succeeded(item.id);
        savePendingSoon();
        return;
    }
    // Media is downloaded again through the number's WhatsApp session, so wait until it is back online.
    if (content.media && !isLive(instanceId)) {
        pendingSync.postpone(item.id, Date.now(), 2 * 60_000);
        return;
    }
    const context = { instanceId, locationId: meta.locationId };
    const label = `${direction === 'inbound' ? 'from' : 'to'} ${(0, events_1.maskPhone)(phone)}`;
    const message = msg;
    try {
        await inChat(`${instanceId}|${message.key.remoteJid}`, () => pushToGhl(instanceId, sessions.get(instanceId)?.sock ?? null, message, content, phone, direction, sentAt));
        pendingSync.succeeded(item.id);
        (0, events_1.recordEvent)('info', `Synced a waiting WhatsApp message ${label} into HighLevel (attempt ${item.attempts + 1})`, context);
    }
    catch (err) {
        const outcome = worthRetrying(err) ? pendingSync.failed(item.id, Date.now(), describeError(err)) : 'gave-up';
        if (outcome === 'gave-up') {
            pendingSync.succeeded(item.id);
            (0, events_1.recordEvent)('error', `Gave up syncing a WhatsApp message ${label} into HighLevel after ${item.attempts} attempts`, { ...context, detail: describeError(err) });
        }
    }
    savePendingSoon();
}
function rememberUnread(instanceId, phone, key) {
    const id = `${instanceId}|${phone}`;
    unread.set(id, [...(unread.get(id) ?? []), key].slice(-20));
}
// Read the contact's waiting messages before answering them, as a person would.
async function markRead(instanceId, sock, phone) {
    const id = `${instanceId}|${phone}`;
    const keys = unread.get(id);
    if (!keys?.length)
        return;
    unread.delete(id);
    await sock.readMessages(keys).catch(err => events_1.log.debug({ err }, 'marking messages read failed'));
}
// Contacts who talk with a number that has an owner are assigned to that HighLevel user (see assigneeFor).
async function ensureAssignment(meta, phone, target) {
    const userId = (0, numbers_1.assigneeFor)(meta, target.assignedTo);
    if (!userId)
        return;
    try {
        await ghl.assignContact(meta.locationId, target.contactId, userId);
        const cached = contactCache.get(`${meta.locationId}|${phone}`);
        if (cached)
            cached.assignedTo = userId;
        (0, events_1.recordEvent)('info', `Assigned ${(0, events_1.maskPhone)(phone)} to ${meta.assignedUserName || 'its owner'} (number #${meta.slot})`, { instanceId: meta.id, locationId: meta.locationId });
    }
    catch (err) {
        (0, events_1.recordEvent)('warn', `Could not assign ${(0, events_1.maskPhone)(phone)} to ${meta.assignedUserName || userId}`, { instanceId: meta.id, locationId: meta.locationId, detail: describeError(err) });
    }
}
// The contact's "wa: +number" tag follows the number they last wrote to; replies are routed by it.
async function ensureWaTag(locationId, contactId, numberPhone) {
    if (!numberPhone)
        return;
    const cacheKey = `${locationId}|${contactId}`;
    const hit = tagCache.get(cacheKey);
    if (hit && hit.phone === numberPhone && Date.now() - hit.at < TAG_CACHE_MS)
        return;
    try {
        await ghl.setContactWaTag(locationId, contactId, numberPhone);
        tagCache.set(cacheKey, { phone: numberPhone, at: Date.now() });
    }
    catch (err) {
        (0, events_1.recordEvent)('warn', "Could not update the contact's WhatsApp number tag", { locationId, detail: (0, events_1.errorText)(err) });
    }
}
// Phone-typed messages are recorded through the inbound endpoint with direction "outbound". Check once per location
// that HighLevel really stored it as outbound; if not, stop mirroring rather than show agents fake inbound messages.
async function verifyMirrorDirection(locationId, messageId) {
    if (!messageId || mirrorChecked.has(locationId))
        return;
    mirrorChecked.add(locationId);
    try {
        const stored = await ghl.getMessage(locationId, messageId);
        if (stored?.direction && stored.direction !== 'outbound') {
            mirrorDisabled.add(locationId);
            (0, events_1.recordEvent)('error', 'HighLevel stored a phone-typed message as inbound, so mirroring of phone-typed messages was turned off for this location', {
                locationId,
                detail: `direction=${stored.direction}`
            });
        }
    }
    catch (err) {
        (0, events_1.recordEvent)('warn', 'Could not verify how HighLevel stored a mirrored phone message (needs the conversations/message.readonly scope)', {
            locationId,
            detail: (0, events_1.errorText)(err)
        });
    }
}
const MIME_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf'
};
async function uploadMedia(sock, msg, content, locationId, target) {
    const info = content.media;
    const limitMb = Math.round(config_1.MAX_MEDIA_BYTES / 1024 / 1024);
    if (info.size && info.size > config_1.MAX_MEDIA_BYTES)
        throw new Error(`the file is larger than ${limitMb} MB`);
    const reuploadRequest = sock ? sock.updateMediaMessage : () => Promise.reject(new Error('the WhatsApp number is offline'));
    const data = await (0, baileys_1.downloadMediaMessage)(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest });
    if (data.length > config_1.MAX_MEDIA_BYTES)
        throw new Error(`the file is larger than ${limitMb} MB`);
    const mimetype = info.mimetype.split(';')[0].trim();
    const fileName = info.fileName || `${info.kind}-${msg.key.id}.${MIME_EXTENSIONS[mimetype] || 'bin'}`;
    const urls = await ghl.uploadAttachment(locationId, { ...target, data, mimetype, fileName });
    if (!urls.length)
        throw new Error('HighLevel returned no URL for the uploaded file');
    return urls;
}
async function syncReceipts(instanceId, updates) {
    for (const { key, update } of updates) {
        // An error ack carrying 463 means WhatsApp refused the message: the number may not start new chats right now.
        const restricted = update.status === baileys_1.WAMessageStatus.ERROR && (update.messageStubParameters ?? []).some((p) => String(p) === '463' || /restrict/i.test(String(p)));
        if (key.fromMe && restricted)
            markRestrictedFromError(instanceId);
        const delivery = key.id ? deliveries.get(key.id) : undefined;
        if (!delivery)
            continue;
        const status = (0, wa_message_1.ghlStatusFromWa)(update.status);
        if (!status || !(0, wa_message_1.shouldAdvanceStatus)(delivery.status, status))
            continue;
        delivery.status = status;
        const reason = status === 'failed' ? (restricted ? 'WhatsApp is not letting this number start new chats right now.' : 'WhatsApp rejected the message.') : undefined;
        try {
            await ghl.updateMessageStatus(delivery.locationId, delivery.ghlMessageId, status, reason);
        }
        catch (err) {
            (0, events_1.recordEvent)('warn', `Could not set the HighLevel message status to ${status}`, { locationId: delivery.locationId, detail: (0, events_1.errorText)(err) });
        }
    }
}
const toRouteNumber = (i) => ({
    id: i.id,
    slot: i.slot ?? 0,
    name: i.name,
    phone: i.phone,
    isDefault: Boolean(i.isDefault),
    assignedUserId: i.assignedUserId ?? null
});
async function waitUntilLive(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isLive(id))
            return true;
        if (!store_1.registry.instances[id])
            return false;
        await delay(2000);
    }
    return isLive(id);
}
// Sends from one number are spaced out by a random gap; bursts are queued instead of fired at once.
function enqueueSend(instanceId, task) {
    const run = (sendQueues.get(instanceId) ?? Promise.resolve()).then(task);
    const base = (0, settings_1.sendGapMs)();
    const gap = run.catch(() => undefined).then(() => delay(base + Math.random() * base * 1.5));
    sendQueues.set(instanceId, gap);
    void gap.finally(() => sendQueues.get(instanceId) === gap && sendQueues.delete(instanceId));
    return run;
}
async function whatsappJid(sock, digits) {
    const cached = numberCache.get(digits);
    if (cached && Date.now() - cached.at < 24 * 3600_000)
        return cached.jid;
    try {
        const results = await sock.onWhatsApp(digits);
        if (!results)
            return `${digits}@s.whatsapp.net`;
        const match = results.find(r => r.exists);
        const jid = match ? match.jid : null;
        numberCache.set(digits, { jid, at: Date.now() });
        return jid;
    }
    catch (err) {
        events_1.log.warn({ err }, 'onWhatsApp lookup failed; sending to the phone-number JID directly');
        return `${digits}@s.whatsapp.net`;
    }
}
// Attachments are downloaded here (public HTTPS hosts only, size-capped) and handed to Baileys as bytes,
// so a crafted URL in a delivery webhook cannot make the worker fetch internal addresses.
async function attachmentContent(url) {
    const { data, contentType } = await (0, safe_fetch_1.downloadPublicFile)(url, config_1.MAX_MEDIA_BYTES);
    const mimetype = contentType?.split(';')[0].trim() || undefined;
    switch ((0, wa_message_1.attachmentKind)(url, mimetype)) {
        case 'image':
            return { image: data };
        case 'video':
            return { video: data };
        case 'audio':
            return { audio: data, mimetype: mimetype || 'audio/mpeg' };
        default:
            return { document: data, mimetype: mimetype || 'application/octet-stream', fileName: (0, wa_message_1.fileNameFromUrl)(url) };
    }
}
async function sendTracked(sock, jid, content, delivery) {
    const sent = await sock.sendMessage(jid, content);
    const id = sent?.key.id;
    if (!id)
        return;
    if (sent.message)
        sentMessages.set(id, sent.message);
    if (delivery)
        deliveries.set(id, delivery);
}
// Show "typing…" for a human-sized moment before sending, as WhatsApp Web does when a person types.
async function humanSend(sock, jid, content, typedText, delivery) {
    try {
        await sock.sendPresenceUpdate('available');
        await sock.sendPresenceUpdate('composing', jid);
        await delay((0, protection_1.typingDelayMs)(typedText));
        await sock.sendPresenceUpdate('paused', jid);
    }
    catch (err) {
        events_1.log.debug({ err }, 'presence update failed');
    }
    await sendTracked(sock, jid, content, delivery);
}
// Send a batch to one contact from one number: read their waiting messages, type and send, then go offline again
// (staying "online" would stop notifications on the phone).
function sendFromNumber(instanceId, sock, jid, digits, parts, delivery) {
    return enqueueSend(instanceId, async () => {
        await markRead(instanceId, sock, digits);
        try {
            if (parts.text)
                await humanSend(sock, jid, { text: parts.text }, parts.text, delivery);
            for (const url of parts.attachments)
                await humanSend(sock, jid, await attachmentContent(url), '', delivery);
        }
        finally {
            sock.sendPresenceUpdate('unavailable').catch(() => undefined);
        }
    });
}
let providerVerified = false;
function handleProviderOutbound(payload) {
    deliverToWhatsApp(payload).catch(err => (0, events_1.recordEvent)('error', 'Unexpected error while delivering a HighLevel message', { locationId: payload.locationId, detail: (0, events_1.errorText)(err) }));
    // The message HighLevel just routed through the provider records the provider's real id; check it once per start.
    const { locationId, messageId } = payload;
    if (!providerVerified && locationId && messageId && ghl.isConnected(locationId)) {
        providerVerified = true;
        ghl.learnProviderFromMessage(locationId, messageId).catch(err => {
            providerVerified = false;
            (0, events_1.recordEvent)('warn', 'Could not read the provider id from the HighLevel message', { locationId, detail: (0, events_1.errorText)(err) });
        });
    }
}
async function deliverToWhatsApp(payload) {
    const locationId = payload.locationId || '';
    const context = { locationId };
    const fail = async (reason, detail) => {
        (0, events_1.recordEvent)('error', `HighLevel message not delivered to WhatsApp: ${reason}`, { ...context, detail });
        if (!payload.messageId || !ghl.isConnected(locationId))
            return;
        await ghl.updateMessageStatus(locationId, payload.messageId, 'failed', reason).catch(err => (0, events_1.recordEvent)('warn', 'Could not mark the HighLevel message as failed', { ...context, detail: (0, events_1.errorText)(err) }));
    };
    if (payload.messageId && mirroredGhlIds.has(payload.messageId))
        return;
    // HighLevel (or the web app forwarding to us) may repeat a delivery webhook; each message is sent once.
    if (payload.messageId) {
        if (handledDeliveries.has(payload.messageId)) {
            events_1.log.info({ messageId: payload.messageId }, 'Ignored a repeated delivery webhook');
            return;
        }
        handledDeliveries.set(payload.messageId, Date.now());
    }
    const { token, text } = (0, routing_1.parseRouteToken)((payload.message || '').trim());
    // The contact record gives the phone when the payload lacks it, plus the routing hints: its "wa:" tag and its owner.
    const lookup = payload.contactId && ghl.isConnected(locationId) && (!payload.phone || !token)
        ? await ghl.getContactRouting(locationId, payload.contactId).catch(err => {
            events_1.log.warn({ err: (0, events_1.errorText)(err) }, 'contact lookup for routing failed');
            return null;
        })
        : null;
    const digits = (payload.phone || lookup?.phone || '').replace(/\D/g, '');
    const attachments = (Array.isArray(payload.attachments) ? payload.attachments : []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    const echoAt = digits && text ? recentPhoneSends.get(phoneSendKey(locationId, digits, text)) : undefined;
    if (echoAt && Date.now() - echoAt < ECHO_WINDOW_MS)
        return;
    if (!digits)
        return fail('the contact has no phone number');
    if (!text && !attachments.length)
        return fail('the message is empty');
    const numbers = (0, numbers_1.numbersOf)(locationId);
    if (!numbers.length)
        return fail('no WhatsApp number is linked to this sub-account yet. Connect one on the sub-account page.');
    // Token in the message, else the contact's "wa:" tag, else their owner's number, else the sender's, else the default.
    let candidates;
    try {
        candidates = (0, routing_1.routeCandidates)(numbers.map(toRouteNumber), {
            token,
            taggedPhone: token ? null : lookup?.taggedPhone,
            assignedUserId: lookup?.assignedTo,
            senderUserId: payload.userId
        });
    }
    catch (err) {
        return fail((0, events_1.errorText)(err));
    }
    const preferred = candidates[0];
    const chosen = isLive(preferred.id) || (await waitUntilLive(preferred.id, (0, settings_1.failoverWaitMs)())) ? preferred : candidates.slice(1).find(c => isLive(c.id));
    const session = chosen && sessions.get(chosen.id);
    if (!chosen || !session)
        return fail("none of this sub-account's WhatsApp numbers is connected. Reconnect them on the sub-account page.");
    const jid = await whatsappJid(session.sock, digits);
    if (!jid)
        return fail(`${(0, events_1.maskPhone)(digits)} is not registered on WhatsApp`);
    // Reaching out to people who never wrote to this number is limited; the slot is reserved before queueing.
    const number = store_1.registry.instances[chosen.id];
    const decision = exports.protection.check(chosen.id, digits, (0, numbers_1.numberState)(number), Date.now(), (0, numbers_1.effectivePolicy)(number));
    if (!decision.allowed)
        return fail(`number #${chosen.slot} (${(0, events_1.maskPhone)(chosen.phone)}): ${decision.reason}`);
    exports.protection.recordSend(chosen.id, digits, Date.now());
    saveProtectionSoon();
    const delivery = payload.messageId ? { locationId, ghlMessageId: payload.messageId } : null;
    try {
        await sendFromNumber(chosen.id, session.sock, jid, digits, { text, attachments }, delivery);
        const via = chosen === preferred ? '' : ` as a backup for #${preferred.slot}, which is offline`;
        (0, events_1.recordEvent)('info', `Delivered a HighLevel message to ${(0, events_1.maskPhone)(digits)} from #${chosen.slot} ${chosen.name}${via}`, {
            ...context,
            instanceId: chosen.id
        });
        // A contact without a "wa:" tag is now in a chat with this number; tag it so later messages stay on it.
        // (Only when the lookup worked: a failed lookup must not overwrite a tag that could not be read.)
        if (lookup && !lookup.taggedPhone && chosen === preferred && payload.contactId)
            void ensureWaTag(locationId, payload.contactId, chosen.phone ?? undefined);
    }
    catch (err) {
        await fail('WhatsApp rejected the send', (0, events_1.errorText)(err));
    }
}
async function sendDirect(instanceId, to, text) {
    const session = sessions.get(instanceId);
    const instance = store_1.registry.instances[instanceId];
    if (!session || !instance || !isLive(instanceId))
        throw new Error('Instance is not connected');
    const digits = to.replace(/\D/g, '');
    const jid = await whatsappJid(session.sock, digits);
    if (!jid)
        throw new Error(`${(0, events_1.maskPhone)(digits)} is not registered on WhatsApp`);
    const decision = exports.protection.check(instanceId, digits, (0, numbers_1.numberState)(instance), Date.now(), (0, numbers_1.effectivePolicy)(instance));
    if (!decision.allowed)
        throw new Error(decision.reason);
    exports.protection.recordSend(instanceId, digits, Date.now());
    saveProtectionSoon();
    await sendFromNumber(instanceId, session.sock, jid, digits, { text, attachments: [] }, null);
}
// Admin "clear restriction": forget the stored restriction, then ask WhatsApp whether one is really still active.
async function recheckRestriction(id) {
    updateInstance(id, { restrictedUntil: null });
    const session = sessions.get(id);
    if (!session || !isLive(id))
        return { checked: false };
    try {
        applyRestriction(id, await session.sock.fetchAccountReachoutTimelock());
        return { checked: true, restrictedUntil: store_1.registry.instances[id]?.restrictedUntil ?? null };
    }
    catch (err) {
        return { checked: false, error: (0, events_1.errorText)(err) };
    }
}
// A linked number that stays offline is reported (and alerted) once, then again when it is back.
const offlineSince = new Map();
const offlineReported = new Set();
const OFFLINE_REPORT_MS = 10 * 60_000;
// Statuses that already raised their own event, or that wait for someone to scan a QR code.
const REPORTED_STATUSES = new Set(['logged_out', 'error', 'conflict', 'qr', 'qr_expired']);
function watchOffline(now = Date.now()) {
    for (const instance of Object.values(store_1.registry.instances)) {
        const context = { instanceId: instance.id, locationId: instance.locationId };
        if (isLive(instance.id)) {
            if (offlineReported.has(instance.id))
                (0, events_1.recordEvent)('info', `WhatsApp number #${instance.slot} ${instance.name} is back online`, context);
            offlineSince.delete(instance.id);
            offlineReported.delete(instance.id);
            continue;
        }
        if (!instance.linkedAt || REPORTED_STATUSES.has(instance.status))
            continue;
        const since = offlineSince.get(instance.id) ?? now;
        offlineSince.set(instance.id, since);
        if (now - since >= OFFLINE_REPORT_MS && !offlineReported.has(instance.id)) {
            offlineReported.add(instance.id);
            (0, events_1.recordEvent)('error', `WhatsApp number #${instance.slot} ${instance.name} (${(0, events_1.maskPhone)(instance.phone)}) has been offline for ${Math.round((now - since) / 60_000)} minutes`, {
                ...context,
                detail: instance.lastError || `status: ${instance.status}`
            });
        }
    }
}
function startBackgroundJobs() {
    setInterval(() => void processPendingSync().catch(err => events_1.log.error({ err }, 'retry queue run failed')), 15_000).unref();
    setInterval(() => watchOffline(), 60_000).unref();
}
function sessionCounts() {
    const ids = Object.keys(store_1.registry.instances);
    return { total: ids.length, live: ids.filter(isLive).length };
}
