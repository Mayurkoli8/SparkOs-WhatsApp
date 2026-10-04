import { NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

// The sub-account page's only API. Every response and action is limited to the one location in the URL, and numbers
// are addressed by their slot (#1, #2…), never by internal ids.
type C = { params: Promise<{ locationId: string }> };
type WorkerNumber = {
  id: string;
  slot: number | null;
  name: string;
  phone?: string | null;
  status: string;
  qr?: string | null;
  isDefault: boolean;
  restrictedUntil: number | null;
  protection?: { warmingUp: boolean };
};
type WorkerLocation = { locationId: string; limit: number; ghlReady: boolean; numbers: WorkerNumber[] };

const LOCATION_ID = /^[A-Za-z0-9_-]{6,64}$/;

const unavailable = () => NextResponse.json({ error: 'WhatsApp is temporarily unavailable. Please try again in a moment.' }, { status: 503 });
const unknownLocation = () => NextResponse.json({ error: 'Unknown sub-account.' }, { status: 404 });
const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

async function load(locationId: string): Promise<WorkerLocation | null> {
  const res = await workerFetch(`/locations/${encodeURIComponent(locationId)}`, { cache: 'no-store' }).catch(() => null);
  return res?.ok ? res.json() : null;
}

function view(location: WorkerLocation) {
  return {
    locationId: location.locationId,
    ghlReady: location.ghlReady,
    limit: location.limit,
    numbers: location.numbers.map(n => ({
      slot: n.slot,
      name: n.name,
      phone: n.phone ?? null,
      status: n.status,
      qr: n.qr ?? null,
      isDefault: n.isDefault,
      restricted: Boolean(n.restrictedUntil),
      warmingUp: Boolean(n.protection?.warmingUp)
    }))
  };
}

async function respond(locationId: string) {
  const location = await load(locationId);
  return location ? NextResponse.json(view(location), { headers: { 'cache-control': 'no-store' } }) : unavailable();
}

// Pass the worker's own message through when it is meant for people (e.g. the number limit).
async function relay(res: Response | null, locationId: string) {
  if (!res) return unavailable();
  if (res.status === 409) return NextResponse.json({ error: (await res.json().catch(() => ({}))).error || 'Not allowed.' }, { status: 409 });
  if (!res.ok) return unavailable();
  return respond(locationId);
}

async function numberBySlot(locationId: string, slot: unknown) {
  const location = await load(locationId);
  if (!location) return { location: null, number: null };
  return { location, number: location.numbers.find(n => n.slot === Number(slot)) ?? null };
}

export async function GET(_req: Request, { params }: C) {
  const { locationId } = await params;
  if (!LOCATION_ID.test(locationId)) return unknownLocation();
  return respond(locationId);
}

// { action: "add", name } adds a number (within the limit); { action: "reconnect" | "relink", slot } restarts one,
// "relink" discarding its WhatsApp login for a new QR code.
export async function POST(req: Request, { params }: C) {
  const { locationId } = await params;
  if (!LOCATION_ID.test(locationId)) return unknownLocation();
  const { action, name, slot } = await req.json().catch(() => ({}));
  if (action === 'add') {
    const res = await workerFetch('/instances', {
      method: 'POST',
      body: JSON.stringify({ locationId, name: typeof name === 'string' ? name : '', enforceLimit: true })
    }).catch(() => null);
    return relay(res, locationId);
  }
  if (action !== 'reconnect' && action !== 'relink') return badRequest('Unknown action.');
  const { location, number } = await numberBySlot(locationId, slot);
  if (!location) return unavailable();
  if (!number) return badRequest('That number does not exist.');
  const res = await workerFetch(`/instances/${encodeURIComponent(number.id)}/restart`, {
    method: 'POST',
    body: JSON.stringify({ fresh: action === 'relink' })
  }).catch(() => null);
  return relay(res, locationId);
}

// { slot, name } renames a number; { slot, isDefault: true } makes it the default sender.
export async function PATCH(req: Request, { params }: C) {
  const { locationId } = await params;
  if (!LOCATION_ID.test(locationId)) return unknownLocation();
  const { slot, name, isDefault } = await req.json().catch(() => ({}));
  const { location, number } = await numberBySlot(locationId, slot);
  if (!location) return unavailable();
  if (!number) return badRequest('That number does not exist.');
  const res = await workerFetch(`/instances/${encodeURIComponent(number.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: typeof name === 'string' ? name : undefined, isDefault: isDefault === true })
  }).catch(() => null);
  return relay(res, locationId);
}

// ?slot=2 disconnects (unlinks) that number.
export async function DELETE(req: Request, { params }: C) {
  const { locationId } = await params;
  if (!LOCATION_ID.test(locationId)) return unknownLocation();
  const { location, number } = await numberBySlot(locationId, new URL(req.url).searchParams.get('slot'));
  if (!location) return unavailable();
  if (!number) return badRequest('That number does not exist.');
  const res = await workerFetch(`/instances/${encodeURIComponent(number.id)}`, { method: 'DELETE' }).catch(() => null);
  return relay(res, locationId);
}
