import { NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

// Makes one authenticated HighLevel API call with the stored token for a location.
export async function POST(req: Request) {
  const { locationId } = await req.json().catch(() => ({ locationId: '' }));
  if (!locationId) return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  try {
    const r = await workerFetch(`/integrations/ghl/${encodeURIComponent(locationId)}/test`, { method: 'POST', body: '{}' });
    return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Worker unavailable' }, { status: 502 });
  }
}
