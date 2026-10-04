import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as ghl from '../src/ghl';
import { decrypt, deriveKey, encrypt, initTokenKey, loadRegistry, registry } from '../src/store';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
type Route = { method: string; path: string; reply: (call: Call) => { status?: number; json?: unknown } };

let calls: Call[] = [];
let routes: Route[] = [];

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(String(input));
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  let body: any = init.body;
  if (typeof body === 'string') body = JSON.parse(body);
  else if (body instanceof URLSearchParams) body = Object.fromEntries(body.entries());
  const call = { method: init.method || 'GET', url, headers, body };
  calls.push(call);
  const route = routes.find(r => r.method === call.method && r.path === url.pathname);
  if (!route) return new Response(JSON.stringify({ message: `no stub for ${call.method} ${url.pathname}` }), { status: 404 });
  const { status = 200, json = {} } = route.reply(call);
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const on = (method: string, path: string, reply: Route['reply']) => routes.push({ method, path, reply });
const callsTo = (method: string, path: string) => calls.filter(c => c.method === method && c.url.pathname === path);

beforeEach(async () => {
  calls = [];
  routes = [];
  await loadRegistry();
  await initTokenKey();
  registry.companies = {};
  registry.ghl = {
    LOC1: {
      locationId: 'LOC1',
      accessToken: encrypt('tok-1'),
      refreshToken: encrypt('ref-1'),
      expiresAt: Date.now() + 3_600_000,
      userType: 'Location',
      updatedAt: new Date().toISOString()
    }
  };
});

test('inbound sync uses the documented API versions, IDs and provider', async () => {
  on('POST', '/contacts/upsert', () => ({ json: { new: false, contact: { id: 'C1' } } }));
  on('GET', '/conversations/search', () => ({ json: { conversations: [{ id: 'CONV1' }], total: 1 } }));
  on('POST', '/conversations/messages/inbound', () => ({ json: { success: true, conversationId: 'CONV1', messageId: 'GM1' } }));

  const contact = await ghl.upsertContact('LOC1', '+919876543210', 'Asha Rao');
  const conversationId = await ghl.findOrCreateConversation('LOC1', contact.contactId);
  const result = await ghl.addInboundMessage('LOC1', {
    contactId: contact.contactId,
    conversationId,
    message: 'hi',
    altId: 'WA1',
    direction: 'inbound',
    date: '2026-10-04T10:00:00.000Z'
  });

  assert.deepEqual(contact, { contactId: 'C1', isNew: false });
  assert.equal(conversationId, 'CONV1');
  assert.equal(result.messageId, 'GM1');

  const [upsert] = callsTo('POST', '/contacts/upsert');
  assert.equal(upsert.headers.version, '2021-07-28');
  assert.equal(upsert.headers.authorization, 'Bearer tok-1');
  assert.deepEqual(upsert.body, { locationId: 'LOC1', phone: '+919876543210' });

  const [search] = callsTo('GET', '/conversations/search');
  assert.equal(search.headers.version, '2021-04-15');
  assert.equal(search.url.searchParams.get('locationId'), 'LOC1');
  assert.equal(search.url.searchParams.get('contactId'), 'C1');

  const [inbound] = callsTo('POST', '/conversations/messages/inbound');
  assert.equal(inbound.headers.version, '2021-04-15');
  assert.deepEqual(inbound.body, {
    type: 'SMS',
    contactId: 'C1',
    conversationId: 'CONV1',
    conversationProviderId: 'provider-123',
    message: 'hi',
    altId: 'WA1',
    direction: 'inbound',
    date: '2026-10-04T10:00:00.000Z'
  });
  assert.equal(callsTo('PUT', '/contacts/C1').length, 0, 'existing contacts must not be renamed');
});

test('the provider message type is detected once and remembered', async () => {
  registry.settings = {};
  const types: string[] = [];
  on('POST', '/conversations/messages/inbound', call => {
    types.push(call.body.type);
    return call.body.type === 'Custom'
      ? { json: { success: true, messageId: `GM-${types.length}` } }
      : { status: 400, json: { statusCode: 400, message: 'Incorrect conversationProviderId/type', canonicalCode: 'CONVERSATIONS_MSG_CONVERSATION_PROVIDER_MISMATCH' } };
  });
  const input = { contactId: 'C1', conversationId: 'CONV1', message: 'hi', direction: 'inbound' as const };

  assert.equal((await ghl.addInboundMessageDetectingType('LOC1', input)).messageId, 'GM-2');
  assert.deepEqual(types, ['SMS', 'Custom']);
  assert.equal(registry.settings.inboundType, 'Custom');

  await ghl.addInboundMessageDetectingType('LOC1', input);
  assert.deepEqual(types, ['SMS', 'Custom', 'Custom']);
});

test('a provider HighLevel rejects for every type is reported as not active', async () => {
  registry.settings = {};
  on('POST', '/conversations/messages/inbound', () => ({
    status: 400,
    json: { statusCode: 400, message: 'Incorrect conversationProviderId/type', canonicalCode: 'CONVERSATIONS_MSG_CONVERSATION_PROVIDER_MISMATCH' }
  }));

  await assert.rejects(
    ghl.addInboundMessageDetectingType('LOC1', { contactId: 'C1', conversationId: 'CONV1', message: 'hi', direction: 'inbound' }),
    (err: unknown) => err instanceof Error && /provider-123/.test(err.message) && /SMS, Custom, WhatsApp/.test(err.message)
  );
  assert.equal(callsTo('POST', '/conversations/messages/inbound').length, 3);
});

test('other inbound errors are not retried with other types', async () => {
  registry.settings = {};
  on('POST', '/conversations/messages/inbound', () => ({ status: 422, json: { message: 'contactId must be valid' } }));

  await assert.rejects(ghl.addInboundMessageDetectingType('LOC1', { contactId: 'C1', conversationId: 'CONV1', message: 'hi', direction: 'inbound' }), ghl.GhlApiError);
  assert.equal(callsTo('POST', '/conversations/messages/inbound').length, 1);
});

test('a contact phone can be looked up for delivery payloads without one', async () => {
  on('GET', '/contacts/C7', () => ({ json: { contact: { id: 'C7', phone: '+919876543210' } } }));

  assert.equal(await ghl.getContactPhone('LOC1', 'C7'), '+919876543210');
  assert.equal(callsTo('GET', '/contacts/C7')[0].headers.version, '2021-07-28');
});

test('new contacts are named from the WhatsApp profile', async () => {
  on('POST', '/contacts/upsert', () => ({ json: { new: true, contact: { id: 'C2' } } }));
  on('PUT', '/contacts/C2', () => ({ json: { succeded: true } }));

  assert.deepEqual(await ghl.upsertContact('LOC1', '+447700900123', 'Asha Rao'), { contactId: 'C2', isNew: true });
  const [update] = callsTo('PUT', '/contacts/C2');
  assert.equal(update.headers.version, '2021-07-28');
  assert.deepEqual(update.body, { firstName: 'Asha', lastName: 'Rao', source: 'WhatsApp' });
});

test('a conversation is created when the contact has none', async () => {
  on('GET', '/conversations/search', () => ({ json: { conversations: [], total: 0 } }));
  on('POST', '/conversations/', () => ({ json: { success: true, conversation: { id: 'CONV9' } } }));

  assert.equal(await ghl.findOrCreateConversation('LOC1', 'C1'), 'CONV9');
  const [create] = callsTo('POST', '/conversations/');
  assert.equal(create.headers.version, '2021-04-15');
  assert.deepEqual(create.body, { locationId: 'LOC1', contactId: 'C1' });
});

test('an "already exists" create error still yields the conversation id', async () => {
  on('GET', '/conversations/search', () => ({ json: { conversations: [], total: 0 } }));
  on('POST', '/conversations/', () => ({ status: 400, json: { statusCode: 400, message: 'Conversation already exists', conversationId: 'CONV5' } }));

  assert.equal(await ghl.findOrCreateConversation('LOC1', 'C1'), 'CONV5');
});

test('an expired token is refreshed exactly once for concurrent callers', async () => {
  registry.ghl.LOC1.expiresAt = Date.now() - 1000;
  on('POST', '/oauth/token', () => ({ json: { access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 86399, userType: 'Location' } }));

  const tokens = await Promise.all([ghl.getAccessToken('LOC1'), ghl.getAccessToken('LOC1'), ghl.getAccessToken('LOC1')]);

  assert.deepEqual(tokens, ['tok-2', 'tok-2', 'tok-2']);
  const refreshCalls = callsTo('POST', '/oauth/token');
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].body.grant_type, 'refresh_token');
  assert.equal(refreshCalls[0].body.refresh_token, 'ref-1');
  assert.equal(refreshCalls[0].body.user_type, 'Location');
  assert.equal(decrypt(registry.ghl.LOC1.accessToken), 'tok-2');
  assert.equal(decrypt(registry.ghl.LOC1.refreshToken!), 'ref-2');
  assert.ok(registry.ghl.LOC1.expiresAt! > Date.now() + 86_000_000);
});

test('a 401 triggers one forced refresh and a retry', async () => {
  let searches = 0;
  on('GET', '/conversations/search', call => {
    searches++;
    return call.headers.authorization === 'Bearer tok-2'
      ? { json: { conversations: [{ id: 'CONV1' }], total: 1 } }
      : { status: 401, json: { statusCode: 401, message: 'Invalid JWT' } };
  });
  on('POST', '/oauth/token', () => ({ json: { access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 86399 } }));

  assert.equal(await ghl.findOrCreateConversation('LOC1', 'C1'), 'CONV1');
  assert.equal(searches, 2);
  assert.equal(callsTo('POST', '/oauth/token').length, 1);
});

test('a scope error is not retried with a refresh', async () => {
  on('GET', '/conversations/search', () => ({ status: 401, json: { statusCode: 401, message: 'The token is not authorized for this scope.' } }));

  await assert.rejects(ghl.findOrCreateConversation('LOC1', 'C1'), (err: unknown) => err instanceof ghl.GhlApiError && /scope/.test(err.body));
  assert.equal(callsTo('POST', '/oauth/token').length, 0);
});

test('a failed refresh after a 401 keeps the original error visible', async () => {
  on('GET', '/conversations/search', () => ({ status: 401, json: { statusCode: 401, message: 'Invalid JWT' } }));
  on('POST', '/oauth/token', () => ({ status: 401, json: { error: 'UnAuthorized!', error_description: 'Invalid refresh token' } }));

  await assert.rejects(ghl.findOrCreateConversation('LOC1', 'C1'), (err: unknown) => {
    assert.ok(err instanceof ghl.GhlApiError);
    assert.equal(err.status, 401);
    assert.match(err.body, /Invalid JWT/);
    assert.match(err.message, /refreshing the token also failed/);
    return true;
  });
});

test('after a failed refresh the connection is flagged and refreshes back off', async () => {
  registry.ghl.LOC1.expiresAt = Date.now() - 1000;
  on('POST', '/oauth/token', () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Invalid refresh token' } }));

  await assert.rejects(ghl.getAccessToken('LOC1'), ghl.GhlApiError);
  assert.match(registry.ghl.LOC1.lastError || '', /invalid_grant/);
  await assert.rejects(ghl.getAccessToken('LOC1'), /Reconnect GHL/);
  assert.equal(callsTo('POST', '/oauth/token').length, 1);
});

test('message status updates carry the provider error', async () => {
  on('PUT', '/conversations/messages/GM1/status', () => ({ json: { success: true } }));

  await ghl.updateMessageStatus('LOC1', 'GM1', 'failed', 'WhatsApp is not connected');
  const [update] = callsTo('PUT', '/conversations/messages/GM1/status');
  assert.equal(update.headers.version, '2021-04-15');
  assert.deepEqual(update.body, { status: 'failed', error: { code: '1', type: 'saas', message: 'WhatsApp is not connected' } });
});

test('API errors expose status and response body', async () => {
  on('POST', '/contacts/upsert', () => ({ status: 422, json: { message: ['phone must be valid'] } }));

  await assert.rejects(ghl.upsertContact('LOC1', '+1', undefined), (err: unknown) => {
    assert.ok(err instanceof ghl.GhlApiError);
    assert.equal(err.status, 422);
    assert.match(err.body, /phone must be valid/);
    return true;
  });
});

test('locations without an OAuth connection are reported clearly', async () => {
  await assert.rejects(ghl.getAccessToken('MISSING'), ghl.GhlNotConnectedError);
});

test('missingScopes lists the provider scopes a token lacks', () => {
  const granted = 'conversations.readonly conversations.write conversations/message.readonly conversations/message.write conversations/reports.readonly';
  assert.deepEqual(ghl.missingScopes(granted), ['contacts.readonly', 'contacts.write']);
  assert.deepEqual(ghl.missingScopes(`${granted} contacts.readonly contacts.write`), []);
  assert.deepEqual(ghl.missingScopes(undefined), ghl.REQUIRED_SCOPES);
});

test('tokenClaims reads the class of the stored token without exposing it', () => {
  const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  registry.ghl.LOC1.accessToken = encrypt(jwt({ authClass: 'Company', authClassId: 'COMPANY9', oauthMeta: { scopes: ['contacts.write'] } }));
  assert.deepEqual(ghl.tokenClaims('LOC1'), { authClass: 'Company', authClassId: 'COMPANY9' });
  registry.ghl.LOC1.accessToken = encrypt('opaque-token');
  assert.equal(ghl.tokenClaims('LOC1'), null);
  assert.equal(ghl.tokenClaims('MISSING'), null);
});

test('connectionProblem explains agency tokens, wrong locations and missing scopes', () => {
  const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  const all = ghl.REQUIRED_SCOPES.join(' ');
  registry.ghl.LOC1.scope = all;
  registry.ghl.LOC1.accessToken = encrypt(jwt({ authClass: 'Company', authClassId: 'COMPANY9' }));
  assert.match(ghl.connectionProblem('LOC1') || '', /agency/i);
  registry.ghl.LOC1.accessToken = encrypt(jwt({ authClass: 'Location', authClassId: 'OTHER' }));
  assert.match(ghl.connectionProblem('LOC1') || '', /OTHER/);
  registry.ghl.LOC1.accessToken = encrypt(jwt({ authClass: 'Location', authClassId: 'LOC1' }));
  assert.equal(ghl.connectionProblem('LOC1'), null);
  registry.ghl.LOC1.scope = 'conversations.readonly';
  assert.match(ghl.connectionProblem('LOC1') || '', /contacts\.write/);
});

test('deriveKey keeps real base64 32-byte keys and hashes anything else', () => {
  const real = crypto.randomBytes(32);
  assert.deepEqual(deriveKey(real.toString('base64')), { key: real, source: 'env' });
  const derived = deriveKey('short-passphrase');
  assert.equal(derived.source, 'env-derived');
  assert.equal(derived.key.length, 32);
  assert.equal(decrypt(encrypt('round trip')), 'round trip');
});
