"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GhlNotConnectedError = exports.GhlApiError = exports.CONVERSATIONS_VERSION = exports.CONTACTS_VERSION = void 0;
exports.getAccessToken = getAccessToken;
exports.saveConnection = saveConnection;
exports.ghlRequest = ghlRequest;
exports.upsertContact = upsertContact;
exports.findOrCreateConversation = findOrCreateConversation;
exports.addInboundMessage = addInboundMessage;
exports.updateMessageStatus = updateMessageStatus;
exports.uploadAttachment = uploadAttachment;
exports.getMessage = getMessage;
exports.testConnection = testConnection;
const config_1 = require("./config");
const store_1 = require("./store");
// HighLevel rejects or misroutes calls without the per-API version from its OpenAPI spec.
exports.CONTACTS_VERSION = '2021-07-28';
exports.CONVERSATIONS_VERSION = '2021-04-15';
class GhlApiError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = 'GhlApiError';
    }
}
exports.GhlApiError = GhlApiError;
class GhlNotConnectedError extends Error {
    constructor(locationId) {
        super(`No HighLevel connection for location ${locationId}. Click "Connect GHL" on the dashboard and install the app into this sub-account.`);
        this.name = 'GhlNotConnectedError';
    }
}
exports.GhlNotConnectedError = GhlNotConnectedError;
async function call(token, endpoint, { method = 'GET', version, body }) {
    const headers = { Authorization: `Bearer ${token}`, Version: version, Accept: 'application/json' };
    let payload;
    if (body instanceof FormData)
        payload = body;
    else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const res = await fetch(`${config_1.GHL_BASE}${endpoint}`, { method, headers, body: payload, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok)
        throw new GhlApiError(`GHL ${method} ${endpoint.split('?')[0]} failed with HTTP ${res.status}`, res.status, text.slice(0, 1000));
    if (!text)
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        return { raw: text };
    }
}
const refreshes = new Map();
const REFRESH_BACKOFF_MS = 10 * 60_000;
async function getAccessToken(locationId, forceRefresh = false) {
    const conn = store_1.registry.ghl[locationId];
    if (!conn)
        throw new GhlNotConnectedError(locationId);
    const stillValid = conn.expiresAt === undefined || conn.expiresAt > Date.now() + 5 * 60_000;
    if (!conn.refreshToken || (stillValid && !forceRefresh))
        return (0, store_1.decrypt)(conn.accessToken);
    // A revoked refresh token would otherwise be retried on every single API call.
    if (conn.refreshFailedAt && Date.now() - conn.refreshFailedAt < REFRESH_BACKOFF_MS) {
        throw new Error(`HighLevel token for ${locationId} could not be refreshed (${conn.lastError}). Reconnect GHL from the dashboard.`);
    }
    // GHL refresh tokens are single-use, so concurrent callers must share one refresh.
    let pending = refreshes.get(locationId);
    if (!pending) {
        pending = refreshAccessToken(conn).finally(() => refreshes.delete(locationId));
        refreshes.set(locationId, pending);
    }
    return pending;
}
async function refreshAccessToken(conn) {
    if (!config_1.GHL_CLIENT_ID || !config_1.GHL_CLIENT_SECRET) {
        throw new Error('GHL_CLIENT_ID / GHL_CLIENT_SECRET are not set on the worker, so the HighLevel token cannot be refreshed.');
    }
    const form = new URLSearchParams({
        client_id: config_1.GHL_CLIENT_ID,
        client_secret: config_1.GHL_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: (0, store_1.decrypt)(conn.refreshToken),
        user_type: conn.userType === 'Company' ? 'Company' : 'Location'
    });
    if (config_1.GHL_REDIRECT_URI)
        form.set('redirect_uri', config_1.GHL_REDIRECT_URI);
    const res = await fetch(`${config_1.GHL_BASE}/oauth/token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(30_000)
    });
    const text = await res.text();
    if (!res.ok) {
        conn.lastError = `token refresh failed with HTTP ${res.status}: ${text.slice(0, 200)}`;
        conn.refreshFailedAt = Date.now();
        await (0, store_1.save)();
        throw new GhlApiError(`GHL token refresh failed with HTTP ${res.status}`, res.status, text.slice(0, 1000));
    }
    const data = JSON.parse(text);
    await saveConnection({
        locationId: conn.locationId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || (0, store_1.decrypt)(conn.refreshToken),
        expiresIn: data.expires_in,
        scope: data.scope || conn.scope,
        userId: data.userId || conn.userId,
        companyId: data.companyId || conn.companyId,
        userType: data.userType || conn.userType
    });
    return data.access_token;
}
async function saveConnection(input) {
    store_1.registry.ghl[input.locationId] = {
        locationId: input.locationId,
        accessToken: (0, store_1.encrypt)(input.accessToken),
        refreshToken: input.refreshToken ? (0, store_1.encrypt)(input.refreshToken) : undefined,
        expiresAt: input.expiresIn ? Date.now() + Number(input.expiresIn) * 1000 : undefined,
        scope: input.scope,
        userId: input.userId,
        companyId: input.companyId,
        userType: input.userType,
        updatedAt: new Date().toISOString()
    };
    await (0, store_1.save)();
}
async function ghlRequest(locationId, endpoint, options) {
    const token = await getAccessToken(locationId);
    try {
        return await call(token, endpoint, options);
    }
    catch (err) {
        // A 401 can mean the token expired early (refresh helps) or a missing scope (it does not).
        const retryable = err instanceof GhlApiError && err.status === 401 && !/scope/i.test(err.body) && store_1.registry.ghl[locationId]?.refreshToken;
        if (!retryable)
            throw err;
        let fresh;
        try {
            fresh = await getAccessToken(locationId, true);
        }
        catch (refreshErr) {
            throw new GhlApiError(`${err.message}; refreshing the token also failed (${refreshErr instanceof Error ? refreshErr.message : refreshErr})`, err.status, err.body);
        }
        return call(fresh, endpoint, options);
    }
}
function splitName(name) {
    const [firstName, ...rest] = name.trim().split(/\s+/);
    return rest.length ? { firstName, lastName: rest.join(' ') } : { firstName };
}
// Upsert by phone only, so an existing contact's curated name is never overwritten by a WhatsApp profile name.
async function upsertContact(locationId, phoneE164, displayName) {
    const data = await ghlRequest(locationId, '/contacts/upsert', {
        method: 'POST',
        version: exports.CONTACTS_VERSION,
        body: { locationId, phone: phoneE164 }
    });
    const contactId = data.contact?.id || data.contactId || data.id;
    if (!contactId)
        throw new Error(`GHL contact upsert returned no contact id: ${JSON.stringify(data).slice(0, 300)}`);
    const isNew = Boolean(data.new);
    if (isNew && displayName?.trim()) {
        await ghlRequest(locationId, `/contacts/${contactId}`, {
            method: 'PUT',
            version: exports.CONTACTS_VERSION,
            body: { ...splitName(displayName), source: 'WhatsApp' }
        }).catch(() => undefined);
    }
    return { contactId, isNew };
}
async function findOrCreateConversation(locationId, contactId) {
    const query = new URLSearchParams({ locationId, contactId, limit: '1' });
    const found = await ghlRequest(locationId, `/conversations/search?${query}`, { version: exports.CONVERSATIONS_VERSION });
    const existing = found.conversations?.[0]?.id;
    if (existing)
        return existing;
    try {
        const created = await ghlRequest(locationId, '/conversations/', {
            method: 'POST',
            version: exports.CONVERSATIONS_VERSION,
            body: { locationId, contactId }
        });
        const id = created.conversation?.id || created.id;
        if (!id)
            throw new Error(`GHL create conversation returned no id: ${JSON.stringify(created).slice(0, 300)}`);
        return id;
    }
    catch (err) {
        if (err instanceof GhlApiError && err.status === 400) {
            try {
                const id = JSON.parse(err.body)?.conversationId;
                if (id)
                    return id;
            }
            catch {
                // fall through to the original error
            }
        }
        throw err;
    }
}
async function addInboundMessage(locationId, input) {
    const body = {
        type: config_1.INBOUND_TYPE,
        contactId: input.contactId,
        conversationId: input.conversationId,
        conversationProviderId: config_1.PROVIDER_ID || undefined,
        message: input.message,
        attachments: input.attachments?.length ? input.attachments : undefined,
        altId: input.altId,
        direction: input.direction,
        date: input.date
    };
    for (const k of Object.keys(body))
        if (body[k] === undefined)
            delete body[k];
    return ghlRequest(locationId, '/conversations/messages/inbound', { method: 'POST', version: exports.CONVERSATIONS_VERSION, body });
}
async function updateMessageStatus(locationId, messageId, status, errorMessage) {
    const body = { status };
    if (errorMessage)
        body.error = { code: '1', type: 'saas', message: errorMessage.slice(0, 300) };
    return ghlRequest(locationId, `/conversations/messages/${encodeURIComponent(messageId)}/status`, {
        method: 'PUT',
        version: exports.CONVERSATIONS_VERSION,
        body
    });
}
async function uploadAttachment(locationId, input) {
    const form = new FormData();
    form.append('conversationId', input.conversationId);
    form.append('contactId', input.contactId);
    form.append('locationId', locationId);
    form.append('fileAttachment', new Blob([new Uint8Array(input.data)], { type: input.mimetype }), input.fileName);
    const data = await ghlRequest(locationId, '/conversations/messages/upload', { method: 'POST', version: exports.CONVERSATIONS_VERSION, body: form });
    const uploaded = data.uploadedFiles || {};
    return Object.values(uploaded).filter((url) => typeof url === 'string');
}
async function getMessage(locationId, messageId) {
    const data = await ghlRequest(locationId, `/conversations/messages/${encodeURIComponent(messageId)}`, { version: exports.CONVERSATIONS_VERSION });
    return data.message || data;
}
// A cheap authenticated call that exercises the token, the conversations scope and the Version header.
async function testConnection(locationId) {
    const query = new URLSearchParams({ locationId, limit: '1' });
    await ghlRequest(locationId, `/conversations/search?${query}`, { version: exports.CONVERSATIONS_VERSION });
}
