"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMIT = exports.BUILD = exports.MAX_MEDIA_BYTES = exports.SEND_INTERVAL_MS = exports.SYNC_PHONE_MESSAGES = exports.GHL_WEBHOOK_PUBLIC_KEY = exports.SIGNATURE_CHECK_DISABLED = exports.GHL_REDIRECT_URI = exports.GHL_CLIENT_SECRET = exports.GHL_CLIENT_ID = exports.INBOUND_TYPE = exports.PROVIDER_ID = exports.GHL_BASE = exports.INTERNAL_API_KEY = exports.DATA_DIR = exports.VOLUME_PATH = exports.PORT = void 0;
const node_path_1 = __importDefault(require("node:path"));
const env = process.env;
exports.PORT = Number(env.PORT || 3001);
// Railway exposes the mount path of an attached volume; prefer it so sessions and tokens survive redeploys.
exports.VOLUME_PATH = env.RAILWAY_VOLUME_MOUNT_PATH || '';
exports.DATA_DIR = env.DATA_DIR || exports.VOLUME_PATH || node_path_1.default.resolve(process.cwd(), 'data');
exports.INTERNAL_API_KEY = env.INTERNAL_API_KEY || '';
exports.GHL_BASE = (env.GHL_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/+$/, '');
exports.PROVIDER_ID = (env.GHL_CONVERSATION_PROVIDER_ID || '').trim();
exports.INBOUND_TYPE = env.GHL_INBOUND_TYPE || 'SMS';
exports.GHL_CLIENT_ID = env.GHL_CLIENT_ID || '';
exports.GHL_CLIENT_SECRET = env.GHL_CLIENT_SECRET || '';
exports.GHL_REDIRECT_URI = env.GHL_REDIRECT_URI || '';
exports.SIGNATURE_CHECK_DISABLED = env.DISABLE_GHL_SIGNATURE === 'true';
exports.GHL_WEBHOOK_PUBLIC_KEY = env.GHL_WEBHOOK_PUBLIC_KEY;
// Mirror messages typed on the phone into GHL as outbound messages.
exports.SYNC_PHONE_MESSAGES = env.SYNC_PHONE_MESSAGES !== 'false';
// Minimum gap between WhatsApp sends per instance; bursts from bulk actions get queued instead of fired at once.
exports.SEND_INTERVAL_MS = Number(env.SEND_MIN_INTERVAL_MS || 1200);
exports.MAX_MEDIA_BYTES = Number(env.MAX_MEDIA_MB || 16) * 1024 * 1024;
exports.BUILD = '2026-10-04.1';
exports.COMMIT = (env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7);
