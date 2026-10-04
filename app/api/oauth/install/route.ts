import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return signInRequired();
  const base = process.env.GHL_INSTALL_URL;
  if (!base) return NextResponse.json({ error: 'Set GHL_INSTALL_URL in Vercel.' }, { status: 500 });
  return NextResponse.redirect(new URL(base).toString());
}
