// Loaded before every test file (see the "test" script) so config.ts reads a hermetic environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bridge-test-'));

Object.assign(process.env, {
  DATA_DIR: dataDir,
  LOG_LEVEL: 'silent',
  GHL_API_BASE: 'https://ghl.test',
  GHL_CONVERSATION_PROVIDER_ID: 'provider-123',
  GHL_CLIENT_ID: 'client-id',
  GHL_CLIENT_SECRET: 'client-secret',
  TOKEN_ENCRYPTION_KEY: 'not-a-32-byte-base64-key',
  INTERNAL_API_KEY: 'internal-key',
  GHL_RETRY_BASE_MS: '1'
});
delete process.env.GHL_VERSION;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
