import { NextRequest, NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

export const maxDuration = 60;

// Answers that mean the worker is restarting or briefly unreachable, not that it refused the message.
const UNAVAILABLE = new Set([502, 503, 504]);
const RETRY_FOR_MS = 25_000;

// HighLevel Conversation Provider "Delivery URL". The body is forwarded byte-for-byte because the worker
// verifies the Ed25519 X-GHL-Signature against the exact payload. While the worker restarts (a deploy, a reboot) the
// message is retried for a short while instead of failing; the worker sends each HighLevel message id only once.
export async function POST(req: NextRequest) {
  const raw = await req.arrayBuffer();
  const signature = req.headers.get('x-ghl-signature') || '';
  const deadline = Date.now() + RETRY_FOR_MS;
  let problem = '';
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await workerFetch('/webhooks/ghl/outbound', {
        method: 'POST',
        body: raw,
        headers: { 'x-ghl-signature': signature },
        signal: AbortSignal.timeout(10_000)
      });
      if (!UNAVAILABLE.has(res.status) || Date.now() >= deadline) {
        return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
      }
      problem = `HTTP ${res.status}`;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    const wait = Math.min(1000 * attempt, 4000);
    if (Date.now() + wait >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, wait));
  }
  return NextResponse.json({ error: `WhatsApp worker unavailable: ${problem}` }, { status: 502 });
}
