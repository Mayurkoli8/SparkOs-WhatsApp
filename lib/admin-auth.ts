import crypto from 'node:crypto';
import { NextResponse } from 'next/server';

// Admin sign-in: one password (ADMIN_PASSWORD on Vercel) and an HMAC-signed, HttpOnly session cookie.
export const ADMIN_COOKIE = 'sparkwa_admin';
export const SESSION_MAX_AGE = 14 * 24 * 3600; // seconds

function secret() {
  const base = process.env.ADMIN_SESSION_SECRET || `${process.env.ADMIN_PASSWORD || ''}|${process.env.WORKER_API_KEY || ''}`;
  return crypto.createHash('sha256').update(`sparkwa-admin:${base}`).digest();
}

const sign = (value: string) => crypto.createHmac('sha256', secret()).update(value).digest('base64url');

function sameBytes(a: string, b: string) {
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

export function passwordConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD);
}

export function checkPassword(input: string) {
  const expected = process.env.ADMIN_PASSWORD || '';
  return Boolean(expected) && sameBytes(input, expected);
}

export function createSessionToken(now = Date.now()) {
  const expires = String(now + SESSION_MAX_AGE * 1000);
  return `${expires}.${sign(expires)}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now()) {
  if (!token || !passwordConfigured()) return false;
  const [expires, signature] = token.split('.');
  if (!expires || !signature || Number(expires) < now) return false;
  return sameBytes(signature, sign(expires));
}

function cookieFromHeader(header: string | null, name: string) {
  for (const part of (header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function isAdminRequest(req: Request) {
  return verifySessionToken(cookieFromHeader(req.headers.get('cookie'), ADMIN_COOKIE));
}

export function signInRequired() {
  return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
}
