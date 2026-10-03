"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GHL_DEFAULT_PUBLIC_KEY = void 0;
exports.loadGhlPublicKey = loadGhlPublicKey;
exports.verifyGhlSignature = verifyGhlSignature;
const node_crypto_1 = __importDefault(require("node:crypto"));
// HighLevel signs Conversation Provider delivery webhooks with Ed25519 in the X-GHL-Signature header.
// https://marketplace.gohighlevel.com/docs/webhook/ProviderOutboundMessage
exports.GHL_DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;
// Env editors mangle multi-line PEMs in different ways (literal "\n", "\\n", wrapping quotes), so rebuild it from the base64 body.
function normalizePem(input) {
    const body = input
        .replace(/\\+n/g, '\n')
        .replace(/["'\\]/g, '')
        .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
        .replace(/\s+/g, '');
    return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}
function loadGhlPublicKey(configured) {
    if (configured?.trim()) {
        try {
            return { key: node_crypto_1.default.createPublicKey(normalizePem(configured)), source: 'env' };
        }
        catch (err) {
            return {
                key: node_crypto_1.default.createPublicKey(exports.GHL_DEFAULT_PUBLIC_KEY),
                source: 'default',
                error: `GHL_WEBHOOK_PUBLIC_KEY could not be parsed (${err instanceof Error ? err.message : String(err)}); using HighLevel's published key instead.`
            };
        }
    }
    return { key: node_crypto_1.default.createPublicKey(exports.GHL_DEFAULT_PUBLIC_KEY), source: 'default' };
}
function verifyGhlSignature(raw, signature, key) {
    if (!signature)
        return false;
    try {
        return node_crypto_1.default.verify(null, raw, key, Buffer.from(signature, 'base64'));
    }
    catch {
        return false;
    }
}
