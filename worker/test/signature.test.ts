import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GHL_DEFAULT_PUBLIC_KEY, loadGhlPublicKey, verifyGhlSignature } from '../src/signature';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const raw = '{"locationId":"L1","messageId":"M1","phone":"+15550001111","message":"héllo"}';
const sign = (body: string) => crypto.sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64');

test('verifyGhlSignature accepts the exact signed bytes', () => {
  assert.equal(verifyGhlSignature(Buffer.from(raw, 'utf8'), sign(raw), publicKey), true);
});

test('verifyGhlSignature rejects tampered bodies, missing and malformed signatures', () => {
  assert.equal(verifyGhlSignature(Buffer.from(raw + ' ', 'utf8'), sign(raw), publicKey), false);
  assert.equal(verifyGhlSignature(Buffer.from(raw, 'utf8'), '', publicKey), false);
  assert.equal(verifyGhlSignature(Buffer.from(raw, 'utf8'), undefined, publicKey), false);
  assert.equal(verifyGhlSignature(Buffer.from(raw, 'utf8'), 'not-base64!!', publicKey), false);
});

test('loadGhlPublicKey parses the built-in HighLevel Ed25519 key', () => {
  const loaded = loadGhlPublicKey(undefined);
  assert.equal(loaded.source, 'default');
  assert.equal(loaded.key.asymmetricKeyType, 'ed25519');
});

test('loadGhlPublicKey tolerates PEMs pasted with literal or double-escaped \\n sequences', () => {
  const singleEscaped = GHL_DEFAULT_PUBLIC_KEY.replace(/\n/g, '\\n');
  const doubleEscaped = GHL_DEFAULT_PUBLIC_KEY.replace(/\n/g, '\\\\n');
  for (const value of [singleEscaped, doubleEscaped, `"${singleEscaped}"`]) {
    const loaded = loadGhlPublicKey(value);
    assert.equal(loaded.source, 'env', value);
    assert.equal(loaded.key.asymmetricKeyType, 'ed25519');
  }
});

test('loadGhlPublicKey falls back to the built-in key when the configured one is unusable', () => {
  const loaded = loadGhlPublicKey('definitely not a key');
  assert.equal(loaded.source, 'default');
  assert.ok(loaded.error);
});
