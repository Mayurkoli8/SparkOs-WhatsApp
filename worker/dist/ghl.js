"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REQUIRED_SCOPES = exports.GhlNotConnectedError = exports.GhlApiError = exports.CONVERSATIONS_VERSION = exports.CONTACTS_VERSION = void 0;
exports.installStatus = installStatus;
exports.isConnected = isConnected;
exports.getAccessToken = getAccessToken;
exports.saveAgencyConnection = saveAgencyConnection;
exports.migrateAgencyTokens = migrateAgencyTokens;
exports.saveConnection = saveConnection;
exports.ghlRequest = ghlRequest;
exports.upsertContact = upsertContact;
exports.findOrCreateConversation = findOrCreateConversation;
exports.inboundTypeCandidates = inboundTypeCandidates;
exports.addInboundMessageDetectingType = addInboundMessageDetectingType;
exports.effectiveProviderId = effectiveProviderId;
exports.learnProviderFromMessage = learnProviderFromMessage;
exports.getContactPhone = getContactPhone;
exports.addInboundMessage = addInboundMessage;
exports.updateMessageStatus = updateMessageStatus;
exports.uploadAttachment = uploadAttachment;
exports.getMessage = getMessage;
exports.missingScopes = missingScopes;
exports.claimsOf = claimsOf;
exports.tokenClaims = tokenClaims;
exports.agencyCanMint = agencyCanMint;
exports.connectionProblem = connectionProblem;
exports.testConnection = testConnection;
const config_1 = require("./config");
const events_1 = require("./events");
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
const inflight = new Map();
const REFRESH_BACKOFF_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;
function singleFlight(key, task) {
    let pending = inflight.get(key);
    if (!pending) {
        pending = task().finally(() => inflight.delete(key));
        inflight.set(key, pending);
    }
    return pending;
}
const isFresh = (record) => record.expiresAt === undefined || record.expiresAt > Date.now() + EXPIRY_MARGIN_MS;
async function refreshableToken(label, record, userType, forceRefresh) {
    if (!record.refreshToken || (isFresh(record) && !forceRefresh))
        return (0, store_1.decrypt)(record.accessToken);
    // A revoked refresh token would otherwise be retried on every single API call.
    if (record.refreshFailedAt && Date.now() - record.refreshFailedAt < REFRESH_BACKOFF_MS) {
        throw new Error(`HighLevel token for ${label} could not be refreshed (${record.lastError}). Reconnect GHL from the dashboard.`);
    }
    // GHL refresh tokens are single-use, so concurrent callers must share one refresh.
    return singleFlight(`refresh:${label}`, () => refreshRecord(record, userType));
}
async function refreshRecord(record, userType) {
    if (!config_1.GHL_CLIENT_ID || !config_1.GHL_CLIENT_SECRET) {
        throw new Error('GHL_CLIENT_ID / GHL_CLIENT_SECRET are not set on the worker, so the HighLevel token cannot be refreshed.');
    }
    // redirect_uri is optional for refreshes; omitting it avoids failures when GHL_REDIRECT_URI is stale.
    const form = new URLSearchParams({
        client_id: config_1.GHL_CLIENT_ID,
        client_secret: config_1.GHL_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: (0, store_1.decrypt)(record.refreshToken),
        user_type: userType
    });
    const res = await fetch(`${config_1.GHL_BASE}/oauth/token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(30_000)
    });
    const text = await res.text();
    if (!res.ok) {
        record.lastError = `token refresh failed with HTTP ${res.status}: ${text.slice(0, 200)}`;
        record.refreshFailedAt = Date.now();
        await (0, store_1.save)();
        throw new GhlApiError(`GHL token refresh failed with HTTP ${res.status}`, res.status, text.slice(0, 1000));
    }
    const data = JSON.parse(text);
    record.accessToken = (0, store_1.encrypt)(data.access_token);
    if (data.refresh_token)
        record.refreshToken = (0, store_1.encrypt)(data.refresh_token);
    record.expiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined;
    record.scope = data.scope || record.scope;
    record.userId = data.userId || record.userId;
    record.lastError = null;
    record.refreshFailedAt = undefined;
    record.updatedAt = new Date().toISOString();
    await (0, store_1.save)();
    return data.access_token;
}
// The agency (Company) install that can mint tokens for this location, if any.
function agencyFor(locationId) {
    const linked = store_1.registry.ghl[locationId]?.companyId;
    if (linked && store_1.registry.companies[linked])
        return store_1.registry.companies[linked];
    const companies = Object.values(store_1.registry.companies);
    return companies.find(c => c.locationIds.includes(locationId)) || (companies.length === 1 ? companies[0] : undefined);
}
function agencyTokenInfo(company) {
    let claims = {};
    try {
        const payload = (0, store_1.decrypt)(company.accessToken).split('.')[1];
        if (payload)
            claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    }
    catch {
        // opaque token; fall back to the configured client id
    }
    const client = claims.oauthMeta?.client || config_1.GHL_CLIENT_ID;
    return { appId: client.split('-')[0] || undefined, versionId: claims.oauthMeta?.versionId };
}
// When HighLevel refuses a sub-account token, ask it whether the app is installed there and in which version.
async function explainLocationAccess(company, locationId, agencyToken) {
    const { appId, versionId } = agencyTokenInfo(company);
    if (!appId)
        return null;
    const query = new URLSearchParams({ companyId: company.companyId, appId, locationId, limit: '5' });
    try {
        const res = await fetch(`${config_1.GHL_BASE}/oauth/installedLocations?${query}`, {
            headers: { Authorization: `Bearer ${agencyToken}`, Version: exports.CONTACTS_VERSION, Accept: 'application/json' },
            signal: AbortSignal.timeout(20_000)
        });
        if (!res.ok)
            return null;
        const data = await res.json();
        const entry = (data.locations || []).find((l) => l._id === locationId);
        if (!entry || entry.isInstalled === false)
            return `the app is not installed in sub-account ${locationId}`;
        if (versionId && entry.versionId && entry.versionId !== versionId) {
            return `sub-account ${locationId} has app version ${entry.versionId}, but the agency authorized version ${versionId}`;
        }
        return null;
    }
    catch {
        return null;
    }
}
function decodeClaims(encryptedToken) {
    try {
        const payload = (0, store_1.decrypt)(encryptedToken).split('.')[1];
        return payload ? JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) : {};
    }
    catch {
        return {};
    }
}
// Non-secret facts about how the app is installed for a location: which app version the agency authorized, and
// whether HighLevel considers the app installed in that sub-account (and in which version).
async function installStatus(locationId) {
    const company = agencyFor(locationId);
    const conn = store_1.registry.ghl[locationId];
    const summarize = (claims) => ({
        authClass: claims.authClass,
        authClassId: claims.authClassId,
        source: claims.source,
        channel: claims.channel,
        oauthMetaKeys: claims.oauthMeta ? Object.keys(claims.oauthMeta) : [],
        client: claims.oauthMeta?.client,
        versionId: claims.oauthMeta?.versionId,
        scopes: claims.oauthMeta?.scopes
    });
    const result = {
        locationId,
        locationToken: conn ? { storedAs: conn.source || 'direct', ...summarize(decodeClaims(conn.accessToken)) } : null,
        agencyToken: company ? { companyId: company.companyId, ...summarize(decodeClaims(company.accessToken)) } : null
    };
    if (!company)
        return result;
    const { appId } = agencyTokenInfo(company);
    const token = await refreshableToken(`company ${company.companyId}`, company, 'Company', false);
    const query = new URLSearchParams({ companyId: company.companyId, appId: appId || '', locationId, limit: '5' });
    const res = await fetch(`${config_1.GHL_BASE}/oauth/installedLocations?${query}`, {
        headers: { Authorization: `Bearer ${token}`, Version: exports.CONTACTS_VERSION, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000)
    });
    const text = await res.text();
    let entry = null;
    try {
        const found = (JSON.parse(text).locations || []).find((l) => l._id === locationId);
        if (found)
            entry = { isInstalled: found.isInstalled, versionId: found.versionId, installedAt: found.installedAt };
    }
    catch {
        // reported below as the raw status
    }
    result.installedLocations = { appId, httpStatus: res.status, entry, error: res.ok ? undefined : text.slice(0, 300) };
    return result;
}
// Agency installs get sub-account tokens from /oauth/locationToken; they carry no refresh token and are re-minted.
async function mintLocationToken(company, locationId, retried = false) {
    const agencyToken = await refreshableToken(`company ${company.companyId}`, company, 'Company', retried);
    const res = await fetch(`${config_1.GHL_BASE}/oauth/locationToken`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${agencyToken}`,
            Version: exports.CONTACTS_VERSION,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ companyId: company.companyId, locationId }),
        signal: AbortSignal.timeout(30_000)
    });
    const text = await res.text();
    if (!res.ok) {
        if (res.status === 401 && !retried && !/scope/i.test(text) && company.refreshToken)
            return mintLocationToken(company, locationId, true);
        const explanation = res.status === 400 || res.status === 403 ? await explainLocationAccess(company, locationId, agencyToken) : null;
        const raw = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        company.mintErrors = { ...company.mintErrors, [locationId]: explanation ? `${explanation} (${raw})` : raw };
        await (0, store_1.save)();
        throw new GhlApiError(`Could not create a sub-account token for ${locationId} from the agency install (HTTP ${res.status})`, res.status, text.slice(0, 1000));
    }
    const data = JSON.parse(text);
    const { [locationId]: _cleared, ...otherErrors } = company.mintErrors || {};
    company.mintErrors = otherErrors;
    if (!company.locationIds.includes(locationId))
        company.locationIds.push(locationId);
    store_1.registry.ghl[locationId] = {
        locationId,
        accessToken: (0, store_1.encrypt)(data.access_token),
        expiresAt: Date.now() + Number(data.expires_in || 86399) * 1000,
        scope: data.scope,
        userId: data.userId,
        companyId: company.companyId,
        userType: 'Location',
        source: 'agency',
        updatedAt: new Date().toISOString()
    };
    await (0, store_1.save)();
    return data.access_token;
}
// True when a token for this location exists or can be minted from an agency install.
function isConnected(locationId) {
    return Boolean(store_1.registry.ghl[locationId] || agencyFor(locationId));
}
async function getAccessToken(locationId, forceRefresh = false) {
    const conn = store_1.registry.ghl[locationId];
    if (conn && conn.source !== 'agency') {
        return refreshableToken(locationId, conn, conn.userType === 'Company' ? 'Company' : 'Location', forceRefresh);
    }
    const company = agencyFor(locationId);
    if (!company) {
        if (conn)
            return (0, store_1.decrypt)(conn.accessToken);
        throw new GhlNotConnectedError(locationId);
    }
    if (conn && isFresh(conn) && !forceRefresh)
        return (0, store_1.decrypt)(conn.accessToken);
    return singleFlight(`mint:${locationId}`, () => mintLocationToken(company, locationId));
}
async function saveAgencyConnection(input) {
    const previous = store_1.registry.companies[input.companyId];
    store_1.registry.companies[input.companyId] = {
        companyId: input.companyId,
        accessToken: (0, store_1.encrypt)(input.accessToken),
        refreshToken: input.refreshToken ? (0, store_1.encrypt)(input.refreshToken) : undefined,
        expiresAt: input.expiresIn ? Date.now() + Number(input.expiresIn) * 1000 : undefined,
        scope: input.scope,
        userId: input.userId,
        locationIds: [...new Set([...(previous?.locationIds || []), ...(input.locationIds || [])])],
        mintErrors: {},
        updatedAt: new Date().toISOString()
    };
    // Tokens minted from the previous agency token may lack newly granted scopes; mint fresh ones on demand.
    for (const [locationId, conn] of Object.entries(store_1.registry.ghl)) {
        if (conn.source === 'agency' && conn.companyId === input.companyId)
            delete store_1.registry.ghl[locationId];
    }
    await (0, store_1.save)();
}
// Older callbacks stored agency tokens under a location id. Move them to the agency slot so sub-account tokens get minted.
async function migrateAgencyTokens() {
    const moved = [];
    for (const [locationId, conn] of Object.entries(store_1.registry.ghl)) {
        if (conn.source === 'agency')
            continue;
        const claims = tokenClaims(locationId);
        if (claims?.authClass !== 'Company' || !claims.authClassId)
            continue;
        const companyId = claims.authClassId;
        const existing = store_1.registry.companies[companyId];
        const keepExisting = existing && existing.updatedAt >= conn.updatedAt;
        store_1.registry.companies[companyId] = {
            ...(keepExisting
                ? existing
                : {
                    companyId,
                    accessToken: conn.accessToken,
                    refreshToken: conn.refreshToken,
                    expiresAt: conn.expiresAt,
                    scope: conn.scope,
                    userId: conn.userId,
                    updatedAt: conn.updatedAt,
                    lastError: conn.lastError,
                    refreshFailedAt: conn.refreshFailedAt,
                    mintErrors: existing?.mintErrors || {}
                }),
            locationIds: [...new Set([...(existing?.locationIds || []), locationId])]
        };
        delete store_1.registry.ghl[locationId];
        moved.push(companyId);
    }
    if (moved.length)
        await (0, store_1.save)();
    return moved;
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
        source: 'direct',
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
        const conn = store_1.registry.ghl[locationId];
        const renewable = Boolean(conn?.refreshToken) || conn?.source === 'agency';
        const retryable = err instanceof GhlApiError && err.status === 401 && !/scope/i.test(err.body) && renewable;
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
const PROVIDER_MISMATCH = /CONVERSATION_PROVIDER_MISMATCH|Incorrect conversationProviderId/i;
// HighLevel has no API to read a provider's type, and a mismatched type is rejected before anything is created,
// so try the plausible types once and remember the one HighLevel accepts.
function inboundTypeCandidates() {
    return [...new Set([store_1.registry.settings.inboundType, config_1.INBOUND_TYPE, 'SMS', 'Custom', 'WhatsApp'].filter((t) => Boolean(t)))];
}
async function addInboundMessageDetectingType(locationId, input) {
    const candidates = inboundTypeCandidates();
    const rejected = [];
    for (const type of candidates) {
        try {
            const result = await addInboundMessage(locationId, { ...input, type });
            if (store_1.registry.settings.inboundType !== type) {
                store_1.registry.settings.inboundType = type;
                await (0, store_1.save)();
                (0, events_1.recordEvent)('info', `HighLevel accepts this conversation provider's messages as type ${type}; using it from now on`, { locationId });
            }
            return result;
        }
        catch (err) {
            if (!(err instanceof GhlApiError) || !PROVIDER_MISMATCH.test(err.body))
                throw err;
            rejected.push(type);
        }
    }
    throw new Error(`HighLevel rejected conversation provider ${effectiveProviderId() || '(none set)'} for location ${locationId} with types ${rejected.join(', ')}. Either that is not the ID of the provider listed in the sub-account under Settings → Conversation Providers (copy the provider ID from the Marketplace app's Conversation Providers page into GHL_CONVERSATION_PROVIDER_ID on the worker, or send one message from the provider's tab in Conversations so the bridge learns it), or the provider is not active in this sub-account.`);
}
function effectiveProviderId() {
    return store_1.registry.settings.providerId || config_1.PROVIDER_ID;
}
// A message sent through the provider records the provider id HighLevel really uses; adopt it if it differs.
async function learnProviderFromMessage(locationId, messageId) {
    const message = await getMessage(locationId, messageId);
    const providerId = message?.conversationProviderId;
    if (!providerId)
        return null;
    if (providerId !== effectiveProviderId()) {
        const previous = effectiveProviderId();
        store_1.registry.settings.providerId = providerId;
        store_1.registry.settings.inboundType = undefined;
        await (0, store_1.save)();
        (0, events_1.recordEvent)('warn', `Conversation provider id corrected from ${previous || '(none)'} to ${providerId}, read from a message HighLevel sent through the provider`, {
            locationId,
            detail: `message type: ${message.messageType || 'unknown'}`
        });
    }
    return providerId;
}
async function getContactPhone(locationId, contactId) {
    const data = await ghlRequest(locationId, `/contacts/${encodeURIComponent(contactId)}`, { version: exports.CONTACTS_VERSION });
    return data.contact?.phone || null;
}
async function addInboundMessage(locationId, input) {
    const body = {
        type: input.type || config_1.INBOUND_TYPE,
        contactId: input.contactId,
        conversationId: input.conversationId,
        conversationProviderId: effectiveProviderId() || undefined,
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
// Scopes the Conversation Provider docs require for this bridge.
exports.REQUIRED_SCOPES = [
    'conversations.readonly',
    'conversations.write',
    'conversations/message.readonly',
    'conversations/message.write',
    'contacts.readonly',
    'contacts.write'
];
function missingScopes(scope) {
    const granted = new Set((scope || '').split(/\s+/).filter(Boolean));
    return exports.REQUIRED_SCOPES.filter(s => !granted.has(s));
}
// HighLevel access tokens are JWTs; their claims say whether this is an agency (Company) or sub-account (Location)
// token. Only these two claims are surfaced, never the token.
function claimsOf(token) {
    try {
        const payload = token.split('.')[1];
        if (!payload)
            return null;
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return { authClass: claims.authClass, authClassId: claims.authClassId };
    }
    catch {
        return null;
    }
}
function tokenClaims(locationId) {
    const conn = store_1.registry.ghl[locationId];
    if (!conn)
        return null;
    try {
        return claimsOf((0, store_1.decrypt)(conn.accessToken));
    }
    catch {
        return null;
    }
}
// Judged by actual /oauth/locationToken results: the scope string GHL reports for agency tokens can omit oauth.write
// even when minting works.
function agencyProblem(company, locationId) {
    const mintError = company.mintErrors?.[locationId];
    if (!mintError)
        return company.lastError || null;
    if (mintError.startsWith('the app is not installed')) {
        return `${mintError}. The app is authorized for the agency, but HighLevel only issues tokens for sub-accounts the app is installed in. Install it into ${locationId} (select that sub-account on the install screen that "Connect GHL" opens, or add it in the app's sub-account settings in your agency), then click "Connect GHL" again.`;
    }
    if (mintError.startsWith('sub-account')) {
        return `${mintError}. Update the app in that sub-account to the current version (reinstall it there), then click "Connect GHL" again.`;
    }
    return `the app is installed at the agency level and HighLevel refused to create a sub-account token for ${locationId} (${mintError}). Either add the oauth.readonly and oauth.write scopes to the Marketplace app and click "Connect GHL" again, or set the app's target user to Sub-account and install it into ${locationId}.`;
}
function agencyCanMint(companyId) {
    const company = store_1.registry.companies[companyId];
    if (!company)
        return false;
    const minted = Object.values(store_1.registry.ghl).some(c => c.source === 'agency' && c.companyId === companyId);
    return minted || (company.scope || '').split(/\s+/).includes('oauth.write');
}
function connectionProblem(locationId) {
    const conn = store_1.registry.ghl[locationId];
    if (!conn) {
        const company = agencyFor(locationId);
        return company ? agencyProblem(company, locationId) : `HighLevel is not connected for location ${locationId}. Click "Connect GHL" and install the app.`;
    }
    const claims = tokenClaims(locationId);
    if (claims?.authClass === 'Company') {
        return `the stored token is an agency (Company) token, but conversations need a sub-account token. Set the Marketplace app's target user to Sub-account, then click "Connect GHL" and install it into location ${locationId}.`;
    }
    if (claims?.authClass === 'Location' && claims.authClassId && claims.authClassId !== locationId) {
        return `the stored token belongs to location ${claims.authClassId}, not ${locationId}. Click "Connect GHL" and install into ${locationId}.`;
    }
    const missing = missingScopes(conn.scope);
    if (missing.length) {
        return `the token is missing scopes ${missing.join(', ')}. Add them in the Marketplace app (Advanced Settings → Auth → Scopes), then click "Connect GHL" again.`;
    }
    return conn.lastError || null;
}
// A cheap authenticated call that exercises the token, the conversations scope and the Version header.
async function testConnection(locationId) {
    const query = new URLSearchParams({ locationId, limit: '1' });
    await ghlRequest(locationId, `/conversations/search?${query}`, { version: exports.CONVERSATIONS_VERSION });
}
