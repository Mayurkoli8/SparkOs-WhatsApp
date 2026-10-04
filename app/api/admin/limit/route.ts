import { NextResponse } from 'next/server';
import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { workerFetch } from '@/lib/worker';

// How many WhatsApp numbers a sub-account may add itself.
export async function PUT(req: Request) {
  if (!isAdminRequest(req)) return signInRequired();
  const { locationId, limit } = await req.json().catch(() => ({}));
  if (typeof locationId !== 'string' || !locationId) return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  try {
    const r = await workerFetch(`/locations/${encodeURIComponent(locationId)}/limit`, { method: 'PUT', body: JSON.stringify({ limit }) });
    return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Worker unavailable' }, { status: 502 });
  }
}
