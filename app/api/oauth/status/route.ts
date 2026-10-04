import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { NextResponse } from 'next/server';import { workerFetch } from '@/lib/worker';
export async function GET(req: Request) {
  if (!isAdminRequest(req)) return signInRequired();
  try{const r=await workerFetch('/integrations/ghl');return new NextResponse(await r.text(),{status:r.status,headers:{'content-type':'application/json'}})}catch(e){return NextResponse.json({connections:[],error:e instanceof Error?e.message:'Worker unavailable'})}}
