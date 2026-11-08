import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type * as GhlModule from '../src/ghl';
import type * as StoreModule from '../src/store';

// This file runs in its own process: configure a worker that has no client secret but may refresh through the web app.
process.env.GHL_CLIENT_SECRET = '';
process.env.TOKEN_REFRESH_URL = 'https://web.test/api/oauth/refresh';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const calls: Call[] = [];

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(String(input));
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body;
  calls.push({ method: init.method || 'GET', url, headers, body });
  if (url.href === 'https://web.test/api/oauth/refresh') {
    return new Response(JSON.stringify({ access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 86399 }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

let ghl: typeof GhlModule;
let store: typeof StoreModule;

before(async () => {
  // Loaded only now, after the environment above is in place.
  store = require('../src/store');
  ghl = require('../src/ghl');
  await store.loadRegistry();
  await store.initTokenKey();
});

test('without a client secret, tokens are refreshed through the web app', async () => {
  store.registry.ghl = {
    LOC1: {
      locationId: 'LOC1',
      accessToken: store.encrypt('tok-1'),
      refreshToken: store.encrypt('ref-1'),
      expiresAt: Date.now() - 1000,
      userType: 'Location',
      updatedAt: new Date().toISOString()
    }
  };

  assert.equal(await ghl.getAccessToken('LOC1'), 'tok-2');
  const [refresh] = calls;
  assert.equal(refresh.method, 'POST');
  assert.equal(refresh.url.href, 'https://web.test/api/oauth/refresh');
  assert.equal(refresh.headers['x-internal-api-key'], 'internal-key');
  assert.deepEqual(refresh.body, { refresh_token: 'ref-1', user_type: 'Location' });
  assert.equal(calls.some(c => c.url.pathname === '/oauth/token'), false, 'must not call HighLevel without the secret');
  assert.equal(store.decrypt(store.registry.ghl.LOC1.refreshToken!), 'ref-2');
});
