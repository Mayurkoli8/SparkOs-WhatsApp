import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, registry } from '../src/store';
import { applyPolicyPatch, describePolicyPatch, describeSettingsPatch, failoverWaitMs, parsePolicyPatch, parseSettingsPatch, sendGapMs, updateSettings } from '../src/settings';
import { defaultPolicy, limitFor } from '../src/numbers';

beforeEach(async () => {
  await loadRegistry();
  registry.instances = {};
  registry.settings = {};
});

test('policy patches accept numbers, numeric strings, null (back to default) and the on/off switch', () => {
  assert.deepEqual(parsePolicyPatch({ warmupDays: 3, newChatsPerDay: '12', enabled: false, coldMessagesPerContact: null, junk: 1 }), {
    warmupDays: 3,
    newChatsPerDay: 12,
    enabled: false,
    coldMessagesPerContact: null
  });
  assert.deepEqual(parsePolicyPatch({ warmupNewChatsPerDay: '' }), { warmupNewChatsPerDay: null });
});

test('policy patches reject values outside the safe range', () => {
  assert.throws(() => parsePolicyPatch({ warmupDays: -1 }), /Warm-up days must be a whole number from 0 to 90/);
  assert.throws(() => parsePolicyPatch({ newChatsPerDay: 2.5 }), /whole number/);
  assert.throws(() => parsePolicyPatch({ coldMessagesPerContact: 0 }), /from 1 to 50/);
  assert.throws(() => parsePolicyPatch({ enabled: 'yes' }), /enabled/);
  assert.throws(() => parsePolicyPatch('x'), /object/);
});

test('applying a patch merges fields and null removes the override', () => {
  assert.deepEqual(applyPolicyPatch({ warmupDays: 3, enabled: false }, { warmupDays: null, newChatsPerDay: 40 }), { enabled: false, newChatsPerDay: 40 });
  assert.equal(applyPolicyPatch({ warmupDays: 3 }, { warmupDays: null }), undefined, 'no overrides left');
});

test('settings patches are validated', () => {
  assert.deepEqual(parseSettingsPatch({ defaultNumberLimit: 8, failoverWaitSeconds: 0, sendGapSeconds: 2.5, alertWebhookUrl: ' https://hooks.example.com/x ' }), {
    defaultNumberLimit: 8,
    failoverWaitSeconds: 0,
    sendGapSeconds: 2.5,
    alertWebhookUrl: 'https://hooks.example.com/x'
  });
  assert.deepEqual(parseSettingsPatch({ alertWebhookUrl: '' }), { alertWebhookUrl: null });
  assert.throws(() => parseSettingsPatch({ alertWebhookUrl: 'http://hooks.example.com/x' }), /https/);
  assert.throws(() => parseSettingsPatch({ failoverWaitSeconds: 100000 }), /from 0 to 900/);
  assert.throws(() => parseSettingsPatch({ sendGapSeconds: -1 }), /from 0 to 120/);
  assert.throws(() => parseSettingsPatch({ protectionDefaults: { warmupDays: 500 } }), /Warm-up days/);
});

test('changes are described in plain words, without the webhook URL', () => {
  assert.deepEqual(describePolicyPatch({ enabled: false, warmupDays: 14, newChatsPerDay: null }), ['protection off', 'warm-up days 14', 'new chats a day back to default']);
  const text = describeSettingsPatch(parseSettingsPatch({ failoverWaitSeconds: 30, alertWebhookUrl: 'https://hooks.example.com/secret-token', protectionDefaults: { warmupDays: 3 } }));
  assert.equal(text, 'failover wait 30 s, alert webhook set, default warm-up days 3');
  assert.doesNotMatch(text, /secret-token/);
});

test('saved settings change the defaults the bridge uses', async () => {
  await updateSettings(parseSettingsPatch({ defaultNumberLimit: 2, failoverWaitSeconds: 10, sendGapSeconds: 3, protectionDefaults: { warmupDays: 14 } }));
  assert.equal(limitFor('L1'), 2);
  assert.equal(failoverWaitMs(), 10_000);
  assert.equal(sendGapMs(), 3000);
  assert.equal(defaultPolicy().warmupDays, 14);
  await updateSettings(parseSettingsPatch({ defaultNumberLimit: null, failoverWaitSeconds: null, protectionDefaults: { warmupDays: null } }));
  assert.equal(limitFor('L1'), 5);
  assert.equal(failoverWaitMs(), 60_000);
  assert.equal(defaultPolicy().warmupDays, 7);
  assert.equal(registry.settings.protectionDefaults, undefined);
});
