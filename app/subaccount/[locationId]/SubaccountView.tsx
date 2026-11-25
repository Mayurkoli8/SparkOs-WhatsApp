'use client';

import { useCallback, useEffect, useState } from 'react';

type NumberView = {
  slot: number;
  name: string;
  phone: string | null;
  status: string;
  qr: string | null;
  lastError: string | null;
  isDefault: boolean;
  restricted: boolean;
  warmingUp: boolean;
  historyBackfillStatus: 'awaiting-pairing' | 'syncing' | 'paused' | 'complete' | null;
  historyBackfillCount: number;
  historyBackfillDays: number | null;
  historyBackfillProgress: number | null;
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
  const [backfillOnConnect, setBackfillOnConnect] = useState(false);
  const [backfillDays, setBackfillDays] = useState('');
  const [renaming, setRenaming] = useState<{ slot: number; name: string } | null>(null);
  const api = `/api/subaccount/${encodeURIComponent(locationId)}`;
  const parsedBackfillDays = Number(backfillDays);
  const validBackfillDays = Number.isInteger(parsedBackfillDays) && parsedBackfillDays >= 1 && parsedBackfillDays <= 30;

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
    if (backfillOnConnect && !validBackfillDays) return;
    if (
      await act('add', 'POST', {
        action: 'add',
        name: newName.trim(),
        ...(backfillOnConnect ? { historyBackfillDays: parsedBackfillDays } : {})
      })
    ) {
      setNewName('');
      setBackfillOnConnect(false);
      setBackfillDays('');
    }
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
                  {n.lastError && <p className="sa-warn">{n.lastError}</p>}
                  {n.historyBackfillStatus && (
                    <div className="sa-history">
                      <p className="sa-hint">
                        {n.historyBackfillStatus === 'awaiting-pairing'
                          ? `History backfill for the last ${n.historyBackfillDays || 1} days is waiting for the QR scan.`
                          : n.historyBackfillStatus === 'syncing'
                            ? n.historyBackfillProgress === null
                              ? `Waiting for WhatsApp's history progress. ${n.historyBackfillCount} messages received so far.`
                              : `WhatsApp history: ${n.historyBackfillProgress}% received, ${100 - n.historyBackfillProgress}% remaining. ${n.historyBackfillCount} messages received so far.`
                            : n.historyBackfillStatus === 'paused'
                              ? `WhatsApp paused history transfer${n.historyBackfillProgress === null ? '' : ` at ${n.historyBackfillProgress}%`}. ${n.historyBackfillCount} messages received so far.`
                              : `History transfer complete: ${n.historyBackfillCount} messages received from the last ${n.historyBackfillDays || 1} days.`}
                      </p>
                      {n.historyBackfillStatus !== 'awaiting-pairing' && (
                        <div
                          className={`sa-progress${n.historyBackfillProgress === null ? ' indeterminate' : ''}`}
                          role="progressbar"
                          aria-label={`WhatsApp history received for ${n.name}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={n.historyBackfillProgress ?? undefined}
                          aria-valuetext={n.historyBackfillProgress === null ? 'Waiting for WhatsApp progress' : `${n.historyBackfillProgress}% received`}
                        >
                          <span style={{ width: n.historyBackfillProgress === null ? undefined : `${n.historyBackfillProgress}%` }} />
                        </div>
                      )}
                    </div>
                  )}

                  {n.qr || n.status === 'qr' ? (
                    <div className="sa-qrbox">
                      {n.qr ? (
                        <>
                          <img className="sa-qr" src={n.qr} alt={`QR code for ${n.name}`} />
                          <ol className="sa-steps">
                            <li>Open WhatsApp on the phone with this number.</li>
                            <li>Tap <b>Menu ⋮</b> (Android) or <b>Settings</b> (iPhone), then <b>Linked devices</b>.</li>
                            <li>Tap <b>Link a device</b> and scan this code.</li>
                          </ol>
                        </>
                      ) : (
                        <div className="sa-state"><span className="sa-spinner" /> Generating a WhatsApp QR code…</div>
                      )}
                    </div>
                  ) : null}
                  {!n.qr && (n.status === 'starting' || n.status === 'connecting' || n.status === 'reconnecting') && (
                    <div className="sa-qrbox">
                      <div className="sa-state">
                        <span className="sa-spinner" />{' '}
                        {n.status === 'reconnecting'
                          ? 'WhatsApp connection closed; reconnecting. A new QR will appear if needed…'
                          : 'Generating a WhatsApp QR code…'}
                      </div>
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
            <label className="sa-backfill-toggle">
              <input
                className="sa-checkbox"
                type="checkbox"
                checked={backfillOnConnect}
                disabled={atLimit || busy !== ''}
                onChange={e => setBackfillOnConnect(e.target.checked)}
              />
              Backfill history
            </label>
            {backfillOnConnect && (
              <label className="sa-backfill-days">
                Days (1–30)
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  value={backfillDays}
                  disabled={atLimit || busy !== ''}
                  onChange={e => setBackfillDays(e.target.value)}
                />
              </label>
            )}
            <button className="sa-primary" disabled={atLimit || busy !== '' || (backfillOnConnect && !validBackfillDays)} onClick={() => void add()}>
              {busy === 'add' ? 'Starting…' : numbers.length ? 'Add number' : 'Connect WhatsApp'}
            </button>
            <p className="sa-hint">
              {atLimit
                ? `All ${view.limit} numbers are in use. Ask your administrator if you need more.`
                : backfillOnConnect
                  ? `WhatsApp will be asked for the last ${validBackfillDays ? parsedBackfillDays : 'chosen'} days of history when you scan the QR.`
                  : `${numbers.length} of ${view.limit} numbers used.`}
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
