import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as ghl from '../src/ghl';
import { decrypt, encrypt, initTokenKey, loadRegistry, registry } from '../src/store';

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
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const AGENCY_SCOPES = `${ghl.REQUIRED_SCOPES.join(' ')} oauth.readonly oauth.write`;

beforeEach(async () => {
  calls = [];
  routes = [];
  await loadRegistry();
  await initTokenKey();
  registry.ghl = {};
  registry.companies = {};
  registry.instances = {};
});

test('an agency token filed under a location is migrated to an agency connection', async () => {
  registry.ghl.LOC1 = {
    locationId: 'LOC1',
    accessToken: encrypt(jwt({ authClass: 'Company', authClassId: 'CO1' })),
    refreshToken: encrypt('agency-refresh'),
    expiresAt: Date.now() + 3_600_000,
    scope: 'conversations.readonly',
    updatedAt: new Date().toISOString()
  };

  assert.deepEqual(await ghl.migrateAgencyTokens(), ['CO1']);
  assert.equal(registry.ghl.LOC1, undefined);
  assert.equal(registry.companies.CO1.companyId, 'CO1');
  assert.equal(decrypt(registry.companies.CO1.refreshToken!), 'agency-refresh');
  assert.deepEqual(registry.companies.CO1.locationIds, ['LOC1']);
});

test('a sub-account token is minted from the agency token and reused until it expires', async () => {
  await ghl.saveAgencyConnection({ companyId: 'CO1', accessToken: 'agency-token', refreshToken: 'agency-refresh', expiresIn: 86399, scope: AGENCY_SCOPES, locationIds: ['LOC1'] });
  on('POST', '/oauth/locationToken', () => ({ json: { access_token: jwt({ authClass: 'Location', authClassId: 'LOC1' }), expires_in: 86399, scope: ghl.REQUIRED_SCOPES.join(' '), locationId: 'LOC1' } }));

  const first = await ghl.getAccessToken('LOC1');
  const second = await ghl.getAccessToken('LOC1');

  assert.equal(first, second);
  const mints = callsTo('POST', '/oauth/locationToken');
  assert.equal(mints.length, 1);
  assert.equal(mints[0].headers.authorization, 'Bearer agency-token');
  assert.equal(mints[0].headers.version, '2021-07-28');
  assert.deepEqual(mints[0].body, { companyId: 'CO1', locationId: 'LOC1' });
  assert.equal(registry.ghl.LOC1.source, 'agency');
  assert.equal(registry.ghl.LOC1.companyId, 'CO1');
  assert.equal(ghl.connectionProblem('LOC1'), null);

  registry.ghl.LOC1.expiresAt = Date.now() - 1000;
  await ghl.getAccessToken('LOC1');
  assert.equal(callsTo('POST', '/oauth/locationToken').length, 2);
});

test('a 401 on an agency-minted token re-mints it and retries', async () => {
  await ghl.saveAgencyConnection({ companyId: 'CO1', accessToken: 'agency-token', refreshToken: 'agency-refresh', expiresIn: 86399, scope: AGENCY_SCOPES, locationIds: ['LOC1'] });
  let minted = 0;
  on('POST', '/oauth/locationToken', () => ({ json: { access_token: `loc-token-${++minted}`, expires_in: 86399, scope: AGENCY_SCOPES } }));
  on('GET', '/conversations/search', call =>
    call.headers.authorization === 'Bearer loc-token-2'
      ? { json: { conversations: [{ id: 'CONV1' }], total: 1 } }
      : { status: 401, json: { statusCode: 401, message: 'Invalid JWT' } }
  );

  assert.equal(await ghl.findOrCreateConversation('LOC1', 'C1'), 'CONV1');
  assert.equal(minted, 2);
});

test('minting failures are recorded and explained', async () => {
  await ghl.saveAgencyConnection({ companyId: 'CO1', accessToken: 'agency-token', refreshToken: 'agency-refresh', expiresIn: 86399, scope: 'conversations.readonly', locationIds: ['LOC1'] });
  on('POST', '/oauth/locationToken', () => ({ status: 401, json: { statusCode: 401, message: 'The token is not authorized for this scope.' } }));

  await assert.rejects(ghl.getAccessToken('LOC1'), ghl.GhlApiError);
  const problem = ghl.connectionProblem('LOC1') || '';
  assert.match(problem, /oauth\.write/);
  assert.match(problem, /not authorized for this scope/);
});

test('a location access error is explained with the installed-locations check', async () => {
  const agencyJwt = jwt({ authClass: 'Company', authClassId: 'CO1', oauthMeta: { client: 'APP123-abc', versionId: 'VER-NEW', scopes: ['contacts.write'] } });
  await ghl.saveAgencyConnection({ companyId: 'CO1', accessToken: agencyJwt, refreshToken: 'agency-refresh', expiresIn: 86399, scope: AGENCY_SCOPES, locationIds: ['LOC1', 'LOC2'] });
  on('POST', '/oauth/locationToken', () => ({
    status: 400,
    json: { message: 'Invalid locationId or accessToken does not have access to following location', error: 'Bad Request', statusCode: 400 }
  }));
  on('GET', '/oauth/installedLocations', call =>
    call.url.searchParams.get('locationId') === 'LOC1'
      ? { json: { locations: [{ _id: 'LOC1', name: 'Shop', address: '', isInstalled: false }], count: 1 } }
      : { json: { locations: [{ _id: 'LOC2', name: 'Shop 2', address: '', isInstalled: true, versionId: 'VER-OLD' }], count: 1 } }
  );

  await assert.rejects(ghl.getAccessToken('LOC1'), ghl.GhlApiError);
  const [lookup] = callsTo('GET', '/oauth/installedLocations');
  assert.equal(lookup.headers.authorization, `Bearer ${agencyJwt}`);
  assert.equal(lookup.headers.version, '2021-07-28');
  assert.equal(lookup.url.searchParams.get('companyId'), 'CO1');
  assert.equal(lookup.url.searchParams.get('appId'), 'APP123');
  assert.match(ghl.connectionProblem('LOC1') || '', /not installed in sub-account LOC1/);

  await assert.rejects(ghl.getAccessToken('LOC2'), ghl.GhlApiError);
  assert.match(ghl.connectionProblem('LOC2') || '', /VER-OLD/);
  assert.match(ghl.connectionProblem('LOC2') || '', /VER-NEW/);
});

test('locations without any connection report that HighLevel is not connected', async () => {
  await assert.rejects(ghl.getAccessToken('LOC9'), ghl.GhlNotConnectedError);
  assert.match(ghl.connectionProblem('LOC9') || '', /not connected/i);
});

test('an agency token is refreshed with user_type Company', async () => {
  await ghl.saveAgencyConnection({ companyId: 'CO1', accessToken: 'agency-token', refreshToken: 'agency-refresh', expiresIn: 1, scope: AGENCY_SCOPES, locationIds: ['LOC1'] });
  on('POST', '/oauth/token', () => ({ json: { access_token: 'agency-token-2', refresh_token: 'agency-refresh-2', expires_in: 86399, userType: 'Company' } }));
  on('POST', '/oauth/locationToken', call => ({ json: { access_token: `minted-with-${call.headers.authorization.slice(7)}`, expires_in: 86399, scope: AGENCY_SCOPES } }));

  assert.equal(await ghl.getAccessToken('LOC1'), 'minted-with-agency-token-2');
  const [refresh] = callsTo('POST', '/oauth/token');
  assert.equal(refresh.body.user_type, 'Company');
  assert.equal(refresh.body.refresh_token, 'agency-refresh');
  assert.equal(decrypt(registry.companies.CO1.refreshToken!), 'agency-refresh-2');
});
