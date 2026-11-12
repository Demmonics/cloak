import sodium from 'libsodium-wrappers-sumo';
import { ARGON2_DEFAULT_BROWSER_PARAMS, CLIENT_LIMITS } from '@cloak/config';
import type {
  DecryptedMessageBody,
  EpochKeyEnvelopeDto,
} from '@cloak/protocol';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

let readyPromise: Promise<void> | null = null;

export async function ensureCryptoReady(): Promise<typeof sodium> {
  if (!readyPromise) {
    readyPromise = sodium.ready;
  }
  await readyPromise;
  return sodium;
}

export class CryptoOperationError extends Error {
  constructor(
    public readonly code:
      | 'CRYPTO_NOT_READY'
      | 'DECRYPTION_FAILED'
      | 'SIGNATURE_INVALID'
      | 'UNSUPPORTED_VERSION'
      | 'INVALID_FORMAT'
      | 'INTEGRITY_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'CryptoOperationError';
  }
}

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, part) => acc + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length % 2 !== 0 || !/^[0-9a-f]*$/.test(normalized)) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Invalid hexadecimal string');
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function wipeBytes(bytes: Uint8Array | null | undefined): void {
  if (!bytes || bytes.byteLength === 0) return;
  try {
    sodium.memzero(bytes);
  } catch {
    bytes.fill(0);
  }
}

export function toBase64Std(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export function fromBase64Std(b64: string): Uint8Array {
  return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
}

export function toBase64UrlNoPad(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function fromBase64UrlNoPad(b64: string): Uint8Array {
  return sodium.from_base64(b64, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const s = await ensureCryptoReady();
  return s.crypto_hash_sha256(data);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return bytesToHex(await sha256(data));
}

export async function randomBytes(length: number): Promise<Uint8Array> {
  const s = await ensureCryptoReady();
  return s.randombytes_buf(length);
}

export interface DeviceKeyBundle {
  deviceId: string;
  ed25519PublicKeyB64: string;
  ed25519SecretKeyB64: string;
  x25519PublicKeyB64: string;
  x25519SecretKeyB64: string;
  createdAt: string;
}

export async function generateDeviceIdentity(): Promise<DeviceKeyBundle> {
  const s = await ensureCryptoReady();
  const signKp = s.crypto_sign_keypair();
  const boxKp = s.crypto_box_keypair();
  return {
    deviceId: crypto.randomUUID(),
    ed25519PublicKeyB64: toBase64Std(signKp.publicKey),
    ed25519SecretKeyB64: toBase64Std(signKp.privateKey),
    x25519PublicKeyB64: toBase64Std(boxKp.publicKey),
    x25519SecretKeyB64: toBase64Std(boxKp.privateKey),
    createdAt: new Date().toISOString(),
  };
}

export async function signRegistrationProof(bundle: DeviceKeyBundle): Promise<string> {
  const s = await ensureCryptoReady();
  const canonical = `cloak-register-v1:${bundle.deviceId}:${bundle.ed25519PublicKeyB64}:${bundle.x25519PublicKeyB64}`;
  const sig = s.crypto_sign_detached(utf8Encode(canonical), fromBase64Std(bundle.ed25519SecretKeyB64));
  return toBase64Std(sig);
}

export async function signAuthChallenge(
  bundle: DeviceKeyBundle,
  challengeId: string,
  nonceB64: string,
): Promise<string> {
  const s = await ensureCryptoReady();
  const canonical = `cloak-auth-v1:${challengeId}:${nonceB64}:${bundle.deviceId}`;
  const sig = s.crypto_sign_detached(utf8Encode(canonical), fromBase64Std(bundle.ed25519SecretKeyB64));
  return toBase64Std(sig);
}

export async function verifyDetachedSignature(
  message: Uint8Array | string,
  signatureB64: string,
  ed25519PublicKeyB64: string,
): Promise<boolean> {
  const s = await ensureCryptoReady();
  try {
    const sig = fromBase64Std(signatureB64);
    const pk = fromBase64Std(ed25519PublicKeyB64);
    if (sig.byteLength !== s.crypto_sign_BYTES || pk.byteLength !== s.crypto_sign_PUBLICKEYBYTES) {
      return false;
    }
    return s.crypto_sign_verify_detached(sig, message, pk);
  } catch {
    return false;
  }
}

export interface Argon2Params {
  opslimit: number;
  memlimitBytes: number;
}

export async function benchmarkArgon2Params(targetMs = 350): Promise<Argon2Params> {
  const s = await ensureCryptoReady();
  const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
  const ops = ARGON2_DEFAULT_BROWSER_PARAMS.opslimit;
  const mem = ARGON2_DEFAULT_BROWSER_PARAMS.memlimitBytes;

  const t0 = performance.now();
  const k = s.crypto_pwhash(32, 'benchmark-probe', salt, ops, mem, s.crypto_pwhash_ALG_ARGON2ID13);
  const elapsed = performance.now() - t0;
  wipeBytes(k);

  if (elapsed < targetMs * 0.45 && mem * 2 <= 32 * 1024 * 1024) {
    return { opslimit: ops + 1, memlimitBytes: mem * 2 };
  }
  return { opslimit: ops, memlimitBytes: mem };
}

export function validateArgon2Params(opslimit: number, memlimitBytes: number): void {
  if (
    !Number.isInteger(opslimit) ||
    !Number.isInteger(memlimitBytes) ||
    opslimit < ARGON2_DEFAULT_BROWSER_PARAMS.minOpslimit ||
    opslimit > ARGON2_DEFAULT_BROWSER_PARAMS.maxOpslimit ||
    memlimitBytes < ARGON2_DEFAULT_BROWSER_PARAMS.minMemlimitBytes ||
    memlimitBytes > ARGON2_DEFAULT_BROWSER_PARAMS.maxMemlimitBytes
  ) {
    throw new CryptoOperationError(
      'INVALID_FORMAT',
      `Argon2id parameters out of safe bounds (ops=${opslimit}, mem=${memlimitBytes})`,
    );
  }
}

export async function deriveArgon2idKey(
  password: string,
  salt: Uint8Array,
  opslimit: number = ARGON2_DEFAULT_BROWSER_PARAMS.opslimit,
  memlimitBytes: number = ARGON2_DEFAULT_BROWSER_PARAMS.memlimitBytes,
  keyLength = 32,
): Promise<Uint8Array> {
  const s = await ensureCryptoReady();
  if (!password) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Password must not be empty');
  }
  if (salt.byteLength !== s.crypto_pwhash_SALTBYTES) {
    throw new CryptoOperationError('INVALID_FORMAT', `Salt must be ${s.crypto_pwhash_SALTBYTES} bytes`);
  }
  validateArgon2Params(opslimit, memlimitBytes);
  return s.crypto_pwhash(
    keyLength,
    utf8Encode(password),
    salt,
    opslimit,
    memlimitBytes,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export interface CloakKeyBackupV1 {
  app: 'cloak-key-backup';
  version: 1;
  deviceId: string;
  kdf: {
    alg: 'argon2id';
    opslimit: number;
    memlimitBytes: number;
    saltB64: string;
  };
  cipher: 'xchacha20poly1305';
  nonceB64: string;
  ciphertextB64: string;
  createdAt: string;
}

export async function exportEncryptedDeviceBackup(
  bundle: DeviceKeyBundle,
  passphrase: string,
  params?: Argon2Params,
): Promise<CloakKeyBackupV1> {
  const s = await ensureCryptoReady();
  if (passphrase.trim().length < 8) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Backup passphrase must be at least 8 characters');
  }
  const opslimit = params?.opslimit ?? ARGON2_DEFAULT_BROWSER_PARAMS.opslimit;
  const memlimitBytes = params?.memlimitBytes ?? ARGON2_DEFAULT_BROWSER_PARAMS.memlimitBytes;
  const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
  const key = await deriveArgon2idKey(passphrase, salt, opslimit, memlimitBytes, 32);
  try {
    const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const aad = utf8Encode(`cloak-key-backup-v1:${bundle.deviceId}`);
    const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
      utf8Encode(JSON.stringify(bundle)),
      aad,
      null,
      nonce,
      key,
    );
    return {
      app: 'cloak-key-backup',
      version: 1,
      deviceId: bundle.deviceId,
      kdf: {
        alg: 'argon2id',
        opslimit,
        memlimitBytes,
        saltB64: toBase64Std(salt),
      },
      cipher: 'xchacha20poly1305',
      nonceB64: toBase64Std(nonce),
      ciphertextB64: toBase64Std(ciphertext),
      createdAt: new Date().toISOString(),
    };
  } finally {
    wipeBytes(key);
  }
}

export async function importEncryptedDeviceBackup(
  backup: CloakKeyBackupV1,
  passphrase: string,
): Promise<DeviceKeyBundle> {
  const s = await ensureCryptoReady();
  if (backup?.app !== 'cloak-key-backup' || backup?.version !== 1) {
    throw new CryptoOperationError('UNSUPPORTED_VERSION', 'Unsupported Cloak key backup format');
  }
  const salt = fromBase64Std(backup.kdf.saltB64);
  const key = await deriveArgon2idKey(
    passphrase,
    salt,
    backup.kdf.opslimit,
    backup.kdf.memlimitBytes,
    32,
  );
  try {
    const nonce = fromBase64Std(backup.nonceB64);
    const ciphertext = fromBase64Std(backup.ciphertextB64);
    const aad = utf8Encode(`cloak-key-backup-v1:${backup.deviceId}`);
    let plaintext: Uint8Array;
    try {
      plaintext = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, aad, nonce, key);
    } catch {
      throw new CryptoOperationError('DECRYPTION_FAILED', 'Incorrect passphrase or corrupted key backup');
    }
    const parsed = JSON.parse(utf8Decode(plaintext)) as DeviceKeyBundle;
    if (!parsed.deviceId || !parsed.ed25519SecretKeyB64 || !parsed.x25519SecretKeyB64) {
      throw new CryptoOperationError('INVALID_FORMAT', 'Malformed device bundle inside backup');
    }
    return parsed;
  } finally {
    wipeBytes(key);
  }
}

export async function generateRoomEpochKey(): Promise<Uint8Array> {
  const s = await ensureCryptoReady();
  return s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
}

interface EpochWrapPayload {
  v: 1;
  roomId: string;
  epoch: number;
  recipientDeviceId: string;
  senderDeviceId: string;
  epochKeyB64: string;
}

export async function wrapEpochKeyForRecipient(params: {
  roomId: string;
  epoch: number;
  recipientDeviceId: string;
  recipientX25519PublicKeyB64: string;
  senderDeviceId: string;
  senderX25519SecretKeyB64: string;
  epochKey: Uint8Array;
}): Promise<string> {
  const s = await ensureCryptoReady();
  const payload: EpochWrapPayload = {
    v: 1,
    roomId: params.roomId,
    epoch: params.epoch,
    recipientDeviceId: params.recipientDeviceId,
    senderDeviceId: params.senderDeviceId,
    epochKeyB64: toBase64Std(params.epochKey),
  };
  const nonce = s.randombytes_buf(s.crypto_box_NONCEBYTES);
  const recipientPk = fromBase64Std(params.recipientX25519PublicKeyB64);
  const senderSk = fromBase64Std(params.senderX25519SecretKeyB64);
  const boxed = s.crypto_box_easy(utf8Encode(JSON.stringify(payload)), nonce, recipientPk, senderSk);
  return toBase64Std(concatBytes(nonce, boxed));
}

export async function unwrapEpochKeyEnvelope(params: {
  envelope: EpochKeyEnvelopeDto;
  expectedRoomId: string;
  expectedRecipientDeviceId: string;
  recipientX25519SecretKeyB64: string;
}): Promise<Uint8Array> {
  const s = await ensureCryptoReady();
  const packed = fromBase64Std(params.envelope.wrappedKeyCiphertextB64);
  if (packed.byteLength <= s.crypto_box_NONCEBYTES + s.crypto_box_MACBYTES) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Epoch envelope too short');
  }
  const nonce = packed.subarray(0, s.crypto_box_NONCEBYTES);
  const ciphertext = packed.subarray(s.crypto_box_NONCEBYTES);
  const senderPk = fromBase64Std(params.envelope.senderX25519PublicKeyB64);
  const recipientSk = fromBase64Std(params.recipientX25519SecretKeyB64);

  let plaintext: Uint8Array;
  try {
    plaintext = s.crypto_box_open_easy(ciphertext, nonce, senderPk, recipientSk);
  } catch {
    throw new CryptoOperationError('DECRYPTION_FAILED', 'Failed to unwrap room epoch key');
  }

  const parsed = JSON.parse(utf8Decode(plaintext)) as EpochWrapPayload;
  if (
    parsed.v !== 1 ||
    parsed.roomId !== params.expectedRoomId ||
    parsed.epoch !== params.envelope.epoch ||
    parsed.recipientDeviceId !== params.expectedRecipientDeviceId ||
    parsed.senderDeviceId !== params.envelope.senderDeviceId
  ) {
    throw new CryptoOperationError('INTEGRITY_MISMATCH', 'Epoch envelope metadata mismatch');
  }
  const epochKey = fromBase64Std(parsed.epochKeyB64);
  if (epochKey.byteLength !== s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Invalid room epoch key length');
  }
  return epochKey;
}

const INVITE_BLOB_MAGIC = new Uint8Array([0x43, 0x4b, 0x49, 0x01]); // "CKI\x01"

export interface InviteKeyWrapResult {
  linkSecretB64Url: string;
  wrappedRoomKeyBlobB64: string;
}

export async function wrapRoomKeyForInvite(params: {
  roomId: string;
  epoch: number;
  epochKey: Uint8Array;
  password?: string;
}): Promise<InviteKeyWrapResult> {
  const s = await ensureCryptoReady();
  const linkSecret = s.randombytes_buf(32);
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const trimmedPw = params.password?.trim() ?? '';
  const hasPassword = trimmedPw.length > 0;

  let wrappingKey: Uint8Array;
  let salt: Uint8Array = new Uint8Array(s.crypto_pwhash_SALTBYTES);
  let opslimit = 0;
  let memlimitBytes = 0;

  if (hasPassword) {
    opslimit = ARGON2_DEFAULT_BROWSER_PARAMS.opslimit;
    memlimitBytes = ARGON2_DEFAULT_BROWSER_PARAMS.memlimitBytes;
    salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
    const pwKey = await deriveArgon2idKey(trimmedPw, salt, opslimit, memlimitBytes, 32);
    try {
      wrappingKey = s.crypto_generichash(32, concatBytes(linkSecret, pwKey), null);
    } finally {
      wipeBytes(pwKey);
    }
  } else {
    wrappingKey = linkSecret;
  }

  try {
    const aad = utf8Encode(`cloak-invite-v1:${params.roomId}:${params.epoch}:${hasPassword ? 'pw' : 'nopw'}`);
    const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(params.epochKey, aad, null, nonce, wrappingKey);

    // Compact binary header (<= 118 bytes total, well inside backend 512-byte cap)
    const header = new Uint8Array(4 + 1 + 4 + 4);
    header.set(INVITE_BLOB_MAGIC, 0);
    header[4] = hasPassword ? 1 : 0;
    const dv = new DataView(header.buffer);
    dv.setUint32(5, opslimit, true);
    dv.setUint32(9, memlimitBytes, true);

    const blob = concatBytes(header, salt, nonce, ct);
    return {
      linkSecretB64Url: toBase64UrlNoPad(linkSecret),
      wrappedRoomKeyBlobB64: toBase64Std(blob),
    };
  } finally {
    if (hasPassword) wipeBytes(wrappingKey);
    wipeBytes(linkSecret);
  }
}

export async function unwrapRoomKeyFromInvite(params: {
  roomId: string;
  epoch: number;
  wrappedRoomKeyBlobB64: string;
  linkSecretB64Url: string;
  password?: string;
}): Promise<Uint8Array> {
  const s = await ensureCryptoReady();
  const blob = fromBase64Std(params.wrappedRoomKeyBlobB64);
  const minLen = 4 + 1 + 4 + 4 + s.crypto_pwhash_SALTBYTES + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES + 32;
  if (blob.byteLength < minLen) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Wrapped invite key blob is corrupted');
  }
  for (let i = 0; i < INVITE_BLOB_MAGIC.length; i++) {
    if (blob[i] !== INVITE_BLOB_MAGIC[i]) {
      throw new CryptoOperationError('UNSUPPORTED_VERSION', 'Unsupported invite blob header');
    }
  }
  const hasPassword = blob[4] === 1;
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const opslimit = dv.getUint32(5, true);
  const memlimitBytes = dv.getUint32(9, true);

  let offset = 13;
  const salt = blob.subarray(offset, offset + s.crypto_pwhash_SALTBYTES);
  offset += s.crypto_pwhash_SALTBYTES;
  const nonce = blob.subarray(offset, offset + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  offset += s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const ct = blob.subarray(offset);

  const linkSecret = fromBase64UrlNoPad(params.linkSecretB64Url);
  if (linkSecret.byteLength !== 32) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Invalid invite link secret');
  }

  let wrappingKey: Uint8Array;
  if (hasPassword) {
    const pw = params.password?.trim() ?? '';
    if (!pw) {
      throw new CryptoOperationError('DECRYPTION_FAILED', 'Invitation password is required');
    }
    const pwKey = await deriveArgon2idKey(pw, salt, opslimit, memlimitBytes, 32);
    try {
      wrappingKey = s.crypto_generichash(32, concatBytes(linkSecret, pwKey), null);
    } finally {
      wipeBytes(pwKey);
    }
  } else {
    wrappingKey = linkSecret;
  }

  try {
    const aad = utf8Encode(`cloak-invite-v1:${params.roomId}:${params.epoch}:${hasPassword ? 'pw' : 'nopw'}`);
    const epochKey = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, wrappingKey);
    if (epochKey.byteLength !== s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
      throw new CryptoOperationError('INVALID_FORMAT', 'Unwrapped epoch key invalid length');
    }
    return epochKey;
  } catch (err) {
    if (err instanceof CryptoOperationError) throw err;
    throw new CryptoOperationError('DECRYPTION_FAILED', 'Invalid invite link secret or password');
  } finally {
    if (hasPassword) wipeBytes(wrappingKey);
  }
}

export type UnsignedMessageBody = Omit<DecryptedMessageBody, 'senderSigB64'>;

function canonicalMessageDigestInput(params: {
  roomId: string;
  channelId: string;
  messageId: string;
  encryptionEpoch: number;
  senderDeviceId: string;
  unsignedBody: UnsignedMessageBody;
}): string {
  return `cloak-msg-sig-v1:${params.roomId}:${params.channelId}:${params.messageId}:${params.encryptionEpoch}:${params.senderDeviceId}:${JSON.stringify(params.unsignedBody)}`;
}

function buildMessageAad(params: {
  roomId: string;
  channelId: string;
  messageId: string;
  senderDeviceId: string;
  encryptionEpoch: number;
}): Uint8Array {
  return utf8Encode(
    `cloak-msg-aad-v1:${params.roomId}:${params.channelId}:${params.messageId}:${params.senderDeviceId}:${params.encryptionEpoch}`,
  );
}

export async function encryptMessageBody(params: {
  roomId: string;
  channelId: string;
  messageId: string;
  encryptionEpoch: number;
  epochKey: Uint8Array;
  senderBundle: DeviceKeyBundle;
  body: UnsignedMessageBody;
}): Promise<string> {
  const s = await ensureCryptoReady();
  const sigInputHash = await sha256Hex(
    canonicalMessageDigestInput({
      roomId: params.roomId,
      channelId: params.channelId,
      messageId: params.messageId,
      encryptionEpoch: params.encryptionEpoch,
      senderDeviceId: params.senderBundle.deviceId,
      unsignedBody: params.body,
    }),
  );
  const sig = s.crypto_sign_detached(
    utf8Encode(sigInputHash),
    fromBase64Std(params.senderBundle.ed25519SecretKeyB64),
  );
  const fullBody: DecryptedMessageBody = {
    ...params.body,
    version: 1,
    senderSigB64: toBase64Std(sig),
  };

  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const aad = buildMessageAad({
    roomId: params.roomId,
    channelId: params.channelId,
    messageId: params.messageId,
    senderDeviceId: params.senderBundle.deviceId,
    encryptionEpoch: params.encryptionEpoch,
  });
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    utf8Encode(JSON.stringify(fullBody)),
    aad,
    null,
    nonce,
    params.epochKey,
  );
  return toBase64Std(concatBytes(new Uint8Array([1]), nonce, ciphertext));
}

export async function decryptMessageCiphertext(params: {
  roomId: string;
  channelId: string;
  messageId: string;
  senderDeviceId: string;
  encryptionEpoch: number;
  epochKey: Uint8Array;
  ciphertextB64: string;
  senderEd25519PublicKeyB64?: string;
}): Promise<{ body: DecryptedMessageBody; signatureVerified: boolean }> {
  const s = await ensureCryptoReady();
  const raw = fromBase64Std(params.ciphertextB64);
  if (raw.byteLength < 1 + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES + s.crypto_aead_xchacha20poly1305_ietf_ABYTES) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Message ciphertext too short');
  }
  if (raw[0] !== 1) {
    throw new CryptoOperationError('UNSUPPORTED_VERSION', `Unsupported message ciphertext version ${raw[0]}`);
  }
  const nonce = raw.subarray(1, 1 + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = raw.subarray(1 + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const aad = buildMessageAad({
    roomId: params.roomId,
    channelId: params.channelId,
    messageId: params.messageId,
    senderDeviceId: params.senderDeviceId,
    encryptionEpoch: params.encryptionEpoch,
  });

  let plaintext: Uint8Array;
  try {
    plaintext = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, aad, nonce, params.epochKey);
  } catch {
    throw new CryptoOperationError('DECRYPTION_FAILED', 'Unable to decrypt message in this room epoch');
  }

  const body = JSON.parse(utf8Decode(plaintext)) as DecryptedMessageBody;
  let signatureVerified = false;
  if (params.senderEd25519PublicKeyB64 && body.senderSigB64) {
    const { senderSigB64, ...unsignedBody } = body;
    const sigInputHash = await sha256Hex(
      canonicalMessageDigestInput({
        roomId: params.roomId,
        channelId: params.channelId,
        messageId: params.messageId,
        encryptionEpoch: params.encryptionEpoch,
        senderDeviceId: params.senderDeviceId,
        unsignedBody,
      }),
    );
    signatureVerified = await verifyDetachedSignature(
      utf8Encode(sigInputHash),
      senderSigB64,
      params.senderEd25519PublicKeyB64,
    );
  }
  return { body, signatureVerified };
}

export interface EncryptedAttachmentPayload {
  fileKeyB64: string;
  streamHeaderB64: string;
  plaintextSha256Hex: string;
  plaintextSizeBytes: number;
  plaintextChunkSizeBytes: number;
  expectedCiphertextBytes: number;
  encryptedChunks: Uint8Array[];
}

export async function encryptAttachmentChunks(
  plaintext: Uint8Array,
  plaintextChunkSizeBytes: number = CLIENT_LIMITS.attachmentChunkBytes,
): Promise<EncryptedAttachmentPayload> {
  const s = await ensureCryptoReady();
  const key = s.crypto_secretstream_xchacha20poly1305_keygen();
  try {
    const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(key);
    const plaintextSha256Hex = await sha256Hex(plaintext);

    const encryptedChunks: Uint8Array[] = [];
    let expectedCiphertextBytes = 0;
    const totalChunks = Math.max(1, Math.ceil(plaintext.byteLength / plaintextChunkSizeBytes));

    for (let i = 0; i < totalChunks; i++) {
      const start = i * plaintextChunkSizeBytes;
      const end = Math.min(plaintext.byteLength, start + plaintextChunkSizeBytes);
      const slice = plaintext.subarray(start, end);
      const isFinal = i === totalChunks - 1;
      const tag = isFinal
        ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      const ad = utf8Encode(`cloak-att-chunk:${i}`);
      const encChunk = s.crypto_secretstream_xchacha20poly1305_push(state, slice, ad, tag);
      encryptedChunks.push(encChunk);
      expectedCiphertextBytes += encChunk.byteLength;
    }

    return {
      fileKeyB64: toBase64Std(key),
      streamHeaderB64: toBase64Std(header),
      plaintextSha256Hex,
      plaintextSizeBytes: plaintext.byteLength,
      plaintextChunkSizeBytes,
      expectedCiphertextBytes,
      encryptedChunks,
    };
  } finally {
    wipeBytes(key);
  }
}

export async function decryptAttachmentChunks(params: {
  encryptedChunks: readonly Uint8Array[];
  fileKeyB64: string;
  streamHeaderB64: string;
  expectedPlaintextSha256Hex?: string;
}): Promise<Uint8Array> {
  const s = await ensureCryptoReady();
  const key = fromBase64Std(params.fileKeyB64);
  const header = fromBase64Std(params.streamHeaderB64);
  if (key.byteLength !== s.crypto_secretstream_xchacha20poly1305_KEYBYTES) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Invalid attachment file key length');
  }
  if (header.byteLength !== s.crypto_secretstream_xchacha20poly1305_HEADERBYTES) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Invalid attachment stream header length');
  }

  try {
    const state = s.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
    const plainParts: Uint8Array[] = [];
    let sawFinalTag = false;

    for (let i = 0; i < params.encryptedChunks.length; i++) {
      const chunk = params.encryptedChunks[i]!;
      const ad = utf8Encode(`cloak-att-chunk:${i}`);
      const pulled = s.crypto_secretstream_xchacha20poly1305_pull(state, chunk, ad);
      if (pulled === false) {
        throw new CryptoOperationError('DECRYPTION_FAILED', `Attachment authentication failed at chunk ${i}`);
      }
      plainParts.push(pulled.message);
      if (pulled.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
        if (i !== params.encryptedChunks.length - 1) {
          throw new CryptoOperationError('INTEGRITY_MISMATCH', 'Unexpected trailing chunks after TAG_FINAL');
        }
        sawFinalTag = true;
      }
    }

    if (!sawFinalTag) {
      throw new CryptoOperationError('INTEGRITY_MISMATCH', 'Attachment stream truncated before TAG_FINAL');
    }

    const combined = concatBytes(...plainParts);
    if (params.expectedPlaintextSha256Hex) {
      const actualHex = await sha256Hex(combined);
      if (actualHex !== params.expectedPlaintextSha256Hex.toLowerCase()) {
        throw new CryptoOperationError('INTEGRITY_MISMATCH', 'Decrypted attachment SHA-256 mismatch');
      }
    }
    return combined;
  } finally {
    wipeBytes(key);
  }
}

export interface SecretStreamFrameEncryptor {
  header: Uint8Array;
  pushChunk(plaintext: Uint8Array, isFinal: boolean, ad?: Uint8Array | null): Uint8Array;
}

export async function createSecretStreamPush(key: Uint8Array): Promise<SecretStreamFrameEncryptor> {
  const s = await ensureCryptoReady();
  const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(key);
  return {
    header,
    pushChunk(plaintext: Uint8Array, isFinal: boolean, ad: Uint8Array | null = null): Uint8Array {
      const tag = isFinal
        ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      return s.crypto_secretstream_xchacha20poly1305_push(state, plaintext, ad, tag);
    },
  };
}

export interface SecretStreamFrameDecryptor {
  pullChunk(cipherFrame: Uint8Array, ad?: Uint8Array | null): { message: Uint8Array; isFinal: boolean };
}

export async function createSecretStreamPull(
  header: Uint8Array,
  key: Uint8Array,
): Promise<SecretStreamFrameDecryptor> {
  const s = await ensureCryptoReady();
  if (header.byteLength !== s.crypto_secretstream_xchacha20poly1305_HEADERBYTES) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Invalid secretstream header length');
  }
  if (key.byteLength !== s.crypto_secretstream_xchacha20poly1305_KEYBYTES) {
    throw new CryptoOperationError('INVALID_FORMAT', 'Invalid secretstream key length');
  }
  const state = s.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
  return {
    pullChunk(cipherFrame: Uint8Array, ad: Uint8Array | null = null): { message: Uint8Array; isFinal: boolean } {
      const result = s.crypto_secretstream_xchacha20poly1305_pull(state, cipherFrame, ad);
      if (result === false) {
        throw new CryptoOperationError('DECRYPTION_FAILED', 'Stream authentication failed (wrong password or tampered data)');
      }
      return {
        message: result.message,
        isFinal: result.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
      };
    },
  };
}
