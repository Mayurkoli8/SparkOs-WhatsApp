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
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_path_1 = __importDefault(require("node:path"));
const express_1 = __importDefault(require("express"));
const config_1 = require("./config");
const events_1 = require("./events");
const ghl = __importStar(require("./ghl"));
const bridge = __importStar(require("./bridge"));
const store_1 = require("./store");
const signature_1 = require("./signature");
const startedAt = new Date().toISOString();
const ghlPublicKey = (0, signature_1.loadGhlPublicKey)(config_1.GHL_WEBHOOK_PUBLIC_KEY);
const WEBHOOK_PATH = '/webhooks/ghl/outbound';
const app = (0, express_1.default)();
app.disable('x-powered-by');
// The delivery webhook is verified against its exact bytes, so it must not go through the JSON parser.
const jsonBody = express_1.default.json({ limit: '2mb' });
app.use((req, res, next) => (req.path === WEBHOOK_PATH ? next() : jsonBody(req, res, next)));
function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && node_crypto_1.default.timingSafeEqual(left, right);
}
app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/health')
        return next();
    if (!config_1.INTERNAL_API_KEY || !safeEqual(req.header('x-internal-api-key') || '', config_1.INTERNAL_API_KEY)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});
const publicInstance = ({ id, name, locationId, status, phone, createdAt, updatedAt, qr, lastError }) => ({
    id,
    name,
    locationId,
    status,
    phone,
    createdAt,
    updatedAt,
    qr: qr || null,
    lastError: lastError || null,
    ghlConnected: Boolean(store_1.registry.ghl[locationId])
});
function sendError(res, err, status = 500) {
    res.status(status).json({ error: (0, events_1.errorText)(err) });
}
app.get('/', (_req, res) => res.json({ service: 'ghl-whatsapp-bridge-worker', ok: true, health: '/health' }));
app.get('/health', (_req, res) => {
    const instances = Object.values(store_1.registry.instances);
    res.json({
        ok: true,
        build: config_1.BUILD,
        commit: config_1.COMMIT || null,
        startedAt,
        instances: instances.length,
        connected: instances.filter(i => bridge.isLive(i.id)).length
    });
});
app.get('/instances', (_req, res) => res.json({ instances: Object.values(store_1.registry.instances).map(publicInstance) }));
app.post('/instances', async (req, res) => {
    try {
        const locationId = String(req.body?.locationId || '').trim();
        const name = String(req.body?.name || 'WhatsApp Instance').trim() || 'WhatsApp Instance';
        if (!locationId)
            return res.status(400).json({ error: 'locationId is required' });
        const id = node_crypto_1.default.randomUUID();
        store_1.registry.instances[id] = { id, name, locationId, status: 'starting', createdAt: new Date().toISOString(), qr: null, lastError: null };
        await (0, store_1.save)();
        if (!store_1.registry.ghl[locationId])
            (0, events_1.recordEvent)('warn', `Instance created for ${locationId}, which is not connected to HighLevel yet`, { instanceId: id, locationId });
        await bridge.startInstance(id);
        res.json({ instance: publicInstance(store_1.registry.instances[id]) });
    }
    catch (err) {
        sendError(res, err);
    }
});
app.get('/instances/:id', (req, res) => {
    const instance = store_1.registry.instances[req.params.id];
    if (!instance)
        return res.status(404).json({ error: 'Not found' });
    res.json({ instance: publicInstance(instance) });
});
app.post('/instances/:id/restart', async (req, res) => {
    try {
        if (!store_1.registry.instances[req.params.id])
            return res.status(404).json({ error: 'Not found' });
        await bridge.startInstance(req.params.id, { fresh: req.body?.fresh === true });
        res.json({ ok: true, instance: publicInstance(store_1.registry.instances[req.params.id]) });
    }
    catch (err) {
        sendError(res, err);
    }
});
app.delete('/instances/:id', async (req, res) => {
    try {
        if (!store_1.registry.instances[req.params.id])
            return res.status(404).json({ error: 'Not found' });
        await bridge.deleteInstance(req.params.id);
        res.json({ ok: true });
    }
    catch (err) {
        sendError(res, err);
    }
});
app.post('/instances/:id/send', async (req, res) => {
    try {
        const { to, text } = req.body || {};
        if (!to || !text)
            return res.status(400).json({ error: 'to and text required' });
        res.json({ ok: true, id: await bridge.sendDirect(req.params.id, String(to), String(text)) });
    }
    catch (err) {
        sendError(res, err, 409);
    }
});
function connectionSummary(locationId) {
    const conn = store_1.registry.ghl[locationId];
    const claims = ghl.tokenClaims(locationId);
    return {
        locationId,
        connected: true,
        userType: conn.userType || null,
        tokenClass: claims?.authClass || null,
        tokenClassId: claims?.authClassId || null,
        scope: conn.scope || null,
        missingScopes: ghl.missingScopes(conn.scope),
        expiresAt: conn.expiresAt ? new Date(conn.expiresAt).toISOString() : null,
        canRefresh: Boolean(conn.refreshToken),
        lastError: ghl.connectionProblem(locationId),
        updatedAt: conn.updatedAt
    };
}
app.get('/integrations/ghl', (_req, res) => res.json({ connections: Object.keys(store_1.registry.ghl).map(connectionSummary) }));
async function checkConnection(locationId) {
    try {
        await ghl.testConnection(locationId);
        return { ok: true };
    }
    catch (err) {
        return {
            ok: false,
            status: err instanceof ghl.GhlApiError ? err.status : null,
            error: (0, events_1.errorText)(err),
            body: err instanceof ghl.GhlApiError ? err.body : undefined
        };
    }
}
app.post('/integrations/ghl/connect', async (req, res) => {
    try {
        const { locationId, accessToken, refreshToken, expiresIn, scope, userId, companyId, userType } = req.body || {};
        if (!locationId || !accessToken)
            return res.status(400).json({ error: 'locationId and accessToken required' });
        await ghl.saveConnection({ locationId, accessToken, refreshToken, expiresIn, scope, userId, companyId, userType });
        const check = await checkConnection(locationId);
        const problem = ghl.connectionProblem(locationId);
        if (check.ok && !problem)
            (0, events_1.recordEvent)('info', `HighLevel connected for location ${locationId}`, { locationId });
        else
            (0, events_1.recordEvent)('error', `HighLevel token saved for ${locationId}, but ${problem || 'a test API call failed'}`, { locationId, detail: check.ok ? undefined : `${check.error} ${check.body || ''}` });
        res.json({ ok: true, locationId, check });
    }
    catch (err) {
        sendError(res, err);
    }
});
app.post('/integrations/ghl/:locationId/test', async (req, res) => {
    if (!store_1.registry.ghl[req.params.locationId])
        return res.status(404).json({ error: 'Location is not connected' });
    res.json(await checkConnection(req.params.locationId));
});
app.post(WEBHOOK_PATH, express_1.default.raw({ type: () => true, limit: '2mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.header('x-ghl-signature') || undefined;
    if (!config_1.SIGNATURE_CHECK_DISABLED && !(0, signature_1.verifyGhlSignature)(raw, signature, ghlPublicKey.key)) {
        (0, events_1.recordEvent)('warn', signature ? 'Rejected a delivery webhook with an invalid X-GHL-Signature' : 'Rejected a delivery webhook without an X-GHL-Signature header');
        return res.status(401).json({ error: signature ? 'Invalid GHL signature' : 'Missing GHL signature' });
    }
    let payload;
    try {
        payload = JSON.parse(raw.toString('utf8'));
    }
    catch {
        return res.status(400).json({ error: 'Body is not valid JSON' });
    }
    if (!payload?.locationId)
        return res.status(400).json({ error: 'locationId is missing' });
    // Acknowledge right away; the result is reported back to HighLevel through the message status API.
    bridge.handleProviderOutbound(payload);
    res.json({ success: true, messageId: payload.messageId ?? null });
});
app.get('/diagnostics', (_req, res) => {
    const instances = Object.values(store_1.registry.instances);
    const locations = Object.keys(store_1.registry.ghl);
    const relative = config_1.VOLUME_PATH ? node_path_1.default.relative(config_1.VOLUME_PATH, config_1.DATA_DIR) : null;
    const persistent = relative === null ? null : !relative.startsWith('..') && !node_path_1.default.isAbsolute(relative);
    const keySource = (0, store_1.getTokenKeySource)();
    const unlinkedLocations = [...new Set(instances.map(i => i.locationId))].filter(l => !store_1.registry.ghl[l]);
    const brokenLocations = locations.map(l => [l, ghl.connectionProblem(l)]).filter(([, problem]) => problem);
    const checks = [
        persistent === true
            ? { id: 'storage', level: 'ok', message: `Data is stored on the attached volume (${config_1.DATA_DIR}).` }
            : persistent === false
                ? { id: 'storage', level: 'error', message: `DATA_DIR (${config_1.DATA_DIR}) is outside the attached volume (${config_1.VOLUME_PATH}); sessions and tokens are lost on every deploy.` }
                : { id: 'storage', level: 'warn', message: `No Railway volume detected. Unless ${config_1.DATA_DIR} is on a persistent disk, WhatsApp sessions and HighLevel tokens are lost on every redeploy.` },
        config_1.PROVIDER_ID
            ? { id: 'provider', level: 'ok', message: `Conversation provider id: ${config_1.PROVIDER_ID}` }
            : { id: 'provider', level: 'warn', message: 'GHL_CONVERSATION_PROVIDER_ID is not set on the worker. Inbound messages only work if the app is the default SMS provider.' },
        config_1.GHL_CLIENT_ID && config_1.GHL_CLIENT_SECRET
            ? { id: 'oauth-client', level: 'ok', message: 'GHL client id and secret are set, so tokens can be refreshed.' }
            : { id: 'oauth-client', level: 'error', message: 'GHL_CLIENT_ID / GHL_CLIENT_SECRET are missing on the worker; the HighLevel token will stop working after ~24h.' },
        keySource === 'generated'
            ? { id: 'token-key', level: 'warn', message: 'TOKEN_ENCRYPTION_KEY is not set; using a key generated in the data directory.' }
            : { id: 'token-key', level: 'ok', message: keySource === 'env' ? 'Tokens are encrypted with TOKEN_ENCRYPTION_KEY.' : 'Tokens are encrypted with a key derived from TOKEN_ENCRYPTION_KEY.' },
        config_1.SIGNATURE_CHECK_DISABLED
            ? { id: 'signature', level: 'error', message: 'DISABLE_GHL_SIGNATURE=true: anyone can make this number send WhatsApp messages. Remove it.' }
            : ghlPublicKey.error
                ? { id: 'signature', level: 'warn', message: ghlPublicKey.error }
                : { id: 'signature', level: 'ok', message: 'Delivery webhooks must carry a valid X-GHL-Signature.' },
        !locations.length
            ? { id: 'ghl', level: 'error', message: 'No HighLevel location is connected. Click "Connect GHL" and install the app into the sub-account.' }
            : brokenLocations.length
                ? { id: 'ghl', level: 'error', message: brokenLocations.map(([l, problem]) => `HighLevel connection for ${l}: ${problem}`).join(' ') }
                : { id: 'ghl', level: 'ok', message: `HighLevel connected for ${locations.join(', ')}` },
        unlinkedLocations.length
            ? { id: 'location-match', level: 'error', message: `These instances' locations have no HighLevel connection: ${unlinkedLocations.join(', ')}` }
            : { id: 'location-match', level: 'ok', message: 'Every instance belongs to a connected HighLevel location.' },
        instances.some(i => bridge.isLive(i.id))
            ? { id: 'whatsapp', level: 'ok', message: 'At least one WhatsApp number is connected.' }
            : { id: 'whatsapp', level: 'error', message: 'No WhatsApp number is connected. Create or reconnect an instance and scan the QR code.' }
    ];
    res.json({
        build: config_1.BUILD,
        commit: config_1.COMMIT || null,
        startedAt,
        dataDir: config_1.DATA_DIR,
        persistentVolume: persistent,
        providerId: config_1.PROVIDER_ID || null,
        inboundType: config_1.INBOUND_TYPE,
        syncPhoneMessages: config_1.SYNC_PHONE_MESSAGES,
        checks,
        connections: locations.map(connectionSummary),
        instances: instances.map(publicInstance),
        events: (0, events_1.recentEvents)(100)
    });
});
process.on('unhandledRejection', err => events_1.log.error({ err }, 'Unhandled promise rejection'));
async function main() {
    await (0, store_1.loadRegistry)();
    await (0, events_1.loadEvents)();
    await (0, store_1.initTokenKey)();
    if (ghlPublicKey.error)
        (0, events_1.recordEvent)('warn', ghlPublicKey.error);
    (0, events_1.recordEvent)('info', `Worker started (build ${config_1.BUILD}${config_1.COMMIT ? `, commit ${config_1.COMMIT}` : ''})`);
    const server = app.listen(config_1.PORT, '0.0.0.0', () => events_1.log.info({ port: config_1.PORT, dataDir: config_1.DATA_DIR }, 'Worker listening'));
    await bridge.resumeInstances();
    const stop = async (signal) => {
        events_1.log.info({ signal }, 'Shutting down');
        bridge.shutdown();
        await (0, store_1.save)();
        await (0, events_1.flushEvents)();
        server.close();
        setTimeout(() => process.exit(0), 1500).unref();
    };
    process.once('SIGTERM', () => void stop('SIGTERM'));
    process.once('SIGINT', () => void stop('SIGINT'));
}
main().catch(err => {
    events_1.log.fatal({ err }, 'Worker failed to start');
    process.exit(1);
});
