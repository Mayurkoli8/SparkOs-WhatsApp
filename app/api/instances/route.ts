import { NextResponse } from 'next/server';
import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { workerFetch } from '@/lib/worker';

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return signInRequired();
  try {
    const r = await workerFetch('/instances');
    return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Worker unavailable' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return signInRequired();
  try {
    const r = await workerFetch('/instances', { method: 'POST', body: await req.text() });
    return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Worker unavailable' }, { status: 500 });
  }
}
