import { GHL_BASE, GHL_CLIENT_ID, GHL_CLIENT_SECRET, INBOUND_TYPE, PROVIDER_ID } from './config';
import { decrypt, encrypt, registry, save, type GhlConnection } from './store';

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

const refreshes = new Map<string, Promise<string>>();
const REFRESH_BACKOFF_MS = 10 * 60_000;

export async function getAccessToken(locationId: string, forceRefresh = false): Promise<string> {
  const conn = registry.ghl[locationId];
  if (!conn) throw new GhlNotConnectedError(locationId);
  const stillValid = conn.expiresAt === undefined || conn.expiresAt > Date.now() + 5 * 60_000;
  if (!conn.refreshToken || (stillValid && !forceRefresh)) return decrypt(conn.accessToken);
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

async function refreshAccessToken(conn: GhlConnection): Promise<string> {
  if (!GHL_CLIENT_ID || !GHL_CLIENT_SECRET) {
    throw new Error('GHL_CLIENT_ID / GHL_CLIENT_SECRET are not set on the worker, so the HighLevel token cannot be refreshed.');
  }
  const form = new URLSearchParams({
    client_id: GHL_CLIENT_ID,
    client_secret: GHL_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: decrypt(conn.refreshToken!),
    // redirect_uri is optional for refreshes; omitting it avoids failures when GHL_REDIRECT_URI is stale.
    user_type: conn.userType === 'Company' ? 'Company' : 'Location'
  });
  const res = await fetch(`${GHL_BASE}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
  const text = await res.text();
  if (!res.ok) {
    conn.lastError = `token refresh failed with HTTP ${res.status}: ${text.slice(0, 200)}`;
    conn.refreshFailedAt = Date.now();
    await save();
    throw new GhlApiError(`GHL token refresh failed with HTTP ${res.status}`, res.status, text.slice(0, 1000));
  }
  const data = JSON.parse(text);
  await saveConnection({
    locationId: conn.locationId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || decrypt(conn.refreshToken!),
    expiresIn: data.expires_in,
    scope: data.scope || conn.scope,
    userId: data.userId || conn.userId,
    companyId: data.companyId || conn.companyId,
    userType: data.userType || conn.userType
  });
  return data.access_token;
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
    const retryable = err instanceof GhlApiError && err.status === 401 && !/scope/i.test(err.body) && registry.ghl[locationId]?.refreshToken;
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

export async function addInboundMessage(
  locationId: string,
  input: {
    contactId: string;
    conversationId: string;
    message: string;
    attachments?: string[];
    altId?: string;
    direction: 'inbound' | 'outbound';
    date?: string;
  }
): Promise<{ messageId?: string; conversationId?: string }> {
  const body: Record<string, unknown> = {
    type: INBOUND_TYPE,
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
export function tokenClaims(locationId: string): { authClass?: string; authClassId?: string } | null {
  const conn = registry.ghl[locationId];
  if (!conn) return null;
  try {
    const payload = decrypt(conn.accessToken).split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return { authClass: claims.authClass, authClassId: claims.authClassId };
  } catch {
    return null;
  }
}

export function connectionProblem(locationId: string): string | null {
  const conn = registry.ghl[locationId];
  if (!conn) return null;
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
