import { NextResponse } from 'next/server';
import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { forwardToWorker } from '@/lib/admin-proxy';

// ?locationId=… lists that sub-account's HighLevel users (for assigning numbers); &refresh=1 skips the cache.
export async function GET(req: Request) {
  if (!isAdminRequest(req)) return signInRequired();
  const params = new URL(req.url).searchParams;
  const locationId = params.get('locationId') || '';
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(locationId)) return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  return forwardToWorker(`/locations/${encodeURIComponent(locationId)}/users${params.get('refresh') === '1' ? '?refresh=1' : ''}`);
}
