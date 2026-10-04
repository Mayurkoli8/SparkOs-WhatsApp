'use client';

import { useCallback, useEffect, useState } from 'react';
import { PolicyFields } from './PolicyFields';
import { call, day, when, type NumberInfo, type Policy, type Run } from './shared';

type User = { id: string; name: string; email?: string };

// Everything the admin can change on one number: its contact owner, its protection rules and warm-up, a WhatsApp
// restriction, and a test send.
export function NumberControls({ n, defaults, run }: { n: NumberInfo; defaults: Policy; run: Run }) {
  return (
    <div className="manage">
      <ProtectionBox n={n} defaults={defaults} run={run} />
      <div className="manage-side">
        <OwnerBox n={n} run={run} />
        <TestSend n={n} run={run} />
      </div>
    </div>
  );
}

function ProtectionBox({ n, defaults, run }: { n: NumberInfo; defaults: Policy; run: Run }) {
  const [note, setNote] = useState('');
  const p = n.protection;
  const url = `/api/instances/${encodeURIComponent(n.id)}`;
  const patch = (body: object) => run(() => call(url, 'PATCH', body));
  const hasOverrides = Object.keys(n.overrides).length > 0;

  async function toggle() {
    if (p.enabled && !confirm(`Turn protection off for #${n.slot} ${n.name}?\n\nIt will start new chats without a daily limit or warm-up. A WhatsApp restriction still pauses new chats.`)) return;
    // Matching the default again means following it again (null), so a later change of the default applies here too.
    const next = !p.enabled;
    await patch({ protection: { enabled: next === defaults.enabled ? null : next } });
  }

  async function clearRestriction() {
    const result = (await patch({ clearRestriction: true })) as { restriction?: { checked: boolean; restrictedUntil?: number | null; error?: string } } | undefined;
    const r = result?.restriction;
    setNote(
      !r
        ? ''
        : r.checked
          ? r.restrictedUntil
            ? `WhatsApp still restricts this number until ${when(r.restrictedUntil)}.`
            : 'WhatsApp reports no restriction. New chats are allowed again.'
          : `Cleared. WhatsApp could not be asked right now${r.error ? ` (${r.error})` : ' (the number is offline)'}; a new restriction is detected on the next send.`
    );
  }

  return (
    <div className="box">
      <h3>Warm-up and limits</h3>
      <div className="pstatus">
        {!n.linkedAt ? (
          <div>Not linked yet. The warm-up starts when the number is linked.</div>
        ) : !p.enabled ? (
          <div className="warnText">Protection is off: no daily limit and no warm-up for this number.</div>
        ) : p.warmingUp ? (
          <div>
            <b>Warming up</b>: day {p.warmupDay} of {p.warmupDays}, ends {p.warmupEndsAt ? day(p.warmupEndsAt) : 'soon'}.
          </div>
        ) : (
          <div>{p.warmupDays ? 'Warm-up finished.' : 'No warm-up for this number.'}</div>
        )}
        <div>
          {p.newChatsToday} {p.newChatLimit === null ? 'new chats in the last 24 hours (no limit)' : `of ${p.newChatLimit} new chats used in the last 24 hours`}. People who
          wrote first can always be answered.
        </div>
      </div>
      {p.restricted && n.restrictedUntil && (
        <div className="restricted">
          Restricted by WhatsApp until {when(n.restrictedUntil)}: new chats are paused, existing chats keep working.
          <div className="row-actions">
            <button className="ghost small" onClick={() => void clearRestriction()}>
              Clear and check with WhatsApp
            </button>
          </div>
        </div>
      )}
      {note && <div className="note">{note}</div>}
      <div className="row-actions">
        <button className={p.enabled ? 'ghost small' : 'primary small'} onClick={() => void toggle()}>
          {p.enabled ? 'Turn protection off' : 'Turn protection on'}
        </button>
        {p.warmingUp && (
          <button className="ghost small" onClick={() => void patch({ protection: { warmupDays: 0 } })}>
            Skip warm-up
          </button>
        )}
        {n.linkedAt && (
          <button className="ghost small" onClick={() => confirm(`Start the warm-up of #${n.slot} again from today?`) && void patch({ warmup: 'restart' })}>
            Restart warm-up
          </button>
        )}
        {hasOverrides && (
          <button
            className="ghost small"
            onClick={() =>
              void patch({ protection: { enabled: null, warmupDays: null, warmupNewChatsPerDay: null, newChatsPerDay: null, coldMessagesPerContact: null } })
            }
          >
            Use defaults
          </button>
        )}
      </div>
      <PolicyFields saved={n.overrides} fallback={defaults} onSave={fields => patch({ protection: fields })} />
    </div>
  );
}

function OwnerBox({ n, run }: { n: NumberInfo; run: Run }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [problem, setProblem] = useState('');
  const [choice, setChoice] = useState(n.assignedUserId ?? '');
  const [manual, setManual] = useState('');
  const [mode, setMode] = useState(n.assignMode);

  const load = useCallback(
    async (refresh = false) => {
      try {
        const data = await call(`/api/admin/users?locationId=${encodeURIComponent(n.locationId)}${refresh ? '&refresh=1' : ''}`, 'GET');
        setUsers(data.users ?? []);
        setProblem(data.error ?? '');
      } catch (e) {
        setUsers([]);
        setProblem(e instanceof Error ? e.message : 'Could not load the users');
      }
    },
    [n.locationId]
  );
  useEffect(() => void load(), [load]);

  const list = users ?? [];
  const unlisted = n.assignedUserId && !list.some(u => u.id === n.assignedUserId);
  const pickedId = choice === '__manual' ? manual.trim() : choice;
  const changed = pickedId !== (n.assignedUserId ?? '') || mode !== n.assignMode;

  async function save() {
    const name = list.find(u => u.id === pickedId)?.name ?? (pickedId === n.assignedUserId ? n.assignedUserName : null);
    await run(() => call(`/api/instances/${encodeURIComponent(n.id)}`, 'PATCH', { assignedUserId: pickedId || null, assignedUserName: name, assignMode: mode }));
    if (choice === '__manual') setChoice(pickedId);
  }

  return (
    <div className="box">
      <h3>Contact owner</h3>
      <p className="muted">Contacts who talk to this number are assigned to this HighLevel user, and messages to that user’s contacts go out from it.</p>
      <select className="input" value={choice} onChange={e => setChoice(e.target.value)} disabled={users === null}>
        <option value="">{users === null ? 'Loading users…' : 'Nobody (do not assign)'}</option>
        {list.map(u => (
          <option key={u.id} value={u.id}>
            {u.name}
            {u.email ? ` (${u.email})` : ''}
          </option>
        ))}
        {unlisted && <option value={n.assignedUserId!}>{n.assignedUserName || n.assignedUserId}</option>}
        <option value="__manual">Paste a user ID…</option>
      </select>
      {choice === '__manual' && <input className="input spaced" placeholder="HighLevel user ID" value={manual} onChange={e => setManual(e.target.value)} />}
      {pickedId && (
        <div className="radios">
          <label>
            <input type="radio" checked={mode === 'unassigned'} onChange={() => setMode('unassigned')} /> Only contacts without an owner
          </label>
          <label>
            <input type="radio" checked={mode === 'always'} onChange={() => setMode('always')} /> Every contact, even if another user owns them
          </label>
        </div>
      )}
      {problem && <div className="note warnText">{problem}</div>}
      <div className="row-actions">
        <button className="primary small" disabled={!changed || (choice === '__manual' && !manual.trim())} onClick={() => void save()}>
          Save owner
        </button>
        <button className="ghost small" onClick={() => void load(true)}>
          Reload users
        </button>
      </div>
    </div>
  );
}

function TestSend({ n, run }: { n: NumberInfo; run: Run }) {
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [sent, setSent] = useState('');
  const live = n.status === 'connected';

  async function send() {
    setSent('');
    const result = await run(() => call(`/api/instances/${encodeURIComponent(n.id)}/send`, 'POST', { to, text }));
    if (result) setSent(`Sent to +${to.replace(/\D/g, '')}.`);
  }

  return (
    <div className="box">
      <h3>Send a test message</h3>
      <input className="input" placeholder="Phone with country code, e.g. 919876543210" value={to} onChange={e => setTo(e.target.value)} />
      <input className="input spaced" placeholder="Message" value={text} maxLength={1000} onChange={e => setText(e.target.value)} />
      <div className="row-actions">
        <button className="secondary small" disabled={!live || !to.trim() || !text.trim()} onClick={() => void send()}>
          Send
        </button>
        <span className="muted">{live ? 'Counts as a normal message: the limits above apply.' : 'Connect the number first.'}</span>
      </div>
      {sent && <div className="note">{sent}</div>}
    </div>
  );
}
