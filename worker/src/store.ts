import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';
import { log } from './events';
import type { ProtectionPolicy } from './protection';

export type InstanceRecord = {
  id: string;
  name: string;
  locationId: string;
  status: string;
  phone?: string;
  createdAt: string;
  updatedAt?: string;
  qr?: string | null;
  lastError?: string | null;
  // Multi-number: a permanent per-sub-account slot (#1, #2… used in {WA#2}) and the default sender.
  slot?: number;
  isDefault?: boolean;
  linkedAt?: string | null;
  // WhatsApp stops this number from starting new chats until then (epoch ms).
  restrictedUntil?: number | null;
  // Admin overrides of the protection defaults (unset fields follow the defaults), and a restarted warm-up.
  protection?: Partial<ProtectionPolicy>;
  warmupFrom?: string | null;
  // The HighLevel user who owns this number's contacts: new contacts are assigned to them (or every contact, "always").
  assignedUserId?: string | null;
  assignedUserName?: string | null;
  assignMode?: 'unassigned' | 'always';
};

// Admin-editable settings; anything unset falls back to the worker's environment defaults.
export type Settings = {
  inboundType?: string;
  providerId?: string;
  limits?: Record<string, number>;
  slotCounters?: Record<string, number>;
  defaultNumberLimit?: number;
  protectionDefaults?: Partial<ProtectionPolicy>;
  failoverWaitSeconds?: number;
  sendGapSeconds?: number;
  alertWebhookUrl?: string | null;
};

export type GhlConnection = {
  locationId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  userId?: string;
  companyId?: string;
  userType?: string;
  updatedAt: string;
  lastError?: string | null;
  refreshFailedAt?: number;
  // 'agency' = minted from an agency (Company) connection; it has no refresh token and is re-minted instead.
  source?: 'direct' | 'agency';
};

// An agency-level (Company) install. Sub-account tokens are minted from it with /oauth/locationToken.
export type CompanyConnection = {
  companyId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  userId?: string;
  locationIds: string[];
  mintErrors: Record<string, string>;
  updatedAt: string;
  lastError?: string | null;
  refreshFailedAt?: number;
};

export type Registry = {
  instances: Record<string, InstanceRecord>;
  ghl: Record<string, GhlConnection>;
  companies: Record<string, CompanyConnection>;
  // inboundType and providerId are learned from HighLevel; the rest is set by the admin.
  settings: Settings;
};

export const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json');
export const registry: Registry = { instances: {}, ghl: {}, companies: {}, settings: {} };

let writeChain: Promise<void> = Promise.resolve();

// Writes are serialised and atomic (temp file + rename) so overlapping saves can never leave half-written JSON.
export function save(): Promise<void> {
  const snapshot = JSON.stringify(registry, null, 2);
  writeChain = writeChain
    .then(async () => {
      const tmp = `${REGISTRY_FILE}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, REGISTRY_FILE);
    })
    .catch(err => log.error({ err }, 'Failed to save registry'));
  return writeChain;
}

export async function loadRegistry() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(REGISTRY_FILE, 'utf8')) as Partial<Registry>;
    registry.instances = parsed.instances || {};
    registry.ghl = parsed.ghl || {};
    registry.companies = parsed.companies || {};
    registry.settings = parsed.settings || {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const backup = `${REGISTRY_FILE}.corrupt-${Date.now()}`;
      await fs.rename(REGISTRY_FILE, backup).catch(() => {});
      log.error({ err, backup }, 'Registry was unreadable; moved it aside and started empty');
    }
    registry.instances = {};
    registry.ghl = {};
    registry.companies = {};
    registry.settings = {};
    await save();
  }
}

let tokenKey: Buffer | null = null;
let tokenKeySource: 'env' | 'env-derived' | 'generated' | 'unset' = 'unset';

export function getTokenKeySource() {
  return tokenKeySource;
}

// TOKEN_ENCRYPTION_KEY is meant to be base64 of 32 random bytes. Anything else is hashed into a key
// instead of being rejected, because a rejected key used to make every GHL install fail silently.
export function deriveKey(raw: string): { key: Buffer; source: 'env' | 'env-derived' } {
  const trimmed = raw.trim();
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return { key: decoded, source: 'env' };
  return { key: crypto.createHash('sha256').update(trimmed, 'utf8').digest(), source: 'env-derived' };
}

export async function initTokenKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (raw && raw.trim()) {
    const derived = deriveKey(raw);
    tokenKey = derived.key;
    tokenKeySource = derived.source;
    return;
  }
  const file = path.join(DATA_DIR, '.token-key');
  try {
    const stored = Buffer.from((await fs.readFile(file, 'utf8')).trim(), 'base64');
    if (stored.length === 32) {
      tokenKey = stored;
      tokenKeySource = 'generated';
      return;
    }
  } catch {
    // No key yet; create one below.
  }
  tokenKey = crypto.randomBytes(32);
  await fs.writeFile(file, tokenKey.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  tokenKeySource = 'generated';
  log.warn('TOKEN_ENCRYPTION_KEY is not set; generated a key in the data directory');
}

function key() {
  if (!tokenKey) throw new Error('Token encryption key is not initialised');
  return tokenKey;
}

export function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decrypt(value: string) {
  const [iv, tag, ciphertext] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
