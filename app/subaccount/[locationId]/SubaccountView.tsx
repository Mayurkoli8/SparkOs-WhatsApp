'use client';

import { useCallback, useEffect, useState } from 'react';

type View = {
  locationId: string;
  ghlReady: boolean | null;
  instance: { status: string; phone: string | null; qr: string | null } | null;
};

const PREPARING = new Set(['starting', 'connecting']);

function formatPhone(digits: string | null) {
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length === 12) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
}

export default function SubaccountView({ locationId }: { locationId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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

  async function act(method: 'POST' | 'DELETE', body?: object) {
    setBusy(true);
    try {
      await apply(await fetch(api, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    if (confirm('Disconnect WhatsApp from this account? You can connect again any time by scanning a new QR code.')) void act('DELETE');
  }

  const instance = view?.instance;
  const status = instance?.status;

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

        {!view && !error && <div className="sa-state"><span className="sa-spinner" /> Loading…</div>}

        {view && !instance && (
          <div className="sa-state">
            <h2>Connect your WhatsApp</h2>
            <p>Link the WhatsApp number this business uses. You will scan a QR code with your phone.</p>
            <button className="sa-primary" disabled={busy} onClick={() => void act('POST', { action: 'connect' })}>
              {busy ? 'Starting…' : 'Connect WhatsApp'}
            </button>
          </div>
        )}

        {instance && (PREPARING.has(status!) || (status === 'qr' && !instance.qr)) && (
          <div className="sa-state">
            <span className="sa-spinner" />
            <h2>Preparing your QR code…</h2>
          </div>
        )}

        {instance && status === 'qr' && instance.qr && (
          <div className="sa-state">
            <h2>Scan to connect</h2>
            <img className="sa-qr" src={instance.qr} alt="WhatsApp QR code" />
            <ol className="sa-steps">
              <li>Open WhatsApp on your phone.</li>
              <li>Tap <b>Menu ⋮</b> (Android) or <b>Settings</b> (iPhone), then <b>Linked devices</b>.</li>
              <li>Tap <b>Link a device</b> and point your phone at this code.</li>
            </ol>
          </div>
        )}

        {instance && status === 'connected' && (
          <div className="sa-state">
            <div className="sa-badge">● Connected</div>
            <h2>{formatPhone(instance.phone) || 'WhatsApp is connected'}</h2>
            <p>Messages appear in Conversations under the WhatsApp channel.</p>
            <button className="sa-quiet" disabled={busy} onClick={disconnect}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        )}

        {instance && status === 'reconnecting' && (
          <div className="sa-state">
            <span className="sa-spinner" />
            <h2>Reconnecting…</h2>
            <p>This usually takes a few seconds.</p>
          </div>
        )}

        {instance && ['logged_out', 'qr_expired', 'disconnected', 'conflict', 'error'].includes(status!) && (
          <div className="sa-state">
            <div className="sa-badge off">● Disconnected</div>
            <h2>WhatsApp is disconnected</h2>
            <p>Reconnect to keep receiving messages. You may need to scan a new QR code.</p>
            <button className="sa-primary" disabled={busy} onClick={() => void act('POST', { action: 'reconnect' })}>
              {busy ? 'Reconnecting…' : 'Reconnect'}
            </button>
          </div>
        )}

        {view?.ghlReady === false && (
          <p className="sa-note">Messages won’t reach your conversations until your administrator finishes the HighLevel setup.</p>
        )}
      </section>
    </main>
  );
}
