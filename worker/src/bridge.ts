import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  jidDecode,
  useMultiFileAuthState,
  type AnyMessageContent,
  type AuthenticationCreds,
  type ConnectionState,
  type proto,
  type WAMessage,
  type WAMessageUpdate,
  type WASocket
} from '@whiskeysockets/baileys';
import { DATA_DIR, MAX_MEDIA_BYTES, SEND_INTERVAL_MS, SYNC_PHONE_MESSAGES } from './config';
import { errorText, log, maskPhone, recordEvent } from './events';
import * as ghl from './ghl';
import { downloadPublicFile } from './safe-fetch';
import { registry, save, type InstanceRecord } from './store';
import {
  attachmentKind,
  extractContent,
  fileNameFromUrl,
  ghlStatusFromWa,
  isDirectChatJid,
  mediaLabel,
  resolvePhone,
  shouldAdvanceStatus,
  type ExtractedContent
} from './wa-message';

const baileysLogger = log.child({ module: 'baileys' }, { level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super();
  }
  override set(key: K, value: V) {
    if (this.has(key)) this.delete(key);
    super.set(key, value);
    if (this.size > this.limit) this.delete(this.keys().next().value as K);
    return this;
  }
}

type Session = { sock: WASocket; creds: AuthenticationCreds };
type Delivery = { locationId: string; ghlMessageId: string; status?: ghl.GhlStatus };

const sessions = new Map<string, Session>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const reconnectAttempts = new Map<string, number>();
const replacedCount = new Map<string, number>();
const instanceLocks = new Map<string, Promise<void>>();
let shuttingDown = false;

// WhatsApp message id -> the HighLevel message it delivers, so receipts can update the GHL status.
const deliveries = new BoundedMap<string, Delivery>(5000);
// Copies of what we sent; Baileys needs them to re-encrypt when a recipient asks for a retry.
const sentMessages = new BoundedMap<string, proto.IMessage>(1000);
const seenMessages = new BoundedMap<string, true>(5000);
const contactCache = new BoundedMap<string, { contactId: string; conversationId: string; at: number }>(5000);
const numberCache = new BoundedMap<string, { jid: string | null; at: number }>(5000);
// Phone-typed messages we mirrored into GHL; if GHL ever echoes one to the delivery URL it must not be re-sent.
const mirroredGhlIds = new BoundedMap<string, true>(5000);
const recentPhoneSends = new BoundedMap<string, number>(1000);
const mirrorChecked = new Set<string>();
const mirrorDisabled = new Set<string>();
const chatQueues = new Map<string, Promise<void>>();
const sendQueues = new Map<string, Promise<void>>();

const CONTACT_CACHE_MS = 6 * 3600_000;
const OFFLINE_WINDOW_MS = 48 * 3600_000;
const ECHO_WINDOW_MS = 2 * 60_000;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function authDir(id: string) {
  return path.join(DATA_DIR, 'auth', id);
}

export function updateInstance(id: string, patch: Partial<InstanceRecord>) {
  const current = registry.instances[id];
  if (!current) return;
  registry.instances[id] = { ...current, ...patch, updatedAt: new Date().toISOString() };
  void save();
}

export function isLive(id: string) {
  return sessions.has(id) && registry.instances[id]?.status === 'connected';
}

async function hasPairedCreds(id: string) {
  try {
    const creds = JSON.parse(await fs.readFile(path.join(authDir(id), 'creds.json'), 'utf8'));
    return Boolean(creds?.me?.id);
  } catch {
    return false;
  }
}

// Start/stop operations for one instance run one at a time, so a double-clicked "Restart" cannot leave two sockets alive.
function withInstanceLock(id: string, task: () => Promise<void>) {
  const run = (instanceLocks.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
  instanceLocks.set(id, run);
  void run.finally(() => instanceLocks.get(id) === run && instanceLocks.delete(id)).catch(() => undefined);
  return run;
}

export function startInstance(id: string, options: { fresh?: boolean } = {}) {
  return withInstanceLock(id, () => openSession(id, options.fresh === true));
}

function detachSession(id: string) {
  const previous = sessions.get(id);
  // Remove it from the map *before* ending it: the old socket's close event is then ignored instead of
  // deleting the new socket and scheduling yet another reconnect (which left two sessions fighting).
  sessions.delete(id);
  if (previous) {
    try {
      previous.sock.end(undefined);
    } catch {
      // already closed
    }
  }
  return previous;
}

function clearReconnect(id: string) {
  const timer = reconnectTimers.get(id);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(id);
}

async function openSession(id: string, fresh: boolean) {
  const meta = registry.instances[id];
  if (!meta) throw new Error('Instance not found');
  clearReconnect(id);
  detachSession(id);
  if (fresh || meta.status === 'logged_out') await fs.rm(authDir(id), { recursive: true, force: true });
  await fs.mkdir(authDir(id), { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir(id));
  if (!registry.instances[id]) return;
  updateInstance(id, { status: state.creds.me?.id ? 'connecting' : 'starting', qr: null, lastError: null });

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    logger: baileysLogger,
    // Staying "offline" keeps notifications flowing to the phone.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Our own sends must not come back through messages.upsert; every fromMe upsert is then a phone-typed message.
    emitOwnEvents: false,
    getMessage: async key => (key.id ? sentMessages.get(key.id) : undefined)
  });
  const session: Session = { sock, creds: state.creds };
  sessions.set(id, session);
  const isCurrent = () => sessions.get(id) === session;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', update => {
    if (!isCurrent()) return;
    handleConnectionUpdate(id, session, update).catch(err => log.error({ err, id }, 'connection.update handler failed'));
  });
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (!isCurrent()) return;
    for (const message of messages) queueIncoming(id, sock, message, type);
  });
  sock.ev.on('messages.update', updates => {
    if (isCurrent()) void syncReceipts(updates);
  });
}

async function handleConnectionUpdate(id: string, session: Session, update: Partial<ConnectionState>) {
  const meta = registry.instances[id];
  if (!meta) return;
  const context = { instanceId: id, locationId: meta.locationId };

  if (update.qr) {
    const dataUrl = await QRCode.toDataURL(update.qr, { width: 360, margin: 2 });
    if (sessions.get(id) === session) updateInstance(id, { status: 'qr', qr: dataUrl, lastError: null });
  }

  if (update.connection === 'open') {
    reconnectAttempts.delete(id);
    replacedCount.delete(id);
    const phone = jidDecode(session.sock.user?.id)?.user;
    updateInstance(id, { status: 'connected', phone, qr: null, lastError: null });
    recordEvent('info', `WhatsApp connected as ${maskPhone(phone)}`, context);
  }

  if (update.connection !== 'close') return;
  sessions.delete(id);
  if (shuttingDown) return;

  const error = update.lastDisconnect?.error as (Error & { output?: { statusCode?: number } }) | undefined;
  const code = error?.output?.statusCode;
  const reason = error?.message || 'Connection closed';
  const paired = Boolean(session.creds.me?.id);

  if (code === DisconnectReason.loggedOut) {
    // The credentials are dead; wipe them so the next start shows a fresh QR instead of failing again.
    await fs.rm(authDir(id), { recursive: true, force: true });
    updateInstance(id, { status: 'logged_out', qr: null, lastError: 'WhatsApp logged this device out. Click "Reconnect" and scan a new QR code.' });
    recordEvent('warn', 'WhatsApp logged this device out; scan a new QR code to reconnect', context);
    return;
  }
  if (code === DisconnectReason.forbidden || code === DisconnectReason.multideviceMismatch) {
    updateInstance(id, { status: 'error', qr: null, lastError: `WhatsApp refused the connection (${code}): ${reason}` });
    recordEvent('error', `WhatsApp refused the connection (${code})`, { ...context, detail: reason });
    return;
  }
  if (!paired && code === DisconnectReason.timedOut) {
    updateInstance(id, { status: 'qr_expired', qr: null, lastError: 'The QR code expired before it was scanned. Click "Reconnect" for a new one.' });
    return;
  }
  if (code === DisconnectReason.connectionReplaced) {
    const count = (replacedCount.get(id) ?? 0) + 1;
    replacedCount.set(id, count);
    recordEvent('warn', 'Another session using this WhatsApp login replaced this connection', { ...context, detail: reason });
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
  if (code === DisconnectReason.restartRequired) {
    // Normal right after a QR scan; the short pause lets saveCreds finish writing the new login first.
    scheduleReconnect(id, 1000, null);
    return;
  }
  const attempt = (reconnectAttempts.get(id) ?? 0) + 1;
  reconnectAttempts.set(id, attempt);
  scheduleReconnect(id, Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5)), reason);
}

function scheduleReconnect(id: string, delayMs: number, reason: string | null) {
  updateInstance(id, { status: 'reconnecting', lastError: reason });
  clearReconnect(id);
  const timer = setTimeout(() => {
    reconnectTimers.delete(id);
    startInstance(id).catch(err =>
      recordEvent('error', `WhatsApp reconnect failed: ${errorText(err)}`, { instanceId: id, locationId: registry.instances[id]?.locationId })
    );
  }, delayMs);
  reconnectTimers.set(id, timer);
}

export async function resumeInstances() {
  for (const instance of Object.values(registry.instances)) {
    if (instance.status !== 'logged_out' && (await hasPairedCreds(instance.id))) {
      startInstance(instance.id).catch(err =>
        recordEvent('error', `Could not resume WhatsApp session: ${errorText(err)}`, { instanceId: instance.id, locationId: instance.locationId })
      );
    } else if (instance.status !== 'logged_out') {
      updateInstance(instance.id, { status: 'disconnected', qr: null, lastError: 'Not linked yet. Click "Reconnect" to show a QR code.' });
    }
  }
}

export async function deleteInstance(id: string) {
  await withInstanceLock(id, async () => {
    clearReconnect(id);
    const session = sessions.get(id);
    sessions.delete(id);
    if (session) {
      // Unlink the device on the phone as well, then make sure the socket is gone.
      await Promise.race([session.sock.logout('Removed from the bridge dashboard').catch(() => undefined), delay(5000)]);
      try {
        session.sock.end(undefined);
      } catch {
        // already closed
      }
    }
    await fs.rm(authDir(id), { recursive: true, force: true });
    delete registry.instances[id];
    await save();
  });
}

export function shutdown() {
  shuttingDown = true;
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  for (const [id, session] of sessions) {
    sessions.delete(id);
    try {
      session.sock.end(undefined);
    } catch {
      // already closed
    }
  }
}

function timestampMs(msg: WAMessage) {
  const raw = msg.messageTimestamp as unknown;
  if (raw == null) return undefined;
  const seconds = typeof raw === 'object' && typeof (raw as { toNumber?: unknown }).toNumber === 'function' ? (raw as { toNumber: () => number }).toNumber() : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function queueIncoming(instanceId: string, sock: WASocket, msg: WAMessage, type: 'notify' | 'append') {
  const { key } = msg;
  if (!key.id || !msg.message || !isDirectChatJid(key.remoteJid)) return;
  if (key.fromMe && !SYNC_PHONE_MESSAGES) return;
  // "append" carries messages that arrived while this worker was offline; take recent ones, skip old backlog.
  const sentAt = timestampMs(msg);
  if (type === 'append' && (!sentAt || Date.now() - sentAt > OFFLINE_WINDOW_MS)) return;
  if (seenMessages.has(key.id)) return;
  const content = extractContent(msg.message);
  if (!content) return;
  seenMessages.set(key.id, true);

  // Messages of one chat are pushed in order; different chats run in parallel.
  const chatKey = `${instanceId}|${key.remoteJid}`;
  const next = (chatQueues.get(chatKey) ?? Promise.resolve())
    .then(() => syncToGhl(instanceId, sock, msg, content))
    .catch(err => {
      const detail = err instanceof ghl.GhlApiError ? `${err.message}: ${err.body}` : errorText(err);
      recordEvent('error', 'Failed to sync a WhatsApp message to HighLevel', { instanceId, locationId: registry.instances[instanceId]?.locationId, detail });
    });
  chatQueues.set(chatKey, next);
  void next.finally(() => chatQueues.get(chatKey) === next && chatQueues.delete(chatKey));
}

function phoneSendKey(locationId: string, digits: string, text: string) {
  return `${locationId}|${digits}|${text.trim()}`;
}

async function resolveContact(locationId: string, phone: string, displayName?: string) {
  const cacheKey = `${locationId}|${phone}`;
  const hit = contactCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CONTACT_CACHE_MS) return { contactId: hit.contactId, conversationId: hit.conversationId, cached: true };
  const { contactId } = await ghl.upsertContact(locationId, `+${phone}`, displayName);
  const conversationId = await ghl.findOrCreateConversation(locationId, contactId);
  contactCache.set(cacheKey, { contactId, conversationId, at: Date.now() });
  return { contactId, conversationId, cached: false };
}

async function syncToGhl(instanceId: string, sock: WASocket, msg: WAMessage, content: ExtractedContent) {
  const meta = registry.instances[instanceId];
  if (!meta) return;
  const { locationId } = meta;
  const context = { instanceId, locationId };
  const direction = msg.key.fromMe ? 'outbound' : 'inbound';
  if (direction === 'outbound' && mirrorDisabled.has(locationId)) return;

  const phone = await resolvePhone(msg.key, lid => sock.signalRepository.lidMapping.getPNForLID(lid));
  if (!phone) {
    recordEvent('warn', `Skipped a WhatsApp ${direction} message: WhatsApp hid the contact's number behind a private id (LID) and it could not be mapped yet`, context);
    return;
  }
  if (!ghl.isConnected(locationId)) {
    recordEvent('warn', `WhatsApp message ${direction === 'inbound' ? 'from' : 'to'} ${maskPhone(phone)} was not synced: location ${locationId} is not connected to HighLevel yet`, context);
    return;
  }
  if (direction === 'outbound' && content.text.trim()) recentPhoneSends.set(phoneSendKey(locationId, phone, content.text), Date.now());

  const displayName = direction === 'inbound' ? msg.pushName || undefined : undefined;
  let target = await resolveContact(locationId, phone, displayName);
  let message = content.text;
  let attachments: string[] = [];
  if (content.media) {
    attachments = await uploadMedia(sock, msg, content, locationId, target).catch(err => {
      recordEvent('warn', `Could not attach a WhatsApp ${content.media!.kind} in HighLevel; sent a text placeholder instead`, { ...context, detail: errorText(err) });
      return [];
    });
    if (!message) message = mediaLabel(content.media);
  }
  const sentAt = timestampMs(msg);
  const send = () =>
    ghl.addInboundMessageDetectingType(locationId, {
      contactId: target.contactId,
      conversationId: target.conversationId,
      message,
      attachments,
      altId: msg.key.id || undefined,
      direction,
      date: sentAt ? new Date(sentAt).toISOString() : undefined
    });

  let result: Awaited<ReturnType<typeof ghl.addInboundMessage>>;
  try {
    result = await send();
  } catch (err) {
    // The cached contact or conversation may have been deleted in HighLevel; resolve it again once.
    if (!(err instanceof ghl.GhlApiError) || !target.cached || ![400, 404, 422].includes(err.status)) throw err;
    contactCache.delete(`${locationId}|${phone}`);
    target = await resolveContact(locationId, phone, displayName);
    result = await send();
  }

  if (direction === 'inbound') {
    recordEvent('info', `Synced a WhatsApp message from ${maskPhone(phone)} into HighLevel`, context);
    return;
  }
  if (result.messageId) mirroredGhlIds.set(result.messageId, true);
  recordEvent('info', `Mirrored a message typed on the phone to ${maskPhone(phone)} into HighLevel`, context);
  void verifyMirrorDirection(locationId, result.messageId);
}

// Phone-typed messages are recorded through the inbound endpoint with direction "outbound". Check once per location
// that HighLevel really stored it as outbound; if not, stop mirroring rather than show agents fake inbound messages.
async function verifyMirrorDirection(locationId: string, messageId?: string) {
  if (!messageId || mirrorChecked.has(locationId)) return;
  mirrorChecked.add(locationId);
  try {
    const stored = await ghl.getMessage(locationId, messageId);
    if (stored?.direction && stored.direction !== 'outbound') {
      mirrorDisabled.add(locationId);
      recordEvent('error', 'HighLevel stored a phone-typed message as inbound, so mirroring of phone-typed messages was turned off for this location', {
        locationId,
        detail: `direction=${stored.direction}`
      });
    }
  } catch (err) {
    recordEvent('warn', 'Could not verify how HighLevel stored a mirrored phone message (needs the conversations/message.readonly scope)', {
      locationId,
      detail: errorText(err)
    });
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf'
};

async function uploadMedia(sock: WASocket, msg: WAMessage, content: ExtractedContent, locationId: string, target: { contactId: string; conversationId: string }) {
  const info = content.media!;
  const limitMb = Math.round(MAX_MEDIA_BYTES / 1024 / 1024);
  if (info.size && info.size > MAX_MEDIA_BYTES) throw new Error(`the file is larger than ${limitMb} MB`);
  const data = await downloadMediaMessage(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage });
  if (data.length > MAX_MEDIA_BYTES) throw new Error(`the file is larger than ${limitMb} MB`);
  const mimetype = info.mimetype.split(';')[0].trim();
  const fileName = info.fileName || `${info.kind}-${msg.key.id}.${MIME_EXTENSIONS[mimetype] || 'bin'}`;
  const urls = await ghl.uploadAttachment(locationId, { ...target, data, mimetype, fileName });
  if (!urls.length) throw new Error('HighLevel returned no URL for the uploaded file');
  return urls;
}

async function syncReceipts(updates: WAMessageUpdate[]) {
  for (const { key, update } of updates) {
    const delivery = key.id ? deliveries.get(key.id) : undefined;
    if (!delivery) continue;
    const status = ghlStatusFromWa(update.status);
    if (!status || !shouldAdvanceStatus(delivery.status, status)) continue;
    delivery.status = status;
    try {
      await ghl.updateMessageStatus(delivery.locationId, delivery.ghlMessageId, status);
    } catch (err) {
      recordEvent('warn', `Could not set the HighLevel message status to ${status}`, { locationId: delivery.locationId, detail: errorText(err) });
    }
  }
}

export type ProviderOutboundPayload = {
  locationId?: string;
  messageId?: string;
  contactId?: string;
  phone?: string;
  message?: string;
  attachments?: unknown;
  type?: string;
};

function pickInstance(locationId: string) {
  const candidates = Object.values(registry.instances).filter(i => i.locationId === locationId);
  return candidates.find(i => isLive(i.id)) || candidates[0];
}

// Sends are spaced out per number; bulk sends from workflows are queued instead of fired at once.
function enqueueSend(instanceId: string, task: () => Promise<void>) {
  const run = (sendQueues.get(instanceId) ?? Promise.resolve()).then(task);
  const gap = run.catch(() => undefined).then(() => delay(SEND_INTERVAL_MS));
  sendQueues.set(instanceId, gap);
  void gap.finally(() => sendQueues.get(instanceId) === gap && sendQueues.delete(instanceId));
  return run;
}

async function whatsappJid(sock: WASocket, digits: string): Promise<string | null> {
  const cached = numberCache.get(digits);
  if (cached && Date.now() - cached.at < 24 * 3600_000) return cached.jid;
  try {
    const results = await sock.onWhatsApp(digits);
    if (!results) return `${digits}@s.whatsapp.net`;
    const match = results.find(r => r.exists);
    const jid = match ? match.jid : null;
    numberCache.set(digits, { jid, at: Date.now() });
    return jid;
  } catch (err) {
    log.warn({ err }, 'onWhatsApp lookup failed; sending to the phone-number JID directly');
    return `${digits}@s.whatsapp.net`;
  }
}

// Attachments are downloaded here (public HTTPS hosts only, size-capped) and handed to Baileys as bytes,
// so a crafted URL in a delivery webhook cannot make the worker fetch internal addresses.
async function attachmentContent(url: string): Promise<AnyMessageContent> {
  const { data, contentType } = await downloadPublicFile(url, MAX_MEDIA_BYTES);
  const mimetype = contentType?.split(';')[0].trim() || undefined;
  switch (attachmentKind(url, mimetype)) {
    case 'image':
      return { image: data };
    case 'video':
      return { video: data };
    case 'audio':
      return { audio: data, mimetype: mimetype || 'audio/mpeg' };
    default:
      return { document: data, mimetype: mimetype || 'application/octet-stream', fileName: fileNameFromUrl(url) };
  }
}

async function sendTracked(sock: WASocket, jid: string, content: AnyMessageContent, delivery: Delivery | null) {
  const sent = await sock.sendMessage(jid, content);
  const id = sent?.key.id;
  if (!id) return;
  if (sent.message) sentMessages.set(id, sent.message);
  if (delivery) deliveries.set(id, delivery);
}

let providerVerified = false;

export function handleProviderOutbound(payload: ProviderOutboundPayload) {
  deliverToWhatsApp(payload).catch(err =>
    recordEvent('error', 'Unexpected error while delivering a HighLevel message', { locationId: payload.locationId, detail: errorText(err) })
  );
  // The message HighLevel just routed through the provider records the provider's real id; check it once per start.
  const { locationId, messageId } = payload;
  if (!providerVerified && locationId && messageId && ghl.isConnected(locationId)) {
    providerVerified = true;
    ghl.learnProviderFromMessage(locationId, messageId).catch(err => {
      providerVerified = false;
      recordEvent('warn', 'Could not read the provider id from the HighLevel message', { locationId, detail: errorText(err) });
    });
  }
}

async function deliverToWhatsApp(payload: ProviderOutboundPayload) {
  const locationId = payload.locationId || '';
  const context = { locationId };
  const fail = async (reason: string, detail?: string) => {
    recordEvent('error', `HighLevel message not delivered to WhatsApp: ${reason}`, { ...context, detail });
    if (!payload.messageId || !ghl.isConnected(locationId)) return;
    await ghl.updateMessageStatus(locationId, payload.messageId, 'failed', reason).catch(err =>
      recordEvent('warn', 'Could not mark the HighLevel message as failed', { ...context, detail: errorText(err) })
    );
  };

  if (payload.messageId && mirroredGhlIds.has(payload.messageId)) return;
  let phone = payload.phone || '';
  // Some provider payloads carry only the contact; its phone number is on the contact record.
  if (!phone && payload.contactId && ghl.isConnected(locationId)) {
    phone = (await ghl.getContactPhone(locationId, payload.contactId).catch(() => null)) || '';
  }
  const digits = phone.replace(/\D/g, '');
  const text = (payload.message || '').trim();
  const attachments = (Array.isArray(payload.attachments) ? payload.attachments : []).filter(
    (u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u)
  );
  const echoAt = digits && text ? recentPhoneSends.get(phoneSendKey(locationId, digits, text)) : undefined;
  if (echoAt && Date.now() - echoAt < ECHO_WINDOW_MS) return;

  if (!digits) return fail('the contact has no phone number');
  if (!text && !attachments.length) return fail('the message is empty');
  const instance = pickInstance(locationId);
  if (!instance) return fail('no WhatsApp number is linked to this sub-account yet. Create an instance on the bridge dashboard and scan the QR code.');
  const session = sessions.get(instance.id);
  if (!session || !isLive(instance.id)) return fail(`WhatsApp is not connected (status: ${instance.status}). Reconnect it on the bridge dashboard.`);

  const jid = await whatsappJid(session.sock, digits);
  if (!jid) return fail(`${maskPhone(digits)} is not registered on WhatsApp`);
  const delivery: Delivery | null = payload.messageId ? { locationId, ghlMessageId: payload.messageId } : null;
  try {
    await enqueueSend(instance.id, async () => {
      if (text) await sendTracked(session.sock, jid, { text }, delivery);
      for (const url of attachments) await sendTracked(session.sock, jid, await attachmentContent(url), delivery);
    });
    recordEvent('info', `Delivered a HighLevel message to WhatsApp ${maskPhone(digits)}`, { ...context, instanceId: instance.id, detail: `provider message type: ${payload.type || 'not given'}` });
  } catch (err) {
    await fail('WhatsApp rejected the send', errorText(err));
  }
}

export async function sendDirect(instanceId: string, to: string, text: string) {
  const session = sessions.get(instanceId);
  if (!session || !isLive(instanceId)) throw new Error('Instance is not connected');
  const digits = to.replace(/\D/g, '');
  const jid = await whatsappJid(session.sock, digits);
  if (!jid) throw new Error(`${maskPhone(digits)} is not registered on WhatsApp`);
  let id: string | null = null;
  await enqueueSend(instanceId, async () => {
    const sent = await session.sock.sendMessage(jid, { text });
    id = sent?.key.id || null;
    if (id && sent?.message) sentMessages.set(id, sent.message);
  });
  return id;
}
