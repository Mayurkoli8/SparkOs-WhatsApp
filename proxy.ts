import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_COOKIE, verifySessionToken } from '@/lib/admin-auth';

// Admin pages and admin APIs need the admin session. Each admin route also checks it itself, so a matcher change
// cannot silently expose one. The sub-account page, GHL webhooks and the OAuth callback stay public.
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (pathname === '/admin/login' || pathname === '/api/admin/login') return NextResponse.next();
  if (verifySessionToken(req.cookies.get(ADMIN_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  const login = new URL('/admin/login', req.url);
  login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    '/admin/:path*',
    '/api/admin/:path*',
    '/api/instances',
    '/api/instances/:path*',
    '/api/diagnostics',
    '/api/oauth/status',
    '/api/oauth/test',
    '/api/oauth/install',
    '/api/oauth/install-status'
  ]
};
