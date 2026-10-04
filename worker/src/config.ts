import path from 'node:path';

const env = process.env;

export const PORT = Number(env.PORT || 3001);
// Railway exposes the mount path of an attached volume; prefer it so sessions and tokens survive redeploys.
export const VOLUME_PATH = env.RAILWAY_VOLUME_MOUNT_PATH || '';
// Set by hosts that persist DATA_DIR some other way (the Docker kit sets it for its named volume).
export const DATA_VOLUME = env.DATA_VOLUME || '';
export const DATA_DIR = env.DATA_DIR || VOLUME_PATH || path.resolve(process.cwd(), 'data');
export const INTERNAL_API_KEY = env.INTERNAL_API_KEY || '';

export const GHL_BASE = (env.GHL_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/+$/, '');
export const PROVIDER_ID = (env.GHL_CONVERSATION_PROVIDER_ID || '').trim();
export const INBOUND_TYPE = env.GHL_INBOUND_TYPE || 'SMS';
export const GHL_CLIENT_ID = env.GHL_CLIENT_ID || '';
export const GHL_CLIENT_SECRET = env.GHL_CLIENT_SECRET || '';
// Without GHL_CLIENT_SECRET the worker refreshes tokens through the web app (which holds the secret), e.g.
// https://your-vercel-domain/api/oauth/refresh, authenticated with INTERNAL_API_KEY.
export const TOKEN_REFRESH_URL = (env.TOKEN_REFRESH_URL || '').trim();
export const SIGNATURE_CHECK_DISABLED = env.DISABLE_GHL_SIGNATURE === 'true';
export const GHL_WEBHOOK_PUBLIC_KEY = env.GHL_WEBHOOK_PUBLIC_KEY;

// Mirror messages typed on the phone into GHL as outbound messages.
export const SYNC_PHONE_MESSAGES = env.SYNC_PHONE_MESSAGES !== 'false';
// Minimum gap between WhatsApp sends per instance; bursts from bulk actions get queued instead of fired at once.
export const SEND_INTERVAL_MS = Number(env.SEND_MIN_INTERVAL_MS || 1200);
export const MAX_MEDIA_BYTES = Number(env.MAX_MEDIA_MB || 16) * 1024 * 1024;

export const BUILD = '2026-10-04.1';
export const COMMIT = (env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7);
