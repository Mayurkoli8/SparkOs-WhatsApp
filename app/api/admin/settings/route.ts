import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { forwardToWorker } from '@/lib/admin-proxy';

// Bridge-wide settings: protection defaults, failover wait, gap between messages, number limit, alert webhook.
export async function GET(req: Request) {
  if (!isAdminRequest(req)) return signInRequired();
  return forwardToWorker('/settings');
}

export async function PUT(req: Request) {
  if (!isAdminRequest(req)) return signInRequired();
  return forwardToWorker('/settings', { method: 'PUT', body: (await req.text()) || '{}' });
}

// Sends a test alert to the saved webhook.
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return signInRequired();
  return forwardToWorker('/settings/test-alert', { method: 'POST', body: '{}' });
}
