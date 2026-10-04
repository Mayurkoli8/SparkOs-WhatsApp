'use client';

import { useCallback, useEffect, useState } from 'react';
import { NumberControls } from './NumberControls';
import { SettingsTab } from './SettingsTab';
import {
  call,
  DOWN,
  formatPhone,
  protectionText,
  STATUS_LABELS,
  when,
  type BridgeEvent,
  type Location,
  type NumberInfo,
  type Overview,
  type Policy,
  type Run
} from './shared';
import { SystemPanel } from './SystemPanel';

type Tab = 'overview' | 'subaccounts' | 'activity' | 'settings' | 'setup';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'subaccounts', label: 'Sub-accounts' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
  { id: 'setup', label: 'Setup' }
];

export default function AdminPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState('');
  const [banner, setBanner] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const hash = window.location.hash.slice(1) as Tab;
    if (TABS.some(t => t.id === hash)) setTab(hash);
    const params = new URLSearchParams(window.location.search);
    const state = params.get('ghl');
    if (state) {
      const loc = params.get('locationId');
      setBanner(
        state === 'connected'
          ? { kind: 'ok', text: `HighLevel connected${loc ? ` for ${loc}` : ''}.` }
          : { kind: state === 'warning' ? 'warn' : 'error', text: params.get('message') || 'Connecting HighLevel failed.' }
      );
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setData(await call('/api/admin/overview', 'GET'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the dashboard');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  function open(next: Tab) {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
  }

  const run: Run = async action => {
    try {
      const result = await action();
      setError('');
      await refresh();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
      return undefined;
    }
  };

  async function logout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    window.location.href = '/admin/login';
  }

  const worker = data?.worker;
  const locations = worker?.locations ?? [];
  const numbers = locations.flatMap(l => l.numbers);
  // Each problem once, in its most specific form: per-sub-account and per-number items replace the general checks
  // that summarise them.
  const locationProblems = locations.filter(l => l.ghl.problem);
  const covered = new Set(['location-match', 'whatsapp', ...(locationProblems.length ? ['ghl'] : [])]);
  const problems = [
    ...(data?.checks ?? []).filter(c => c.level !== 'ok' && !covered.has(c.id)).map(c => ({ level: c.level, text: c.message, tab: 'setup' as Tab })),
    ...locationProblems.map(l => ({ level: 'error' as const, text: `${l.locationId}: ${l.ghl.problem}`, tab: 'subaccounts' as Tab })),
    ...numbers
      .filter(n => DOWN.has(n.status) || n.protection.restricted)
      .map(n => ({
        level: n.protection.restricted ? ('error' as const) : ('warn' as const),
        text: `${n.locationId} #${n.slot} ${n.name}: ${n.protection.restricted ? protectionText(n) : STATUS_LABELS[n.status] || n.status}`,
        tab: 'subaccounts' as Tab
      }))
  ];

  return (
    <main className="shell admin">
      <header className="admin-top">
        <div className="brand">
          Spark<span>WA</span> <small>Admin</small>
        </div>
        <div className="admin-top-actions">
          <span className="health">
            <span className={`dot ${worker ? (problems.length ? 'warn' : 'good') : data ? 'bad' : ''}`} />
            {worker ? `Worker online · ${worker.build}` : data ? 'Worker unreachable' : 'Loading…'}
          </span>
          <button className="primary" onClick={() => (window.location.href = '/api/oauth/install')}>
            Connect GHL
          </button>
          <button className="ghost" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map(t => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => open(t.id)}>
            {t.label}
            {t.id === 'overview' && problems.length > 0 && <span className="tab-count">{problems.length}</span>}
          </button>
        ))}
      </nav>

      {banner && (
        <div className={`banner ${banner.kind}`}>
          <span>{banner.text}</span>
          <button className="ghost small" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {tab === 'overview' && (
        <>
          <section className="tiles">
            <div className="tile">
              <b>{locations.length}</b>
              <span>Sub-accounts</span>
            </div>
            <div className="tile">
              <b>
                {numbers.filter(n => n.status === 'connected').length}
                <small>/{numbers.length}</small>
              </b>
              <span>Numbers connected</span>
            </div>
            <div className="tile">
              <b>{numbers.filter(n => n.protection.restricted).length}</b>
              <span>Restricted numbers</span>
            </div>
            <div className={`tile ${problems.length ? 'alert' : ''}`}>
              <b>{problems.length}</b>
              <span>Need attention</span>
            </div>
          </section>

          <section className="panel">
            <div className="panelhead">
              <h2>Needs attention</h2>
              <span>{problems.length ? `${problems.length} item${problems.length > 1 ? 's' : ''}` : 'all good'}</span>
            </div>
            {problems.length === 0 ? (
              <p className="muted">Everything is running. Numbers are connected and HighLevel is set up.</p>
            ) : (
              <div className="checks">
                {problems.map((p, i) => (
                  <button key={i} className={`check linkish lvl-${p.level}`} onClick={() => open(p.tab)}>
                    <span className={`dot ${p.level === 'warn' ? 'warn' : 'bad'}`} />
                    <span>{p.text}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <SystemPanel system={worker?.system} pending={worker?.pendingSync} run={run} />

          <section className="panel">
            <div className="panelhead">
              <h2>Latest activity</h2>
              <button className="ghost small" onClick={() => open('activity')}>
                View all
              </button>
            </div>
            <EventList events={(worker?.events ?? []).slice(0, 8)} />
          </section>
        </>
      )}

      {tab === 'subaccounts' && worker && <SubAccounts locations={locations} defaults={worker.protection} run={run} />}

      {tab === 'activity' && <Activity events={worker?.events ?? []} />}

      {tab === 'settings' && (worker?.settings ? <SettingsTab settings={worker.settings} run={run} /> : <div className="empty">The worker is not reachable, or runs an older build.</div>)}

      {tab === 'setup' && data && <Setup data={data} />}
    </main>
  );
}

function SubAccounts({ locations, defaults, run }: { locations: Location[]; defaults: Policy; run: Run }) {
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');

  async function add() {
    if (!locationId.trim()) return;
    await run(() => call('/api/instances', 'POST', { locationId: locationId.trim(), name: name.trim() }));
    setName('');
  }

  return (
    <>
      <section className="panel add-number">
        <div className="field">
          <label>Sub-account (Location ID)</label>
          <input value={locationId} onChange={e => setLocationId(e.target.value)} placeholder="e.g. TX9KRMZh1GWrjsLyD391" list="known-locations" />
          <datalist id="known-locations">
            {locations.map(l => (
              <option key={l.locationId} value={l.locationId} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label>Number name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Sales" maxLength={40} />
        </div>
        <button className="primary" disabled={!locationId.trim()} onClick={() => void add()}>
          Add number
        </button>
      </section>

      {locations.length === 0 && <div className="empty">No sub-accounts yet. Connect GHL, then add a number above or from the sub-account page.</div>}

      {locations.map(location => (
        <LocationCard key={location.locationId} location={location} defaults={defaults} run={run} />
      ))}
    </>
  );
}

function LocationCard({ location, defaults, run }: { location: Location; defaults: Policy; run: Run }) {
  const [editingLimit, setEditingLimit] = useState<string | null>(null);
  const { locationId, limit, ghl, numbers } = location;

  return (
    <section className="panel loc">
      <div className="loc-head">
        <div>
          <code className="loc-id">{locationId}</code>
          <div className={`loc-ghl ${ghl.problem ? 'bad' : 'good'}`}>
            <span className={`dot ${ghl.problem ? 'bad' : 'good'}`} />
            {ghl.problem ? ghl.problem : 'HighLevel connected'}
          </div>
        </div>
        <div className="loc-tools">
          {editingLimit === null ? (
            <button className="ghost small" onClick={() => setEditingLimit(String(limit))}>
              {numbers.length}/{limit} numbers · change limit
            </button>
          ) : (
            <span className="inline-edit">
              <input type="number" min={0} max={100} value={editingLimit} onChange={e => setEditingLimit(e.target.value)} />
              <button className="primary small" onClick={() => void run(() => call('/api/admin/limit', 'PUT', { locationId, limit: Number(editingLimit) })).then(() => setEditingLimit(null))}>
                Save
              </button>
              <button className="ghost small" onClick={() => setEditingLimit(null)}>
                Cancel
              </button>
            </span>
          )}
          <a className="ghost small linkbtn" href={`/subaccount/${encodeURIComponent(locationId)}`} target="_blank" rel="noreferrer">
            Sub-account page ↗
          </a>
        </div>
      </div>

      {numbers.length === 0 ? (
        <p className="muted">No numbers yet.</p>
      ) : (
        <div className="numbers">
          {numbers.map(n => (
            <NumberRow key={n.id} n={n} defaults={defaults} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}

function NumberRow({ n, defaults, run }: { n: NumberInfo; defaults: Policy; run: Run }) {
  const [showQr, setShowQr] = useState(true);
  const [managing, setManaging] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const url = `/api/instances/${encodeURIComponent(n.id)}`;

  return (
    <div className="num">
      <div className="num-main">
        <div className="num-title">
          <span className="slot">#{n.slot}</span>
          {renaming === null ? (
            <strong>{n.name}</strong>
          ) : (
            <span className="inline-edit">
              <input value={renaming} maxLength={40} autoFocus onChange={e => setRenaming(e.target.value)} />
              <button className="primary small" onClick={() => void run(() => call(url, 'PATCH', { name: renaming })).then(() => setRenaming(null))}>
                Save
              </button>
              <button className="ghost small" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </span>
          )}
          {n.isDefault && <span className="chip">default</span>}
          <span className={`status ${n.status}`}>{STATUS_LABELS[n.status] || n.status}</span>
        </div>
        <div className="meta">
          {formatPhone(n.phone) || 'not linked yet'} · <span className={n.protection.restricted || !n.protection.enabled ? 'warnText' : ''}>{protectionText(n)}</span>
          {n.assignedUserId && <> · owner {n.assignedUserName || n.assignedUserId}</>}
        </div>
        {n.lastError && DOWN.has(n.status) && <div className="lasterror">{n.lastError}</div>}
      </div>
      <div className="actions">
        <button className={managing ? 'secondary small' : 'ghost small'} onClick={() => setManaging(!managing)}>
          {managing ? 'Close' : 'Manage'}
        </button>
        {n.status === 'qr' && (
          <button className="secondary small" onClick={() => setShowQr(!showQr)}>
            {showQr ? 'Hide QR' : 'Show QR'}
          </button>
        )}
        {DOWN.has(n.status) ? (
          <button className="primary small" onClick={() => void run(() => call(url, 'POST', {}))}>
            Reconnect
          </button>
        ) : (
          <button className="ghost small" onClick={() => void run(() => call(url, 'POST', {}))}>
            Restart
          </button>
        )}
        {!n.isDefault && (
          <button className="ghost small" onClick={() => void run(() => call(url, 'PATCH', { isDefault: true }))}>
            Make default
          </button>
        )}
        {renaming === null && (
          <button className="ghost small" onClick={() => setRenaming(n.name)}>
            Rename
          </button>
        )}
        {n.status === 'connected' && (
          <button className="ghost small" onClick={() => confirm('Unlink this WhatsApp login and show a new QR code?') && void run(() => call(url, 'POST', { fresh: true }))}>
            New QR
          </button>
        )}
        <button className="danger small" onClick={() => confirm(`Delete ${n.name} and unlink it from WhatsApp?`) && void run(() => call(url, 'DELETE'))}>
          Delete
        </button>
      </div>
      {n.status === 'qr' && showQr && (
        <div className="qrbox">
          {n.qr ? (
            <>
              <img src={n.qr} alt={`QR code for ${n.name}`} />
              <div>WhatsApp → Linked devices → Link a device. The code refreshes about every 20 seconds.</div>
            </>
          ) : (
            <div className="muted">Generating a QR code…</div>
          )}
        </div>
      )}
      {managing && <NumberControls n={n} defaults={defaults} run={run} />}
    </div>
  );
}

function EventList({ events }: { events: BridgeEvent[] }) {
  if (!events.length) return <div className="empty">No activity yet.</div>;
  return (
    <div className="events">
      {events.map((e, i) => (
        <div className={`event lvl-${e.level}`} key={e.at + i}>
          <time>{when(e.at)}</time>
          <div>
            <div>{e.message}</div>
            {e.detail && <div className="detail">{e.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Activity({ events }: { events: BridgeEvent[] }) {
  const [problemsOnly, setProblemsOnly] = useState(false);
  const shown = problemsOnly ? events.filter(e => e.level !== 'info') : events;
  return (
    <section className="panel">
      <div className="panelhead">
        <h2>Activity</h2>
        <span className="seg">
          <button className={`ghost small ${!problemsOnly ? 'on' : ''}`} onClick={() => setProblemsOnly(false)}>
            All
          </button>
          <button className={`ghost small ${problemsOnly ? 'on' : ''}`} onClick={() => setProblemsOnly(true)}>
            Problems
          </button>
        </span>
      </div>
      <EventList events={shown} />
    </section>
  );
}

function Setup({ data }: { data: Overview }) {
  const worker = data.worker;
  return (
    <div className="grid2 setup">
      <section className="panel">
        <div className="panelhead">
          <h2>Health checks</h2>
          <span>{data.checks.filter(c => c.level !== 'ok').length ? 'needs attention' : 'all good'}</span>
        </div>
        <div className="checks">
          {data.checks.map(c => (
            <div className={`check lvl-${c.level}`} key={c.id + c.message}>
              <span className={`dot ${c.level === 'ok' ? 'good' : c.level === 'warn' ? 'warn' : 'bad'}`} />
              <span>{c.message}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panelhead">
          <h2>HighLevel app settings</h2>
          <span>Marketplace</span>
        </div>
        <CopyRow label="OAuth redirect URL" value={data.urls.callbackUrl} />
        <CopyRow label="Conversation provider Delivery URL" value={data.urls.deliveryUrl} />
        <CopyRow label="Conversation provider ID (worker)" value={worker?.providerId || 'not set'} />
        <CopyRow label="Sub-account page (Custom Menu Link URL)" value={data.urls.subaccountUrl} />
        <ul className="steps">
          <li>
            Add the sub-account page in the agency under <b>Settings → Custom Menu Links</b> so each sub-account manages its own numbers.
          </li>
          <li>
            Messages go out from the number in the contact’s <b>wa: +number</b> tag (set automatically when they write or are first messaged), else the number
            whose owner the contact is assigned to, else the sender’s own number, else the default. <b>{'{WA#2}'}</b> or <b>{'{WA:Sales}'}</b> in a message
            picks a number explicitly.
          </li>
          <li>
            To pick contact owners from a list, the Marketplace app needs the <b>users.readonly</b> scope (then click Connect GHL again).
          </li>
        </ul>
      </section>

      {worker && (
        <section className="panel">
          <div className="panelhead">
            <h2>Number protection</h2>
            <span>per number</span>
          </div>
          <ul className="steps">
            <li>People who wrote to a number first can always be answered from it.</li>
            {!worker.protection.enabled && (
              <li>
                <b>Protection is switched off by default</b>; only numbers with their own settings are limited.
              </li>
            )}
            <li>
              At most <b>{worker.protection.newChatsPerDay}</b> new conversations per day with people who never wrote (
              <b>{worker.protection.warmupNewChatsPerDay}</b> during the first <b>{worker.protection.warmupDays}</b> days after linking).
            </li>
            <li>
              At most <b>{worker.protection.coldMessagesPerContact}</b> messages to someone who has not replied.
            </li>
            <li>When WhatsApp restricts a number it stops starting new chats until the restriction ends; that outreach is never moved to your other numbers.</li>
            <li>Messages are sent with a typing indicator, human-like pauses, and the contact’s messages marked as read first.</li>
            <li>
              Change these defaults on the <b>Settings</b> tab, or per number under <b>Sub-accounts → Manage</b>: skip or restart a warm-up, turn protection
              off, or set other limits.
            </li>
          </ul>
        </section>
      )}
    </div>
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
