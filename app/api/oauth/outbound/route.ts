import { NextRequest, NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

// HighLevel Conversation Provider "Delivery URL". The body is forwarded byte-for-byte because the worker
// verifies the Ed25519 X-GHL-Signature against the exact payload.
export async function POST(req: NextRequest) {
  const raw = await req.arrayBuffer();
  try {
    const res = await workerFetch('/webhooks/ghl/outbound', {
      method: 'POST',
      body: raw,
      headers: { 'x-ghl-signature': req.headers.get('x-ghl-signature') || '' }
    });
    return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return NextResponse.json({ error: `WhatsApp worker unavailable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}
