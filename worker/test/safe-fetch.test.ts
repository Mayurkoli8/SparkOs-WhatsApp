import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadPublicFile, isPublicAddress, postPublicJson } from '../src/safe-fetch';

test('isPublicAddress accepts public IPv4 and IPv6 addresses', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('142.250.183.16'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('isPublicAddress rejects loopback, private, link-local, CGNAT, ULA and mapped addresses', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'not-an-ip'
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('downloadPublicFile refuses non-https URLs and private targets before connecting', async () => {
  const max = 1024 * 1024;
  await assert.rejects(downloadPublicFile('http://example.com/a.png', max), /https/);
  await assert.rejects(downloadPublicFile('file:///etc/passwd', max), /https/);
  await assert.rejects(downloadPublicFile('https://127.0.0.1/a.png', max), /private/);
  await assert.rejects(downloadPublicFile('https://169.254.169.254/latest/meta-data', max), /private/);
  await assert.rejects(downloadPublicFile('https://[::1]/a.png', max), /private/);
  await assert.rejects(downloadPublicFile('https://localhost/a.png', max), /private/);
});

test('postPublicJson refuses non-https URLs and private targets before connecting', async () => {
  await assert.rejects(postPublicJson('http://example.com/hook', {}), /https/);
  await assert.rejects(postPublicJson('https://127.0.0.1/hook', {}), /private/);
  await assert.rejects(postPublicJson('https://169.254.169.254/hook', {}), /private/);
  await assert.rejects(postPublicJson('https://localhost/hook', {}), /private/);
});
