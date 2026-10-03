import { NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

type C = { params: Promise<{ id: string }> };

async function proxy(path: string, init?: RequestInit) {
  try {
    const r = await workerFetch(path, init);
    return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Worker unavailable' }, { status: 502 });
  }
}

export async function GET(_req: Request, { params }: C) {
  const { id } = await params;
  return proxy(`/instances/${encodeURIComponent(id)}`);
}

// Body { fresh: true } discards the stored WhatsApp login and shows a new QR code.
export async function POST(req: Request, { params }: C) {
  const { id } = await params;
  const body = (await req.text()) || '{}';
  return proxy(`/instances/${encodeURIComponent(id)}/restart`, { method: 'POST', body });
}

export async function DELETE(_req: Request, { params }: C) {
  const { id } = await params;
  return proxy(`/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
