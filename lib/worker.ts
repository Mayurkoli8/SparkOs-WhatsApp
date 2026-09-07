export function workerUrl() {
  const value = process.env.WORKER_URL?.trim();
  if (!value) throw new Error('WORKER_URL is required');
  return `${/^https?:\/\//i.test(value) ? value : `https://${value}`}`.replace(/\/$/, '');
}

export async function workerFetch(path: string, init?: RequestInit) {
  const key = process.env.WORKER_API_KEY;
  if (!key) throw new Error('WORKER_URL and WORKER_API_KEY are required');
  return fetch(`${workerUrl()}${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), 'content-type': 'application/json', 'x-internal-api-key': key }
  });
}
