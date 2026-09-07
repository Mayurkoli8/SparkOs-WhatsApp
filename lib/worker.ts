export async function workerFetch(path: string, init?: RequestInit) {
  const base = process.env.WORKER_URL;
  const key = process.env.WORKER_API_KEY;
  if (!base || !key) throw new Error('WORKER_URL and WORKER_API_KEY are required');
  return fetch(`${base.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), 'content-type': 'application/json', 'x-internal-api-key': key }
  });
}
