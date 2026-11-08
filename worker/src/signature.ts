import crypto from 'node:crypto';

// HighLevel signs Conversation Provider delivery webhooks with Ed25519 in the X-GHL-Signature header.
// https://marketplace.gohighlevel.com/docs/webhook/ProviderOutboundMessage
export const GHL_DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

// Env editors mangle multi-line PEMs in different ways (literal "\n", "\\n", wrapping quotes), so rebuild it from the base64 body.
function normalizePem(input: string) {
  const body = input
    .replace(/\\+n/g, '\n')
    .replace(/["'\\]/g, '')
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

export function loadGhlPublicKey(configured: string | undefined): { key: crypto.KeyObject; source: 'env' | 'default'; error?: string } {
  if (configured?.trim()) {
    try {
      return { key: crypto.createPublicKey(normalizePem(configured)), source: 'env' };
    } catch (err) {
      return {
        key: crypto.createPublicKey(GHL_DEFAULT_PUBLIC_KEY),
        source: 'default',
        error: `GHL_WEBHOOK_PUBLIC_KEY could not be parsed (${err instanceof Error ? err.message : String(err)}); using HighLevel's published key instead.`
      };
    }
  }
  return { key: crypto.createPublicKey(GHL_DEFAULT_PUBLIC_KEY), source: 'default' };
}

export function verifyGhlSignature(raw: Buffer, signature: string | undefined, key: crypto.KeyObject) {
  if (!signature) return false;
  try {
    return crypto.verify(null, raw, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
