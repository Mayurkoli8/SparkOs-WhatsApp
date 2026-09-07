import { NextRequest,NextResponse } from 'next/server';
export async function GET(req:NextRequest){
  const base=process.env.GHL_INSTALL_URL;if(!base)return NextResponse.json({error:'Set GHL_INSTALL_URL in Vercel.'},{status:500});
  const target=req.nextUrl.searchParams.get('locationId');const url=new URL(base);
  const response=NextResponse.redirect(url.toString());
  if(target){response.cookies.set('ghl_location_id',target,{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:600});}
  return response;
}
