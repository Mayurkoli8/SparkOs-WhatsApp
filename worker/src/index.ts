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
  ghlConnected: Boolean(registry.ghl[locationId])
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
    if (!registry.ghl[locationId]) recordEvent('warn', `Instance created for ${locationId}, which is not connected to HighLevel yet`, { instanceId: id, locationId });
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
  return {
    locationId,
    connected: true,
    userType: conn.userType || null,
    scope: conn.scope || null,
    expiresAt: conn.expiresAt ? new Date(conn.expiresAt).toISOString() : null,
    canRefresh: Boolean(conn.refreshToken),
    lastError: conn.lastError || null,
    updatedAt: conn.updatedAt
  };
}

app.get('/integrations/ghl', (_req, res) => res.json({ connections: Object.keys(registry.ghl).map(connectionSummary) }));

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

app.post('/integrations/ghl/connect', async (req, res) => {
  try {
    const { locationId, accessToken, refreshToken, expiresIn, scope, userId, companyId, userType } = req.body || {};
    if (!locationId || !accessToken) return res.status(400).json({ error: 'locationId and accessToken required' });
    await ghl.saveConnection({ locationId, accessToken, refreshToken, expiresIn, scope, userId, companyId, userType });
    const check = await checkConnection(locationId);
    if (check.ok) recordEvent('info', `HighLevel connected for location ${locationId}`, { locationId });
    else recordEvent('error', `HighLevel token saved for ${locationId}, but a test API call failed`, { locationId, detail: `${check.error} ${check.body || ''}` });
    res.json({ ok: true, locationId, check });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/integrations/ghl/:locationId/test', async (req, res) => {
  if (!registry.ghl[req.params.locationId]) return res.status(404).json({ error: 'Location is not connected' });
  res.json(await checkConnection(req.params.locationId));
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
  const locations = Object.keys(registry.ghl);
  const relative = VOLUME_PATH ? path.relative(VOLUME_PATH, DATA_DIR) : null;
  const persistent = relative === null ? null : !relative.startsWith('..') && !path.isAbsolute(relative);
  const keySource = getTokenKeySource();
  const unlinkedLocations = [...new Set(instances.map(i => i.locationId))].filter(l => !registry.ghl[l]);
  const brokenLocations = locations.filter(l => registry.ghl[l].lastError);
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
    !locations.length
      ? { id: 'ghl', level: 'error', message: 'No HighLevel location is connected. Click "Connect GHL" and install the app into the sub-account.' }
      : brokenLocations.length
        ? { id: 'ghl', level: 'error', message: `HighLevel token problem for ${brokenLocations.map(l => `${l} (${registry.ghl[l].lastError})`).join('; ')}. Click "Connect GHL" again.` }
        : { id: 'ghl', level: 'ok', message: `HighLevel connected for ${locations.join(', ')}` },
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
    connections: locations.map(connectionSummary),
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
  const server = app.listen(PORT, '0.0.0.0', () => log.info({ port: PORT, dataDir: DATA_DIR }, 'Worker listening'));
  await bridge.resumeInstances();

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
