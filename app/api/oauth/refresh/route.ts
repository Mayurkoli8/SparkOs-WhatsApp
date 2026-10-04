import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

// Refreshes a HighLevel token for the worker, so GHL_CLIENT_SECRET only has to live on Vercel.
// Callers authenticate with the worker key (WORKER_API_KEY here, INTERNAL_API_KEY on the worker).
function sameKey(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function POST(req: NextRequest) {
  const key = process.env.WORKER_API_KEY || '';
  if (!key || !sameKey(req.headers.get('x-internal-api-key') || '', key)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { refresh_token: refreshToken, user_type: userType } = await req.json().catch(() => ({}));
  if (typeof refreshToken !== 'string' || !refreshToken) return NextResponse.json({ error: 'refresh_token required' }, { status: 400 });
  if (!process.env.GHL_CLIENT_ID || !process.env.GHL_CLIENT_SECRET) {
    return NextResponse.json({ error: 'GHL_CLIENT_ID / GHL_CLIENT_SECRET are not set on Vercel' }, { status: 500 });
  }
  const res = await fetch('https://services.leadconnectorhq.com/oauth/token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      user_type: userType === 'Company' ? 'Company' : 'Location'
    })
  });
  return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
}
