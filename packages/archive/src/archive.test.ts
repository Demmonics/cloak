import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { sha256Hex, utf8Encode } from '@cloak/crypto';
import { describe, expect, it } from 'vitest';
import {
  ArchiveError,
  classifySafeAttachmentRenderMode,
  createChatExportArchive,
  openChatExportArchive,
  validateArchiveEntryPath,
} from './index.js';
import type { ExportBuildInput } from './types.js';

const FAST_ARGON2 = { opslimit: 2, memlimitBytes: 8 * 1024 * 1024 };

function sampleInput(overrides?: Partial<ExportBuildInput['options']>): ExportBuildInput {
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const svgBytes = utf8Encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  return {
    roomId: 'room-111',
    roomDisplayName: 'Research & Signal 🔐',
    syncCursorSeq: 42,
    lastSuccessfulSyncAtUtc: '2026-10-15T10:00:00.000Z',
    isHistoricalOfflineSnapshot: false,
    timezone: 'UTC',
    channels: [
      { id: 'c1', name: 'general', channelType: 'text' },
      { id: 'c2', name: 'files', channelType: 'text' },
    ],
    participants: [
      { deviceId: 'dev-a', displayName: 'Alice <script>alert(1)</script>', avatarColor: '#7c6cff' },
      { deviceId: 'dev-b', displayName: 'Bob 👋', avatarColor: '#38bdf8' },
    ],
    messages: [
      {
        id: 'm1',
        channelId: 'c1',
        channelName: 'general',
        senderDeviceId: 'dev-a',
        senderDisplayName: 'Alice <script>alert(1)</script>',
        senderAvatarColor: '#7c6cff',
        createdAtUtc: '2026-10-15T09:00:00.000Z',
        editedAtUtc: null,
        expiresAtUtc: null,
        text: 'Hello! Check [safe](https://example.com) and [xss](javascript:alert(1)) & raw <script>alert(2)</script> <img src=x onerror=alert(2)> and code `<img src=x onerror=alert(1)>`',
        reactions: [{ emoji: '🔥', count: 2, reactorDeviceIds: ['dev-a', 'dev-b'] }],
        attachments: [],
        signatureVerified: true,
      },
      {
        id: 'm2',
        channelId: 'c2',
        channelName: 'files',
        senderDeviceId: 'dev-b',
        senderDisplayName: 'Bob 👋',
        senderAvatarColor: '#38bdf8',
        createdAtUtc: '2026-10-15T09:05:00.000Z',
        editedAtUtc: '2026-10-15T09:06:00.000Z',
        expiresAtUtc: null,
        text: 'Attached PNG & SVG',
        replyToMessageId: 'm1',
        replyPreviewText: 'Hello!',
        isPinned: true,
        reactions: [],
        attachments: [
          {
            attachmentId: '11111111-1111-4111-8111-111111111111',
            filename: 'chart.png',
            mimeType: 'image/png',
            plaintextSizeBytes: pngBytes.byteLength,
            plaintextSha256Hex: 'dummy',
            bytes: pngBytes,
          },
          {
            attachmentId: '22222222-2222-4222-8222-222222222222',
            filename: 'diagram.svg',
            mimeType: 'image/svg+xml',
            plaintextSizeBytes: svgBytes.byteLength,
            plaintextSha256Hex: 'dummy2',
            bytes: svgBytes,
          },
        ],
        signatureVerified: true,
      },
      {
        id: 'm-del-me',
        channelId: 'c1',
        channelName: 'general',
        senderDeviceId: 'dev-a',
        senderDisplayName: 'Alice',
        senderAvatarColor: '#7c6cff',
        createdAtUtc: '2026-10-15T09:10:00.000Z',
        editedAtUtc: null,
        expiresAtUtc: null,
        deletedForMe: true,
        text: 'SECRET DELETED FOR ME MUST NOT EXPORT',
        reactions: [],
        attachments: [],
        signatureVerified: true,
      },
      {
        id: 'm-del-all',
        channelId: 'c1',
        channelName: 'general',
        senderDeviceId: 'dev-b',
        senderDisplayName: 'Bob 👋',
        senderAvatarColor: '#38bdf8',
        createdAtUtc: '2026-10-15T09:12:00.000Z',
        editedAtUtc: null,
        expiresAtUtc: null,
        deletedForEveryoneAtUtc: '2026-10-15T09:15:00.000Z',
        text: 'SECRET DELETED FOR EVERYONE MUST NOT EXPORT',
        reactions: [],
        attachments: [],
        signatureVerified: true,
      },
      {
        id: 'm-expired',
        channelId: 'c1',
        channelName: 'general',
        senderDeviceId: 'dev-a',
        senderDisplayName: 'Alice',
        senderAvatarColor: '#7c6cff',
        createdAtUtc: '2026-10-15T09:14:00.000Z',
        editedAtUtc: null,
        expiresAtUtc: '2020-01-01T00:00:00.000Z',
        text: 'SECRET EXPIRED DISAPPEARING MUST NOT EXPORT',
        reactions: [],
        attachments: [],
        signatureVerified: true,
      },
    ],
    options: {
      format: 'complete',
      scope: 'all',
      includeAttachments: true,
      containerMode: 'cloakexport',
      password: 'vault-export-password-2026',
      argon2Params: FAST_ARGON2,
      ...overrides,
    },
  };
}

describe('@cloak/archive', () => {
  it('refuses to build an export without a non-empty strong password', async () => {
    await expect(createChatExportArchive(sampleInput({ password: '' }))).rejects.toThrow(ArchiveError);
    await expect(createChatExportArchive(sampleInput({ password: '123' }))).rejects.toThrow(ArchiveError);
  });

  it('creates and decrypts complete .cloakexport container, excludes deleted/expired messages, and sanitizes XSS', async () => {
    const phases: string[] = [];
    const built = await createChatExportArchive({
      ...sampleInput(),
      onProgress: (p) => phases.push(p.phase),
    });

    expect(built.filename.endsWith('.cloakexport')).toBe(true);
    expect(built.manifest.includedMessageCount).toBe(2);
    expect(built.manifest.includedAttachmentCount).toBe(2);
    expect(phases).toContain('complete');

    // Wrong password fails cleanly
    await expect(
      openChatExportArchive({ archiveBytes: built.bytes, password: 'wrong-password' }),
    ).rejects.toThrow(ArchiveError);

    // Correct password opens & verifies integrity
    const opened = await openChatExportArchive({
      archiveBytes: built.bytes,
      password: 'vault-export-password-2026',
    });

    expect(opened.integrityVerified).toBe(true);
    expect(opened.messagesDoc?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(opened.attachments.size).toBe(2);

    // Deleted & expired content never appears anywhere
    expect(opened.transcriptTxt).not.toContain('MUST NOT EXPORT');
    expect(opened.htmlContent).not.toContain('MUST NOT EXPORT');
    expect(JSON.stringify(opened.messagesDoc)).not.toContain('MUST NOT EXPORT');

    // Offline HTML contains strict CSP, zero <script> tags, zero external stylesheet/script links, and downloads SVGs rather than <img>
    expect(opened.htmlContent).toContain("script-src 'none'");
    expect(opened.htmlContent).not.toMatch(/<script[\s>]/i);
    expect(opened.htmlContent).not.toContain('javascript:alert(1)');
    expect(opened.htmlContent).not.toContain('<img src=x');
    expect(opened.htmlContent).toContain('<img src="./attachments/11111111-chart.png"');
    expect(opened.htmlContent).toContain('download="diagram.svg"');
    expect(opened.htmlContent).not.toContain('<img src="./attachments/22222222-diagram.svg"');
    expect(classifySafeAttachmentRenderMode('image/svg+xml', 'diagram.svg')).toBe('download_only');
  });

  it('supports optional AES-256 ZIP mode with clear metadata warning and password check', async () => {
    const built = await createChatExportArchive(sampleInput({ containerMode: 'aes_zip' }));
    expect(built.filename.endsWith('.zip')).toBe(true);
    expect(built.warnings.some((w) => w.includes('central directory filenames'))).toBe(true);

    await expect(
      openChatExportArchive({ archiveBytes: built.bytes, password: 'wrong-password' }),
    ).rejects.toThrow(ArchiveError);

    const opened = await openChatExportArchive({
      archiveBytes: built.bytes,
      password: 'vault-export-password-2026',
    });
    expect(opened.containerMode).toBe('aes_zip');
    expect(opened.integrityVerified).toBe(true);
    expect(opened.messagesDoc?.messages).toHaveLength(2);
  });

  it('detects ciphertext tampering, truncation, and trailing byte injection on .cloakexport', async () => {
    const built = await createChatExportArchive(sampleInput());

    // Flip a byte near the end
    const flipped = new Uint8Array(built.bytes);
    flipped[flipped.length - 5]! ^= 0xff;
    await expect(
      openChatExportArchive({ archiveBytes: flipped, password: 'vault-export-password-2026' }),
    ).rejects.toThrow(ArchiveError);

    // Truncate stream
    const truncated = built.bytes.subarray(0, built.bytes.byteLength - 40);
    await expect(
      openChatExportArchive({ archiveBytes: truncated, password: 'vault-export-password-2026' }),
    ).rejects.toThrow(ArchiveError);

    // Append trailing garbage
    const extended = new Uint8Array(built.bytes.byteLength + 8);
    extended.set(built.bytes, 0);
    await expect(
      openChatExportArchive({ archiveBytes: extended, password: 'vault-export-password-2026' }),
    ).rejects.toThrow(ArchiveError);
  });

  it('rejects Zip-Slip entry paths and SHA-256 integrity mismatches', async () => {
    expect(() => validateArchiveEntryPath('../evil.txt')).toThrow(ArchiveError);
    expect(() => validateArchiveEntryPath('C:\\Windows\\win.ini')).toThrow(ArchiveError);
    expect(() => validateArchiveEntryPath('/etc/passwd')).toThrow(ArchiveError);

    // Craft an AES ZIP whose file SHA-256 disagrees with integrity.sha256
    const writer = new Uint8ArrayWriter();
    const zw = new ZipWriter(writer, { password: 'pw', encryptionStrength: 3, zipCrypto: false });
    const manifestJson = JSON.stringify({
      appId: 'cloak',
      archiveFormatVersion: 1,
      exportFormat: 'txt',
      containerMode: 'aes_zip',
      createdAtUtc: new Date().toISOString(),
      roomId: 'r1',
      roomDisplayName: 'Test',
      syncCursorSeq: 1,
      lastSuccessfulSyncAtUtc: null,
      isHistoricalOfflineSnapshot: false,
      timezone: 'UTC',
      participants: [],
      includedMessageCount: 0,
      includedAttachmentCount: 0,
      includedAttachmentBytes: 0,
      options: {
        format: 'txt',
        scope: 'all',
        includeAttachments: false,
        passwordProtected: true,
        respectDeletedMessageState: true,
      },
      files: [],
      warnings: [],
    });
    const txt = 'tampered';
    const fakeIntegrity = JSON.stringify({
      'manifest.json': await sha256Hex(manifestJson),
      'transcript.txt': '0'.repeat(64),
    });
    await zw.add('manifest.json', new TextReader(manifestJson));
    await zw.add('transcript.txt', new TextReader(txt));
    await zw.add('integrity.sha256', new TextReader(fakeIntegrity));
    const zipBytes = await zw.close();

    await expect(openChatExportArchive({ archiveBytes: zipBytes, password: 'pw' })).rejects.toThrow(
      /SHA-256 mismatch/,
    );
  });

  it('respects scope filters, attachment exclusion, offline snapshot warning, and AbortSignal', async () => {
    const input = sampleInput({
      scope: 'selected',
      selectedChannelIds: ['c1'],
      includeAttachments: false,
    });
    input.isHistoricalOfflineSnapshot = true;

    const res = await createChatExportArchive(input);
    expect(res.manifest.includedMessageCount).toBe(1);
    expect(res.manifest.includedAttachmentCount).toBe(0);
    expect(res.warnings.some((w) => w.includes('offline'))).toBe(true);

    const opened = await openChatExportArchive({
      archiveBytes: res.bytes,
      password: 'vault-export-password-2026',
    });
    expect(opened.htmlContent).toContain('Historical Offline Snapshot');

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(createChatExportArchive({ ...sampleInput(), signal: ctrl.signal })).rejects.toThrow(
      ArchiveError,
    );
  });
});
