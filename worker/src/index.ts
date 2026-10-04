import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import {
  BUILD,
  COMMIT,
  DATA_DIR,
  GHL_CLIENT_ID,
  GHL_CLIENT_SECRET,
  GHL_WEBHOOK_PUBLIC_KEY,
  INBOUND_TYPE,
  INTERNAL_API_KEY,
  PORT,
  PROVIDER_ID,
  SIGNATURE_CHECK_DISABLED,
  SYNC_PHONE_MESSAGES,
  VOLUME_PATH
} from './config';
import { errorText, flushEvents, loadEvents, log, recentEvents, recordEvent } from './events';
import * as ghl from './ghl';
import * as bridge from './bridge';
import { getTokenKeySource, initTokenKey, loadRegistry, registry, save, type InstanceRecord } from './store';
import { loadGhlPublicKey, verifyGhlSignature } from './signature';

const startedAt = new Date().toISOString();
const ghlPublicKey = loadGhlPublicKey(GHL_WEBHOOK_PUBLIC_KEY);
const WEBHOOK_PATH = '/webhooks/ghl/outbound';

const app = express();
app.disable('x-powered-by');

// The delivery webhook is verified against its exact bytes, so it must not go through the JSON parser.
const jsonBody = express.json({ limit: '2mb' });
app.use((req, res, next) => (req.path === WEBHOOK_PATH ? next() : jsonBody(req, res, next)));

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/health') return next();
  if (!INTERNAL_API_KEY || !safeEqual(req.header('x-internal-api-key') || '', INTERNAL_API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

const publicInstance = ({ id, name, locationId, status, phone, createdAt, updatedAt, qr, lastError }: InstanceRecord) => ({
  id,
  name,
  locationId,
  status,
  phone,
  createdAt,
  updatedAt,
  qr: qr || null,
  lastError: lastError || null,
  ghlConnected: ghl.isConnected(locationId)
});

function sendError(res: express.Response, err: unknown, status = 500) {
  res.status(status).json({ error: errorText(err) });
}

app.get('/', (_req, res) => res.json({ service: 'ghl-whatsapp-bridge-worker', ok: true, health: '/health' }));

app.get('/health', (_req, res) => {
  const instances = Object.values(registry.instances);
  res.json({
    ok: true,
    build: BUILD,
    commit: COMMIT || null,
    startedAt,
    instances: instances.length,
    connected: instances.filter(i => bridge.isLive(i.id)).length
  });
});

app.get('/instances', (_req, res) => res.json({ instances: Object.values(registry.instances).map(publicInstance) }));

app.post('/instances', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId || '').trim();
    const name = String(req.body?.name || 'WhatsApp Instance').trim() || 'WhatsApp Instance';
    if (!locationId) return res.status(400).json({ error: 'locationId is required' });
    const id = crypto.randomUUID();
    registry.instances[id] = { id, name, locationId, status: 'starting', createdAt: new Date().toISOString(), qr: null, lastError: null };
    await save();
    if (!ghl.isConnected(locationId)) recordEvent('warn', `Instance created for ${locationId}, which is not connected to HighLevel yet`, { instanceId: id, locationId });
    await bridge.startInstance(id);
    res.json({ instance: publicInstance(registry.instances[id]) });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/instances/:id', (req, res) => {
  const instance = registry.instances[req.params.id];
  if (!instance) return res.status(404).json({ error: 'Not found' });
  res.json({ instance: publicInstance(instance) });
});

app.post('/instances/:id/restart', async (req, res) => {
  try {
    if (!registry.instances[req.params.id]) return res.status(404).json({ error: 'Not found' });
    await bridge.startInstance(req.params.id, { fresh: req.body?.fresh === true });
    res.json({ ok: true, instance: publicInstance(registry.instances[req.params.id]) });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/instances/:id', async (req, res) => {
  try {
    if (!registry.instances[req.params.id]) return res.status(404).json({ error: 'Not found' });
    await bridge.deleteInstance(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/instances/:id/send', async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'to and text required' });
    res.json({ ok: true, id: await bridge.sendDirect(req.params.id, String(to), String(text)) });
  } catch (err) {
    sendError(res, err, 409);
  }
});

function connectionSummary(locationId: string) {
  const conn = registry.ghl[locationId];
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

function agencySummary(companyId: string) {
  const company = registry.companies[companyId];
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
  return [...new Set([...Object.values(registry.instances).map(i => i.locationId), ...Object.keys(registry.ghl)])];
}

app.get('/integrations/ghl', (_req, res) =>
  res.json({
    connections: Object.keys(registry.ghl).map(connectionSummary),
    agencies: Object.keys(registry.companies).map(agencySummary),
    problems: Object.fromEntries(knownLocations().map(l => [l, ghl.connectionProblem(l)]))
  })
);

// Lets the web app record OAuth outcomes in the activity log.
app.post('/events', (req, res) => {
  const { level, message, detail, locationId } = req.body || {};
  if (!['info', 'warn', 'error'].includes(level) || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'level and message required' });
  }
  recordEvent(level, message.slice(0, 300), {
    locationId: typeof locationId === 'string' ? locationId : undefined,
    detail: typeof detail === 'string' ? detail : undefined
  });
  res.json({ ok: true });
});

async function checkConnection(locationId: string) {
  try {
    await ghl.testConnection(locationId);
    return { ok: true as const };
  } catch (err) {
    return {
      ok: false as const,
      status: err instanceof ghl.GhlApiError ? err.status : null,
      error: errorText(err),
      body: err instanceof ghl.GhlApiError ? err.body : undefined
    };
  }
}

async function verifyLocation(locationId: string) {
  const check = await checkConnection(locationId);
  const problem = ghl.connectionProblem(locationId);
  if (check.ok && !problem) recordEvent('info', `HighLevel connected for location ${locationId}`, { locationId });
  else
    recordEvent('error', `HighLevel connection for ${locationId} is not usable: ${problem || 'a test API call failed'}`, {
      locationId,
      detail: check.ok ? undefined : `${check.error} ${check.body || ''}`
    });
  return { locationId, ...check, problem };
}

app.post('/integrations/ghl/connect', async (req, res) => {
  try {
    const { locationId, accessToken, refreshToken, expiresIn, scope, userId, companyId, userType, approvedLocations } = req.body || {};
    if (!accessToken) return res.status(400).json({ error: 'accessToken required' });
    const claims = ghl.claimsOf(accessToken);

    if (userType === 'Company' || claims?.authClass === 'Company') {
      const agencyId = companyId || claims?.authClassId;
      if (!agencyId) return res.status(400).json({ error: 'companyId required for an agency install' });
      const approved = Array.isArray(approvedLocations) ? approvedLocations.filter((l: unknown): l is string => typeof l === 'string') : [];
      const targets = [...new Set([...(locationId ? [locationId] : []), ...Object.values(registry.instances).map(i => i.locationId)])];
      await ghl.saveAgencyConnection({ companyId: agencyId, accessToken, refreshToken, expiresIn, scope, userId, locationIds: [...approved, ...targets] });
      recordEvent('info', `HighLevel agency install saved for company ${agencyId}`, { detail: `scopes: ${scope || 'none reported'}` });
      const locations = [];
      for (const target of targets) locations.push(await verifyLocation(target));
      return res.json({ ok: true, agency: true, companyId: agencyId, locations });
    }

    if (!locationId) return res.status(400).json({ error: 'locationId required for a sub-account install' });
    await ghl.saveConnection({ locationId, accessToken, refreshToken, expiresIn, scope, userId, companyId, userType });
    const result = await verifyLocation(locationId);
    res.json({ ok: true, agency: false, locationId, locations: [result], check: result });
  } catch (err) {
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

app.post(WEBHOOK_PATH, express.raw({ type: () => true, limit: '2mb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const signature = req.header('x-ghl-signature') || undefined;
  if (!SIGNATURE_CHECK_DISABLED && !verifyGhlSignature(raw, signature, ghlPublicKey.key)) {
    recordEvent('warn', signature ? 'Rejected a delivery webhook with an invalid X-GHL-Signature' : 'Rejected a delivery webhook without an X-GHL-Signature header');
    return res.status(401).json({ error: signature ? 'Invalid GHL signature' : 'Missing GHL signature' });
  }
  let payload: bridge.ProviderOutboundPayload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Body is not valid JSON' });
  }
  if (!payload?.locationId) return res.status(400).json({ error: 'locationId is missing' });
  // Acknowledge right away; the result is reported back to HighLevel through the message status API.
  bridge.handleProviderOutbound(payload);
  res.json({ success: true, messageId: payload.messageId ?? null });
});

type Check = { id: string; level: 'ok' | 'warn' | 'error'; message: string };

app.get('/diagnostics', (_req, res) => {
  const instances = Object.values(registry.instances);
  const locations = knownLocations();
  const relative = VOLUME_PATH ? path.relative(VOLUME_PATH, DATA_DIR) : null;
  const persistent = relative === null ? null : !relative.startsWith('..') && !path.isAbsolute(relative);
  const keySource = getTokenKeySource();
  const problems = locations.map(l => [l, ghl.connectionProblem(l)] as const);
  const unlinkedLocations = problems.filter(([, p]) => p?.startsWith('HighLevel is not connected')).map(([l]) => l);
  const brokenLocations = problems.filter(([, p]) => p && !p.startsWith('HighLevel is not connected'));
  const anyConnection = Object.keys(registry.ghl).length > 0 || Object.keys(registry.companies).length > 0;
  const checks: Check[] = [
    persistent === true
      ? { id: 'storage', level: 'ok', message: `Data is stored on the attached volume (${DATA_DIR}).` }
      : persistent === false
        ? { id: 'storage', level: 'error', message: `DATA_DIR (${DATA_DIR}) is outside the attached volume (${VOLUME_PATH}); sessions and tokens are lost on every deploy.` }
        : { id: 'storage', level: 'warn', message: `No Railway volume detected. Unless ${DATA_DIR} is on a persistent disk, WhatsApp sessions and HighLevel tokens are lost on every redeploy.` },
    PROVIDER_ID
      ? { id: 'provider', level: 'ok', message: `Conversation provider id: ${PROVIDER_ID}` }
      : { id: 'provider', level: 'warn', message: 'GHL_CONVERSATION_PROVIDER_ID is not set on the worker. Inbound messages only work if the app is the default SMS provider.' },
    GHL_CLIENT_ID && GHL_CLIENT_SECRET
      ? { id: 'oauth-client', level: 'ok', message: 'GHL client id and secret are set, so tokens can be refreshed.' }
      : { id: 'oauth-client', level: 'error', message: 'GHL_CLIENT_ID / GHL_CLIENT_SECRET are missing on the worker; the HighLevel token will stop working after ~24h.' },
    keySource === 'generated'
      ? { id: 'token-key', level: 'warn', message: 'TOKEN_ENCRYPTION_KEY is not set; using a key generated in the data directory.' }
      : { id: 'token-key', level: 'ok', message: keySource === 'env' ? 'Tokens are encrypted with TOKEN_ENCRYPTION_KEY.' : 'Tokens are encrypted with a key derived from TOKEN_ENCRYPTION_KEY.' },
    SIGNATURE_CHECK_DISABLED
      ? { id: 'signature', level: 'error', message: 'DISABLE_GHL_SIGNATURE=true: anyone can make this number send WhatsApp messages. Remove it.' }
      : ghlPublicKey.error
        ? { id: 'signature', level: 'warn', message: ghlPublicKey.error }
        : { id: 'signature', level: 'ok', message: 'Delivery webhooks must carry a valid X-GHL-Signature.' },
    !anyConnection
      ? { id: 'ghl', level: 'error', message: 'No HighLevel location is connected. Click "Connect GHL" and install the app into the sub-account.' }
      : brokenLocations.length
        ? { id: 'ghl', level: 'error', message: brokenLocations.map(([l, problem]) => `HighLevel connection for ${l}: ${problem}`).join(' ') }
        : { id: 'ghl', level: 'ok', message: `HighLevel connected for ${locations.filter(l => !unlinkedLocations.includes(l)).join(', ') || 'no locations yet'}` },
    /^(SMS|Custom)$/.test(INBOUND_TYPE)
      ? { id: 'inbound-type', level: 'ok', message: `Inbound messages are added as type ${INBOUND_TYPE}.` }
      : {
          id: 'inbound-type',
          level: 'warn',
          message: `GHL_INBOUND_TYPE is "${INBOUND_TYPE}". HighLevel documents custom SMS providers with type SMS; other types are routed to HighLevel's own channels, so replies may not reach this bridge. Set GHL_INBOUND_TYPE=SMS on the worker (or remove it).`
        },
    unlinkedLocations.length
      ? { id: 'location-match', level: 'error', message: `These instances' locations have no HighLevel connection: ${unlinkedLocations.join(', ')}` }
      : { id: 'location-match', level: 'ok', message: 'Every instance belongs to a connected HighLevel location.' },
    instances.some(i => bridge.isLive(i.id))
      ? { id: 'whatsapp', level: 'ok', message: 'At least one WhatsApp number is connected.' }
      : { id: 'whatsapp', level: 'error', message: 'No WhatsApp number is connected. Create or reconnect an instance and scan the QR code.' }
  ];
  res.json({
    build: BUILD,
    commit: COMMIT || null,
    startedAt,
    dataDir: DATA_DIR,
    persistentVolume: persistent,
    providerId: PROVIDER_ID || null,
    inboundType: INBOUND_TYPE,
    syncPhoneMessages: SYNC_PHONE_MESSAGES,
    checks,
    connections: Object.keys(registry.ghl).map(connectionSummary),
    agencies: Object.keys(registry.companies).map(agencySummary),
    instances: instances.map(publicInstance),
    events: recentEvents(100)
  });
});

process.on('unhandledRejection', err => log.error({ err }, 'Unhandled promise rejection'));

async function main() {
  await loadRegistry();
  await loadEvents();
  await initTokenKey();
  if (ghlPublicKey.error) recordEvent('warn', ghlPublicKey.error);
  recordEvent('info', `Worker started (build ${BUILD}${COMMIT ? `, commit ${COMMIT}` : ''})`);
  const moved = await ghl.migrateAgencyTokens();
  if (moved.length) recordEvent('warn', `Found agency (Company) tokens stored as sub-account tokens; moved them to agency connections: ${moved.join(', ')}`);
  const server = app.listen(PORT, '0.0.0.0', () => log.info({ port: PORT, dataDir: DATA_DIR }, 'Worker listening'));
  await bridge.resumeInstances();
  // Agency installs: get a sub-account token for every instance location up front so problems show immediately.
  for (const locationId of new Set(Object.values(registry.instances).map(i => i.locationId))) {
    if (registry.ghl[locationId]?.source === 'direct') continue;
    if (ghl.connectionProblem(locationId)?.startsWith('HighLevel is not connected')) continue;
    void verifyLocation(locationId).catch(err => log.warn({ err, locationId }, 'Agency token warm-up failed'));
  }

  const stop = async (signal: string) => {
    log.info({ signal }, 'Shutting down');
    bridge.shutdown();
    await save();
    await flushEvents();
    server.close();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

main().catch(err => {
  log.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
