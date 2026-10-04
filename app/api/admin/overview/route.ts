import { NextRequest, NextResponse } from 'next/server';
import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { workerFetch } from '@/lib/worker';

export const dynamic = 'force-dynamic';

type Check = { id: string; level: 'ok' | 'warn' | 'error'; message: string };

const REQUIRED_ENV = ['WORKER_URL', 'WORKER_API_KEY', 'GHL_CLIENT_ID', 'GHL_CLIENT_SECRET', 'GHL_INSTALL_URL', 'ADMIN_PASSWORD'];

// Everything the admin dashboard shows: the worker's sub-accounts, numbers, checks and activity, plus checks of
// the web app's own configuration.
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return signInRequired();
  const origin = new URL(req.url).origin;
  const urls = {
    callbackUrl: `${origin}/api/oauth/callback`,
    deliveryUrl: `${origin}/api/oauth/outbound`,
    subaccountUrl: `${origin}/subaccount/{{location.id}}`
  };
  const checks: Check[] = [];
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) checks.push({ id: 'vercel-env', level: 'error', message: `Missing Vercel environment variables: ${missing.join(', ')}` });

  let worker: Record<string, any> | null = null;
  try {
    const res = await workerFetch('/admin/overview', { cache: 'no-store' });
    if (res.status === 401) checks.push({ id: 'worker', level: 'error', message: "The worker rejected WORKER_API_KEY. It must equal the worker's INTERNAL_API_KEY." });
    else if (res.status === 404) checks.push({ id: 'worker', level: 'error', message: 'The worker runs an older build. Reboot the VM so it pulls the latest code.' });
    else if (!res.ok) checks.push({ id: 'worker', level: 'error', message: `The worker answered HTTP ${res.status}.` });
    else worker = await res.json();
  } catch (err) {
    checks.push({ id: 'worker', level: 'error', message: `Cannot reach the WhatsApp worker: ${err instanceof Error ? err.message : String(err)}` });
  }
  return NextResponse.json({ urls, checks: [...checks, ...(worker?.checks ?? [])], worker }, { headers: { 'cache-control': 'no-store' } });
}
