"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDirectChatJid = isDirectChatJid;
exports.resolvePhone = resolvePhone;
exports.extractContent = extractContent;
exports.mediaLabel = mediaLabel;
exports.ghlStatusFromWa = ghlStatusFromWa;
exports.shouldAdvanceStatus = shouldAdvanceStatus;
exports.attachmentKind = attachmentKind;
exports.fileNameFromUrl = fileNameFromUrl;
exports.serializeMessage = serializeMessage;
exports.deserializeMessage = deserializeMessage;
const baileys_1 = require("@whiskeysockets/baileys");
function isDirectChatJid(jid) {
    return Boolean(jid && ((0, baileys_1.isPnUser)(jid) || (0, baileys_1.isLidUser)(jid)));
}
function userPart(jid) {
    return (jid && (0, baileys_1.jidDecode)(jid)?.user) || null;
}
// WhatsApp now addresses many chats by LID (a privacy id, "...@lid") instead of the phone number.
// For incoming messages Baileys puts the sender's phone JID in remoteJidAlt; for messages typed on our own
// phone remoteJidAlt is *our* alternate id, so the contact's number has to come from the LID mapping store.
async function resolvePhone(key, lookupPnForLid) {
    const jid = key.remoteJid;
    if (!jid)
        return null;
    if ((0, baileys_1.isPnUser)(jid))
        return userPart(jid);
    if (!(0, baileys_1.isLidUser)(jid))
        return null;
    if (!key.fromMe && key.remoteJidAlt && (0, baileys_1.isPnUser)(key.remoteJidAlt))
        return userPart(key.remoteJidAlt);
    try {
        const pn = await lookupPnForLid(jid);
        return pn && (0, baileys_1.isPnUser)(pn) ? userPart(pn) : null;
    }
    catch {
        return null;
    }
}
// Protobuf decodes fileLength as a Long object rather than a number.
function toNumber(value) {
    if (value == null)
        return undefined;
    if (typeof value === 'object' && typeof value.toNumber === 'function')
        return value.toNumber();
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
function media(kind, message, fallbackMime, voiceNote = false) {
    return { kind, mimetype: message.mimetype || fallbackMime, fileName: message.fileName || undefined, size: toNumber(message.fileLength), voiceNote };
}
function vcardPhones(vcard) {
    return [...(vcard || '').matchAll(/TEL[^:]*:([^\n\r]+)/g)].map(m => m[1].trim()).filter(Boolean);
}
function extractContent(message) {
    const m = (0, baileys_1.normalizeMessageContent)(message);
    if (!m)
        return null;
    if (m.conversation)
        return { text: m.conversation };
    if (m.extendedTextMessage?.text)
        return { text: m.extendedTextMessage.text };
    if (m.imageMessage)
        return { text: m.imageMessage.caption || '', media: media('image', m.imageMessage, 'image/jpeg') };
    if (m.videoMessage)
        return { text: m.videoMessage.caption || '', media: media('video', m.videoMessage, 'video/mp4') };
    if (m.audioMessage)
        return { text: '', media: media('audio', m.audioMessage, 'audio/ogg', Boolean(m.audioMessage.ptt)) };
    if (m.documentMessage)
        return { text: m.documentMessage.caption || '', media: media('document', m.documentMessage, 'application/octet-stream') };
    if (m.stickerMessage)
        return { text: '', media: media('sticker', m.stickerMessage, 'image/webp') };
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
    const reply = m.buttonsResponseMessage?.selectedDisplayText ||
        m.listResponseMessage?.title ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        m.interactiveResponseMessage?.body?.text;
    if (reply)
        return { text: reply };
    const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
    if (poll?.name)
        return { text: `📊 Poll: ${poll.name}` };
    return null;
}
function mediaLabel(info) {
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
function ghlStatusFromWa(status) {
    switch (status) {
        case baileys_1.WAMessageStatus.DELIVERY_ACK:
            return 'delivered';
        case baileys_1.WAMessageStatus.READ:
        case baileys_1.WAMessageStatus.PLAYED:
            return 'read';
        case baileys_1.WAMessageStatus.ERROR:
            return 'failed';
        default:
            return null;
    }
}
const STATUS_RANK = { pending: 0, delivered: 1, read: 2, failed: 1 };
function shouldAdvanceStatus(current, next) {
    if (!current)
        return true;
    if (next === 'failed')
        return current === 'pending';
    if (current === 'failed')
        return false;
    return STATUS_RANK[next] > STATUS_RANK[current];
}
const EXTENSION_KINDS = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
    mp4: 'video', mov: 'video', '3gp': 'video', mpeg: 'video',
    mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio'
};
function attachmentKind(url, contentType) {
    const type = (contentType || '').toLowerCase();
    if (type.startsWith('image/'))
        return 'image';
    if (type.startsWith('video/'))
        return 'video';
    if (type.startsWith('audio/'))
        return 'audio';
    let ext = '';
    try {
        ext = new URL(url).pathname.split('.').pop()?.toLowerCase() || '';
    }
    catch {
        // not a URL; treat as a document
    }
    return EXTENSION_KINDS[ext] || 'document';
}
function fileNameFromUrl(url, fallback = 'attachment') {
    try {
        const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
        return name || fallback;
    }
    catch {
        return fallback;
    }
}
// A WhatsApp message as JSON for the retry queue on disk: bytes as base64, 64-bit numbers as plain numbers, and
// preview thumbnails dropped (the media itself is downloaded again from WhatsApp when the retry runs).
function serializeMessage(msg) {
    return JSON.stringify({ key: msg.key, message: msg.message, pushName: msg.pushName ?? null }, (key, value) => {
        if (key === 'jpegThumbnail')
            return undefined;
        if (value && typeof value === 'object' && 'low' in value && typeof value.toNumber === 'function')
            return value.toNumber();
        return baileys_1.BufferJSON.replacer(key, value);
    });
}
function deserializeMessage(raw) {
    return JSON.parse(raw, baileys_1.BufferJSON.reviver);
}
