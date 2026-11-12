import { CLIENT_LIMITS } from '@cloak/config';
import { sha256Hex, utf8Encode } from '@cloak/crypto';
import type { ExportManifest } from '@cloak/protocol';
import {
  configure,
  TextReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import {
  decryptCloakExportContainer,
  encryptCloakExportContainer,
  isCloakExportContainer,
  isZipContainer,
} from './container.js';
import {
  buildAttachmentArchivePlans,
  buildMessagesDocument,
  buildOfflineSafeHtml,
  buildPlainTextTranscript,
  filterMessagesForExport,
} from './formatters.js';
import { sanitizeZipFilenameComponent, validateArchiveEntryPath } from './safety.js';
import {
  ArchiveError,
  type ArchiveAttachmentEntry,
  type ArchiveMessagesDocument,
  type ExportBuildInput,
  type ExportBuildResult,
  type OpenedArchiveData,
} from './types.js';

export * from './types.js';
export * from './safety.js';
export * from './container.js';
export * from './formatters.js';

configure({ useWebWorkers: false });

export async function createChatExportArchive(input: ExportBuildInput): Promise<ExportBuildResult> {
  if (!input.options.password || input.options.password.trim().length < 6) {
    throw new ArchiveError(
      'PASSWORD_REQUIRED',
      'Export archives must be protected by a password of at least 6 characters',
    );
  }
  if (input.signal?.aborted) {
    throw new ArchiveError('CANCELLED', 'Export cancelled');
  }

  input.onProgress?.({ phase: 'filtering', percent: 10, detail: 'Filtering active & authorized messages' });
  const timezone =
    input.timezone ||
    (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC') ||
    'UTC';

  const filtered = filterMessagesForExport(input);
  const { plansByMessageAndId, uniqueFiles, totalBytes } = buildAttachmentArchivePlans(
    filtered,
    input.options.includeAttachments,
  );

  const warnings: string[] = [];
  if (input.isHistoricalOfflineSnapshot) {
    warnings.push('Generated offline: server-side deletions since last sync could not be verified.');
  }
  if (input.options.containerMode === 'aes_zip') {
    warnings.push(
      'AES-256 ZIP encrypts file contents, but ZIP central directory filenames and sizes remain visible without the password.',
    );
  }

  const manifest: ExportManifest = {
    appId: 'cloak',
    archiveFormatVersion: 1,
    exportFormat: input.options.format,
    containerMode: input.options.containerMode,
    createdAtUtc: new Date().toISOString(),
    roomId: input.roomId,
    roomDisplayName: input.roomDisplayName,
    syncCursorSeq: input.syncCursorSeq,
    lastSuccessfulSyncAtUtc: input.lastSuccessfulSyncAtUtc,
    isHistoricalOfflineSnapshot: input.isHistoricalOfflineSnapshot,
    timezone,
    participants: input.participants,
    includedMessageCount: filtered.length,
    includedAttachmentCount: uniqueFiles.length,
    includedAttachmentBytes: totalBytes,
    options: {
      format: input.options.format,
      scope: input.options.scope,
      includeAttachments: input.options.includeAttachments,
      passwordProtected: true,
      respectDeletedMessageState: true,
    },
    files: [],
    warnings,
  };

  const doc = buildMessagesDocument(manifest, input, filtered, plansByMessageAndId);

  input.onProgress?.({ phase: 'packaging', percent: 40, detail: 'Building archive entries' });

  const entries: Array<{ path: string; bytes: Uint8Array; text?: string }> = [];
  const integritySha256: Record<string, string> = {};

  const pushTextEntry = async (path: string, text: string, mimeType: string) => {
    validateArchiveEntryPath(path);
    const encoded = utf8Encode(text);
    const hex = await sha256Hex(encoded);
    integritySha256[path] = hex;
    manifest.files.push({ path, sizeBytes: encoded.byteLength, sha256Hex: hex, mimeType });
    entries.push({ path, bytes: encoded, text });
  };

  if (input.options.format === 'json' || input.options.format === 'complete') {
    await pushTextEntry('messages.json', JSON.stringify(doc, null, 2), 'application/json');
  }
  if (input.options.format === 'txt' || input.options.format === 'complete') {
    await pushTextEntry('transcript.txt', buildPlainTextTranscript(doc, timezone), 'text/plain; charset=utf-8');
  }
  if (input.options.format === 'html' || input.options.format === 'complete') {
    await pushTextEntry('index.html', buildOfflineSafeHtml(doc, timezone), 'text/html; charset=utf-8');
  }

  for (const attFile of uniqueFiles) {
    if (input.signal?.aborted) {
      throw new ArchiveError('CANCELLED', 'Export cancelled while packaging attachments');
    }
    validateArchiveEntryPath(attFile.archivePath);
    const hex = await sha256Hex(attFile.bytes);
    integritySha256[attFile.archivePath] = hex;
    manifest.files.push({
      path: attFile.archivePath,
      sizeBytes: attFile.bytes.byteLength,
      sha256Hex: hex,
      mimeType: attFile.mimeType,
    });
    entries.push({ path: attFile.archivePath, bytes: attFile.bytes });
  }

  const manifestText = JSON.stringify(manifest, null, 2);
  const manifestEncoded = utf8Encode(manifestText);
  integritySha256['manifest.json'] = await sha256Hex(manifestEncoded);
  entries.unshift({ path: 'manifest.json', bytes: manifestEncoded, text: manifestText });

  const integrityJson = JSON.stringify(integritySha256, null, 2);
  entries.push({ path: 'integrity.sha256', bytes: utf8Encode(integrityJson), text: integrityJson });

  const zipWriterStream = new Uint8ArrayWriter();
  const isZipAes = input.options.containerMode === 'aes_zip';
  const zipWriter = new ZipWriter(
    zipWriterStream,
    isZipAes
      ? {
          password: input.options.password,
          encryptionStrength: 3,
          zipCrypto: false,
          useUnicodeFileNames: true,
        }
      : {
          useUnicodeFileNames: true,
        },
  );

  for (const entry of entries) {
    if (input.signal?.aborted) {
      throw new ArchiveError('CANCELLED', 'Export cancelled during ZIP packing');
    }
    if (entry.text !== undefined) {
      await zipWriter.add(entry.path, new TextReader(entry.text), { level: 6 });
    } else {
      await zipWriter.add(entry.path, new Uint8ArrayReader(entry.bytes), { level: 0 });
    }
  }
  const zipBytes = await zipWriter.close();

  const safeSlug = sanitizeZipFilenameComponent(input.roomDisplayName).toLowerCase().replace(/\s+/g, '-');
  const dateStamp = manifest.createdAtUtc.slice(0, 10);

  if (input.options.containerMode === 'aes_zip') {
    input.onProgress?.({ phase: 'complete', percent: 100, detail: 'AES-256 ZIP archive ready' });
    return {
      bytes: zipBytes,
      filename: `cloak-${safeSlug}-${dateStamp}.zip`,
      mimeType: 'application/zip',
      manifest,
      integritySha256,
      warnings,
    };
  }

  input.onProgress?.({ phase: 'encrypting', percent: 70, detail: 'Encrypting with Argon2id + XChaCha20-Poly1305' });
  const containerBytes = await encryptCloakExportContainer({
    zipBytes,
    password: input.options.password,
    argon2Params: input.options.argon2Params,
    signal: input.signal,
    onProgress: (pct) => {
      input.onProgress?.({
        phase: 'encrypting',
        percent: 70 + Math.round(pct * 0.3),
        detail: 'Streaming authenticated archive encryption',
      });
    },
  });

  input.onProgress?.({ phase: 'complete', percent: 100, detail: 'Encrypted .cloakexport ready' });
  return {
    bytes: containerBytes,
    filename: `cloak-${safeSlug}-${dateStamp}.cloakexport`,
    mimeType: 'application/octet-stream',
    manifest,
    integritySha256,
    warnings,
  };
}

export async function openChatExportArchive(params: {
  archiveBytes: Uint8Array;
  password: string;
}): Promise<OpenedArchiveData> {
  if (!params.password) {
    throw new ArchiveError('PASSWORD_REQUIRED', 'Password is required to decrypt an archive');
  }

  let containerMode: 'cloakexport' | 'aes_zip';
  let zipBytes: Uint8Array;

  if (isCloakExportContainer(params.archiveBytes)) {
    containerMode = 'cloakexport';
    const dec = await decryptCloakExportContainer({
      containerBytes: params.archiveBytes,
      password: params.password,
    });
    zipBytes = dec.zipBytes;
  } else if (isZipContainer(params.archiveBytes)) {
    containerMode = 'aes_zip';
    zipBytes = params.archiveBytes;
  } else {
    throw new ArchiveError('CORRUPTED_CONTAINER', 'Unrecognized archive format (expected .cloakexport or .zip)');
  }

  const zipReader = new ZipReader(new Uint8ArrayReader(zipBytes));
  try {
    const entries = await zipReader.getEntries();
    if (entries.length === 0 || entries.length > CLIENT_LIMITS.maxUnpackEntryCount) {
      throw new ArchiveError('DECOMPRESSION_BOMB', 'Archive contains empty or excessive entry count');
    }

    const seenNames = new Set<string>();
    const decodedFiles = new Map<string, Uint8Array>();
    let cumulativeUncompressed = 0;

    for (const entry of entries) {
      validateArchiveEntryPath(entry.filename);
      if (seenNames.has(entry.filename)) {
        throw new ArchiveError('UNSAFE_ARCHIVE_ENTRY', `Duplicate entry rejected: ${entry.filename}`);
      }
      seenNames.add(entry.filename);

      if (entry.directory) continue;
      if (entry.uncompressedSize > CLIENT_LIMITS.maxUnpackEntryBytes) {
        throw new ArchiveError('DECOMPRESSION_BOMB', `Entry exceeds max size: ${entry.filename}`);
      }
      if (
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > CLIENT_LIMITS.maxCompressionRatio
      ) {
        throw new ArchiveError('DECOMPRESSION_BOMB', `Suspicious compression ratio on ${entry.filename}`);
      }

      let rawBytes: Uint8Array;
      try {
        rawBytes = await entry.getData(
          new Uint8ArrayWriter(),
          containerMode === 'aes_zip' ? { password: params.password } : undefined,
        );
      } catch {
        throw new ArchiveError(
          'WRONG_PASSWORD_OR_CORRUPTED',
          'Incorrect archive password or corrupted ZIP entry',
        );
      }

      if (rawBytes.byteLength > CLIENT_LIMITS.maxUnpackEntryBytes) {
        throw new ArchiveError('DECOMPRESSION_BOMB', `Decoded entry exceeds max size: ${entry.filename}`);
      }
      cumulativeUncompressed += rawBytes.byteLength;
      if (cumulativeUncompressed > CLIENT_LIMITS.maxUnpackArchiveBytes) {
        throw new ArchiveError('DECOMPRESSION_BOMB', 'Total extracted archive size exceeds safe limit');
      }
      decodedFiles.set(entry.filename, rawBytes);
    }

    const manifestBytes = decodedFiles.get('manifest.json');
    const integrityBytes = decodedFiles.get('integrity.sha256');
    if (!manifestBytes || !integrityBytes) {
      throw new ArchiveError('CORRUPTED_CONTAINER', 'Missing required manifest.json or integrity.sha256');
    }

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const manifest = JSON.parse(decoder.decode(manifestBytes)) as ExportManifest;
    if (manifest?.appId !== 'cloak' || manifest?.archiveFormatVersion !== 1) {
      throw new ArchiveError('UNSUPPORTED_VERSION', 'Unsupported Cloak archive manifest');
    }

    const integritySha256 = JSON.parse(decoder.decode(integrityBytes)) as Record<string, string>;

    for (const path of decodedFiles.keys()) {
      if (path !== 'integrity.sha256' && !Object.prototype.hasOwnProperty.call(integritySha256, path)) {
        throw new ArchiveError('TAMPERED_INTEGRITY', `Unlisted archive entry detected: ${path}`);
      }
    }

    for (const [path, expectedHex] of Object.entries(integritySha256)) {
      const content = decodedFiles.get(path);
      if (!content) {
        throw new ArchiveError('TAMPERED_INTEGRITY', `Archived file missing from integrity check: ${path}`);
      }
      const actualHex = await sha256Hex(content);
      if (actualHex !== expectedHex.toLowerCase()) {
        throw new ArchiveError('TAMPERED_INTEGRITY', `SHA-256 mismatch on ${path}`);
      }
    }

    const messagesRaw = decodedFiles.get('messages.json');
    const messagesDoc = messagesRaw
      ? (JSON.parse(decoder.decode(messagesRaw)) as ArchiveMessagesDocument)
      : null;

    const transcriptRaw = decodedFiles.get('transcript.txt');
    const transcriptTxt = transcriptRaw ? decoder.decode(transcriptRaw) : null;

    const htmlRaw = decodedFiles.get('index.html');
    const htmlContent = htmlRaw ? decoder.decode(htmlRaw) : null;

    const attachments = new Map<string, ArchiveAttachmentEntry>();
    if (messagesDoc) {
      for (const msg of messagesDoc.messages) {
        for (const att of msg.attachments) {
          if (att.archivePath && decodedFiles.has(att.archivePath) && !attachments.has(att.archivePath)) {
            attachments.set(att.archivePath, {
              archivePath: att.archivePath,
              filename: att.filename,
              mimeType: att.mimeType,
              bytes: decodedFiles.get(att.archivePath)!,
              sha256Hex: att.plaintextSha256Hex,
            });
          }
        }
      }
    } else {
      for (const [path, bytes] of decodedFiles.entries()) {
        if (path.startsWith('attachments/')) {
          attachments.set(path, {
            archivePath: path,
            filename: path.slice('attachments/'.length),
            mimeType: 'application/octet-stream',
            bytes,
            sha256Hex: integritySha256[path] ?? (await sha256Hex(bytes)),
          });
        }
      }
    }

    return {
      containerMode,
      manifest,
      messagesDoc,
      transcriptTxt,
      htmlContent,
      attachments,
      integritySha256,
      integrityVerified: true,
      rawEntries: Array.from(decodedFiles.keys()),
    };
  } finally {
    await zipReader.close();
  }
}

export async function verifyTextArchiveEntryHash(bytes: Uint8Array, expectedHex: string): Promise<boolean> {
  return (await sha256Hex(bytes)) === expectedHex.toLowerCase();
}

export function extractTextEntryReader(text: string): TextReader {
  return new TextReader(text);
}

export function createMemoryTextWriter(): TextWriter {
  return new TextWriter();
}
