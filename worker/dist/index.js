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
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const express_1 = __importDefault(require("express"));
const config_1 = require("./config");
const alerts_1 = require("./alerts");
const events_1 = require("./events");
const ghl = __importStar(require("./ghl"));
const bridge = __importStar(require("./bridge"));
const numbers_1 = require("./numbers");
const settings_1 = require("./settings");
const store_1 = require("./store");
const signature_1 = require("./signature");
const startedAt = new Date().toISOString();
const ghlPublicKey = (0, signature_1.loadGhlPublicKey)(config_1.GHL_WEBHOOK_PUBLIC_KEY);
const WEBHOOK_PATH = '/webhooks/ghl/outbound';
// HighLevel may also be pointed straight at the worker; that path is authenticated by X-GHL-Signature alone.
const DIRECT_WEBHOOK_PATH = '/api/oauth/outbound';
const WEBHOOK_PATHS = [WEBHOOK_PATH, DIRECT_WEBHOOK_PATH];
const app = (0, express_1.default)();
app.disable('x-powered-by');
// The delivery webhook is verified against its exact bytes, so it must not go through the JSON parser.
const jsonBody = express_1.default.json({ limit: '2mb' });
app.use((req, res, next) => (WEBHOOK_PATHS.includes(req.path) ? next() : jsonBody(req, res, next)));
function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && node_crypto_1.default.timingSafeEqual(left, right);
}
app.use((req, res, next) => {
    // The direct webhook path may skip the internal key only while X-GHL-Signature is enforced; never fail open.
    const signedWebhook = req.path === DIRECT_WEBHOOK_PATH && !config_1.SIGNATURE_CHECK_DISABLED;
    if (req.path === '/' || req.path === '/health' || signedWebhook)
        return next();
    if (!config_1.INTERNAL_API_KEY || !safeEqual(req.header('x-internal-api-key') || '', config_1.INTERNAL_API_KEY)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});
const publicInstance = (instance) => {
    const { id, name, locationId, status, phone, createdAt, updatedAt, qr, lastError, slot, isDefault, linkedAt } = instance;
    const policy = (0, numbers_1.effectivePolicy)(instance);
    const protection = bridge.protection.stats(id, (0, numbers_1.numberState)(instance), Date.now(), policy);
    return {
        id,
        name,
        locationId,
        status,
        phone,
        createdAt,
        updatedAt,
        qr: qr || null,
        lastError: lastError || null,
        slot: slot ?? null,
        isDefault: Boolean(isDefault),
        linkedAt: linkedAt || null,
        restrictedUntil: protection.restricted ? instance.restrictedUntil : null,
        protection,
        // The rules in force for this number, and which of them the admin set for it (the rest follow the defaults).
        policy,
        overrides: instance.protection ?? {},
        warmupFrom: instance.warmupFrom ?? null,
        assignedUserId: instance.assignedUserId ?? null,
        assignedUserName: instance.assignedUserName ?? null,
        assignMode: instance.assignMode ?? 'unassigned',
        ghlConnected: ghl.isConnected(locationId)
    };
};
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
        if (!locationId)
            return res.status(400).json({ error: 'locationId is required' });
        const existing = (0, numbers_1.numbersOf)(locationId);
        // Sub-account self-service respects the limit; the admin may go beyond it.
        if (req.body?.enforceLimit === true && existing.length >= (0, numbers_1.limitFor)(locationId)) {
            return res.status(409).json({ error: `This sub-account already uses all ${(0, numbers_1.limitFor)(locationId)} of its WhatsApp numbers.` });
        }
        const slot = (0, numbers_1.claimSlot)(locationId);
        const name = String(req.body?.name || '').trim().slice(0, 40) || `Number ${slot}`;
        const id = node_crypto_1.default.randomUUID();
        store_1.registry.instances[id] = {
            id,
            name,
            locationId,
            status: 'starting',
            createdAt: new Date().toISOString(),
            qr: null,
            lastError: null,
            slot,
            isDefault: existing.length === 0
        };
        await (0, store_1.save)();
        if (!ghl.isConnected(locationId))
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
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Everything the admin can change on one number. All input is validated before anything is applied; `described`
// lists the changes in plain words for the activity log.
function parseNumberPatch(instance, body) {
    const changes = {};
    const described = [];
    if (typeof body.name === 'string' && body.name.trim())
        changes.name = body.name.trim().slice(0, 40);
    if (body.protection !== undefined) {
        const policyPatch = (0, settings_1.parsePolicyPatch)(body.protection);
        changes.protection = (0, settings_1.applyPolicyPatch)(instance.protection, policyPatch);
        described.push(...(0, settings_1.describePolicyPatch)(policyPatch));
    }
    if (body.assignedUserId !== undefined) {
        const userId = typeof body.assignedUserId === 'string' ? body.assignedUserId.trim() : body.assignedUserId;
        if (userId === null || userId === '') {
            changes.assignedUserId = null;
            changes.assignedUserName = null;
        }
        else if (typeof userId === 'string' && USER_ID.test(userId)) {
            changes.assignedUserId = userId;
            changes.assignedUserName = typeof body.assignedUserName === 'string' ? body.assignedUserName.trim().slice(0, 80) || null : null;
        }
        else {
            throw new settings_1.InputError('assignedUserId must be a HighLevel user id');
        }
        if (changes.assignedUserId !== (instance.assignedUserId ?? null)) {
            described.push(changes.assignedUserId ? `contact owner ${changes.assignedUserName || changes.assignedUserId}` : 'no contact owner');
        }
    }
    if (body.assignMode !== undefined) {
        if (body.assignMode !== 'unassigned' && body.assignMode !== 'always')
            throw new settings_1.InputError('assignMode must be "unassigned" or "always"');
        changes.assignMode = body.assignMode;
        if (body.assignMode !== (instance.assignMode ?? 'unassigned')) {
            described.push(body.assignMode === 'always' ? 'assigns every contact' : 'assigns only contacts without an owner');
        }
    }
    if (body.warmup !== undefined) {
        if (body.warmup !== 'restart')
            throw new settings_1.InputError('warmup must be "restart"');
        changes.warmupFrom = new Date().toISOString();
        // Restarting means warming up again, so a "no warm-up" override on this number goes.
        const own = changes.protection !== undefined ? changes.protection : instance.protection;
        if (own?.warmupDays === 0)
            changes.protection = (0, settings_1.applyPolicyPatch)(own, { warmupDays: null });
        described.push('warm-up restarted');
    }
    return { changes, described };
}
// Rename a number, make it the default sender, set its owner and protection rules, restart its warm-up, or clear a
// restriction (which asks WhatsApp again).
app.patch('/instances/:id', async (req, res) => {
    const instance = store_1.registry.instances[req.params.id];
    if (!instance)
        return res.status(404).json({ error: 'Not found' });
    const body = (req.body ?? {});
    let changes;
    let described;
    try {
        ({ changes, described } = parseNumberPatch(instance, body));
    }
    catch (err) {
        if (err instanceof settings_1.InputError)
            return res.status(400).json({ error: err.message });
        return sendError(res, err);
    }
    const { protection, ...rest } = changes;
    Object.assign(instance, rest, { updatedAt: new Date().toISOString() });
    if ('protection' in changes) {
        if (protection)
            instance.protection = protection;
        else
            delete instance.protection;
    }
    if (body.isDefault === true)
        (0, numbers_1.setDefault)(instance.id);
    await (0, store_1.save)();
    if (described.length) {
        (0, events_1.recordEvent)('info', `Admin changed #${instance.slot} ${instance.name}: ${described.join(', ')}`, { instanceId: instance.id, locationId: instance.locationId });
    }
    const restriction = body.clearRestriction === true ? await bridge.recheckRestriction(instance.id) : undefined;
    res.json({ instance: publicInstance(store_1.registry.instances[instance.id]), restriction });
});
// One sub-account's numbers, limit and HighLevel readiness (what the sub-account page needs).
app.get('/locations/:locationId', (req, res) => {
    const { locationId } = req.params;
    res.json({
        locationId,
        limit: (0, numbers_1.limitFor)(locationId),
        ghlReady: ghl.connectionProblem(locationId) === null,
        numbers: (0, numbers_1.numbersOf)(locationId).map(publicInstance)
    });
});
// The HighLevel users of a sub-account, for assigning numbers to them. Needs the users.readonly scope.
const usersCache = new Map();
app.get('/locations/:locationId/users', async (req, res) => {
    const { locationId } = req.params;
    if (!ghl.isConnected(locationId))
        return res.json({ users: [], error: 'This sub-account is not connected to HighLevel.' });
    const cached = usersCache.get(locationId);
    if (cached && Date.now() - cached.at < 5 * 60_000 && req.query.refresh !== '1')
        return res.json({ users: cached.users });
    try {
        const users = await ghl.listUsers(locationId);
        usersCache.set(locationId, { at: Date.now(), users });
        res.json({ users });
    }
    catch (err) {
        const denied = err instanceof ghl.GhlApiError && (err.status === 401 || err.status === 403);
        res.json({
            users: [],
            needsScope: denied,
            error: denied
                ? 'HighLevel did not allow reading this sub-account\'s users. Add the users.readonly scope to the Marketplace app (Advanced Settings → Auth → Scopes), then click "Connect GHL" again. Until then you can paste a user ID.'
                : (0, events_1.errorText)(err)
        });
    }
});
app.get('/settings', (_req, res) => res.json((0, settings_1.settingsView)()));
app.put('/settings', async (req, res) => {
    let patch;
    try {
        patch = (0, settings_1.parseSettingsPatch)(req.body);
        await (0, settings_1.updateSettings)(patch);
    }
    catch (err) {
        if (err instanceof settings_1.InputError)
            return res.status(400).json({ error: err.message });
        return sendError(res, err);
    }
    const described = (0, settings_1.describeSettingsPatch)(patch);
    if (described)
        (0, events_1.recordEvent)('info', `Admin changed the settings: ${described}`);
    res.json((0, settings_1.settingsView)());
});
app.post('/settings/test-alert', async (_req, res) => {
    try {
        await (0, alerts_1.sendTestAlert)();
        res.json({ ok: true });
    }
    catch (err) {
        sendError(res, err, 400);
    }
});
app.get('/sync/pending', (_req, res) => res.json(bridge.pendingSyncSummary()));
app.post('/sync/retry', (_req, res) => res.json({ ok: true, retrying: bridge.retryPendingNow() }));
app.put('/locations/:locationId/limit', async (req, res) => {
    const limit = Number(req.body?.limit);
    if (!Number.isInteger(limit) || limit < 0 || limit > 100)
        return res.status(400).json({ error: 'limit must be a whole number from 0 to 100' });
    await (0, numbers_1.setLimit)(req.params.locationId, limit);
    res.json({ locationId: req.params.locationId, limit });
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
function agencySummary(companyId) {
    const company = store_1.registry.companies[companyId];
    return {
        companyId,
        scope: company.scope || null,
        canMint: ghl.agencyCanMint(companyId),
        locationIds: company.locationIds,
        mintErrors: company.mintErrors || {},
        lastError: company.lastError || null,
        updatedAt: company.updatedAt
    };
}
// Locations the bridge needs a HighLevel token for: those with instances plus those already connected.
function knownLocations() {
    return [...new Set([...Object.values(store_1.registry.instances).map(i => i.locationId), ...Object.keys(store_1.registry.ghl)])];
}
app.get('/integrations/ghl', (_req, res) => res.json({
    connections: Object.keys(store_1.registry.ghl).map(connectionSummary),
    agencies: Object.keys(store_1.registry.companies).map(agencySummary),
    problems: Object.fromEntries(knownLocations().map(l => [l, ghl.connectionProblem(l)]))
}));
// Lets the web app record OAuth outcomes in the activity log.
app.post('/events', (req, res) => {
    const { level, message, detail, locationId } = req.body || {};
    if (!['info', 'warn', 'error'].includes(level) || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'level and message required' });
    }
    (0, events_1.recordEvent)(level, message.slice(0, 300), {
        locationId: typeof locationId === 'string' ? locationId : undefined,
        detail: typeof detail === 'string' ? detail : undefined
    });
    res.json({ ok: true });
});
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
async function verifyLocation(locationId) {
    const check = await checkConnection(locationId);
    const problem = ghl.connectionProblem(locationId);
    if (check.ok && !problem)
        (0, events_1.recordEvent)('info', `HighLevel connected for location ${locationId}`, { locationId });
    else
        (0, events_1.recordEvent)('error', `HighLevel connection for ${locationId} is not usable: ${problem || 'a test API call failed'}`, {
            locationId,
            detail: check.ok ? undefined : `${check.error} ${check.body || ''}`
        });
    return { locationId, ...check, problem };
}
app.post('/integrations/ghl/connect', async (req, res) => {
    try {
        const { locationId, accessToken, refreshToken, expiresIn, scope, userId, companyId, userType, approvedLocations } = req.body || {};
        if (!accessToken)
            return res.status(400).json({ error: 'accessToken required' });
        const claims = ghl.claimsOf(accessToken);
        if (userType === 'Company' || claims?.authClass === 'Company') {
            const agencyId = companyId || claims?.authClassId;
            if (!agencyId)
                return res.status(400).json({ error: 'companyId required for an agency install' });
            const approved = Array.isArray(approvedLocations) ? approvedLocations.filter((l) => typeof l === 'string') : [];
            const targets = [...new Set([...(locationId ? [locationId] : []), ...Object.values(store_1.registry.instances).map(i => i.locationId)])];
            await ghl.saveAgencyConnection({ companyId: agencyId, accessToken, refreshToken, expiresIn, scope, userId, locationIds: [...approved, ...targets] });
            (0, events_1.recordEvent)('info', `HighLevel agency install saved for company ${agencyId}`, { detail: `scopes: ${scope || 'none reported'}` });
            const locations = [];
            for (const target of targets)
                locations.push(await verifyLocation(target));
            return res.json({ ok: true, agency: true, companyId: agencyId, locations });
        }
        if (!locationId)
            return res.status(400).json({ error: 'locationId required for a sub-account install' });
        await ghl.saveConnection({ locationId, accessToken, refreshToken, expiresIn, scope, userId, companyId, userType });
        const result = await verifyLocation(locationId);
        res.json({ ok: true, agency: false, locationId, locations: [result], check: result });
    }
    catch (err) {
        sendError(res, err);
    }
});
app.get('/integrations/ghl/:locationId/install-status', async (req, res) => {
    try {
        res.json(await ghl.installStatus(req.params.locationId));
    }
    catch (err) {
        sendError(res, err);
    }
});
app.post('/integrations/ghl/:locationId/test', async (req, res) => {
    const { locationId } = req.params;
    if (!ghl.isConnected(locationId)) {
        return res.status(404).json({ error: 'Location is not connected' });
    }
    res.json(await checkConnection(locationId));
});
app.post(WEBHOOK_PATHS, express_1.default.raw({ type: () => true, limit: '2mb' }), (req, res) => {
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
// Disk space and usable memory are read once a minute rather than on every dashboard poll.
let disk = null;
let availableMemory = node_os_1.default.freemem();
async function refreshResources() {
    try {
        const stats = await promises_1.default.statfs(config_1.DATA_DIR);
        disk = { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    }
    catch {
        disk = null;
    }
    // On Linux os.freemem() leaves out the file cache the kernel frees on demand; MemAvailable is what can be used.
    try {
        const match = /^MemAvailable:\s+(\d+) kB/m.exec(await promises_1.default.readFile('/proc/meminfo', 'utf8'));
        availableMemory = match ? Number(match[1]) * 1024 : node_os_1.default.freemem();
    }
    catch {
        availableMemory = node_os_1.default.freemem();
    }
}
function systemInfo() {
    const memory = process.memoryUsage();
    return {
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
        host: { totalMemBytes: node_os_1.default.totalmem(), freeMemBytes: availableMemory, load: node_os_1.default.loadavg(), cpus: node_os_1.default.cpus().length },
        disk,
        sessions: bridge.sessionCounts()
    };
}
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const memoryLow = () => availableMemory < 100 * MB || availableMemory / node_os_1.default.totalmem() < 0.05;
function diagnostics() {
    const instances = Object.values(store_1.registry.instances);
    const pending = bridge.pendingSyncSummary();
    const locations = knownLocations();
    const relative = config_1.VOLUME_PATH ? node_path_1.default.relative(config_1.VOLUME_PATH, config_1.DATA_DIR) : null;
    const persistent = config_1.DATA_VOLUME ? true : relative === null ? null : !relative.startsWith('..') && !node_path_1.default.isAbsolute(relative);
    const keySource = (0, store_1.getTokenKeySource)();
    const problems = locations.map(l => [l, ghl.connectionProblem(l)]);
    const unlinkedLocations = problems.filter(([, p]) => p?.startsWith('HighLevel is not connected')).map(([l]) => l);
    const brokenLocations = problems.filter(([, p]) => p && !p.startsWith('HighLevel is not connected'));
    const anyConnection = Object.keys(store_1.registry.ghl).length > 0 || Object.keys(store_1.registry.companies).length > 0;
    const checks = [
        persistent === true
            ? { id: 'storage', level: 'ok', message: `Data is stored on ${config_1.DATA_VOLUME || 'the attached volume'} (${config_1.DATA_DIR}).` }
            : persistent === false
                ? { id: 'storage', level: 'error', message: `DATA_DIR (${config_1.DATA_DIR}) is outside the attached volume (${config_1.VOLUME_PATH}); sessions and tokens are lost on every deploy.` }
                : { id: 'storage', level: 'warn', message: `No Railway volume detected. Unless ${config_1.DATA_DIR} is on a persistent disk, WhatsApp sessions and HighLevel tokens are lost on every redeploy.` },
        config_1.PROVIDER_ID
            ? store_1.registry.settings.providerId && store_1.registry.settings.providerId !== config_1.PROVIDER_ID
                ? {
                    id: 'provider',
                    level: 'warn',
                    message: `Using conversation provider id ${store_1.registry.settings.providerId}, learned from HighLevel. GHL_CONVERSATION_PROVIDER_ID on the worker is ${config_1.PROVIDER_ID}; update it to ${store_1.registry.settings.providerId}.`
                }
                : { id: 'provider', level: 'ok', message: `Conversation provider id: ${config_1.PROVIDER_ID}${store_1.registry.settings.providerId ? ' (confirmed by HighLevel)' : ''}` }
            : { id: 'provider', level: 'warn', message: 'GHL_CONVERSATION_PROVIDER_ID is not set on the worker. Inbound messages only work if the app is the default SMS provider.' },
        config_1.GHL_CLIENT_ID && config_1.GHL_CLIENT_SECRET
            ? { id: 'oauth-client', level: 'ok', message: 'GHL client id and secret are set, so tokens can be refreshed.' }
            : config_1.TOKEN_REFRESH_URL
                ? { id: 'oauth-client', level: 'ok', message: `Tokens are refreshed through the web app (${config_1.TOKEN_REFRESH_URL}).` }
                : { id: 'oauth-client', level: 'error', message: 'Neither GHL_CLIENT_SECRET nor TOKEN_REFRESH_URL is set on the worker; the HighLevel token will stop working after ~24h.' },
        keySource === 'generated'
            ? { id: 'token-key', level: 'warn', message: 'TOKEN_ENCRYPTION_KEY is not set; using a key generated in the data directory.' }
            : { id: 'token-key', level: 'ok', message: keySource === 'env' ? 'Tokens are encrypted with TOKEN_ENCRYPTION_KEY.' : 'Tokens are encrypted with a key derived from TOKEN_ENCRYPTION_KEY.' },
        config_1.SIGNATURE_CHECK_DISABLED
            ? { id: 'signature', level: 'error', message: 'DISABLE_GHL_SIGNATURE=true: anyone can make this number send WhatsApp messages. Remove it.' }
            : ghlPublicKey.error
                ? { id: 'signature', level: 'warn', message: ghlPublicKey.error }
                : { id: 'signature', level: 'ok', message: 'Delivery webhooks must carry a valid X-GHL-Signature.' },
        !anyConnection
            ? { id: 'ghl', level: 'error', message: 'No HighLevel location is connected. Click "Connect GHL" and install the app into the sub-account.' }
            : brokenLocations.length
                ? { id: 'ghl', level: 'error', message: brokenLocations.map(([l, problem]) => `HighLevel connection for ${l}: ${problem}`).join(' ') }
                : { id: 'ghl', level: 'ok', message: `HighLevel connected for ${locations.filter(l => !unlinkedLocations.includes(l)).join(', ') || 'no locations yet'}` },
        store_1.registry.settings.inboundType
            ? { id: 'inbound-type', level: 'ok', message: `HighLevel accepts this provider's inbound messages as type ${store_1.registry.settings.inboundType}.` }
            : {
                id: 'inbound-type',
                level: 'ok',
                message: `The provider's message type is detected on the first synced message (trying ${ghl.inboundTypeCandidates().join(', ')} in that order).`
            },
        unlinkedLocations.length
            ? { id: 'location-match', level: 'error', message: `These instances' locations have no HighLevel connection: ${unlinkedLocations.join(', ')}` }
            : { id: 'location-match', level: 'ok', message: 'Every instance belongs to a connected HighLevel location.' },
        instances.some(i => bridge.isLive(i.id))
            ? { id: 'whatsapp', level: 'ok', message: 'At least one WhatsApp number is connected.' }
            : { id: 'whatsapp', level: 'error', message: 'No WhatsApp number is connected. Create or reconnect an instance and scan the QR code.' },
        pending.count
            ? {
                id: 'sync-queue',
                level: 'warn',
                message: `${pending.count} WhatsApp message${pending.count === 1 ? ' is' : 's are'} waiting to be synced into HighLevel (oldest since ${pending.oldestAt}). They are retried automatically.`
            }
            : { id: 'sync-queue', level: 'ok', message: 'No WhatsApp messages are waiting to be synced.' },
        disk && disk.freeBytes < GB
            ? { id: 'disk', level: disk.freeBytes < GB / 4 ? 'error' : 'warn', message: `Only ${(disk.freeBytes / GB).toFixed(1)} GB of disk space is left on the worker.` }
            : memoryLow()
                ? { id: 'memory', level: 'warn', message: `The worker's machine is low on memory (${Math.round(availableMemory / MB)} MB available).` }
                : { id: 'resources', level: 'ok', message: 'The worker has enough disk space and memory.' }
    ];
    return {
        build: config_1.BUILD,
        commit: config_1.COMMIT || null,
        startedAt,
        dataDir: config_1.DATA_DIR,
        persistentVolume: persistent,
        providerId: ghl.effectiveProviderId() || null,
        inboundType: store_1.registry.settings.inboundType || config_1.INBOUND_TYPE,
        syncPhoneMessages: config_1.SYNC_PHONE_MESSAGES,
        checks,
        connections: Object.keys(store_1.registry.ghl).map(connectionSummary),
        agencies: Object.keys(store_1.registry.companies).map(agencySummary),
        instances: instances.map(publicInstance),
        events: (0, events_1.recentEvents)(100)
    };
}
app.get('/diagnostics', (_req, res) => res.json(diagnostics()));
// Everything the admin dashboard shows, grouped by sub-account.
app.get('/admin/overview', (_req, res) => {
    const { checks, events, providerId, inboundType } = diagnostics();
    const locationIds = [...new Set([...knownLocations(), ...Object.keys(store_1.registry.settings.limits ?? {})])];
    res.json({
        build: config_1.BUILD,
        commit: config_1.COMMIT || null,
        startedAt,
        providerId,
        inboundType,
        protection: (0, numbers_1.defaultPolicy)(),
        settings: (0, settings_1.settingsView)(),
        system: systemInfo(),
        pendingSync: bridge.pendingSyncSummary(),
        checks,
        locations: locationIds.map(locationId => ({
            locationId,
            limit: (0, numbers_1.limitFor)(locationId),
            ghl: { connected: ghl.isConnected(locationId), problem: ghl.connectionProblem(locationId) },
            numbers: (0, numbers_1.numbersOf)(locationId).map(publicInstance)
        })),
        events
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
    if ((0, numbers_1.assignSlotsAndDefaults)())
        await (0, store_1.save)();
    await bridge.loadProtection();
    await bridge.loadPendingSync();
    await refreshResources();
    setInterval(() => void refreshResources(), 60_000).unref();
    (0, alerts_1.startAlerts)();
    const moved = await ghl.migrateAgencyTokens();
    if (moved.length)
        (0, events_1.recordEvent)('warn', `Found agency (Company) tokens stored as sub-account tokens; moved them to agency connections: ${moved.join(', ')}`);
    const server = app.listen(config_1.PORT, '0.0.0.0', () => events_1.log.info({ port: config_1.PORT, dataDir: config_1.DATA_DIR }, 'Worker listening'));
    await bridge.resumeInstances();
    bridge.startBackgroundJobs();
    // Agency installs: get a sub-account token for every instance location up front so problems show immediately.
    for (const locationId of new Set(Object.values(store_1.registry.instances).map(i => i.locationId))) {
        if (store_1.registry.ghl[locationId]?.source === 'direct')
            continue;
        if (ghl.connectionProblem(locationId)?.startsWith('HighLevel is not connected'))
            continue;
        void verifyLocation(locationId).catch(err => events_1.log.warn({ err, locationId }, 'Agency token warm-up failed'));
    }
    const stop = async (signal) => {
        events_1.log.info({ signal }, 'Shutting down');
        bridge.shutdown();
        await (0, store_1.save)();
        await bridge.flushProtection();
        await bridge.flushPendingSync();
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
