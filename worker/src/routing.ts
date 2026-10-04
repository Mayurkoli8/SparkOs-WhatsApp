// Which of a sub-account's WhatsApp numbers sends an outgoing message:
// a {WA#2} / {WA:Sales} / {WA:+91…} token in the message, then the contact's "wa: +number" tag,
// then the number of the HighLevel user the contact is assigned to, then the number of the user who sent it,
// then the sub-account's default number, then the remaining numbers by slot.

export type RouteNumber = { id: string; slot: number; name: string; phone?: string | null; isDefault: boolean; assignedUserId?: string | null };
export type RouteHints = { token?: RouteToken | null; taggedPhone?: string | null; assignedUserId?: string | null; senderUserId?: string | null };
export type RouteToken = { kind: 'slot' | 'name' | 'phone'; value: string };

const TOKEN = /\{\s*wa\s*(?:#\s*(\d+)|:\s*([^}]+?))\s*\}/i;
const WA_TAG = /^\s*wa:\s*\+?(\d{6,15})\s*$/i;

export function parseRouteToken(message: string): { token: RouteToken | null; text: string } {
  const match = TOKEN.exec(message);
  if (!match) return { token: null, text: message };
  const text = `${message.slice(0, match.index)} ${message.slice(match.index + match[0].length)}`.replace(/[ \t]{2,}/g, ' ').trim();
  if (match[1]) return { token: { kind: 'slot', value: match[1] }, text };
  const raw = match[2].trim();
  const digits = raw.replace(/[\s()+-]/g, '');
  const token: RouteToken = /^[+\d\s()-]+$/.test(raw) && /^\d{6,15}$/.test(digits) ? { kind: 'phone', value: digits } : { kind: 'name', value: raw };
  return { token, text };
}

export function formatWaTag(phone: string) {
  return `wa: +${phone.replace(/\D/g, '')}`;
}

export function isWaTag(tag: string) {
  return /^\s*wa:/i.test(tag);
}

export function parseWaTag(tags: readonly string[] | null | undefined): string | null {
  for (const tag of tags ?? []) {
    const match = WA_TAG.exec(tag);
    if (match) return match[1];
  }
  return null;
}

function describe(token: RouteToken) {
  return token.kind === 'slot' ? `#${token.value}` : token.kind === 'phone' ? `+${token.value}` : `"${token.value}"`;
}

function matches(number: RouteNumber, token: RouteToken) {
  if (token.kind === 'slot') return number.slot === Number(token.value);
  if (token.kind === 'phone') return number.phone === token.value;
  return number.name.trim().toLowerCase() === token.value.trim().toLowerCase();
}

// Ordered candidates: the preferred number first, then the default, then the rest by slot.
export function routeCandidates<T extends RouteNumber>(numbers: T[], opts: RouteHints): T[] {
  const bySlot = [...numbers].sort((a, b) => a.slot - b.slot);
  const fallback = [...bySlot.filter(n => n.isDefault), ...bySlot.filter(n => !n.isDefault)];
  const ownedBy = (userId?: string | null) => (userId ? fallback.find(n => n.assignedUserId === userId) : undefined);
  let preferred: T | undefined;
  if (opts.token) {
    preferred = bySlot.find(n => matches(n, opts.token!));
    if (!preferred) throw new Error(`No WhatsApp number ${describe(opts.token)} in this sub-account`);
  }
  preferred ??= (opts.taggedPhone ? bySlot.find(n => n.phone === opts.taggedPhone) : undefined) ?? ownedBy(opts.assignedUserId) ?? ownedBy(opts.senderUserId);
  return preferred ? [preferred, ...fallback.filter(n => n !== preferred)] : fallback;
}
