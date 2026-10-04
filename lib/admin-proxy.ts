import { NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

// Forward an admin request to the worker and hand its answer back unchanged.
export async function forwardToWorker(path: string, init?: RequestInit) {
  try {
    const res = await workerFetch(path, { cache: 'no-store', ...init });
    return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Worker unavailable' }, { status: 502 });
  }
}
