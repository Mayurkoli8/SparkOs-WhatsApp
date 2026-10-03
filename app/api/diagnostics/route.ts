import { NextRequest, NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

export const dynamic = 'force-dynamic';

type Check = { id: string; level: 'ok' | 'warn' | 'error'; message: string };

const REQUIRED_ENV = ['WORKER_URL', 'WORKER_API_KEY', 'GHL_CLIENT_ID', 'GHL_CLIENT_SECRET', 'GHL_REDIRECT_URI', 'GHL_INSTALL_URL'];

export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  const callbackUrl = `${origin}/api/oauth/callback`;
  const deliveryUrl = `${origin}/api/oauth/outbound`;
  const redirectUri = process.env.GHL_REDIRECT_URI || '';
  const vercelProviderId = (process.env.GHL_CONVERSATION_PROVIDER_ID || '').trim();
  const checks: Check[] = [];

  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  checks.push(
    missing.length
      ? { id: 'vercel-env', level: 'error', message: `Missing Vercel environment variables: ${missing.join(', ')}` }
      : { id: 'vercel-env', level: 'ok', message: 'Vercel environment variables are set.' }
  );
  if (redirectUri && redirectUri !== callbackUrl) {
    checks.push({
      id: 'redirect',
      level: 'warn',
      message: `GHL_REDIRECT_URI is ${redirectUri} but this site's callback is ${callbackUrl}. The redirect URL in the HighLevel app, GHL_REDIRECT_URI, and the site you install from must all match.`
    });
  }

  let worker: Record<string, any> | null = null;
  try {
    const res = await workerFetch('/diagnostics', { cache: 'no-store' });
    if (res.status === 401) {
      checks.push({ id: 'worker', level: 'error', message: "The worker rejected WORKER_API_KEY. It must equal the worker's INTERNAL_API_KEY." });
    } else if (res.status === 404) {
      checks.push({ id: 'worker', level: 'error', message: 'The worker is running an old build without diagnostics. Redeploy the Railway worker from the latest commit.' });
    } else if (!res.ok) {
      checks.push({ id: 'worker', level: 'error', message: `The worker answered HTTP ${res.status}.` });
    } else {
      worker = await res.json();
    }
  } catch (err) {
    checks.push({ id: 'worker', level: 'error', message: `Cannot reach the WhatsApp worker: ${err instanceof Error ? err.message : String(err)}` });
  }

  if (worker && vercelProviderId && worker.providerId && worker.providerId !== vercelProviderId) {
    checks.push({
      id: 'provider-match',
      level: 'warn',
      message: `GHL_CONVERSATION_PROVIDER_ID differs: Vercel has ${vercelProviderId}, the worker has ${worker.providerId}. The worker's value is used for messages.`
    });
  }

  return NextResponse.json({ urls: { callbackUrl, deliveryUrl, redirectUri: redirectUri || null }, checks, worker });
}
