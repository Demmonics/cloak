export const PROTOCOL_VERSION = 'v1' as const;

export type RoomKind = 'dm' | 'group' | 'community';
export type ChannelType = 'text' | 'voice' | 'announcement';
export type RoleName = 'owner' | 'admin' | 'member' | 'readonly';
export type MembershipStatus = 'active' | 'pending_approval' | 'removed' | 'banned';
export type InviteAccessScope = 'read_only' | 'read_write';

export type AttachmentState =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'expired'
  | 'deleted'
  | 'unavailable';

export type DeletionScope = 'device' | 'everyone' | 'expired' | 'burned' | 'cleared';

export interface DeviceProfile {
  id: string;
  ed25519PublicKeyB64: string;
  x25519PublicKeyB64: string;
  displayName: string;
  avatarColor: string;
  avatarEmoji?: string | null;
  createdAt: string;
}

export interface AuthChallengeResponse {
  challengeId: string;
  nonceB64: string;
  expiresAt: string;
}

export interface AuthSessionResponse {
  accessToken: string;
  expiresAt: string;
  device: DeviceProfile;
}

export interface ChannelSummary {
  id: string;
  roomId: string;
  categoryName: string | null;
  name: string;
  topic: string;
  channelType: ChannelType;
  position: number;
  isPrivate: boolean;
  slowModeSeconds: number;
  disappearSeconds: number | null;
  createdAt: string;
}

export interface RoomMemberSummary {
  deviceId: string;
  displayName: string;
  avatarColor: string;
  avatarEmoji?: string | null;
  x25519PublicKeyB64: string;
  ed25519PublicKeyB64: string;
  roleName: RoleName;
  status: MembershipStatus;
  joinedAt: string;
}

export interface EpochKeyEnvelopeDto {
  id: string;
  roomId: string;
  epoch: number;
  recipientDeviceId: string;
  senderDeviceId: string;
  senderX25519PublicKeyB64: string;
  wrappedKeyCiphertextB64: string;
}

export interface RoomSummary {
  id: string;
  roomKind: RoomKind;
  name: string;
  description: string;
  ownerDeviceId: string;
  currentEpoch: number;
  defaultDisappearSeconds: number | null;
  quotaBytes: number;
  usedBytes: number;
  nextEventSeq: number;
  myRole: RoleName;
  myStatus: MembershipStatus;
  channels: ChannelSummary[];
  createdAt: string;
}

export interface InviteSummary {
  id: string;
  roomId: string;
  roleName: RoleName;
  accessScope: InviteAccessScope;
  requiresApproval: boolean;
  hasPassword: boolean;
  wrappedEpoch: number;
  maxUses: number | null;
  usesCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface InviteInspectionResponse {
  inviteId: string;
  roomId: string;
  roomName: string;
  roomKind: RoomKind;
  roleName: RoleName;
  accessScope: InviteAccessScope;
  requiresApproval: boolean;
  hasPassword: boolean;
  wrappedEpoch: number;
  wrappedRoomKeyBlobB64: string;
  expiresAt: string | null;
}

export interface DecryptedAttachmentRef {
  attachmentId: string;
  encryptedFilename: string;
  mimeType: string;
  plaintextSizeBytes: number;
  fileKeyB64: string;
  streamHeaderB64: string;
  plaintextSha256Hex: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  thumbnailDataUrl?: string;
}

export interface DecryptedMessageBody {
  version: 1;
  text: string;
  replyToMessageId?: string;
  replyPreviewText?: string;
  replyPreviewSender?: string;
  threadRootId?: string;
  forwardedFromRoom?: string;
  mentions?: string[];
  attachments?: DecryptedAttachmentRef[];
  voiceNote?: boolean;
  editedAt?: string;
  senderSigB64: string;
}

export interface EncryptedMessageDto {
  id: string;
  roomId: string;
  channelId: string;
  senderDeviceId: string;
  idempotencyKey: string;
  encryptionEpoch: number;
  eventSeq: number;
  ciphertextB64: string;
  ciphertextVersion: number;
  replyToMessageId: string | null;
  threadRootId: string | null;
  editedAt: string | null;
  expiresAt: string | null;
  expireAfterReadSeconds: number | null;
  deletedForEveryoneAt: string | null;
  createdAt: string;
}

export interface MessageEventDto {
  id: string;
  roomId: string;
  channelId: string | null;
  messageId: string | null;
  actorDeviceId: string;
  eventSeq: number;
  eventType:
    | 'message.created'
    | 'message.edited'
    | 'message.deleted'
    | 'message.reacted'
    | 'message.pinned'
    | 'message.unpinned'
    | 'room.burned'
    | 'channel.updated'
    | 'member.updated'
    | 'epoch.rotated';
  encryptedPayloadB64: string | null;
  createdAt: string;
}

export interface MessageTombstoneDto {
  id: string;
  roomId: string;
  channelId: string;
  messageId: string;
  scope: DeletionScope;
  targetDeviceId: string | null;
  actorDeviceId: string;
  eventSeq: number;
  createdAt: string;
}

export interface AttachmentMetadataDto {
  id: string;
  roomId: string;
  uploaderDeviceId: string;
  encryptionEpoch: number;
  state: AttachmentState;
  expectedCiphertextBytes: number;
  actualCiphertextBytes: number;
  chunkSizeBytes: number;
  totalChunks: number;
  streamHeaderB64: string;
  expiresAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface RoomSyncResponse {
  roomId: string;
  currentEpoch: number;
  latestEventSeq: number;
  syncedAt: string;
  events: MessageEventDto[];
  tombstones: MessageTombstoneDto[];
  pinnedMessageIds: Record<string, string[]>;
  epochEnvelopes: EpochKeyEnvelopeDto[];
}

export interface LiveKitCallTokenResponse {
  livekitUrl: string;
  token: string;
  livekitRoomName: string;
  callSessionId: string;
  e2eeRequired: boolean;
  expiresAt: string;
}

export type WsClientMessage =
  | { type: 'auth'; accessToken: string }
  | { type: 'subscribe'; roomIds: string[] }
  | { type: 'ping'; ts: number }
  | { type: 'typing'; roomId: string; channelId: string; isTyping: boolean }
  | { type: 'presence'; status: 'online' | 'idle' | 'dnd' };

export type WsServerMessage =
  | { type: 'authenticated'; deviceId: string }
  | { type: 'pong'; ts: number }
  | { type: 'message.created'; message: EncryptedMessageDto }
  | { type: 'message.ack'; idempotencyKey: string; messageId: string; eventSeq: number }
  | { type: 'event'; event: MessageEventDto }
  | { type: 'tombstone'; tombstone: MessageTombstoneDto }
  | { type: 'typing'; roomId: string; channelId: string; deviceId: string; isTyping: boolean }
  | { type: 'presence'; roomId: string; deviceId: string; status: 'online' | 'idle' | 'dnd' | 'offline' }
  | { type: 'error'; code: string; message: string };

export type ExportFormat = 'html' | 'json' | 'txt' | 'complete';
export type ExportScope = 'all' | 'selected' | 'date_range';
export type ExportContainerMode = 'cloakexport' | 'aes_zip';

export interface ExportManifest {
  appId: 'cloak';
  archiveFormatVersion: 1;
  exportFormat: ExportFormat;
  containerMode: ExportContainerMode;
  createdAtUtc: string;
  roomId: string;
  roomDisplayName: string;
  syncCursorSeq: number;
  lastSuccessfulSyncAtUtc: string | null;
  isHistoricalOfflineSnapshot: boolean;
  timezone: string;
  participants: Array<{
    deviceId: string;
    displayName: string;
    avatarColor: string;
  }>;
  includedMessageCount: number;
  includedAttachmentCount: number;
  includedAttachmentBytes: number;
  options: {
    format: ExportFormat;
    scope: ExportScope;
    includeAttachments: boolean;
    passwordProtected: true;
    respectDeletedMessageState: true;
  };
  files: Array<{
    path: string;
    sizeBytes: number;
    sha256Hex: string;
    mimeType: string;
  }>;
  warnings: string[];
}

