import { NextRequest, NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';

const GHL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';

// Every outcome lands back on the dashboard with a readable banner instead of a raw JSON error page.
function backToDashboard(req: NextRequest, params: Record<string, string>) {
  const url = new URL('/', req.url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url);
  response.cookies.delete('ghl_location_id');
  return response;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get('code');
  if (!code) {
    return backToDashboard(req, { ghl: 'error', message: params.get('error_description') || params.get('error') || 'HighLevel did not send an authorization code.' });
  }
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
      return backToDashboard(req, { ghl: 'error', message: `HighLevel token exchange failed (${res.status}): ${reason}` });
    }
  } catch (err) {
    return backToDashboard(req, { ghl: 'error', message: `Could not reach HighLevel: ${err instanceof Error ? err.message : String(err)}` });
  }

  const locationId: string | undefined = token.locationId;
  if (!locationId) {
    return backToDashboard(req, {
      ghl: 'error',
      message:
        token.userType === 'Company'
          ? 'The app was installed at the agency level. Install it into a specific sub-account by choosing that location on the HighLevel install screen.'
          : 'HighLevel did not return a location id for this install.'
    });
  }

  try {
    const res = await workerFetch('/integrations/ghl/connect', {
      method: 'POST',
      body: JSON.stringify({
        locationId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresIn: token.expires_in,
        scope: token.scope,
        userId: token.userId,
        companyId: token.companyId,
        userType: token.userType
      })
    });
    const saved = await res.json().catch(() => ({}));
    if (!res.ok) {
      return backToDashboard(req, { ghl: 'error', locationId, message: `HighLevel authorized the app, but the worker could not store the token: ${saved.error || `HTTP ${res.status}`}` });
    }
    if (saved.check && !saved.check.ok) {
      return backToDashboard(req, { ghl: 'warning', locationId, message: `Connected, but a test call to HighLevel failed: ${saved.check.error}` });
    }
    return backToDashboard(req, { ghl: 'connected', locationId });
  } catch (err) {
    return backToDashboard(req, { ghl: 'error', locationId, message: `The WhatsApp worker is unreachable: ${err instanceof Error ? err.message : String(err)}` });
  }
}
