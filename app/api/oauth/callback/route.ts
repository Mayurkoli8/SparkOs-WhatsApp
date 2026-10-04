import { NextRequest, NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

const GHL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';

type LocationResult = { locationId: string; ok: boolean; error?: string; problem?: string | null };

// Every outcome is written to the worker's activity log (best effort) and shown as a banner on the dashboard.
async function report(level: 'info' | 'warn' | 'error', message: string, detail?: string) {
  console.log(`[oauth-callback] ${level}: ${message}${detail ? ` | ${detail}` : ''}`);
  await workerFetch('/events', { method: 'POST', body: JSON.stringify({ level, message, detail }) }).catch(() => undefined);
}

function backToDashboard(req: NextRequest, params: Record<string, string>) {
  const url = new URL('/', req.url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url);
  response.cookies.delete('ghl_location_id');
  return response;
}

async function fail(req: NextRequest, message: string, detail?: string) {
  await report('error', `HighLevel install failed: ${message}`, detail);
  return backToDashboard(req, { ghl: 'error', message });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get('code');
  if (!code) return fail(req, params.get('error_description') || params.get('error') || 'HighLevel did not send an authorization code.');
  const missing = ['GHL_CLIENT_ID', 'GHL_CLIENT_SECRET', 'WORKER_URL', 'WORKER_API_KEY'].filter(k => !process.env[k]);
  if (missing.length) return backToDashboard(req, { ghl: 'error', message: `Missing Vercel environment variables: ${missing.join(', ')}` });

  // The redirect URI HighLevel just used is, by definition, this request's own URL without the query string.
  const body = new URLSearchParams({
    client_id: process.env.GHL_CLIENT_ID!,
    client_secret: process.env.GHL_CLIENT_SECRET!,
    grant_type: 'authorization_code',
    code,
    user_type: 'Location',
    redirect_uri: `${req.nextUrl.origin}${req.nextUrl.pathname}`
  });

  let token: Record<string, any>;
  try {
    const res = await fetch(GHL_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    token = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = token.error_description || token.message || token.error || 'unknown error';
      return fail(req, `HighLevel token exchange failed (${res.status}): ${reason}`);
    }
  } catch (err) {
    return fail(req, `Could not reach HighLevel: ${err instanceof Error ? err.message : String(err)}`);
  }

  const agency = token.userType === 'Company' || !token.locationId;
  await report(
    'info',
    `HighLevel install returned ${agency ? `an agency token for company ${token.companyId || 'unknown'}` : `a sub-account token for ${token.locationId}`}`,
    `scopes: ${token.scope || 'none reported'}${Array.isArray(token.approvedLocations) ? `; approved locations: ${token.approvedLocations.length}` : ''}`
  );

  let saved: Record<string, any>;
  try {
    const res = await workerFetch('/integrations/ghl/connect', {
      method: 'POST',
      body: JSON.stringify({
        locationId: token.locationId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresIn: token.expires_in,
        scope: token.scope,
        userId: token.userId,
        companyId: token.companyId,
        userType: agency ? 'Company' : token.userType || 'Location',
        approvedLocations: token.approvedLocations
      })
    });
    saved = await res.json().catch(() => ({}));
    if (!res.ok) return fail(req, `HighLevel authorized the app, but the worker could not store the token: ${saved.error || `HTTP ${res.status}`}`);
  } catch (err) {
    return fail(req, `The WhatsApp worker is unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const locations: LocationResult[] = saved.locations || [];
  const broken = locations.filter(l => !l.ok || l.problem);
  const ready = locations.filter(l => l.ok && !l.problem).map(l => l.locationId);
  if (!locations.length) {
    return backToDashboard(req, {
      ghl: 'warning',
      message: 'Agency install saved. Create a WhatsApp instance for a sub-account and the bridge will request a token for it.'
    });
  }
  if (broken.length) {
    const first = broken[0];
    return backToDashboard(req, { ghl: 'warning', locationId: first.locationId, message: `Saved, but ${first.locationId} is not usable yet: ${first.problem || first.error}` });
  }
  return backToDashboard(req, { ghl: 'connected', locationId: ready.join(', ') });
}
