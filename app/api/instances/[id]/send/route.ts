import { NextResponse } from 'next/server';
import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { forwardToWorker } from '@/lib/admin-proxy';

type C = { params: Promise<{ id: string }> };

// Admin test message from one number: body { to, text }. Protection rules apply as for any other send.
export async function POST(req: Request, { params }: C) {
  if (!isAdminRequest(req)) return signInRequired();
  const { id } = await params;
  const { to, text } = await req.json().catch(() => ({}));
  if (typeof to !== 'string' || typeof text !== 'string' || !to.trim() || !text.trim()) {
    return NextResponse.json({ error: 'Enter a phone number and a message.' }, { status: 400 });
  }
  return forwardToWorker(`/instances/${encodeURIComponent(id)}/send`, { method: 'POST', body: JSON.stringify({ to, text: text.slice(0, 1000) }) });
}
