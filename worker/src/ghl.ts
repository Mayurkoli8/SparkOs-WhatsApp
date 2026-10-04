import { GHL_BASE, GHL_CLIENT_ID, GHL_CLIENT_SECRET, INBOUND_TYPE, PROVIDER_ID } from './config';
import { recordEvent } from './events';
import { decrypt, encrypt, registry, save, type CompanyConnection, type GhlConnection } from './store';

// HighLevel rejects or misroutes calls without the per-API version from its OpenAPI spec.
export const CONTACTS_VERSION = '2021-07-28';
export const CONVERSATIONS_VERSION = '2021-04-15';

export type GhlStatus = 'delivered' | 'read' | 'failed' | 'pending';

export class GhlApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = 'GhlApiError';
  }
}

export class GhlNotConnectedError extends Error {
  constructor(locationId: string) {
    super(`No HighLevel connection for location ${locationId}. Click "Connect GHL" on the dashboard and install the app into this sub-account.`);
    this.name = 'GhlNotConnectedError';
  }
}

type RequestOptions = { method?: string; version: string; body?: unknown };

async function call(token: string, endpoint: string, { method = 'GET', version, body }: RequestOptions) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Version: version, Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${GHL_BASE}${endpoint}`, { method, headers, body: payload, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new GhlApiError(`GHL ${method} ${endpoint.split('?')[0]} failed with HTTP ${res.status}`, res.status, text.slice(0, 1000));
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

type TokenRecord = Pick<GhlConnection, 'accessToken' | 'refreshToken' | 'expiresAt' | 'scope' | 'userId' | 'lastError' | 'refreshFailedAt' | 'updatedAt'>;

const inflight = new Map<string, Promise<string>>();
const REFRESH_BACKOFF_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;

function singleFlight(key: string, task: () => Promise<string>) {
  let pending = inflight.get(key);
  if (!pending) {
    pending = task().finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

const isFresh = (record: { expiresAt?: number }) => record.expiresAt === undefined || record.expiresAt > Date.now() + EXPIRY_MARGIN_MS;

async function refreshableToken(label: string, record: TokenRecord, userType: 'Location' | 'Company', forceRefresh: boolean) {
  if (!record.refreshToken || (isFresh(record) && !forceRefresh)) return decrypt(record.accessToken);
  // A revoked refresh token would otherwise be retried on every single API call.
  if (record.refreshFailedAt && Date.now() - record.refreshFailedAt < REFRESH_BACKOFF_MS) {
    throw new Error(`HighLevel token for ${label} could not be refreshed (${record.lastError}). Reconnect GHL from the dashboard.`);
  }
  // GHL refresh tokens are single-use, so concurrent callers must share one refresh.
  return singleFlight(`refresh:${label}`, () => refreshRecord(record, userType));
}

async function refreshRecord(record: TokenRecord, userType: 'Location' | 'Company'): Promise<string> {
  if (!GHL_CLIENT_ID || !GHL_CLIENT_SECRET) {
    throw new Error('GHL_CLIENT_ID / GHL_CLIENT_SECRET are not set on the worker, so the HighLevel token cannot be refreshed.');
  }
  // redirect_uri is optional for refreshes; omitting it avoids failures when GHL_REDIRECT_URI is stale.
  const form = new URLSearchParams({
    client_id: GHL_CLIENT_ID,
    client_secret: GHL_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: decrypt(record.refreshToken!),
    user_type: userType
  });
  const res = await fetch(`${GHL_BASE}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
  const text = await res.text();
  if (!res.ok) {
    record.lastError = `token refresh failed with HTTP ${res.status}: ${text.slice(0, 200)}`;
    record.refreshFailedAt = Date.now();
    await save();
    throw new GhlApiError(`GHL token refresh failed with HTTP ${res.status}`, res.status, text.slice(0, 1000));
  }
  const data = JSON.parse(text);
  record.accessToken = encrypt(data.access_token);
  if (data.refresh_token) record.refreshToken = encrypt(data.refresh_token);
  record.expiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined;
  record.scope = data.scope || record.scope;
  record.userId = data.userId || record.userId;
  record.lastError = null;
  record.refreshFailedAt = undefined;
  record.updatedAt = new Date().toISOString();
  await save();
  return data.access_token;
}

// The agency (Company) install that can mint tokens for this location, if any.
function agencyFor(locationId: string): CompanyConnection | undefined {
  const linked = registry.ghl[locationId]?.companyId;
  if (linked && registry.companies[linked]) return registry.companies[linked];
  const companies = Object.values(registry.companies);
  return companies.find(c => c.locationIds.includes(locationId)) || (companies.length === 1 ? companies[0] : undefined);
}

function agencyTokenInfo(company: CompanyConnection): { appId?: string; versionId?: string } {
  let claims: { oauthMeta?: { client?: string; versionId?: string } } = {};
  try {
    const payload = decrypt(company.accessToken).split('.')[1];
    if (payload) claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    // opaque token; fall back to the configured client id
  }
  const client = claims.oauthMeta?.client || GHL_CLIENT_ID;
  return { appId: client.split('-')[0] || undefined, versionId: claims.oauthMeta?.versionId };
}

// When HighLevel refuses a sub-account token, ask it whether the app is installed there and in which version.
async function explainLocationAccess(company: CompanyConnection, locationId: string, agencyToken: string): Promise<string | null> {
  const { appId, versionId } = agencyTokenInfo(company);
  if (!appId) return null;
  const query = new URLSearchParams({ companyId: company.companyId, appId, locationId, limit: '5' });
  try {
    const res = await fetch(`${GHL_BASE}/oauth/installedLocations?${query}`, {
      headers: { Authorization: `Bearer ${agencyToken}`, Version: CONTACTS_VERSION, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const entry = (data.locations || []).find((l: { _id?: string }) => l._id === locationId);
    if (!entry || entry.isInstalled === false) return `the app is not installed in sub-account ${locationId}`;
    if (versionId && entry.versionId && entry.versionId !== versionId) {
      return `sub-account ${locationId} has app version ${entry.versionId}, but the agency authorized version ${versionId}`;
    }
    return null;
  } catch {
    return null;
  }
}

function decodeClaims(encryptedToken: string): Record<string, any> {
  try {
    const payload = decrypt(encryptedToken).split('.')[1];
    return payload ? JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) : {};
  } catch {
    return {};
  }
}

// Non-secret facts about how the app is installed for a location: which app version the agency authorized, and
// whether HighLevel considers the app installed in that sub-account (and in which version).
export async function installStatus(locationId: string) {
  const company = agencyFor(locationId);
  const conn = registry.ghl[locationId];
  const summarize = (claims: Record<string, any>) => ({
    authClass: claims.authClass,
    authClassId: claims.authClassId,
    source: claims.source,
    channel: claims.channel,
    oauthMetaKeys: claims.oauthMeta ? Object.keys(claims.oauthMeta) : [],
    client: claims.oauthMeta?.client,
    versionId: claims.oauthMeta?.versionId,
    scopes: claims.oauthMeta?.scopes
  });
  const result: Record<string, unknown> = {
    locationId,
    locationToken: conn ? { storedAs: conn.source || 'direct', ...summarize(decodeClaims(conn.accessToken)) } : null,
    agencyToken: company ? { companyId: company.companyId, ...summarize(decodeClaims(company.accessToken)) } : null
  };
  if (!company) return result;
  const { appId } = agencyTokenInfo(company);
  const token = await refreshableToken(`company ${company.companyId}`, company, 'Company', false);
  const query = new URLSearchParams({ companyId: company.companyId, appId: appId || '', locationId, limit: '5' });
  const res = await fetch(`${GHL_BASE}/oauth/installedLocations?${query}`, {
    headers: { Authorization: `Bearer ${token}`, Version: CONTACTS_VERSION, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000)
  });
  const text = await res.text();
  let entry: Record<string, unknown> | null = null;
  try {
    const found = (JSON.parse(text).locations || []).find((l: { _id?: string }) => l._id === locationId);
    if (found) entry = { isInstalled: found.isInstalled, versionId: found.versionId, installedAt: found.installedAt };
  } catch {
    // reported below as the raw status
  }
  result.installedLocations = { appId, httpStatus: res.status, entry, error: res.ok ? undefined : text.slice(0, 300) };
  return result;
}

// Agency installs get sub-account tokens from /oauth/locationToken; they carry no refresh token and are re-minted.
async function mintLocationToken(company: CompanyConnection, locationId: string, retried = false): Promise<string> {
  const agencyToken = await refreshableToken(`company ${company.companyId}`, company, 'Company', retried);
  const res = await fetch(`${GHL_BASE}/oauth/locationToken`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agencyToken}`,
      Version: CONTACTS_VERSION,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ companyId: company.companyId, locationId }),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 && !retried && !/scope/i.test(text) && company.refreshToken) return mintLocationToken(company, locationId, true);
    const explanation = res.status === 400 || res.status === 403 ? await explainLocationAccess(company, locationId, agencyToken) : null;
    const raw = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    company.mintErrors = { ...company.mintErrors, [locationId]: explanation ? `${explanation} (${raw})` : raw };
    await save();
    throw new GhlApiError(`Could not create a sub-account token for ${locationId} from the agency install (HTTP ${res.status})`, res.status, text.slice(0, 1000));
  }
  const data = JSON.parse(text);
  const { [locationId]: _cleared, ...otherErrors } = company.mintErrors || {};
  company.mintErrors = otherErrors;
  if (!company.locationIds.includes(locationId)) company.locationIds.push(locationId);
  registry.ghl[locationId] = {
    locationId,
    accessToken: encrypt(data.access_token),
    expiresAt: Date.now() + Number(data.expires_in || 86399) * 1000,
    scope: data.scope,
    userId: data.userId,
    companyId: company.companyId,
    userType: 'Location',
    source: 'agency',
    updatedAt: new Date().toISOString()
  };
  await save();
  return data.access_token;
}

// True when a token for this location exists or can be minted from an agency install.
export function isConnected(locationId: string) {
  return Boolean(registry.ghl[locationId] || agencyFor(locationId));
}

export async function getAccessToken(locationId: string, forceRefresh = false): Promise<string> {
  const conn = registry.ghl[locationId];
  if (conn && conn.source !== 'agency') {
    return refreshableToken(locationId, conn, conn.userType === 'Company' ? 'Company' : 'Location', forceRefresh);
  }
  const company = agencyFor(locationId);
  if (!company) {
    if (conn) return decrypt(conn.accessToken);
    throw new GhlNotConnectedError(locationId);
  }
  if (conn && isFresh(conn) && !forceRefresh) return decrypt(conn.accessToken);
  return singleFlight(`mint:${locationId}`, () => mintLocationToken(company, locationId));
}

export async function saveAgencyConnection(input: {
  companyId: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number | string;
  scope?: string;
  userId?: string;
  locationIds?: string[];
}) {
  const previous = registry.companies[input.companyId];
  registry.companies[input.companyId] = {
    companyId: input.companyId,
    accessToken: encrypt(input.accessToken),
    refreshToken: input.refreshToken ? encrypt(input.refreshToken) : undefined,
    expiresAt: input.expiresIn ? Date.now() + Number(input.expiresIn) * 1000 : undefined,
    scope: input.scope,
    userId: input.userId,
    locationIds: [...new Set([...(previous?.locationIds || []), ...(input.locationIds || [])])],
    mintErrors: {},
    updatedAt: new Date().toISOString()
  };
  // Tokens minted from the previous agency token may lack newly granted scopes; mint fresh ones on demand.
  for (const [locationId, conn] of Object.entries(registry.ghl)) {
    if (conn.source === 'agency' && conn.companyId === input.companyId) delete registry.ghl[locationId];
  }
  await save();
}

// Older callbacks stored agency tokens under a location id. Move them to the agency slot so sub-account tokens get minted.
export async function migrateAgencyTokens(): Promise<string[]> {
  const moved: string[] = [];
  for (const [locationId, conn] of Object.entries(registry.ghl)) {
    if (conn.source === 'agency') continue;
    const claims = tokenClaims(locationId);
    if (claims?.authClass !== 'Company' || !claims.authClassId) continue;
    const companyId = claims.authClassId;
    const existing = registry.companies[companyId];
    const keepExisting = existing && existing.updatedAt >= conn.updatedAt;
    registry.companies[companyId] = {
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
    } as CompanyConnection;
    delete registry.ghl[locationId];
    moved.push(companyId);
  }
  if (moved.length) await save();
  return moved;
}

export async function saveConnection(input: {
  locationId: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number | string;
  scope?: string;
  userId?: string;
  companyId?: string;
  userType?: string;
}) {
  registry.ghl[input.locationId] = {
    locationId: input.locationId,
    accessToken: encrypt(input.accessToken),
    refreshToken: input.refreshToken ? encrypt(input.refreshToken) : undefined,
    expiresAt: input.expiresIn ? Date.now() + Number(input.expiresIn) * 1000 : undefined,
    scope: input.scope,
    userId: input.userId,
    companyId: input.companyId,
    userType: input.userType,
    source: 'direct',
    updatedAt: new Date().toISOString()
  };
  await save();
}

export async function ghlRequest(locationId: string, endpoint: string, options: RequestOptions) {
  const token = await getAccessToken(locationId);
  try {
    return await call(token, endpoint, options);
  } catch (err) {
    // A 401 can mean the token expired early (refresh helps) or a missing scope (it does not).
    const conn = registry.ghl[locationId];
    const renewable = Boolean(conn?.refreshToken) || conn?.source === 'agency';
    const retryable = err instanceof GhlApiError && err.status === 401 && !/scope/i.test(err.body) && renewable;
    if (!retryable) throw err;
    let fresh: string;
    try {
      fresh = await getAccessToken(locationId, true);
    } catch (refreshErr) {
      throw new GhlApiError(`${err.message}; refreshing the token also failed (${refreshErr instanceof Error ? refreshErr.message : refreshErr})`, err.status, err.body);
    }
    return call(fresh, endpoint, options);
  }
}

function splitName(name: string) {
  const [firstName, ...rest] = name.trim().split(/\s+/);
  return rest.length ? { firstName, lastName: rest.join(' ') } : { firstName };
}

// Upsert by phone only, so an existing contact's curated name is never overwritten by a WhatsApp profile name.
export async function upsertContact(locationId: string, phoneE164: string, displayName?: string) {
  const data = await ghlRequest(locationId, '/contacts/upsert', {
    method: 'POST',
    version: CONTACTS_VERSION,
    body: { locationId, phone: phoneE164 }
  });
  const contactId: string | undefined = data.contact?.id || data.contactId || data.id;
  if (!contactId) throw new Error(`GHL contact upsert returned no contact id: ${JSON.stringify(data).slice(0, 300)}`);
  const isNew = Boolean(data.new);
  if (isNew && displayName?.trim()) {
    await ghlRequest(locationId, `/contacts/${contactId}`, {
      method: 'PUT',
      version: CONTACTS_VERSION,
      body: { ...splitName(displayName), source: 'WhatsApp' }
    }).catch(() => undefined);
  }
  return { contactId, isNew };
}

export async function findOrCreateConversation(locationId: string, contactId: string): Promise<string> {
  const query = new URLSearchParams({ locationId, contactId, limit: '1' });
  const found = await ghlRequest(locationId, `/conversations/search?${query}`, { version: CONVERSATIONS_VERSION });
  const existing = found.conversations?.[0]?.id;
  if (existing) return existing;
  try {
    const created = await ghlRequest(locationId, '/conversations/', {
      method: 'POST',
      version: CONVERSATIONS_VERSION,
      body: { locationId, contactId }
    });
    const id = created.conversation?.id || created.id;
    if (!id) throw new Error(`GHL create conversation returned no id: ${JSON.stringify(created).slice(0, 300)}`);
    return id;
  } catch (err) {
    if (err instanceof GhlApiError && err.status === 400) {
      try {
        const id = JSON.parse(err.body)?.conversationId;
        if (id) return id;
      } catch {
        // fall through to the original error
      }
    }
    throw err;
  }
}

type InboundInput = {
  contactId: string;
  conversationId: string;
  message: string;
  attachments?: string[];
  altId?: string;
  direction: 'inbound' | 'outbound';
  date?: string;
  type?: string;
};

const PROVIDER_MISMATCH = /CONVERSATION_PROVIDER_MISMATCH|Incorrect conversationProviderId/i;

// HighLevel has no API to read a provider's type, and a mismatched type is rejected before anything is created,
// so try the plausible types once and remember the one HighLevel accepts.
export function inboundTypeCandidates() {
  return [...new Set([registry.settings.inboundType, INBOUND_TYPE, 'SMS', 'Custom', 'WhatsApp'].filter((t): t is string => Boolean(t)))];
}

export async function addInboundMessageDetectingType(locationId: string, input: InboundInput) {
  const candidates = inboundTypeCandidates();
  const rejected: string[] = [];
  for (const type of candidates) {
    try {
      const result = await addInboundMessage(locationId, { ...input, type });
      if (registry.settings.inboundType !== type) {
        registry.settings.inboundType = type;
        await save();
        recordEvent('info', `HighLevel accepts this conversation provider's messages as type ${type}; using it from now on`, { locationId });
      }
      return result;
    } catch (err) {
      if (!(err instanceof GhlApiError) || !PROVIDER_MISMATCH.test(err.body)) throw err;
      rejected.push(type);
    }
  }
  throw new Error(
    `HighLevel rejected conversation provider ${PROVIDER_ID || '(none set)'} for location ${locationId} with types ${rejected.join(', ')}. The provider is not active in this sub-account: in the Marketplace app open Conversation Providers, check that this is the provider's ID, that its type is SMS and that it is saved, then confirm it appears in the sub-account under Settings → Conversation Providers or Settings → Phone Numbers → Advanced Settings → SMS Provider.`
  );
}

export async function getContactPhone(locationId: string, contactId: string): Promise<string | null> {
  const data = await ghlRequest(locationId, `/contacts/${encodeURIComponent(contactId)}`, { version: CONTACTS_VERSION });
  return data.contact?.phone || null;
}

export async function addInboundMessage(locationId: string, input: InboundInput): Promise<{ messageId?: string; conversationId?: string }> {
  const body: Record<string, unknown> = {
    type: input.type || INBOUND_TYPE,
    contactId: input.contactId,
    conversationId: input.conversationId,
    conversationProviderId: PROVIDER_ID || undefined,
    message: input.message,
    attachments: input.attachments?.length ? input.attachments : undefined,
    altId: input.altId,
    direction: input.direction,
    date: input.date
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return ghlRequest(locationId, '/conversations/messages/inbound', { method: 'POST', version: CONVERSATIONS_VERSION, body });
}

export async function updateMessageStatus(locationId: string, messageId: string, status: GhlStatus, errorMessage?: string) {
  const body: Record<string, unknown> = { status };
  if (errorMessage) body.error = { code: '1', type: 'saas', message: errorMessage.slice(0, 300) };
  return ghlRequest(locationId, `/conversations/messages/${encodeURIComponent(messageId)}/status`, {
    method: 'PUT',
    version: CONVERSATIONS_VERSION,
    body
  });
}

export async function uploadAttachment(
  locationId: string,
  input: { conversationId: string; contactId: string; data: Buffer; mimetype: string; fileName: string }
): Promise<string[]> {
  const form = new FormData();
  form.append('conversationId', input.conversationId);
  form.append('contactId', input.contactId);
  form.append('locationId', locationId);
  form.append('fileAttachment', new Blob([new Uint8Array(input.data)], { type: input.mimetype }), input.fileName);
  const data = await ghlRequest(locationId, '/conversations/messages/upload', { method: 'POST', version: CONVERSATIONS_VERSION, body: form });
  const uploaded = data.uploadedFiles || {};
  return Object.values(uploaded).filter((url): url is string => typeof url === 'string');
}

export async function getMessage(locationId: string, messageId: string) {
  const data = await ghlRequest(locationId, `/conversations/messages/${encodeURIComponent(messageId)}`, { version: CONVERSATIONS_VERSION });
  return data.message || data;
}

// Scopes the Conversation Provider docs require for this bridge.
export const REQUIRED_SCOPES = [
  'conversations.readonly',
  'conversations.write',
  'conversations/message.readonly',
  'conversations/message.write',
  'contacts.readonly',
  'contacts.write'
];

export function missingScopes(scope: string | null | undefined) {
  const granted = new Set((scope || '').split(/\s+/).filter(Boolean));
  return REQUIRED_SCOPES.filter(s => !granted.has(s));
}

// HighLevel access tokens are JWTs; their claims say whether this is an agency (Company) or sub-account (Location)
// token. Only these two claims are surfaced, never the token.
export function claimsOf(token: string): { authClass?: string; authClassId?: string } | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return { authClass: claims.authClass, authClassId: claims.authClassId };
  } catch {
    return null;
  }
}

export function tokenClaims(locationId: string) {
  const conn = registry.ghl[locationId];
  if (!conn) return null;
  try {
    return claimsOf(decrypt(conn.accessToken));
  } catch {
    return null;
  }
}

// Judged by actual /oauth/locationToken results: the scope string GHL reports for agency tokens can omit oauth.write
// even when minting works.
function agencyProblem(company: CompanyConnection, locationId: string) {
  const mintError = company.mintErrors?.[locationId];
  if (!mintError) return company.lastError || null;
  if (mintError.startsWith('the app is not installed')) {
    return `${mintError}. The app is authorized for the agency, but HighLevel only issues tokens for sub-accounts the app is installed in. Install it into ${locationId} (select that sub-account on the install screen that "Connect GHL" opens, or add it in the app's sub-account settings in your agency), then click "Connect GHL" again.`;
  }
  if (mintError.startsWith('sub-account')) {
    return `${mintError}. Update the app in that sub-account to the current version (reinstall it there), then click "Connect GHL" again.`;
  }
  return `the app is installed at the agency level and HighLevel refused to create a sub-account token for ${locationId} (${mintError}). Either add the oauth.readonly and oauth.write scopes to the Marketplace app and click "Connect GHL" again, or set the app's target user to Sub-account and install it into ${locationId}.`;
}

export function agencyCanMint(companyId: string) {
  const company = registry.companies[companyId];
  if (!company) return false;
  const minted = Object.values(registry.ghl).some(c => c.source === 'agency' && c.companyId === companyId);
  return minted || (company.scope || '').split(/\s+/).includes('oauth.write');
}

export function connectionProblem(locationId: string): string | null {
  const conn = registry.ghl[locationId];
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
export async function testConnection(locationId: string) {
  const query = new URLSearchParams({ locationId, limit: '1' });
  await ghlRequest(locationId, `/conversations/search?${query}`, { version: CONVERSATIONS_VERSION });
}
