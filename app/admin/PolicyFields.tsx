'use client';

import { useEffect, useState } from 'react';
import type { Policy } from './shared';

type Field = Exclude<keyof Policy, 'enabled'>;
const FIELDS: { key: Field; label: string; min: number; max: number }[] = [
  { key: 'warmupDays', label: 'Warm-up days (0 = none)', min: 0, max: 90 },
  { key: 'warmupNewChatsPerDay', label: 'New chats a day while warming up', min: 0, max: 1000 },
  { key: 'newChatsPerDay', label: 'New chats a day after warm-up', min: 0, max: 1000 },
  { key: 'coldMessagesPerContact', label: 'Messages to someone who has not replied', min: 1, max: 50 }
];

const asText = (saved: Partial<Policy>) => Object.fromEntries(FIELDS.map(f => [f.key, saved[f.key] != null ? String(saved[f.key]) : ''])) as Record<Field, string>;

// The four protection numbers. An empty box follows the default shown as its placeholder.
export function PolicyFields({ saved, fallback, onSave }: { saved: Partial<Policy>; fallback: Policy; onSave: (patch: Record<Field, number | null>) => Promise<unknown> }) {
  const savedKey = JSON.stringify(saved);
  const [values, setValues] = useState(() => asText(saved));
  // Keep what the admin is typing while the dashboard refreshes; reset only when the saved values change.
  useEffect(() => setValues(asText(JSON.parse(savedKey))), [savedKey]);
  const original = asText(saved);
  const dirty = FIELDS.some(f => values[f.key] !== original[f.key]);

  return (
    <div className="policy">
      <div className="policy-grid">
        {FIELDS.map(f => (
          <label key={f.key} className="pfield">
            <span>{f.label}</span>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={f.min}
              max={f.max}
              value={values[f.key]}
              placeholder={`${fallback[f.key]} (default)`}
              onChange={e => setValues({ ...values, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="row-actions">
        <button
          className="primary small"
          disabled={!dirty}
          onClick={() => void onSave(Object.fromEntries(FIELDS.map(f => [f.key, values[f.key].trim() === '' ? null : Number(values[f.key])])) as Record<Field, number | null>)}
        >
          Save limits
        </button>
        {dirty && (
          <button className="ghost small" onClick={() => setValues(original)}>
            Undo
          </button>
        )}
        <span className="muted">Leave a box empty to use the default.</span>
      </div>
    </div>
  );
}
