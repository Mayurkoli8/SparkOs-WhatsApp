'use client';

import { bytes, call, duration, when, type PendingSync, type Run, type SystemInfo } from './shared';

// The worker machine at a glance, and the WhatsApp messages waiting to be synced into HighLevel.
export function SystemPanel({ system, pending, run }: { system?: SystemInfo; pending?: PendingSync; run: Run }) {
  if (!system) return null;
  const { host, disk, memory, sessions } = system;
  const memoryLow = host.freeMemBytes < 100 * 1024 ** 2 || host.freeMemBytes / host.totalMemBytes < 0.05;
  const diskLow = disk ? disk.freeBytes < 1024 ** 3 : false;

  return (
    <section className="panel">
      <div className="panelhead">
        <h2>System</h2>
        <span>
          worker up {duration(system.uptimeSeconds)} · Node {system.node}
        </span>
      </div>
      <div className="sys">
        <div>
          <b>
            {sessions.live}
            <small>/{sessions.total}</small>
          </b>
          <span>WhatsApp sessions online</span>
        </div>
        <div className={memoryLow ? 'low' : ''}>
          <b>{bytes(memory.rssBytes)}</b>
          <span>
            worker memory · {bytes(host.freeMemBytes)} of {bytes(host.totalMemBytes)} available
          </span>
        </div>
        <div className={diskLow ? 'low' : ''}>
          <b>{disk ? bytes(disk.freeBytes) : 'n/a'}</b>
          <span>disk free{disk ? ` of ${bytes(disk.totalBytes)}` : ''}</span>
        </div>
        <div className={pending?.count ? 'low' : ''}>
          <b>{pending?.count ?? 0}</b>
          <span>messages waiting to sync</span>
        </div>
      </div>
      {pending && pending.count > 0 && (
        <>
          <div className="row-actions">
            <button className="primary small" onClick={() => void run(() => call('/api/admin/sync', 'POST'))}>
              Retry now
            </button>
            <span className="muted">Waiting since {pending.oldestAt ? when(pending.oldestAt) : 'now'}. They are retried automatically for up to a day.</span>
          </div>
          <div className="events">
            {pending.items.map((item, i) => (
              <div className="event lvl-warn" key={i}>
                <time>next try {when(item.nextAt)}</time>
                <div>
                  <div>
                    #{item.slot} {item.direction === 'inbound' ? 'from' : 'to'} {item.phone} · {item.attempts} attempt{item.attempts === 1 ? '' : 's'}
                  </div>
                  <div className="detail">{item.lastError}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
