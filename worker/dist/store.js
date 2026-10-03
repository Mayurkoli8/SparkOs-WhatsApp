"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registry = exports.REGISTRY_FILE = void 0;
exports.save = save;
exports.loadRegistry = loadRegistry;
exports.getTokenKeySource = getTokenKeySource;
exports.deriveKey = deriveKey;
exports.initTokenKey = initTokenKey;
exports.encrypt = encrypt;
exports.decrypt = decrypt;
const node_crypto_1 = __importDefault(require("node:crypto"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const events_1 = require("./events");
exports.REGISTRY_FILE = node_path_1.default.join(config_1.DATA_DIR, 'registry.json');
exports.registry = { instances: {}, ghl: {} };
let writeChain = Promise.resolve();
// Writes are serialised and atomic (temp file + rename) so overlapping saves can never leave half-written JSON.
function save() {
    const snapshot = JSON.stringify(exports.registry, null, 2);
    writeChain = writeChain
        .then(async () => {
        const tmp = `${exports.REGISTRY_FILE}.tmp`;
        await promises_1.default.writeFile(tmp, snapshot, 'utf8');
        await promises_1.default.rename(tmp, exports.REGISTRY_FILE);
    })
        .catch(err => events_1.log.error({ err }, 'Failed to save registry'));
    return writeChain;
}
async function loadRegistry() {
    await promises_1.default.mkdir(config_1.DATA_DIR, { recursive: true });
    try {
        const parsed = JSON.parse(await promises_1.default.readFile(exports.REGISTRY_FILE, 'utf8'));
        exports.registry.instances = parsed.instances || {};
        exports.registry.ghl = parsed.ghl || {};
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            const backup = `${exports.REGISTRY_FILE}.corrupt-${Date.now()}`;
            await promises_1.default.rename(exports.REGISTRY_FILE, backup).catch(() => { });
            events_1.log.error({ err, backup }, 'Registry was unreadable; moved it aside and started empty');
        }
        exports.registry.instances = {};
        exports.registry.ghl = {};
        await save();
    }
}
let tokenKey = null;
let tokenKeySource = 'unset';
function getTokenKeySource() {
    return tokenKeySource;
}
// TOKEN_ENCRYPTION_KEY is meant to be base64 of 32 random bytes. Anything else is hashed into a key
// instead of being rejected, because a rejected key used to make every GHL install fail silently.
function deriveKey(raw) {
    const trimmed = raw.trim();
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed))
        return { key: decoded, source: 'env' };
    return { key: node_crypto_1.default.createHash('sha256').update(trimmed, 'utf8').digest(), source: 'env-derived' };
}
async function initTokenKey() {
    const raw = process.env.TOKEN_ENCRYPTION_KEY;
    if (raw && raw.trim()) {
        const derived = deriveKey(raw);
        tokenKey = derived.key;
        tokenKeySource = derived.source;
        return;
    }
    const file = node_path_1.default.join(config_1.DATA_DIR, '.token-key');
    try {
        const stored = Buffer.from((await promises_1.default.readFile(file, 'utf8')).trim(), 'base64');
        if (stored.length === 32) {
            tokenKey = stored;
            tokenKeySource = 'generated';
            return;
        }
    }
    catch {
        // No key yet; create one below.
    }
    tokenKey = node_crypto_1.default.randomBytes(32);
    await promises_1.default.writeFile(file, tokenKey.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    tokenKeySource = 'generated';
    events_1.log.warn('TOKEN_ENCRYPTION_KEY is not set; generated a key in the data directory');
}
function key() {
    if (!tokenKey)
        throw new Error('Token encryption key is not initialised');
    return tokenKey;
}
function encrypt(value) {
    const iv = node_crypto_1.default.randomBytes(12);
    const cipher = node_crypto_1.default.createCipheriv('aes-256-gcm', key(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}
function decrypt(value) {
    const [iv, tag, ciphertext] = value.split('.');
    const decipher = node_crypto_1.default.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
