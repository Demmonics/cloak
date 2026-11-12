import type { ExportContainerMode, ExportFormat, ExportManifest, ExportScope } from '@cloak/protocol';
import type { Argon2Params } from '@cloak/crypto';

export class ArchiveError extends Error {
  constructor(
    public readonly code:
      | 'PASSWORD_REQUIRED'
      | 'WRONG_PASSWORD_OR_CORRUPTED'
      | 'CORRUPTED_CONTAINER'
      | 'TAMPERED_INTEGRITY'
      | 'UNSAFE_ARCHIVE_ENTRY'
      | 'DECOMPRESSION_BOMB'
      | 'UNSUPPORTED_VERSION'
      | 'CANCELLED',
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ExportChannelRecord {
  id: string;
  name: string;
  channelType: 'text' | 'voice' | 'announcement';
  topic?: string;
}

export interface ExportAttachmentRecord {
  attachmentId: string;
  filename: string;
  mimeType: string;
  plaintextSizeBytes: number;
  plaintextSha256Hex: string;
  bytes?: Uint8Array;
  unavailableReason?: string;
}

export interface ExportReactionRecord {
  emoji: string;
  count: number;
  reactorDeviceIds: string[];
}

export interface ExportMessageRecord {
  id: string;
  channelId: string;
  channelName: string;
  senderDeviceId: string;
  senderDisplayName: string;
  senderAvatarColor: string;
  createdAtUtc: string;
  editedAtUtc: string | null;
  expiresAtUtc: string | null;
  deletedForMe?: boolean;
  deletedForEveryoneAtUtc?: string | null;
  text: string;
  replyToMessageId?: string | null;
  replyPreviewText?: string | null;
  threadRootId?: string | null;
  isPinned?: boolean;
  reactions: ExportReactionRecord[];
  attachments: ExportAttachmentRecord[];
  signatureVerified: boolean;
}

export interface ExportBuildInput {
  roomId: string;
  roomDisplayName: string;
  syncCursorSeq: number;
  lastSuccessfulSyncAtUtc: string | null;
  isHistoricalOfflineSnapshot: boolean;
  timezone?: string;
  channels: ExportChannelRecord[];
  participants: Array<{ deviceId: string; displayName: string; avatarColor: string }>;
  messages: ExportMessageRecord[];
  options: {
    format: ExportFormat;
    scope: ExportScope;
    selectedChannelIds?: string[];
    selectedMessageIds?: string[];
    dateRangeStartUtc?: string;
    dateRangeEndUtc?: string;
    includeAttachments: boolean;
    containerMode: ExportContainerMode;
    password: string;
    argon2Params?: Argon2Params;
  };
  onProgress?: (progress: ExportBuildProgress) => void;
  signal?: AbortSignal;
}

export interface ExportBuildProgress {
  phase: 'filtering' | 'packaging' | 'encrypting' | 'complete';
  percent: number;
  detail: string;
}

export interface ExportBuildResult {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  manifest: ExportManifest;
  integritySha256: Record<string, string>;
  warnings: string[];
}

export interface ArchiveMessagesDocument {
  manifest: ExportManifest;
  channels: ExportChannelRecord[];
  messages: Array<{
    id: string;
    channelId: string;
    channelName: string;
    senderDeviceId: string;
    senderDisplayName: string;
    createdAtUtc: string;
    editedAtUtc: string | null;
    text: string;
    replyToMessageId: string | null;
    replyPreviewText: string | null;
    threadRootId: string | null;
    isPinned: boolean;
    reactions: ExportReactionRecord[];
    signatureVerified: boolean;
    attachments: Array<{
      attachmentId: string;
      filename: string;
      archivePath: string | null;
      mimeType: string;
      plaintextSizeBytes: number;
      plaintextSha256Hex: string;
      unavailableReason: string | null;
    }>;
  }>;
}

export interface ArchiveAttachmentEntry {
  archivePath: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  sha256Hex: string;
}

export interface OpenedArchiveData {
  containerMode: ExportContainerMode;
  manifest: ExportManifest;
  messagesDoc: ArchiveMessagesDocument | null;
  transcriptTxt: string | null;
  htmlContent: string | null;
  attachments: Map<string, ArchiveAttachmentEntry>;
  integritySha256: Record<string, string>;
  integrityVerified: boolean;
  rawEntries: string[];
}

