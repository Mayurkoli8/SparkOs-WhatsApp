import { NextResponse } from 'next/server';
import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { workerFetch } from '@/lib/worker';

type C = { params: Promise<{ locationId: string }> };

export async function DELETE(req: Request, { params }: C) {
  if (!isAdminRequest(req)) return signInRequired();
  const { locationId } = await params;
  try {
    const r = await workerFetch(`/locations/${encodeURIComponent(locationId)}`, { method: 'DELETE' });
    return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Worker unavailable' }, { status: 502 });
  }
}
