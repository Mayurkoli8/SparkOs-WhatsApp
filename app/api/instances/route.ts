import { NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';
export async function GET(){try{const r=await workerFetch('/instances');return new NextResponse(await r.text(),{status:r.status,headers:{'content-type':'application/json'}})}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Worker unavailable'},{status:500})}}
export async function POST(req:Request){try{const b=await req.text();const r=await workerFetch('/instances',{method:'POST',body:b});return new NextResponse(await r.text(),{status:r.status,headers:{'content-type':'application/json'}})}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Worker unavailable'},{status:500})}}
