import { NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

export const dynamic = 'force-dynamic';

// Public liveness check: shows which worker build is running, nothing secret.
export async function GET() {
  try {
    const r = await workerFetch('/health', { cache: 'no-store' });
    return NextResponse.json({ web: 'ok', worker: await r.json().catch(() => ({ status: r.status })) }, { status: r.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ web: 'ok', worker: null, error: e instanceof Error ? e.message : 'Worker unavailable' }, { status: 502 });
  }
}
