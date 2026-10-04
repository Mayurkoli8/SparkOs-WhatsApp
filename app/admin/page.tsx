'use client';

import { useCallback, useEffect, useState } from 'react';

type Instance = {
  id: string;
  name: string;
  locationId: string;
  status: string;
  phone?: string;
  qr?: string | null;
  createdAt: string;
  updatedAt?: string;
  lastError?: string | null;
  ghlConnected?: boolean;
};

type GhlStatus = {
  agencies: { companyId: string; canMint: boolean }[];
  // Every location the bridge needs a token for, mapped to what is wrong with it (null when usable).
  problems: Record<string, string | null>;
};
type Check = { id: string; level: 'ok' | 'warn' | 'error'; message: string };
type BridgeEvent = { at: string; level: 'info' | 'warn' | 'error'; message: string; locationId?: string; instanceId?: string; detail?: string };
type Diagnostics = {
  urls: { callbackUrl: string; deliveryUrl: string; redirectUri: string | null };
  checks: Check[];
  worker: null | {
    build: string;
    commit: string | null;
    startedAt: string;
    providerId: string | null;
    inboundType: string;
    syncPhoneMessages: boolean;
    checks: Check[];
    events: BridgeEvent[];
  };
};
type Banner = { kind: 'ok' | 'warn' | 'error'; text: string };

const STATUS_LABELS: Record<string, string> = {
  connected: 'connected',
  qr: 'scan QR',
  starting: 'starting',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  disconnected: 'disconnected',
  logged_out: 'logged out',
  qr_expired: 'QR expired',
  conflict: 'conflict',
  error: 'error'
};
const NEEDS_RELINK = new Set(['logged_out', 'qr_expired', 'disconnected', 'conflict', 'error']);

export default function Home() {
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('WhatsApp Instance 1');
  const [instances, setInstances] = useState<Instance[]>([]);
  const [ghl, setGhl] = useState<GhlStatus>({ agencies: [], problems: {} });
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState<Banner | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get('ghl');
    if (!state) return;
    const loc = params.get('locationId');
    const message = params.get('message');
    if (state === 'connected') setBanner({ kind: 'ok', text: `HighLevel connected${loc ? ` for location ${loc}` : ''}.` });
    else setBanner({ kind: state === 'warning' ? 'warn' : 'error', text: message || 'Connecting HighLevel failed.' });
    if (loc) setLocationId(loc);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([fetch('/api/instances', { cache: 'no-store' }), fetch('/api/oauth/status', { cache: 'no-store' })]);
      if (!a.ok) throw new Error((await a.json().catch(() => null))?.error || `Worker returned HTTP ${a.status}`);
      setInstances((await a.json()).instances ?? []);
      if (b.ok) {
        const data = await b.json();
        setGhl({ agencies: data.agencies ?? [], problems: data.problems ?? {} });
      }
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the backend');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDiagnostics = useCallback(async () => {
    try {
      const r = await fetch('/api/diagnostics', { cache: 'no-store' });
      if (r.ok) setDiag(await r.json());
    } catch {
      // the instances poll already reports connectivity problems
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshDiagnostics();
    const a = setInterval(() => void refresh(), 4000);
    const b = setInterval(() => void refreshDiagnostics(), 10000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [refresh, refreshDiagnostics]);

  async function createInstance() {
    if (!locationId.trim()) return setError('Enter the GHL Location ID first.');
    setCreating(true);
    setError('');
    try {
      const r = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locationId: locationId.trim(), name })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not create instance');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setCreating(false);
    }
  }

  async function removeInstance(id: string) {
    if (!confirm('Unlink this WhatsApp number and delete the instance?')) return;
    await fetch(`/api/instances/${id}`, { method: 'DELETE' });
    await refresh();
  }

  async function restartInstance(id: string, fresh = false) {
    if (fresh && !confirm('Discard the current WhatsApp login and show a new QR code?')) return;
    await fetch(`/api/instances/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fresh }) });
    await refresh();
  }

  async function testConnection(loc: string) {
    setTests(t => ({ ...t, [loc]: 'Testing…' }));
    const r = await fetch('/api/oauth/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locationId: loc }) });
    const data = await r.json().catch(() => ({}));
    setTests(t => ({ ...t, [loc]: data.ok ? 'API call OK' : `Failed: ${data.error || r.status}${data.body ? ` – ${data.body}` : ''}` }));
    void refreshDiagnostics();
  }

  const checks = [...(diag?.checks ?? []), ...(diag?.worker?.checks ?? [])];
  const problems = checks.filter(c => c.level !== 'ok').length;
  const events = diag?.worker?.events ?? [];

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="brand">
            Spark<span>WA</span>
          </div>
          <div className="sub">Self-hosted WhatsApp bridge for HighLevel</div>
        </div>
        <a className="doc" href="https://marketplace.gohighlevel.com/docs/marketplace-modules/ConversationProviders/" target="_blank" rel="noreferrer">
          GHL Provider Docs ↗
        </a>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">CONTROL YOUR OWN WHATSAPP LAYER</p>
          <h1>Connect a WhatsApp number to a GHL sub-account.</h1>
          <p className="lede">Create an instance, scan the QR from WhatsApp Linked Devices, and route conversations into HighLevel.</p>
        </div>
        <div className="health">
          <span className={`dot ${diag?.worker ? (problems ? 'warn' : 'good') : diag ? 'bad' : ''}`} />
          {diag?.worker ? `Worker ${diag.worker.build}${diag.worker.commit ? ` · ${diag.worker.commit}` : ''}` : diag ? 'Worker unreachable' : 'Checking…'}
        </div>
      </section>

      {banner && (
        <div className={`banner ${banner.kind}`}>
          <span>{banner.text}</span>
          <button className="ghost small" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <section className="grid2">
        <div className="panel">
          <div className="panelhead">
            <h2>1. Connect HighLevel</h2>
            <span>OAuth</span>
          </div>
          <p className="muted">
            Install the Marketplace app into the sub-account, or at the agency level if the app has the oauth.readonly and oauth.write scopes. Tokens are stored on the worker.
          </p>
          <button className="primary" onClick={() => (window.location.href = '/api/oauth/install')}>
            Connect GHL
          </button>
          <div className="connections">
            {Object.keys(ghl.problems).length === 0 && ghl.agencies.length === 0 ? (
              <span className="muted">No GHL locations connected yet.</span>
            ) : (
              <>
                {ghl.agencies.map(a => (
                  <div className="conn" key={a.companyId}>
                    <span className={`dot ${a.canMint ? 'good' : 'bad'}`} />
                    Agency <code>{a.companyId}</code>
                    <b>{a.canMint ? 'Agency install' : 'Agency install · missing oauth.write'}</b>
                  </div>
                ))}
                {Object.entries(ghl.problems).map(([loc, problem]) => (
                  <div className="conn" key={loc}>
                    <span className={`dot ${problem ? 'bad' : 'good'}`} />
                    <code>{loc}</code>
                    <button className="ghost small" onClick={() => setLocationId(loc)}>
                      Use
                    </button>
                    <button className="ghost small" onClick={() => void testConnection(loc)}>
                      Test
                    </button>
                    <b>{problem ? 'Needs attention' : 'Connected'}</b>
                    {(tests[loc] || problem) && <div className="conninfo">{tests[loc] || problem}</div>}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panelhead">
            <h2>2. Create WhatsApp instance</h2>
            <span>Baileys</span>
          </div>
          <p className="muted">An instance owns one WhatsApp Web session and maps to one GHL Location ID.</p>
          <div className="field">
            <label>Location ID</label>
            <input value={locationId} onChange={e => setLocationId(e.target.value)} placeholder="e.g. x0p0EOTTubwtKvIJ5XYB" />
          </div>
          <div className="field">
            <label>Instance name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Sales WhatsApp" />
          </div>
          <button className="primary" disabled={creating} onClick={createInstance}>
            {creating ? 'Creating…' : 'Create instance'}
          </button>
        </div>
      </section>

      <section className="panel instances">
        <div className="panelhead">
          <h2>WhatsApp instances</h2>
          <span>{instances.length} total</span>
        </div>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : instances.length === 0 ? (
          <div className="empty">No instances yet. Add a Location ID above.</div>
        ) : (
          <div className="table">
            {instances.map(i => (
              <InstanceCard
                key={i.id}
                instance={i}
                onDelete={() => removeInstance(i.id)}
                onRestart={() => restartInstance(i.id)}
                onRelink={() => restartInstance(i.id, true)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="grid2 lower">
        <div className="panel">
          <div className="panelhead">
            <h2>Setup status</h2>
            <span>{diag ? (problems ? `${problems} to fix` : 'all good') : '…'}</span>
          </div>
          <div className="checks">
            {checks.map(c => (
              <div className={`check lvl-${c.level}`} key={c.id + c.message}>
                <span className={`dot ${c.level === 'ok' ? 'good' : c.level === 'warn' ? 'warn' : 'bad'}`} />
                <span>{c.message}</span>
              </div>
            ))}
            {!diag && <span className="muted">Loading diagnostics…</span>}
          </div>
        </div>

        <div className="panel">
          <div className="panelhead">
            <h2>3. HighLevel app settings</h2>
            <span>Provider</span>
          </div>
          <p className="muted">Use these values in the Marketplace app (Advanced Settings → Auth, and Conversation Providers).</p>
          {diag && (
            <>
              <CopyRow label="OAuth redirect URL" value={diag.urls.callbackUrl} />
              <CopyRow label="Provider Delivery URL" value={diag.urls.deliveryUrl} />
              <CopyRow label="Provider ID on the worker" value={diag.worker?.providerId || 'not set'} />
              <CopyRow label="Sub-account page (Custom Menu Link URL)" value={`${new URL(diag.urls.callbackUrl).origin}/subaccount/{{location.id}}`} />
            </>
          )}
          <ul className="steps">
            <li>Provider type <b>SMS</b>. Either leave “Is this a Custom Conversation Provider” unchecked and select it under Settings → Phone Numbers → Advanced Settings → SMS Provider, or check it plus “Always show this Conversation Provider” to get its own tab.</li>
            <li>Scopes: conversations/message.write, conversations/message.readonly, conversations.readonly, conversations.write, contacts.readonly, contacts.write.</li>
            <li>After changing scopes or the provider, click Connect GHL again so the stored token gets them.</li>
            <li>
              Sub-account page: in the agency go to <b>Settings → Custom Menu Links</b>, add a link with the URL above and show it in sub-accounts. Each sub-account then manages its own WhatsApp without seeing this dashboard.
            </li>
          </ul>
        </div>
      </section>

      <section className="panel instances">
        <div className="panelhead">
          <h2>Activity</h2>
          <span>{events.length} recent</span>
        </div>
        {events.length === 0 ? (
          <div className="empty">No activity yet. Messages, connections and errors show up here.</div>
        ) : (
          <div className="events">
            {events.map((e, idx) => (
              <div className={`event lvl-${e.level}`} key={e.at + idx}>
                <time>{new Date(e.at).toLocaleString()}</time>
                <div>
                  <div>{e.message}</div>
                  {e.detail && <div className="detail">{e.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer>Built as a bridge: Vercel dashboard + long-running WhatsApp worker + HighLevel custom Conversation Provider.</footer>
    </main>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="urlrow">
      <label>{label}</label>
      <div>
        <code>{value}</code>
        <button
          className="ghost small"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function InstanceCard({ instance, onDelete, onRestart, onRelink }: { instance: Instance; onDelete: () => void; onRestart: () => void; onRelink: () => void }) {
  const [hideQr, setHideQr] = useState(false);
  const waitingForScan = instance.status === 'qr' || instance.status === 'starting';
  const needsRelink = NEEDS_RELINK.has(instance.status);
  return (
    <div className="instance">
      <div className="instmain">
        <div className="insttitle">
          <strong>{instance.name}</strong>
          <span className={`status ${instance.status}`}>{STATUS_LABELS[instance.status] || instance.status}</span>
        </div>
        <div className="meta">
          Location: <code>{instance.locationId}</code>
          {' · '}
          <a className="metalink" href={`/subaccount/${encodeURIComponent(instance.locationId)}`} target="_blank" rel="noreferrer">
            Sub-account view ↗
          </a>
          {instance.phone ? (
            <>
              {' '}
              · Phone: <code>{instance.phone}</code>
            </>
          ) : null}
          {instance.ghlConnected === false && <span className="warnText"> · this location is not connected to HighLevel</span>}
        </div>
        {instance.lastError && <div className="lasterror">{instance.lastError}</div>}
      </div>
      <div className="actions">
        {waitingForScan && (
          <button className="secondary" onClick={() => setHideQr(!hideQr)}>
            {hideQr ? 'Show QR' : 'Hide QR'}
          </button>
        )}
        {needsRelink ? (
          <button className="primary" onClick={onRestart}>
            Reconnect
          </button>
        ) : (
          <button className="ghost" onClick={onRestart}>
            Restart
          </button>
        )}
        {instance.status === 'connected' && (
          <button className="ghost" onClick={onRelink}>
            New QR
          </button>
        )}
        <button className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
      {waitingForScan && !hideQr && (
        <div className="qrbox">
          {instance.qr ? (
            <>
              <img src={instance.qr} alt="WhatsApp QR code" />
              <div>Open WhatsApp → Linked devices → Link a device, then scan. The code refreshes every ~20 seconds.</div>
            </>
          ) : (
            <div className="muted">Generating a QR code…</div>
          )}
        </div>
      )}
    </div>
  );
}
