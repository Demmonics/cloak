import Dexie, { type Table } from 'dexie';
import { ARGON2_DEFAULT_BROWSER_PARAMS } from '@cloak/config';
import {
  deriveArgon2idKey,
  ensureCryptoReady,
  fromBase64Std,
  randomBytes,
  toBase64Std,
  utf8Decode,
  utf8Encode,
  wipeBytes,
  type DeviceKeyBundle,
} from '@cloak/crypto';
import type { DecryptedAttachmentRef } from '@cloak/protocol';

export interface StoredReaction {
  emoji: string;
  reactorDeviceIds: string[];
}

export interface LocalDecryptedMessage {
  id: string;
  roomId: string;
  channelId: string;
  senderDeviceId: string;
  encryptionEpoch: number;
  eventSeq: number;
  createdAt: string;
  editedAt: string | null;
  expiresAt: string | null;
  expireAfterReadSeconds: number | null;
  deletedForMe: number; // 0 or 1 for IndexedDB indexing
  deletedForEveryoneAt: string | null;
  isPinned: number; // 0 or 1
  replyToMessageId: string | null;
  replyPreviewText: string | null;
  replyPreviewSender: string | null;
  threadRootId: string | null;
  text: string;
  voiceNote: boolean;
  signatureVerified: boolean;
  reactions: StoredReaction[];
  attachments: DecryptedAttachmentRef[];
  localStatus?: 'sending' | 'sent' | 'failed';
  idempotencyKey?: string;
}

export interface StoredVaultRecord {
  id: 'primary';
  mode: 'browser_key' | 'passphrase';
  deviceId: string;
  ivB64: string;
  ciphertextB64: string;
  saltB64?: string;
  opslimit?: number;
  memlimitBytes?: number;
  browserWrappingKey?: CryptoKey;
  profileHint: {
    displayName: string;
    avatarColor: string;
    avatarEmoji?: string | null;
    ed25519PublicKeyB64: string;
    x25519PublicKeyB64: string;
    createdAt: string;
  };
}

export interface StoredEpochKeyRecord {
  compositeId: string; // `${roomId}:${epoch}`
  roomId: string;
  epoch: number;
  keyB64: string; // Encrypted or encoded epoch key
}

export interface StoredAttachmentCacheRecord {
  attachmentId: string;
  roomId: string;
  filename: string;
  mimeType: string;
  sha256Hex: string;
  bytes: Uint8Array;
  cachedAt: string;
}

export interface StoredBookmarkRecord {
  messageId: string;
  roomId: string;
  channelId: string;
  createdAt: string;
}

export interface StoredSyncCursorRecord {
  roomId: string;
  lastEventSeq: number;
  lastSyncedAtUtc: string;
}

export interface StoredDraftRecord {
  channelId: string;
  text: string;
}

class CloakDatabase extends Dexie {
  vault!: Table<StoredVaultRecord, 'primary'>;
  epochKeys!: Table<StoredEpochKeyRecord, string>;
  messages!: Table<LocalDecryptedMessage, string>;
  attachmentsCache!: Table<StoredAttachmentCacheRecord, string>;
  bookmarks!: Table<StoredBookmarkRecord, string>;
  syncCursors!: Table<StoredSyncCursorRecord, string>;
  drafts!: Table<StoredDraftRecord, string>;

  constructor() {
    super('cloak_private_workspace_v1');
    this.version(1).stores({
      vault: '&id, deviceId',
      epochKeys: '&compositeId, roomId, epoch',
      messages: '&id, [roomId+channelId+createdAt], [roomId+eventSeq], roomId, channelId, expiresAt',
      attachmentsCache: '&attachmentId, roomId',
      bookmarks: '&messageId, roomId, channelId',
      syncCursors: '&roomId',
      drafts: '&channelId',
    });
  }
}

export const db = new CloakDatabase();

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  return buf;
}

async function encryptWithBrowserKey(
  plaintext: Uint8Array,
  existingKey?: CryptoKey,
): Promise<{ key: CryptoKey; ivB64: string; ciphertextB64: string }> {
  const key =
    existingKey ??
    (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext),
  );
  return {
    key,
    ivB64: toBase64Std(iv),
    ciphertextB64: toBase64Std(new Uint8Array(encrypted)),
  };
}

async function decryptWithBrowserKey(key: CryptoKey, ivB64: string, ciphertextB64: string): Promise<Uint8Array> {
  const iv = fromBase64Std(ivB64);
  const ct = fromBase64Std(ciphertextB64);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ct),
  );
  return new Uint8Array(plain);
}

export async function saveVaultWithBrowserWrapping(
  bundle: DeviceKeyBundle,
  profile: StoredVaultRecord['profileHint'],
): Promise<void> {
  const s = await ensureCryptoReady();
  const payload = utf8Encode(JSON.stringify(bundle));
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const existing = await db.vault.get('primary');
    const wrapped = await encryptWithBrowserKey(payload, existing?.browserWrappingKey);
    await db.vault.put({
      id: 'primary',
      mode: 'browser_key',
      deviceId: bundle.deviceId,
      ivB64: wrapped.ivB64,
      ciphertextB64: wrapped.ciphertextB64,
      browserWrappingKey: wrapped.key,
      profileHint: profile,
    });
  } else {
    void s;
    await db.vault.put({
      id: 'primary',
      mode: 'browser_key',
      deviceId: bundle.deviceId,
      ivB64: '',
      ciphertextB64: toBase64Std(payload),
      profileHint: profile,
    });
  }
}

export async function saveVaultWithPassphrase(
  bundle: DeviceKeyBundle,
  profile: StoredVaultRecord['profileHint'],
  passphrase: string,
): Promise<void> {
  const s = await ensureCryptoReady();
  const salt = await randomBytes(s.crypto_pwhash_SALTBYTES);
  const opslimit = ARGON2_DEFAULT_BROWSER_PARAMS.opslimit;
  const memlimitBytes = ARGON2_DEFAULT_BROWSER_PARAMS.memlimitBytes;
  const key = await deriveArgon2idKey(passphrase, salt, opslimit, memlimitBytes, 32);
  try {
    const nonce = await randomBytes(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const aad = utf8Encode(`cloak-vault-v1:${bundle.deviceId}`);
    const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
      utf8Encode(JSON.stringify(bundle)),
      aad,
      null,
      nonce,
      key,
    );
    await db.vault.put({
      id: 'primary',
      mode: 'passphrase',
      deviceId: bundle.deviceId,
      ivB64: toBase64Std(nonce),
      ciphertextB64: toBase64Std(ct),
      saltB64: toBase64Std(salt),
      opslimit,
      memlimitBytes,
      profileHint: profile,
    });
  } finally {
    wipeBytes(key);
  }
}

export async function unlockStoredVault(passphrase?: string): Promise<{
  bundle: DeviceKeyBundle;
  record: StoredVaultRecord;
} | null> {
  const record = await db.vault.get('primary');
  if (!record) return null;

  if (record.mode === 'passphrase') {
    if (!passphrase) {
      throw new Error('VAULT_PASSPHRASE_REQUIRED');
    }
    const s = await ensureCryptoReady();
    const salt = fromBase64Std(record.saltB64 || '');
    const key = await deriveArgon2idKey(
      passphrase,
      salt,
      record.opslimit ?? ARGON2_DEFAULT_BROWSER_PARAMS.opslimit,
      record.memlimitBytes ?? ARGON2_DEFAULT_BROWSER_PARAMS.memlimitBytes,
      32,
    );
    try {
      const nonce = fromBase64Std(record.ivB64);
      const ct = fromBase64Std(record.ciphertextB64);
      const aad = utf8Encode(`cloak-vault-v1:${record.deviceId}`);
      const plain = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, key);
      return { bundle: JSON.parse(utf8Decode(plain)) as DeviceKeyBundle, record };
    } finally {
      wipeBytes(key);
    }
  }

  if (record.browserWrappingKey && record.ivB64) {
    const plain = await decryptWithBrowserKey(record.browserWrappingKey, record.ivB64, record.ciphertextB64);
    return { bundle: JSON.parse(utf8Decode(plain)) as DeviceKeyBundle, record };
  }

  const fallbackPlain = fromBase64Std(record.ciphertextB64);
  return { bundle: JSON.parse(utf8Decode(fallbackPlain)) as DeviceKeyBundle, record };
}

export async function storeRoomEpochKey(roomId: string, epoch: number, epochKey: Uint8Array): Promise<void> {
  await ensureCryptoReady();
  await db.epochKeys.put({
    compositeId: `${roomId}:${epoch}`,
    roomId,
    epoch,
    keyB64: toBase64Std(epochKey),
  });
}

export async function loadRoomEpochKey(roomId: string, epoch: number): Promise<Uint8Array | null> {
  await ensureCryptoReady();
  const row = await db.epochKeys.get(`${roomId}:${epoch}`);
  return row ? fromBase64Std(row.keyB64) : null;
}

export async function loadAllRoomEpochKeys(roomId: string): Promise<Map<number, Uint8Array>> {
  await ensureCryptoReady();
  const rows = await db.epochKeys.where('roomId').equals(roomId).toArray();
  const map = new Map<number, Uint8Array>();
  for (const row of rows) {
    map.set(row.epoch, fromBase64Std(row.keyB64));
  }
  return map;
}

export async function upsertLocalMessages(msgs: LocalDecryptedMessage[]): Promise<void> {
  if (msgs.length === 0) return;
  await db.messages.bulkPut(msgs);
}

export async function getActiveChannelMessages(
  roomId: string,
  channelId: string,
): Promise<LocalDecryptedMessage[]> {
  const now = Date.now();
  const all = await db.messages
    .where('[roomId+channelId+createdAt]')
    .between([roomId, channelId, Dexie.minKey], [roomId, channelId, Dexie.maxKey])
    .toArray();
  return all.filter((m) => {
    if (m.deletedForMe === 1 || m.deletedForEveryoneAt) return false;
    if (m.expiresAt && Date.parse(m.expiresAt) <= now) return false;
    return true;
  });
}

export async function purgeDeletedMessageLocally(
  roomId: string,
  messageId: string,
): Promise<string[]> {
  const existing = await db.messages.get(messageId);
  const orphanedAttIds: string[] = [];
  if (existing && existing.roomId === roomId) {
    for (const att of existing.attachments) {
      orphanedAttIds.push(att.attachmentId);
    }
    await db.messages.delete(messageId);
  }
  await db.bookmarks.delete(messageId);
  if (orphanedAttIds.length > 0) {
    await db.attachmentsCache.bulkDelete(orphanedAttIds);
  }
  return existing ? [messageId] : [];
}

export async function purgeExpiredMessagesLocally(nowMs = Date.now()): Promise<string[]> {
  const all = await db.messages.filter((m) => Boolean(m.expiresAt)).toArray();
  const expiredIds: string[] = [];
  const expiredAttIds: string[] = [];

  for (const msg of all) {
    if (msg.expiresAt && Date.parse(msg.expiresAt) <= nowMs) {
      expiredIds.push(msg.id);
      for (const att of msg.attachments) {
        expiredAttIds.push(att.attachmentId);
      }
    }
  }
  if (expiredIds.length > 0) {
    await db.messages.bulkDelete(expiredIds);
    await db.bookmarks.bulkDelete(expiredIds);
  }
  if (expiredAttIds.length > 0) {
    await db.attachmentsCache.bulkDelete(expiredAttIds);
  }
  return expiredIds;
}

export async function purgeChannelLocally(roomId: string, channelId: string): Promise<string[]> {
  const msgs = await db.messages.where('channelId').equals(channelId).toArray();
  const ids = msgs.filter((m) => m.roomId === roomId).map((m) => m.id);
  const attIds = msgs.flatMap((m) => m.attachments.map((a) => a.attachmentId));
  if (ids.length > 0) {
    await db.messages.bulkDelete(ids);
    await db.bookmarks.bulkDelete(ids);
  }
  if (attIds.length > 0) {
    await db.attachmentsCache.bulkDelete(attIds);
  }
  return ids;
}

export async function burnRoomLocally(roomId: string, keepEpoch?: number): Promise<void> {
  await db.transaction(
    'rw',
    [db.messages, db.attachmentsCache, db.bookmarks, db.epochKeys, db.syncCursors],
    async () => {
      await db.messages.where('roomId').equals(roomId).delete();
      await db.attachmentsCache.where('roomId').equals(roomId).delete();
      await db.bookmarks.where('roomId').equals(roomId).delete();
      await db.syncCursors.delete(roomId);
      const epochs = await db.epochKeys.where('roomId').equals(roomId).toArray();
      const dropKeys = epochs
        .filter((e) => keepEpoch === undefined || e.epoch < keepEpoch)
        .map((e) => e.compositeId);
      if (dropKeys.length > 0) {
        await db.epochKeys.bulkDelete(dropKeys);
      }
    },
  );
}
