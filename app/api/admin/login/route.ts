import { NextResponse } from 'next/server';
import { ADMIN_COOKIE, SESSION_MAX_AGE, checkPassword, createSessionToken, passwordConfigured } from '@/lib/admin-auth';

export async function POST(req: Request) {
  if (!passwordConfigured()) return NextResponse.json({ error: 'Admin sign-in is not configured (ADMIN_PASSWORD is not set).' }, { status: 503 });
  const { password } = await req.json().catch(() => ({ password: '' }));
  if (typeof password !== 'string' || !checkPassword(password)) {
    // A short pause makes guessing slow.
    await new Promise(resolve => setTimeout(resolve, 600));
    return NextResponse.json({ error: 'Wrong password.' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, createSessionToken(), { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE });
  return res;
}
