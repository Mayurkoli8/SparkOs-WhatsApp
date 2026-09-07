'use client';

import { useEffect, useState } from 'react';

type Instance = {
  id: string;
  name: string;
  locationId: string;
  status: string;
  phone?: string;
  qr?: string | null;
  createdAt: string;
};

type GhlConnection = { locationId: string; connected: boolean; updatedAt?: string };

export default function Home() {
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('WhatsApp Instance 1');
  const [instances, setInstances] = useState<Instance[]>([]);
  const [ghl, setGhl] = useState<GhlConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    try {
      const [a, b] = await Promise.all([
        fetch('/api/instances', { cache: 'no-store' }),
        fetch('/api/oauth/status', { cache: 'no-store' })
      ]);
      if (!a.ok) throw new Error(await a.text());
      setInstances((await a.json()).instances ?? []);
      if (b.ok) setGhl((await b.json()).connections ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the backend');
    } finally { setLoading(false); }
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 4000);
    return () => clearInterval(id);
  }, []);

  async function createInstance() {
    if (!locationId.trim()) return setError('Enter the GHL Location ID first.');
    setCreating(true); setError('');
    try {
      const r = await fetch('/api/instances', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ locationId, name }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not create instance');
      setLocationId('');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setCreating(false); }
  }

  async function removeInstance(id: string) {
    if (!confirm('Disconnect and delete this WhatsApp instance?')) return;
    await fetch(`/api/instances/${id}`, { method: 'DELETE' });
    await refresh();
  }

  async function restartInstance(id: string) {
    await fetch(`/api/instances/${id}`, { method: 'POST' });
    await refresh();
  }

  function connectGhl() {
    const url = '/api/oauth/install' + (locationId ? `?locationId=${encodeURIComponent(locationId)}` : '');
    window.location.href = url;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="brand">Spark<span>WA</span></div>
          <div className="sub">Self-hosted WhatsApp bridge for HighLevel</div>
        </div>
        <a className="doc" href="https://marketplace.gohighlevel.com/docs/marketplace-modules/ConversationProviders/" target="_blank">GHL Provider Docs ↗</a>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">CONTROL YOUR OWN WHATSAPP LAYER</p>
          <h1>Connect a WhatsApp number to a GHL sub-account.</h1>
          <p className="lede">Create an instance, scan the QR from WhatsApp Linked Devices, and route conversations into HighLevel.</p>
        </div>
        <div className="health"><span className="dot" /> System ready</div>
      </section>

      {error && <div className="error">{error}</div>}

      <section className="grid2">
        <div className="panel">
          <div className="panelhead"><h2>1. Connect HighLevel</h2><span>OAuth</span></div>
          <p className="muted">Install your private Marketplace app into the target sub-account. The callback stores the token on the worker.</p>
          <div className="field"><label>Location ID</label><input value={locationId} onChange={e=>setLocationId(e.target.value)} placeholder="e.g. HN8..." /></div>
          <button className="primary" onClick={connectGhl}>Connect GHL</button>
          <div className="mini">Need the test install link? Set <code>GHL_INSTALL_URL</code> in Vercel.</div>
          <div className="connections">
            {ghl.length === 0 ? <span className="muted">No GHL locations connected yet.</span> : ghl.map(c => <div className="conn" key={c.locationId}><span className="dot good" />{c.locationId}<b>Connected</b></div>)}
          </div>
        </div>

        <div className="panel">
          <div className="panelhead"><h2>2. Create WhatsApp instance</h2><span>Baileys</span></div>
          <p className="muted">An instance owns one WhatsApp Web session and maps to one GHL Location ID.</p>
          <div className="field"><label>Instance name</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="Sales WhatsApp" /></div>
          <button className="primary" disabled={creating} onClick={createInstance}>{creating ? 'Creating…' : 'Create instance'}</button>
          <div className="mini">Sessions are stored on the worker&apos;s persistent disk.</div>
        </div>
      </section>

      <section className="panel instances">
        <div className="panelhead"><h2>WhatsApp instances</h2><span>{instances.length} total</span></div>
        {loading ? <div className="empty">Loading…</div> : instances.length === 0 ? <div className="empty">No instances yet. Add a Location ID above.</div> : <div className="table">
          {instances.map(i => <InstanceCard key={i.id} instance={i} onDelete={()=>removeInstance(i.id)} onRestart={()=>restartInstance(i.id)} />)}
        </div>}
      </section>

      <footer>Built as a bridge: Vercel dashboard + long-running WhatsApp worker + HighLevel custom Conversation Provider.</footer>
    </main>
  );
}

function InstanceCard({instance,onDelete,onRestart}:{instance:Instance;onDelete:()=>void;onRestart:()=>void}){
  const [showQr,setShowQr]=useState(false);
  return <div className="instance">
    <div className="instmain">
      <div className="insttitle"><strong>{instance.name}</strong><span className={`status ${instance.status}`}>{instance.status}</span></div>
      <div className="meta">Location: <code>{instance.locationId}</code>{instance.phone ? <> · Phone: <code>{instance.phone}</code></> : null}</div>
    </div>
    <div className="actions">
      {instance.status !== 'connected' && <button className="secondary" onClick={()=>setShowQr(!showQr)}>{showQr ? 'Hide QR' : 'Show QR'}</button>}
      <button className="ghost" onClick={onRestart}>Restart</button>
      <button className="danger" onClick={onDelete}>Delete</button>
    </div>
    {showQr && <div className="qrbox">
      {instance.qr ? <><img src={instance.qr} alt="WhatsApp QR code"/><div>Open WhatsApp → Linked devices → Link a device.</div></> : <div className="muted">QR not ready yet. Wait a few seconds and refresh.</div>}
    </div>}
  </div>
}
