import { CLIENT_LIMITS } from '@cloak/config';
import {
  concatBytes,
  createSecretStreamPull,
  createSecretStreamPush,
  CryptoOperationError,
  deriveArgon2idKey,
  fromBase64Std,
  randomBytes,
  sha256,
  toBase64Std,
  utf8Decode,
  utf8Encode,
  wipeBytes,
} from '@cloak/crypto';
import type { Argon2Params } from '@cloak/crypto';
import { ArchiveError } from './types.js';

export const CLOAKEXPORT_MAGIC = utf8Encode('CLOAKEXP\x01\x00'); // 10 bytes (v1.0)
export const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

export interface CloakExportHeaderJson {
  appId: 'cloak';
  containerFormatVersion: 1;
  kdf: {
    alg: 'argon2id';
    opslimit: number;
    memlimitBytes: number;
    saltB64: string;
  };
  cipher: 'xchacha20poly1305-secretstream';
  secretstreamHeaderB64: string;
  chunkSizeBytes: number;
  createdAtUtc: string;
}

export function isCloakExportContainer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < CLOAKEXPORT_MAGIC.byteLength) return false;
  for (let i = 0; i < CLOAKEXPORT_MAGIC.byteLength; i++) {
    if (bytes[i] !== CLOAKEXPORT_MAGIC[i]) return false;
  }
  return true;
}

export function isZipContainer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== ZIP_MAGIC[i]) return false;
  }
  return true;
}

function makeFrameAd(headerHash: Uint8Array, chunkIndex: number): Uint8Array {
  const out = new Uint8Array(headerHash.byteLength + 8);
  out.set(headerHash, 0);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(headerHash.byteLength, BigInt(chunkIndex), true);
  return out;
}

export async function encryptCloakExportContainer(params: {
  zipBytes: Uint8Array;
  password: string;
  argon2Params?: Argon2Params;
  chunkSizeBytes?: number;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  if (!params.password) {
    throw new ArchiveError('PASSWORD_REQUIRED', 'A non-empty password is required for .cloakexport exports');
  }

  const chunkSizeBytes = params.chunkSizeBytes ?? CLIENT_LIMITS.exportStreamChunkBytes;
  const opslimit = params.argon2Params?.opslimit ?? 3;
  const memlimitBytes = params.argon2Params?.memlimitBytes ?? 16 * 1024 * 1024;
  const salt = await randomBytes(16);
  const key = await deriveArgon2idKey(params.password, salt, opslimit, memlimitBytes, 32);

  try {
    const push = await createSecretStreamPush(key);
    const headerMeta: CloakExportHeaderJson = {
      appId: 'cloak',
      containerFormatVersion: 1,
      kdf: {
        alg: 'argon2id',
        opslimit,
        memlimitBytes,
        saltB64: toBase64Std(salt),
      },
      cipher: 'xchacha20poly1305-secretstream',
      secretstreamHeaderB64: toBase64Std(push.header),
      chunkSizeBytes,
      createdAtUtc: new Date().toISOString(),
    };
    const metaBytes = utf8Encode(JSON.stringify(headerMeta));
    const metaHash = await sha256(metaBytes);

    const metaLenPrefix = new Uint8Array(4);
    new DataView(metaLenPrefix.buffer).setUint32(0, metaBytes.byteLength, true);

    const parts: Uint8Array[] = [CLOAKEXPORT_MAGIC, metaLenPrefix, metaBytes];
    const totalChunks = Math.max(1, Math.ceil(params.zipBytes.byteLength / chunkSizeBytes));

    for (let i = 0; i < totalChunks; i++) {
      if (params.signal?.aborted) {
        throw new ArchiveError('CANCELLED', 'Export encryption aborted');
      }
      const start = i * chunkSizeBytes;
      const end = Math.min(params.zipBytes.byteLength, start + chunkSizeBytes);
      const slice = params.zipBytes.subarray(start, end);
      const isFinal = i === totalChunks - 1;
      const ad = makeFrameAd(metaHash, i);
      const cipherFrame = push.pushChunk(slice, isFinal, ad);

      const frameLenBytes = new Uint8Array(4);
      new DataView(frameLenBytes.buffer).setUint32(0, cipherFrame.byteLength, true);
      parts.push(frameLenBytes, cipherFrame);

      if (params.onProgress) {
        params.onProgress(Math.round(((i + 1) / totalChunks) * 100));
      }
    }

    return concatBytes(...parts);
  } finally {
    wipeBytes(key);
  }
}

export async function decryptCloakExportContainer(params: {
  containerBytes: Uint8Array;
  password: string;
}): Promise<{ zipBytes: Uint8Array; header: CloakExportHeaderJson }> {
  if (!params.password) {
    throw new ArchiveError('PASSWORD_REQUIRED', 'Password is required to unlock a .cloakexport archive');
  }
  const buf = params.containerBytes;
  if (!isCloakExportContainer(buf)) {
    throw new ArchiveError('CORRUPTED_CONTAINER', 'Not a valid .cloakexport v1 container');
  }

  let offset = CLOAKEXPORT_MAGIC.byteLength;
  if (offset + 4 > buf.byteLength) {
    throw new ArchiveError('CORRUPTED_CONTAINER', 'Truncated .cloakexport header length');
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const metaLen = dv.getUint32(offset, true);
  offset += 4;
  if (metaLen <= 2 || metaLen > 128 * 1024 || offset + metaLen > buf.byteLength) {
    throw new ArchiveError('CORRUPTED_CONTAINER', 'Invalid .cloakexport metadata block length');
  }

  const metaBytes = buf.subarray(offset, offset + metaLen);
  offset += metaLen;

  let header: CloakExportHeaderJson;
  try {
    header = JSON.parse(utf8Decode(metaBytes)) as CloakExportHeaderJson;
  } catch {
    throw new ArchiveError('CORRUPTED_CONTAINER', 'Malformed .cloakexport header JSON');
  }
  if (
    header?.appId !== 'cloak' ||
    header?.containerFormatVersion !== 1 ||
    header?.kdf?.alg !== 'argon2id' ||
    header?.cipher !== 'xchacha20poly1305-secretstream'
  ) {
    throw new ArchiveError('UNSUPPORTED_VERSION', 'Unsupported .cloakexport format version or cipher');
  }

  const metaHash = await sha256(metaBytes);
  const salt = fromBase64Std(header.kdf.saltB64);
  const ssHeader = fromBase64Std(header.secretstreamHeaderB64);
  const key = await deriveArgon2idKey(
    params.password,
    salt,
    header.kdf.opslimit,
    header.kdf.memlimitBytes,
    32,
  );

  try {
    const pull = await createSecretStreamPull(ssHeader, key);
    const plainChunks: Uint8Array[] = [];
    let chunkIndex = 0;
    let totalPlainBytes = 0;
    let sawFinal = false;

    while (offset < buf.byteLength) {
      if (offset + 4 > buf.byteLength) {
        throw new ArchiveError('CORRUPTED_CONTAINER', 'Truncated encrypted frame length in .cloakexport');
      }
      const frameLen = dv.getUint32(offset, true);
      offset += 4;
      if (frameLen === 0 || offset + frameLen > buf.byteLength) {
        throw new ArchiveError('CORRUPTED_CONTAINER', 'Invalid or truncated encrypted frame in .cloakexport');
      }
      const frame = buf.subarray(offset, offset + frameLen);
      offset += frameLen;

      const ad = makeFrameAd(metaHash, chunkIndex);
      let pulled: { message: Uint8Array; isFinal: boolean };
      try {
        pulled = pull.pullChunk(frame, ad);
      } catch (err) {
        if (err instanceof CryptoOperationError) {
          throw new ArchiveError('WRONG_PASSWORD_OR_CORRUPTED', 'Wrong password or tampered .cloakexport archive');
        }
        throw err;
      }

      totalPlainBytes += pulled.message.byteLength;
      if (totalPlainBytes > CLIENT_LIMITS.maxUnpackArchiveBytes) {
        throw new ArchiveError('DECOMPRESSION_BOMB', 'Unpacked archive exceeds safe byte ceiling');
      }
      plainChunks.push(pulled.message);
      chunkIndex++;

      if (pulled.isFinal) {
        sawFinal = true;
        if (offset !== buf.byteLength) {
          throw new ArchiveError('TAMPERED_INTEGRITY', 'Unexpected trailing bytes after encrypted archive end');
        }
      }
    }

    if (!sawFinal) {
      throw new ArchiveError('TAMPERED_INTEGRITY', 'Archive stream truncated before authenticated final frame');
    }

    return { zipBytes: concatBytes(...plainChunks), header };
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    if (err instanceof CryptoOperationError) {
      throw new ArchiveError('WRONG_PASSWORD_OR_CORRUPTED', err.message);
    }
    throw new ArchiveError('CORRUPTED_CONTAINER', 'Failed to decrypt .cloakexport container');
  } finally {
    wipeBytes(key);
  }
}

