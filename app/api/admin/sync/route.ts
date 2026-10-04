import { isAdminRequest, signInRequired } from '@/lib/admin-auth';
import { forwardToWorker } from '@/lib/admin-proxy';

// Retry every WhatsApp message that is waiting to be synced into HighLevel, now.
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return signInRequired();
  return forwardToWorker('/sync/retry', { method: 'POST', body: '{}' });
}
