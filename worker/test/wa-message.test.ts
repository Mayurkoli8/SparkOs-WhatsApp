import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentKind,
  deserializeMessage,
  extractContent,
  ghlStatusFromWa,
  isDirectChatJid,
  mediaLabel,
  serializeMessage,
  resolvePhone,
  shouldAdvanceStatus
} from '../src/wa-message';

const noMapping = async () => null;

test('resolvePhone returns the number for phone-number (PN) chats', async () => {
  assert.equal(await resolvePhone({ remoteJid: '919876543210@s.whatsapp.net', fromMe: false }, noMapping), '919876543210');
});

test('resolvePhone uses remoteJidAlt for incoming messages in LID chats', async () => {
  const key = { remoteJid: '123456789012345@lid', remoteJidAlt: '919876543210@s.whatsapp.net', fromMe: false };
  assert.equal(await resolvePhone(key, noMapping), '919876543210');
});

test('resolvePhone ignores remoteJidAlt for phone-sent messages (it is our own number) and uses the LID mapping', async () => {
  const key = { remoteJid: '123456789012345@lid', remoteJidAlt: '911111111111@s.whatsapp.net', fromMe: true };
  const lookup = async (lid: string) => (lid === '123456789012345@lid' ? '919876543210:3@s.whatsapp.net' : null);
  assert.equal(await resolvePhone(key, lookup), '919876543210');
});

test('resolvePhone falls back to the LID mapping when remoteJidAlt is missing', async () => {
  const lookup = async () => '447700900123@s.whatsapp.net';
  assert.equal(await resolvePhone({ remoteJid: '99887766554433@lid', fromMe: false }, lookup), '447700900123');
});

test('resolvePhone returns null when a LID cannot be mapped, never the LID digits', async () => {
  assert.equal(await resolvePhone({ remoteJid: '99887766554433@lid', fromMe: false }, noMapping), null);
  const failing = async () => { throw new Error('store unavailable'); };
  assert.equal(await resolvePhone({ remoteJid: '99887766554433@lid', fromMe: false }, failing), null);
});

test('isDirectChatJid only accepts 1:1 chats', () => {
  assert.equal(isDirectChatJid('919876543210@s.whatsapp.net'), true);
  assert.equal(isDirectChatJid('123456789012345@lid'), true);
  assert.equal(isDirectChatJid('120363025246125244@g.us'), false);
  assert.equal(isDirectChatJid('status@broadcast'), false);
  assert.equal(isDirectChatJid('120363144038483540@newsletter'), false);
  assert.equal(isDirectChatJid(undefined), false);
});

test('extractContent reads plain and extended text', () => {
  assert.deepEqual(extractContent({ conversation: 'hello' }), { text: 'hello' });
  assert.deepEqual(extractContent({ extendedTextMessage: { text: 'see https://x.y' } }), { text: 'see https://x.y' });
});

test('extractContent unwraps ephemeral and view-once wrappers', () => {
  assert.deepEqual(extractContent({ ephemeralMessage: { message: { conversation: 'disappearing' } } }), { text: 'disappearing' });
  const viewOnce = extractContent({ viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg', caption: 'once' } } } });
  assert.equal(viewOnce?.text, 'once');
  assert.equal(viewOnce?.media?.kind, 'image');
});

test('extractContent describes media messages', () => {
  const image = extractContent({ imageMessage: { mimetype: 'image/jpeg', caption: 'look' } });
  assert.deepEqual(image, { text: 'look', media: { kind: 'image', mimetype: 'image/jpeg', fileName: undefined, size: undefined, voiceNote: false } });

  const voice = extractContent({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, fileLength: 2048 } });
  assert.equal(voice?.text, '');
  assert.equal(voice?.media?.kind, 'audio');
  assert.equal(voice?.media?.voiceNote, true);
  assert.equal(voice?.media?.size, 2048);

  const doc = extractContent({ documentMessage: { mimetype: 'application/pdf', fileName: 'quote.pdf' } });
  assert.equal(doc?.media?.kind, 'document');
  assert.equal(doc?.media?.fileName, 'quote.pdf');
});

test('extractContent turns locations and contact cards into text', () => {
  const location = extractContent({ locationMessage: { degreesLatitude: 19.07, degreesLongitude: 72.87, name: 'Office' } });
  assert.match(location!.text, /Office/);
  assert.match(location!.text, /19\.07,72\.87/);
  const contact = extractContent({ contactMessage: { displayName: 'Asha', vcard: 'BEGIN:VCARD\nTEL;type=CELL:+91 98765 43210\nEND:VCARD' } });
  assert.match(contact!.text, /Asha/);
  assert.match(contact!.text, /\+91 98765 43210/);
});

test('extractContent ignores reactions, protocol messages and empty payloads', () => {
  assert.equal(extractContent({ reactionMessage: { text: '👍' } }), null);
  assert.equal(extractContent({ protocolMessage: { type: 0 } }), null);
  assert.equal(extractContent(undefined), null);
  assert.equal(extractContent({}), null);
});

test('mediaLabel gives a readable placeholder', () => {
  assert.equal(mediaLabel({ kind: 'audio', mimetype: 'audio/ogg', voiceNote: true }), '🎤 Voice message');
  assert.equal(mediaLabel({ kind: 'document', mimetype: 'application/pdf', fileName: 'a.pdf', voiceNote: false }), '📄 a.pdf');
});

test('ghlStatusFromWa maps Baileys numeric receipt statuses', () => {
  assert.equal(ghlStatusFromWa(3), 'delivered'); // DELIVERY_ACK
  assert.equal(ghlStatusFromWa(4), 'read'); // READ
  assert.equal(ghlStatusFromWa(5), 'read'); // PLAYED
  assert.equal(ghlStatusFromWa(0), 'failed'); // ERROR
  assert.equal(ghlStatusFromWa(1), null); // PENDING
  assert.equal(ghlStatusFromWa(2), null); // SERVER_ACK
  assert.equal(ghlStatusFromWa(undefined), null);
});

test('shouldAdvanceStatus never moves a message backwards', () => {
  assert.equal(shouldAdvanceStatus(undefined, 'delivered'), true);
  assert.equal(shouldAdvanceStatus('delivered', 'read'), true);
  assert.equal(shouldAdvanceStatus('read', 'delivered'), false);
  assert.equal(shouldAdvanceStatus('delivered', 'delivered'), false);
  assert.equal(shouldAdvanceStatus('read', 'failed'), false);
  assert.equal(shouldAdvanceStatus(undefined, 'failed'), true);
});

test('attachmentKind picks a WhatsApp media type from the URL or content type', () => {
  assert.equal(attachmentKind('https://cdn.x/a/photo.JPG?x=1'), 'image');
  assert.equal(attachmentKind('https://cdn.x/clip.mp4'), 'video');
  assert.equal(attachmentKind('https://cdn.x/song.mp3'), 'audio');
  assert.equal(attachmentKind('https://cdn.x/file.pdf'), 'document');
  assert.equal(attachmentKind('https://cdn.x/download', 'image/png'), 'image');
  assert.equal(attachmentKind('https://cdn.x/download'), 'document');
});

test('messages survive the retry queue on disk: keys, bytes and 64-bit sizes, without thumbnails', () => {
  const fileLength = { low: 2048, high: 0, unsigned: true, toNumber: () => 2048 };
  const msg = {
    key: { id: 'WA1', remoteJid: '123@lid', fromMe: false, remoteJidAlt: '919876543210@s.whatsapp.net' },
    pushName: 'Asha',
    message: { imageMessage: { mimetype: 'image/jpeg', mediaKey: Buffer.from([1, 2, 3]), fileLength, jpegThumbnail: Buffer.alloc(5000), caption: 'hi' } }
  };
  const raw = serializeMessage(msg as never);
  assert.ok(raw.length < 1000, 'the thumbnail is not stored');
  const copy = deserializeMessage(raw);
  assert.deepEqual(copy.key, msg.key);
  assert.deepEqual(copy.pushName, 'Asha');
  const image = copy.message!.imageMessage!;
  assert.ok(Buffer.isBuffer(image.mediaKey));
  assert.deepEqual([...image.mediaKey!], [1, 2, 3]);
  assert.equal(image.jpegThumbnail, undefined);
  assert.deepEqual(extractContent(copy.message!), { text: 'hi', media: { kind: 'image', mimetype: 'image/jpeg', fileName: undefined, size: 2048, voiceNote: false } });
});
