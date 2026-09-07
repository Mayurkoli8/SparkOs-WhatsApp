import { NextResponse } from 'next/server';
import { workerFetch } from '@/lib/worker';
type C={params:Promise<{id:string}>};
export async function GET(_req:Request,{params}:C){const {id}=await params;const r=await workerFetch(`/instances/${id}`);return new NextResponse(await r.text(),{status:r.status,headers:{'content-type':'application/json'}})}
export async function POST(_req:Request,{params}:C){const {id}=await params;const r=await workerFetch(`/instances/${id}/restart`,{method:'POST',body:'{}'});return new NextResponse(await r.text(),{status:r.status,headers:{'content-type':'application/json'}})}
export async function DELETE(_req:Request,{params}:C){const {id}=await params;const r=await workerFetch(`/instances/${id}`,{method:'DELETE'});return new NextResponse(await r.text(),{status:r.status,headers:{'content-type':'application/json'}})}
