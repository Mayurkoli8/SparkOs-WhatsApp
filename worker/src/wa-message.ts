import { isLidUser, isPnUser, jidDecode, normalizeMessageContent, WAMessageStatus, type proto } from '@whiskeysockets/baileys';
import type { GhlStatus } from './ghl';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';
export type MediaInfo = { kind: MediaKind; mimetype: string; fileName?: string; size?: number; voiceNote: boolean };
export type ExtractedContent = { text: string; media?: MediaInfo };
type ChatKey = { remoteJid?: string | null; remoteJidAlt?: string; fromMe?: boolean | null };

export function isDirectChatJid(jid: string | null | undefined): jid is string {
  return Boolean(jid && (isPnUser(jid) || isLidUser(jid)));
}

function userPart(jid: string | null | undefined) {
  return (jid && jidDecode(jid)?.user) || null;
}

// WhatsApp now addresses many chats by LID (a privacy id, "...@lid") instead of the phone number.
// For incoming messages Baileys puts the sender's phone JID in remoteJidAlt; for messages typed on our own
// phone remoteJidAlt is *our* alternate id, so the contact's number has to come from the LID mapping store.
export async function resolvePhone(key: ChatKey, lookupPnForLid: (lid: string) => Promise<string | null | undefined>) {
  const jid = key.remoteJid;
  if (!jid) return null;
  if (isPnUser(jid)) return userPart(jid);
  if (!isLidUser(jid)) return null;
  if (!key.fromMe && key.remoteJidAlt && isPnUser(key.remoteJidAlt)) return userPart(key.remoteJidAlt);
  try {
    const pn = await lookupPnForLid(jid);
    return pn && isPnUser(pn) ? userPart(pn) : null;
  } catch {
    return null;
  }
}

// Protobuf decodes fileLength as a Long object rather than a number.
function toNumber(value: unknown) {
  if (value == null) return undefined;
  if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') return (value as { toNumber: () => number }).toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function media(kind: MediaKind, message: { mimetype?: string | null; fileLength?: unknown; fileName?: string | null }, fallbackMime: string, voiceNote = false): MediaInfo {
  return { kind, mimetype: message.mimetype || fallbackMime, fileName: message.fileName || undefined, size: toNumber(message.fileLength), voiceNote };
}

function vcardPhones(vcard?: string | null) {
  return [...(vcard || '').matchAll(/TEL[^:]*:([^\n\r]+)/g)].map(m => m[1].trim()).filter(Boolean);
}

export function extractContent(message: proto.IMessage | null | undefined): ExtractedContent | null {
  const m = normalizeMessageContent(message);
  if (!m) return null;
  if (m.conversation) return { text: m.conversation };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text };
  if (m.imageMessage) return { text: m.imageMessage.caption || '', media: media('image', m.imageMessage, 'image/jpeg') };
  if (m.videoMessage) return { text: m.videoMessage.caption || '', media: media('video', m.videoMessage, 'video/mp4') };
  if (m.audioMessage) return { text: '', media: media('audio', m.audioMessage, 'audio/ogg', Boolean(m.audioMessage.ptt)) };
  if (m.documentMessage) return { text: m.documentMessage.caption || '', media: media('document', m.documentMessage, 'application/octet-stream') };
  if (m.stickerMessage) return { text: '', media: media('sticker', m.stickerMessage, 'image/webp') };
  const location = m.locationMessage || m.liveLocationMessage;
  if (location) {
    const place = 'name' in location ? [location.name, location.address].filter(Boolean).join(', ') : '';
    const coords = `${location.degreesLatitude},${location.degreesLongitude}`;
    return { text: `📍 Location${place ? `: ${place}` : ''}\nhttps://maps.google.com/?q=${coords}` };
  }
  if (m.contactMessage) {
    const phones = vcardPhones(m.contactMessage.vcard);
    return { text: `👤 Contact: ${m.contactMessage.displayName || 'Unnamed'}${phones.length ? ` (${phones.join(', ')})` : ''}` };
  }
  if (m.contactsArrayMessage?.contacts?.length) {
    const names = m.contactsArrayMessage.contacts.map(c => c.displayName || 'Unnamed').join(', ');
    return { text: `👤 Contacts: ${names}` };
  }
  const reply =
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.interactiveResponseMessage?.body?.text;
  if (reply) return { text: reply };
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
  if (poll?.name) return { text: `📊 Poll: ${poll.name}` };
  return null;
}

export function mediaLabel(info: MediaInfo) {
  switch (info.kind) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'audio':
      return info.voiceNote ? '🎤 Voice message' : '🎵 Audio';
    case 'document':
      return `📄 ${info.fileName || 'Document'}`;
    case 'sticker':
      return '💬 Sticker';
  }
}

export function ghlStatusFromWa(status: number | null | undefined): Exclude<GhlStatus, 'pending'> | null {
  switch (status) {
    case WAMessageStatus.DELIVERY_ACK:
      return 'delivered';
    case WAMessageStatus.READ:
    case WAMessageStatus.PLAYED:
      return 'read';
    case WAMessageStatus.ERROR:
      return 'failed';
    default:
      return null;
  }
}

const STATUS_RANK: Record<GhlStatus, number> = { pending: 0, delivered: 1, read: 2, failed: 1 };

export function shouldAdvanceStatus(current: GhlStatus | undefined, next: GhlStatus) {
  if (!current) return true;
  if (next === 'failed') return current === 'pending';
  if (current === 'failed') return false;
  return STATUS_RANK[next] > STATUS_RANK[current];
}

const EXTENSION_KINDS: Record<string, Exclude<MediaKind, 'sticker'>> = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  mp4: 'video', mov: 'video', '3gp': 'video', mpeg: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio'
};

export function attachmentKind(url: string, contentType?: string | null): Exclude<MediaKind, 'sticker'> {
  const type = (contentType || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  let ext = '';
  try {
    ext = new URL(url).pathname.split('.').pop()?.toLowerCase() || '';
  } catch {
    // not a URL; treat as a document
  }
  return EXTENSION_KINDS[ext] || 'document';
}

export function fileNameFromUrl(url: string, fallback = 'attachment') {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name || fallback;
  } catch {
    return fallback;
  }
}
