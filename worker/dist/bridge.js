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
exports.authDir = authDir;
exports.updateInstance = updateInstance;
exports.isLive = isLive;
exports.startInstance = startInstance;
exports.resumeInstances = resumeInstances;
exports.deleteInstance = deleteInstance;
exports.shutdown = shutdown;
exports.handleProviderOutbound = handleProviderOutbound;
exports.sendDirect = sendDirect;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const qrcode_1 = __importDefault(require("qrcode"));
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const config_1 = require("./config");
const events_1 = require("./events");
const ghl = __importStar(require("./ghl"));
const safe_fetch_1 = require("./safe-fetch");
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
const contactCache = new BoundedMap(5000);
const numberCache = new BoundedMap(5000);
// Phone-typed messages we mirrored into GHL; if GHL ever echoes one to the delivery URL it must not be re-sent.
const mirroredGhlIds = new BoundedMap(5000);
const recentPhoneSends = new BoundedMap(1000);
const mirrorChecked = new Set();
const mirrorDisabled = new Set();
const chatQueues = new Map();
const sendQueues = new Map();
const CONTACT_CACHE_MS = 6 * 3600_000;
const OFFLINE_WINDOW_MS = 48 * 3600_000;
const ECHO_WINDOW_MS = 2 * 60_000;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
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
            void syncReceipts(updates);
    });
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
    if (update.connection === 'open') {
        reconnectAttempts.delete(id);
        replacedCount.delete(id);
        const phone = (0, baileys_1.jidDecode)(session.sock.user?.id)?.user;
        updateInstance(id, { status: 'connected', phone, qr: null, lastError: null });
        (0, events_1.recordEvent)('info', `WhatsApp connected as ${(0, events_1.maskPhone)(phone)}`, context);
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
        (0, events_1.recordEvent)('warn', 'WhatsApp logged this device out; scan a new QR code to reconnect', context);
        return;
    }
    if (code === baileys_1.DisconnectReason.forbidden || code === baileys_1.DisconnectReason.multideviceMismatch) {
        updateInstance(id, { status: 'error', qr: null, lastError: `WhatsApp refused the connection (${code}): ${reason}` });
        (0, events_1.recordEvent)('error', `WhatsApp refused the connection (${code})`, { ...context, detail: reason });
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
        delete store_1.registry.instances[id];
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
    if (seenMessages.has(key.id))
        return;
    const content = (0, wa_message_1.extractContent)(msg.message);
    if (!content)
        return;
    seenMessages.set(key.id, true);
    // Messages of one chat are pushed in order; different chats run in parallel.
    const chatKey = `${instanceId}|${key.remoteJid}`;
    const next = (chatQueues.get(chatKey) ?? Promise.resolve())
        .then(() => syncToGhl(instanceId, sock, msg, content))
        .catch(err => {
        const detail = err instanceof ghl.GhlApiError ? `${err.message}: ${err.body}` : (0, events_1.errorText)(err);
        (0, events_1.recordEvent)('error', 'Failed to sync a WhatsApp message to HighLevel', { instanceId, locationId: store_1.registry.instances[instanceId]?.locationId, detail });
    });
    chatQueues.set(chatKey, next);
    void next.finally(() => chatQueues.get(chatKey) === next && chatQueues.delete(chatKey));
}
function phoneSendKey(locationId, digits, text) {
    return `${locationId}|${digits}|${text.trim()}`;
}
async function resolveContact(locationId, phone, displayName) {
    const cacheKey = `${locationId}|${phone}`;
    const hit = contactCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CONTACT_CACHE_MS)
        return { contactId: hit.contactId, conversationId: hit.conversationId, cached: true };
    const { contactId } = await ghl.upsertContact(locationId, `+${phone}`, displayName);
    const conversationId = await ghl.findOrCreateConversation(locationId, contactId);
    contactCache.set(cacheKey, { contactId, conversationId, at: Date.now() });
    return { contactId, conversationId, cached: false };
}
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
    if (!ghl.isConnected(locationId)) {
        (0, events_1.recordEvent)('warn', `WhatsApp message ${direction === 'inbound' ? 'from' : 'to'} ${(0, events_1.maskPhone)(phone)} was not synced: location ${locationId} is not connected to HighLevel yet`, context);
        return;
    }
    if (direction === 'outbound' && content.text.trim())
        recentPhoneSends.set(phoneSendKey(locationId, phone, content.text), Date.now());
    const displayName = direction === 'inbound' ? msg.pushName || undefined : undefined;
    let target = await resolveContact(locationId, phone, displayName);
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
    const sentAt = timestampMs(msg);
    const send = () => ghl.addInboundMessage(locationId, {
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
    const data = await (0, baileys_1.downloadMediaMessage)(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage });
    if (data.length > config_1.MAX_MEDIA_BYTES)
        throw new Error(`the file is larger than ${limitMb} MB`);
    const mimetype = info.mimetype.split(';')[0].trim();
    const fileName = info.fileName || `${info.kind}-${msg.key.id}.${MIME_EXTENSIONS[mimetype] || 'bin'}`;
    const urls = await ghl.uploadAttachment(locationId, { ...target, data, mimetype, fileName });
    if (!urls.length)
        throw new Error('HighLevel returned no URL for the uploaded file');
    return urls;
}
async function syncReceipts(updates) {
    for (const { key, update } of updates) {
        const delivery = key.id ? deliveries.get(key.id) : undefined;
        if (!delivery)
            continue;
        const status = (0, wa_message_1.ghlStatusFromWa)(update.status);
        if (!status || !(0, wa_message_1.shouldAdvanceStatus)(delivery.status, status))
            continue;
        delivery.status = status;
        try {
            await ghl.updateMessageStatus(delivery.locationId, delivery.ghlMessageId, status);
        }
        catch (err) {
            (0, events_1.recordEvent)('warn', `Could not set the HighLevel message status to ${status}`, { locationId: delivery.locationId, detail: (0, events_1.errorText)(err) });
        }
    }
}
function pickInstance(locationId) {
    const candidates = Object.values(store_1.registry.instances).filter(i => i.locationId === locationId);
    return candidates.find(i => isLive(i.id)) || candidates[0];
}
// Sends are spaced out per number; bulk sends from workflows are queued instead of fired at once.
function enqueueSend(instanceId, task) {
    const run = (sendQueues.get(instanceId) ?? Promise.resolve()).then(task);
    const gap = run.catch(() => undefined).then(() => delay(config_1.SEND_INTERVAL_MS));
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
function handleProviderOutbound(payload) {
    deliverToWhatsApp(payload).catch(err => (0, events_1.recordEvent)('error', 'Unexpected error while delivering a HighLevel message', { locationId: payload.locationId, detail: (0, events_1.errorText)(err) }));
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
    const digits = (payload.phone || '').replace(/\D/g, '');
    const text = (payload.message || '').trim();
    const attachments = (Array.isArray(payload.attachments) ? payload.attachments : []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    const echoAt = digits && text ? recentPhoneSends.get(phoneSendKey(locationId, digits, text)) : undefined;
    if (echoAt && Date.now() - echoAt < ECHO_WINDOW_MS)
        return;
    if (!digits)
        return fail('the contact has no phone number');
    if (!text && !attachments.length)
        return fail('the message is empty');
    const instance = pickInstance(locationId);
    if (!instance)
        return fail('no WhatsApp number is linked to this sub-account yet. Create an instance on the bridge dashboard and scan the QR code.');
    const session = sessions.get(instance.id);
    if (!session || !isLive(instance.id))
        return fail(`WhatsApp is not connected (status: ${instance.status}). Reconnect it on the bridge dashboard.`);
    const jid = await whatsappJid(session.sock, digits);
    if (!jid)
        return fail(`${(0, events_1.maskPhone)(digits)} is not registered on WhatsApp`);
    const delivery = payload.messageId ? { locationId, ghlMessageId: payload.messageId } : null;
    try {
        await enqueueSend(instance.id, async () => {
            if (text)
                await sendTracked(session.sock, jid, { text }, delivery);
            for (const url of attachments)
                await sendTracked(session.sock, jid, await attachmentContent(url), delivery);
        });
        (0, events_1.recordEvent)('info', `Delivered a HighLevel message to WhatsApp ${(0, events_1.maskPhone)(digits)}`, { ...context, instanceId: instance.id });
    }
    catch (err) {
        await fail('WhatsApp rejected the send', (0, events_1.errorText)(err));
    }
}
async function sendDirect(instanceId, to, text) {
    const session = sessions.get(instanceId);
    if (!session || !isLive(instanceId))
        throw new Error('Instance is not connected');
    const digits = to.replace(/\D/g, '');
    const jid = await whatsappJid(session.sock, digits);
    if (!jid)
        throw new Error(`${(0, events_1.maskPhone)(digits)} is not registered on WhatsApp`);
    let id = null;
    await enqueueSend(instanceId, async () => {
        const sent = await session.sock.sendMessage(jid, { text });
        id = sent?.key.id || null;
        if (id && sent?.message)
            sentMessages.set(id, sent.message);
    });
    return id;
}
