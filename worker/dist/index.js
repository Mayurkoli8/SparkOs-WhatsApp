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
const express_1 = __importDefault(require("express"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const qrcode_1 = __importDefault(require("qrcode"));
const pino_1 = __importDefault(require("pino"));
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const log = (0, pino_1.default)({ level: process.env.LOG_LEVEL || 'info' });
const app = (0, express_1.default)();
app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/webhooks/ghl/outbound') {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { data += c; if (data.length > 2_000_000)
            req.destroy(); });
        req.on('end', () => { req.rawBody = data; try {
            req.body = JSON.parse(data || '{}');
        }
        catch {
            req.body = {};
        } ; next(); });
    }
    else
        next();
});
app.use(express_1.default.json({ limit: '2mb' }));
const PORT = Number(process.env.PORT || 3001);
const DATA_DIR = process.env.DATA_DIR || node_path_1.default.resolve(process.cwd(), 'data');
const REGISTRY_FILE = node_path_1.default.join(DATA_DIR, 'registry.json');
const SECRET_KEY = process.env.TOKEN_ENCRYPTION_KEY;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const GHL_BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const GHL_VERSION = process.env.GHL_VERSION || 'v3';
const PROVIDER_ID = process.env.GHL_CONVERSATION_PROVIDER_ID || '';
const INBOUND_TYPE = (process.env.GHL_INBOUND_TYPE || 'SMS');
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID || '';
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET || '';
const GHL_REDIRECT_URI = process.env.GHL_REDIRECT_URI || '';
const GHL_SIG_BYPASS = process.env.DISABLE_GHL_SIGNATURE === 'true';
const GHL_PUB = process.env.GHL_WEBHOOK_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n-----END PUBLIC KEY-----`;
const sockets = new Map();
const qrCache = new Map();
const outboundMap = new Map();
let registry = { instances: {}, ghl: {} };
function auth(req, res, next) {
    if (req.path === '/health')
        return next();
    if (!INTERNAL_API_KEY || req.header('x-internal-api-key') !== INTERNAL_API_KEY)
        return res.status(401).json({ error: 'Unauthorized' });
    next();
}
app.use(auth);
async function ensureData() { await promises_1.default.mkdir(DATA_DIR, { recursive: true }); try {
    registry = JSON.parse(await promises_1.default.readFile(REGISTRY_FILE, 'utf8'));
}
catch {
    await save();
} }
async function save() { await promises_1.default.writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8'); }
function key32() {
    if (!SECRET_KEY)
        throw new Error('TOKEN_ENCRYPTION_KEY is required');
    const b = Buffer.from(SECRET_KEY, 'base64');
    if (b.length !== 32)
        throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    return b;
}
function enc(value) { const iv = node_crypto_1.default.randomBytes(12), cipher = node_crypto_1.default.createCipheriv('aes-256-gcm', key32(), iv); const c = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), c.toString('base64')].join('.'); }
function dec(value) { const [ivS, tagS, cS] = value.split('.'); const decipher = node_crypto_1.default.createDecipheriv('aes-256-gcm', key32(), Buffer.from(ivS, 'base64')); decipher.setAuthTag(Buffer.from(tagS, 'base64')); return Buffer.concat([decipher.update(Buffer.from(cS, 'base64')), decipher.final()]).toString('utf8'); }
function normalizePhone(input) { return (input || '').replace(/\D/g, ''); }
function jidFromPhone(input) { const p = normalizePhone(input); return p.includes('@') ? input : `${p}@s.whatsapp.net`; }
async function pushInbound(instance, from, text, messageId, when) {
    const g = registry.ghl[instance.locationId];
    if (!g) {
        log.warn({ locationId: instance.locationId }, 'No GHL OAuth connection for instance');
        return;
    }
    const access = await getValidGhlToken(instance.locationId);
    const payload = {
        type: INBOUND_TYPE,
        contactId: undefined,
        message: text,
        conversationProviderId: PROVIDER_ID,
        direction: 'inbound',
        date: new Date(when || Date.now()).toISOString(),
        altId: messageId
    };
    const contact = await ghlFetch(access, `/contacts/upsert`, { method: 'POST', body: { locationId: instance.locationId, phone: `+${normalizePhone(from)}`, source: 'WhatsApp Bridge' } });
    if (!contact.ok) {
        const errorBody = await contact.text();
        log.error({
            status: contact.status,
            body: errorBody,
            locationId: instance.locationId,
        }, 'GHL contact upsert failed');
        return;
    }
    const cd = await contact.json();
    payload.contactId = cd.contact?.id || cd.contactId;
    const r = await ghlFetch(access, `/conversations/messages/inbound`, { method: 'POST', body: payload });
    if (!r.ok) {
        log.error({ status: r.status, body: await r.text() }, 'GHL inbound failed');
    }
}
async function getValidGhlToken(locationId) {
    const g = registry.ghl[locationId];
    if (!g)
        throw new Error(`No GHL token for ${locationId}`);
    if (g.expiresAt && g.expiresAt > Date.now() + 120000)
        return dec(g.accessToken);
    if (!g.refreshToken)
        return dec(g.accessToken);
    const refresh = dec(g.refreshToken);
    const body = new URLSearchParams({ client_id: GHL_CLIENT_ID, client_secret: GHL_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refresh, user_type: 'Location', redirect_uri: GHL_REDIRECT_URI });
    const r = await fetch(`${GHL_BASE}/oauth/token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!r.ok)
        throw new Error(`GHL refresh failed: ${r.status} ${await r.text()}`);
    const d = await r.json();
    g.accessToken = enc(d.access_token);
    if (d.refresh_token)
        g.refreshToken = enc(d.refresh_token);
    g.expiresAt = Date.now() + Number(d.expires_in || 86400) * 1000;
    g.updatedAt = new Date().toISOString();
    registry.ghl[locationId] = g;
    await save();
    return d.access_token;
}
async function ghlFetch(token, endpoint, opts = {}) {
    const r = await fetch(`${GHL_BASE}${endpoint}`, { method: opts.method || 'GET', headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return r;
}
function providerBody(raw, sig) {
    if (GHL_SIG_BYPASS)
        return JSON.parse(raw);
    if (!sig || sig === 'N/A')
        throw new Error('Missing GHL signature');
    const publicKey = node_crypto_1.default.createPublicKey(GHL_PUB);
    const ok = node_crypto_1.default.verify(null, Buffer.from(raw, 'utf8'), publicKey, Buffer.from(sig, 'base64'));
    if (!ok)
        throw new Error('Invalid GHL signature');
    return JSON.parse(raw);
}
async function startInstance(id) {
    const meta = registry.instances[id];
    if (!meta)
        throw new Error('Instance not found');
    if (sockets.has(id))
        try {
            sockets.get(id)?.end(undefined);
        }
        catch { }
    const authPath = node_path_1.default.join(DATA_DIR, 'auth', id);
    await promises_1.default.mkdir(authPath, { recursive: true });
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(authPath);
    registry.instances[id].status = 'starting';
    registry.instances[id].qr = null;
    qrCache.delete(id);
    await save();
    const sock = (0, baileys_1.default)({ auth: state, browser: baileys_1.Browsers.ubuntu('Chrome'), printQRInTerminal: false, logger: log });
    sockets.set(id, sock);
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            qrCache.set(id, await qrcode_1.default.toDataURL(qr, { width: 360, margin: 2 }));
            registry.instances[id].qr = qrCache.get(id);
            registry.instances[id].status = 'qr';
            await save();
        }
        if (connection === 'open') {
            const phone = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0];
            registry.instances[id].status = 'connected';
            registry.instances[id].phone = phone;
            registry.instances[id].qr = null;
            qrCache.delete(id);
            await save();
            log.info({ id, phone }, 'WhatsApp connected');
        }
        if (connection === 'close') {
            sockets.delete(id);
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === baileys_1.DisconnectReason.loggedOut) {
                registry.instances[id].status = 'logged_out';
                await save();
                return;
            }
            registry.instances[id].status = 'reconnecting';
            await save();
            setTimeout(() => startInstance(id).catch(e => log.error(e, 'restart failed')), 3000);
        }
    });
    sock.ev.on('messages.update', async (updates) => {
        for (const u of updates) {
            const waId = u.key?.id;
            const m = outboundMap.get(waId);
            if (!m)
                continue;
            let status = null;
            const ack = String(u.update?.status || '').toLowerCase();
            if (ack.includes('read'))
                status = 'read';
            else if (ack.includes('deliver'))
                status = 'delivered';
            if (!status)
                continue;
            try {
                const token = await getValidGhlToken(m.locationId);
                const r = await ghlFetch(token, `/conversations/messages/${m.ghlMessageId}/status`, { method: 'PUT', body: { status } });
                if (!r.ok)
                    log.warn({ status: r.status }, 'GHL message status update failed');
            }
            catch (e) {
                log.warn({ err: e }, 'GHL status sync failed');
            }
        }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify')
            return;
        for (const m of messages) {
            if (m.key.fromMe)
                continue;
            if (!m.message)
                continue;
            const text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption;
            const remote = m.key.remoteJid;
            if (!text || !remote || remote.endsWith('@g.us') || remote.includes('status'))
                continue;
            const from = remote.split('@')[0];
            await pushInbound(meta, from, text, m.key.id || node_crypto_1.default.randomUUID(), m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now());
        }
    });
}
app.get('/health', (_req, res) => res.json({ ok: true, instances: Object.keys(registry.instances).length }));
app.get('/instances', (_req, res) => res.json({ instances: Object.values(registry.instances).map(({ id, name, locationId, status, phone, createdAt, qr }) => ({ id, name, locationId, status, phone, createdAt, qr: qr || null })) }));
app.post('/instances', async (req, res) => { try {
    const { locationId, name = 'WhatsApp Instance' } = req.body || {};
    if (!locationId)
        return res.status(400).json({ error: 'locationId is required' });
    if (!registry.ghl[locationId])
        log.warn({ locationId }, 'Creating instance before GHL OAuth connection');
    const id = node_crypto_1.default.randomUUID();
    registry.instances[id] = { id, name, locationId, status: 'starting', createdAt: new Date().toISOString(), qr: null };
    await save();
    await startInstance(id);
    res.json({ instance: registry.instances[id] });
}
catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
} });
app.get('/instances/:id', async (req, res) => { const i = registry.instances[req.params.id]; if (!i)
    return res.status(404).json({ error: 'Not found' }); res.json({ instance: i }); });
app.post('/instances/:id/restart', async (req, res) => { try {
    await startInstance(req.params.id);
    res.json({ ok: true, instance: registry.instances[req.params.id] });
}
catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
} });
app.delete('/instances/:id', async (req, res) => { const i = registry.instances[req.params.id]; if (!i)
    return res.status(404).json({ error: 'Not found' }); try {
    sockets.get(req.params.id)?.end(undefined);
}
catch { } sockets.delete(req.params.id); await promises_1.default.rm(node_path_1.default.join(DATA_DIR, 'auth', req.params.id), { recursive: true, force: true }); delete registry.instances[req.params.id]; qrCache.delete(req.params.id); await save(); res.json({ ok: true }); });
app.post('/instances/:id/send', async (req, res) => { try {
    const { to, text } = req.body || {};
    const sock = sockets.get(req.params.id);
    if (!sock)
        return res.status(409).json({ error: 'Instance is not connected' });
    if (!to || !text)
        return res.status(400).json({ error: 'to and text required' });
    const result = await sock.sendMessage(jidFromPhone(to), { text });
    res.json({ ok: true, key: result?.key || null });
}
catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
} });
app.get('/integrations/ghl', (_req, res) => res.json({ connections: Object.values(registry.ghl).map(x => ({ locationId: x.locationId, connected: true, updatedAt: x.updatedAt })) }));
app.post('/integrations/ghl/connect', async (req, res) => { try {
    const { locationId, accessToken, refreshToken, expiresIn, scope, userId, companyId } = req.body || {};
    if (!locationId || !accessToken)
        return res.status(400).json({ error: 'locationId and accessToken required' });
    if (!SECRET_KEY)
        throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
    registry.ghl[locationId] = { locationId, accessToken: enc(accessToken), refreshToken: refreshToken ? enc(refreshToken) : undefined, expiresAt: expiresIn ? Date.now() + Number(expiresIn) * 1000 : undefined, scope, userId, companyId, updatedAt: new Date().toISOString() };
    await save();
    res.json({ ok: true, locationId });
}
catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
} });
app.post('/webhooks/ghl/outbound', async (req, res) => {
    try {
        const raw = req.rawBody ||
            JSON.stringify(req.body);
        const body = providerBody(raw, req.header('x-ghl-signature') || '');
        const locationId = body.locationId;
        const i = Object.values(registry.instances).find(x => x.locationId === locationId);
        if (!i) {
            return res.status(404).json({
                error: 'No WhatsApp instance for this location'
            });
        }
        const to = body.phone ||
            body.toNumber ||
            body.to ||
            body.contact?.phone;
        const text = body.message || body.text;
        if (!to || !text) {
            return res.status(400).json({
                error: 'Outbound payload missing phone or message'
            });
        }
        const sock = sockets.get(i.id);
        if (!sock) {
            return res.status(409).json({
                error: 'WhatsApp instance not connected'
            });
        }
        const result = await sock.sendMessage(jidFromPhone(to), { text });
        const providerMessageId = result?.key?.id || node_crypto_1.default.randomUUID();
        if (body.messageId) {
            outboundMap.set(providerMessageId, {
                locationId,
                ghlMessageId: body.messageId
            });
        }
        res.json({
            success: true,
            providerMessageId,
            messageId: body.messageId || null
        });
    }
    catch (e) {
        log.error(e, 'GHL outbound error');
        res.status(400).json({
            error: e instanceof Error ? e.message : 'Bad request'
        });
    }
});
// Express 5 JSON parser does not expose the raw body after parsing. Rebuild raw JSON for signature checking is not safe in general.
// In production, use express.raw() only on /webhooks/ghl/outbound before JSON parsing and verify the exact bytes. This starter therefore accepts a DEV_BYPASS_SIGNATURE=true mode.
const origRaw = app.use;
(async () => {
    await ensureData();
    // Auto-resume sessions after process restart.
    for (const id of Object.keys(registry.instances)) {
        startInstance(id).catch(e => log.error({ id, err: e }, 'Failed to resume instance'));
    }
    app.listen(PORT, '0.0.0.0', () => log.info({ port: PORT }, 'Worker listening'));
})();
