'use client';

import { useCallback, useEffect, useState } from 'react';

type NumberView = {
  slot: number;
  name: string;
  phone: string | null;
  status: string;
  qr: string | null;
  isDefault: boolean;
  restricted: boolean;
  warmingUp: boolean;
};
type View = { locationId: string; ghlReady: boolean; limit: number; numbers: NumberView[] };

const STATUS: Record<string, { label: string; tone: 'on' | 'wait' | 'off' }> = {
  connected: { label: 'Connected', tone: 'on' },
  qr: { label: 'Scan QR code', tone: 'wait' },
  starting: { label: 'Starting…', tone: 'wait' },
  connecting: { label: 'Connecting…', tone: 'wait' },
  reconnecting: { label: 'Reconnecting…', tone: 'wait' }
};
const DOWN = new Set(['logged_out', 'qr_expired', 'disconnected', 'conflict', 'error']);

function formatPhone(digits: string | null) {
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length === 12) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
}

export default function SubaccountView({ locationId }: { locationId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<{ slot: number; name: string } | null>(null);
  const api = `/api/subaccount/${encodeURIComponent(locationId)}`;

  const apply = useCallback(async (res: Response) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    setView(data);
    setError('');
  }, []);

  const load = useCallback(async () => {
    try {
      await apply(await fetch(api, { cache: 'no-store' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    }
  }, [api, apply]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(key: string, method: string, body?: object, query = '') {
    setBusy(key);
    try {
      await apply(await fetch(`${api}${query}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      return false;
    } finally {
      setBusy('');
    }
  }

  async function add() {
    if (await act('add', 'POST', { action: 'add', name: newName.trim() })) setNewName('');
  }

  async function saveName() {
    if (!renaming?.name.trim()) return;
    if (await act(`rename-${renaming.slot}`, 'PATCH', { slot: renaming.slot, name: renaming.name.trim() })) setRenaming(null);
  }

  function disconnect(n: NumberView) {
    if (confirm(`Disconnect ${n.name}${n.phone ? ` (${formatPhone(n.phone)})` : ''}? You can connect it again later by scanning a new QR code.`)) {
      void act(`delete-${n.slot}`, 'DELETE', undefined, `?slot=${n.slot}`);
    }
  }

  const numbers = view?.numbers ?? [];
  const atLimit = Boolean(view && numbers.length >= view.limit);

  return (
    <main className="sa-shell">
      <section className="sa-card">
        <div className="sa-head">
          <span className="sa-logo" aria-hidden="true" />
          <div>
            <h1>WhatsApp</h1>
            <p>Send and receive WhatsApp messages from Conversations.</p>
          </div>
        </div>

        {error && <div className="sa-alert">{error}</div>}
        {!view && !error && (
          <div className="sa-state">
            <span className="sa-spinner" /> Loading…
          </div>
        )}

        {view && numbers.length === 0 && (
          <div className="sa-state">
            <h2>Connect your WhatsApp</h2>
            <p>Link the WhatsApp number this business uses. You will scan a QR code with your phone.</p>
          </div>
        )}

        {numbers.length > 0 && (
          <ul className="sa-list">
            {numbers.map(n => {
              const status = STATUS[n.status] ?? (DOWN.has(n.status) ? { label: 'Disconnected', tone: 'off' as const } : { label: n.status, tone: 'wait' as const });
              return (
                <li key={n.slot} className="sa-number">
                  <div className="sa-row">
                    <div className="sa-who">
                      {renaming?.slot === n.slot ? (
                        <span className="sa-rename">
                          <input value={renaming.name} maxLength={40} autoFocus onChange={e => setRenaming({ slot: n.slot, name: e.target.value })} onKeyDown={e => e.key === 'Enter' && void saveName()} />
                          <button className="sa-link" disabled={busy !== ''} onClick={() => void saveName()}>Save</button>
                          <button className="sa-link" onClick={() => setRenaming(null)}>Cancel</button>
                        </span>
                      ) : (
                        <strong>
                          #{n.slot} · {n.name}
                        </strong>
                      )}
                      {n.isDefault && <span className="sa-tag">Default</span>}
                      <div className="sa-phone">{formatPhone(n.phone) || 'Not linked yet'}</div>
                    </div>
                    <span className={`sa-pill ${status.tone}`}>{status.label}</span>
                  </div>

                  {n.restricted && <p className="sa-warn">WhatsApp is not letting this number start new chats for now. Chats with people who wrote first still work.</p>}
                  {!n.restricted && n.warmingUp && n.status === 'connected' && <p className="sa-hint">New number warming up: it can start only a few new chats per day for its first week.</p>}

                  {n.status === 'qr' && n.qr && (
                    <div className="sa-qrbox">
                      <img className="sa-qr" src={n.qr} alt={`QR code for ${n.name}`} />
                      <ol className="sa-steps">
                        <li>Open WhatsApp on the phone with this number.</li>
                        <li>Tap <b>Menu ⋮</b> (Android) or <b>Settings</b> (iPhone), then <b>Linked devices</b>.</li>
                        <li>Tap <b>Link a device</b> and scan this code.</li>
                      </ol>
                    </div>
                  )}

                  <div className="sa-actions">
                    {DOWN.has(n.status) && (
                      <button className="sa-primary small" disabled={busy !== ''} onClick={() => void act(`reconnect-${n.slot}`, 'POST', { action: 'reconnect', slot: n.slot })}>
                        {busy === `reconnect-${n.slot}` ? 'Reconnecting…' : 'Reconnect'}
                      </button>
                    )}
                    {!n.isDefault && (
                      <button className="sa-link" disabled={busy !== ''} onClick={() => void act(`default-${n.slot}`, 'PATCH', { slot: n.slot, isDefault: true })}>
                        Make default
                      </button>
                    )}
                    {renaming?.slot !== n.slot && (
                      <button className="sa-link" onClick={() => setRenaming({ slot: n.slot, name: n.name })}>
                        Rename
                      </button>
                    )}
                    <button className="sa-link danger" disabled={busy !== ''} onClick={() => disconnect(n)}>
                      Disconnect
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {view && (
          <div className="sa-add">
            <input value={newName} maxLength={40} placeholder={numbers.length ? 'Name, e.g. Support' : 'Name, e.g. Sales'} disabled={atLimit} onChange={e => setNewName(e.target.value)} />
            <button className="sa-primary" disabled={atLimit || busy !== ''} onClick={() => void add()}>
              {busy === 'add' ? 'Starting…' : numbers.length ? 'Add number' : 'Connect WhatsApp'}
            </button>
            <p className="sa-hint">
              {atLimit ? `All ${view.limit} numbers are in use. Ask your administrator if you need more.` : `${numbers.length} of ${view.limit} numbers used.`}
            </p>
          </div>
        )}

        {numbers.length > 1 && (
          <p className="sa-note">
            Replies go out from the number the contact wrote to (the <b>wa:</b> tag on the contact). Type <b>{`{WA#${numbers[1].slot}}`}</b> in a message to send it
            from number #{numbers[1].slot}.
          </p>
        )}
        {view && !view.ghlReady && <p className="sa-note">Messages won’t reach your conversations until your administrator finishes the HighLevel setup.</p>}
      </section>
    </main>
  );
}
