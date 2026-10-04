'use client';

import { useEffect, useState } from 'react';
import { PolicyFields } from './PolicyFields';
import { call, type Run, type SettingsView } from './shared';

const save = (run: Run, body: object) => run(() => call('/api/admin/settings', 'PUT', body));

// Bridge-wide defaults. Each number can override the protection rules under Sub-accounts → Manage.
export function SettingsTab({ settings, run }: { settings: SettingsView; run: Run }) {
  const { saved, current, builtIn } = settings;

  async function toggleProtection() {
    const off = current.protection.enabled;
    if (off && !confirm('Turn protection off for every number that has no setting of its own?\n\nThey will start new chats without daily limits or warm-up.')) return;
    await save(run, { protectionDefaults: { enabled: off ? false : null } });
  }

  return (
    <div className="grid2 settings">
      <section className="panel">
        <div className="panelhead">
          <h2>Number protection defaults</h2>
          <span>{current.protection.enabled ? 'protection on' : 'protection off'}</span>
        </div>
        <p className="muted">
          These rules apply to every number without its own settings. People who wrote to a number first can always be answered; the limits only cover
          starting chats with people who never wrote.
        </p>
        <div className="row-actions">
          <button className={current.protection.enabled ? 'ghost small' : 'primary small'} onClick={() => void toggleProtection()}>
            {current.protection.enabled ? 'Turn protection off for all' : 'Turn protection on for all'}
          </button>
        </div>
        <PolicyFields saved={saved.protection} fallback={builtIn.protection} onSave={fields => save(run, { protectionDefaults: fields })} />
      </section>

      <DeliveryPanel settings={settings} run={run} />
      <AlertsPanel url={current.alertWebhookUrl} run={run} />
    </div>
  );
}

function DeliveryPanel({ settings, run }: { settings: SettingsView; run: Run }) {
  const { saved, builtIn } = settings;
  const initial = () => ({
    failoverWaitSeconds: saved.failoverWaitSeconds?.toString() ?? '',
    sendGapSeconds: saved.sendGapSeconds?.toString() ?? '',
    defaultNumberLimit: saved.defaultNumberLimit?.toString() ?? ''
  });
  const key = JSON.stringify(initial());
  const [values, setValues] = useState(initial);
  useEffect(() => setValues(JSON.parse(key)), [key]);
  const dirty = JSON.stringify(values) !== key;
  const field = (name: keyof typeof values, label: string, fallback: number, step = '1') => (
    <label className="pfield">
      <span>{label}</span>
      <input className="input" type="number" min={0} step={step} value={values[name]} placeholder={`${fallback} (default)`} onChange={e => setValues({ ...values, [name]: e.target.value })} />
    </label>
  );

  return (
    <section className="panel">
      <div className="panelhead">
        <h2>Delivery</h2>
        <span>all sub-accounts</span>
      </div>
      <div className="policy-grid">
        {field('failoverWaitSeconds', 'Seconds to wait for an offline number before a backup sends', builtIn.failoverWaitSeconds)}
        {field('sendGapSeconds', 'Least seconds between two messages from one number', builtIn.sendGapSeconds, '0.1')}
        {field('defaultNumberLimit', 'Numbers a sub-account may add (unless set on it)', builtIn.numberLimit)}
      </div>
      <div className="row-actions">
        <button
          className="primary small"
          disabled={!dirty}
          onClick={() =>
            void save(run, {
              failoverWaitSeconds: values.failoverWaitSeconds.trim() === '' ? null : Number(values.failoverWaitSeconds),
              sendGapSeconds: values.sendGapSeconds.trim() === '' ? null : Number(values.sendGapSeconds),
              defaultNumberLimit: values.defaultNumberLimit.trim() === '' ? null : Number(values.defaultNumberLimit)
            })
          }
        >
          Save
        </button>
        <span className="muted">The gap is randomised up to 2.5× so sends never look automatic. Empty boxes use the default.</span>
      </div>
    </section>
  );
}

function AlertsPanel({ url, run }: { url: string | null; run: Run }) {
  const [value, setValue] = useState(url ?? '');
  const [note, setNote] = useState('');
  useEffect(() => setValue(url ?? ''), [url]);

  async function test() {
    setNote('');
    if (await run(() => call('/api/admin/settings', 'POST'))) setNote('Test alert sent. Check that it arrived.');
  }

  return (
    <section className="panel">
      <div className="panelhead">
        <h2>Alerts</h2>
        <span>{url ? 'on' : 'off'}</span>
      </div>
      <p className="muted">
        Get told the moment something breaks: a number logged out, banned, restricted or offline for 10 minutes, or a message that could not be synced or
        delivered. Repeats of the same problem are sent at most every 30 minutes.
      </p>
      <label className="pfield">
        <span>Webhook URL (https)</span>
        <input className="input" placeholder="https://services.leadconnectorhq.com/hooks/…" value={value} onChange={e => setValue(e.target.value)} />
      </label>
      <div className="row-actions">
        <button className="primary small" disabled={value.trim() === (url ?? '')} onClick={() => void save(run, { alertWebhookUrl: value.trim() || null })}>
          Save
        </button>
        <button className="ghost small" disabled={!url} onClick={() => void test()}>
          Send test alert
        </button>
      </div>
      {note && <div className="note">{note}</div>}
      <ul className="steps">
        <li>
          In HighLevel, create a workflow with the <b>Inbound Webhook</b> trigger, paste its URL here, and add an action such as <b>Send Email</b> or{' '}
          <b>Send SMS</b> to yourself. Slack, Zapier and Make webhooks work too.
        </li>
        <li>
          Each alert is JSON with <b>message</b>, <b>detail</b>, <b>locationId</b>, <b>number</b> and <b>at</b>.
        </li>
      </ul>
    </section>
  );
}
