import { NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

// The sub-account page's only API. Every response is limited to the one location in the URL; the admin APIs
// (which list every sub-account) are never exposed to it.
type C = { params: Promise<{ locationId: string }> };
type WorkerInstance = { id: string; locationId: string; status: string; phone?: string; qr?: string | null; createdAt: string };

const LOCATION_ID = /^[A-Za-z0-9_-]{6,64}$/;

const unavailable = () =>
  NextResponse.json({ error: 'WhatsApp is temporarily unavailable. Please try again in a moment.' }, { status: 503 });
const unknownLocation = () => NextResponse.json({ error: 'Unknown sub-account.' }, { status: 404 });

async function instancesFor(locationId: string): Promise<WorkerInstance[] | null> {
  const res = await workerFetch('/instances', { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return null;
  const all: WorkerInstance[] = (await res.json()).instances ?? [];
  return all.filter(i => i.locationId === locationId);
}

// The connected instance wins; otherwise the newest one.
function primary(list: WorkerInstance[]) {
  return list.find(i => i.status === 'connected') ?? [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

async function view(locationId: string) {
  const list = await instancesFor(locationId);
  if (!list) return null;
  const instance = primary(list);
  // null = not known yet (the worker only tracks HighLevel status for locations it has seen).
  let ghlReady: boolean | null = null;
  const res = await workerFetch('/integrations/ghl', { cache: 'no-store' }).catch(() => null);
  if (res?.ok) {
    const problems: Record<string, string | null> = (await res.json()).problems ?? {};
    if (locationId in problems) ghlReady = problems[locationId] === null;
  }
  return {
    locationId,
    ghlReady,
    instance: instance ? { status: instance.status, phone: instance.phone ?? null, qr: instance.qr ?? null } : null
  };
}

async function respond(locationId: string) {
  const current = await view(locationId);
  return current ? NextResponse.json(current, { headers: { 'cache-control': 'no-store' } }) : unavailable();
}

export async function GET(_req: Request, { params }: C) {
  const { locationId } = await params;
  if (!LOCATION_ID.test(locationId)) return unknownLocation();
  return respond(locationId);
}

// Connect (or reconnect) this sub-account's WhatsApp; { action: "relink" } discards the current login for a new QR.
export async function POST(req: Request, { params }: C) {
  const { locationId } = await params;
  if (!LOCATION_ID.test(locationId)) return unknownLocation();
  const { action } = await req.json().catch(() => ({ action: undefined }));
  const list = await instancesFor(locationId);
  if (!list) return unavailable();
  const current = primary(list);
  const res = current
    ? await workerFetch(`/instances/${encodeURIComponent(current.id)}/restart`, { method: 'POST', body: JSON.stringify({ fresh: action === 'relink' }) }).catch(() => null)
    : await workerFetch('/instances', { method: 'POST', body: JSON.stringify({ locationId, name: 'WhatsApp' }) }).catch(() => null);
  if (!res?.ok) return unavailable();
  return respond(locationId);
}

// Disconnect: unlink every WhatsApp session of this sub-account.
export async function DELETE(_req: Request, { params }: C) {
  const { locationId } = await params;
  if (!LOCATION_ID.test(locationId)) return unknownLocation();
  const list = await instancesFor(locationId);
  if (!list) return unavailable();
  for (const instance of list) {
    const res = await workerFetch(`/instances/${encodeURIComponent(instance.id)}`, { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) return unavailable();
  }
  return respond(locationId);
}
