import { NextResponse } from 'next/server';

export async function GET() {
  const base = process.env.GHL_INSTALL_URL;
  if (!base) return NextResponse.json({ error: 'Set GHL_INSTALL_URL in Vercel.' }, { status: 500 });
  return NextResponse.redirect(new URL(base).toString());
}
