import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { NextRequest, NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

export const dynamic = 'force-dynamic';

// Whether HighLevel considers the app installed in a sub-account, and which app versions the tokens belong to.
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return signInRequired();
  const locationId = req.nextUrl.searchParams.get('locationId');
  if (!locationId) return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  try {
    const r = await workerFetch(`/integrations/ghl/${encodeURIComponent(locationId)}/install-status`, { cache: 'no-store' });
    return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Worker unavailable' }, { status: 502 });
  }
}
