import { getApiBaseUrl } from '@cloak/config';
import type {
  AttachmentMetadataDto,
  AuthChallengeResponse,
  AuthSessionResponse,
  ChannelSummary,
  DeletionScope,
  DeviceProfile,
  EncryptedMessageDto,
  EpochKeyEnvelopeDto,
  InviteInspectionResponse,
  InviteSummary,
  LiveKitCallTokenResponse,
  RoleName,
  RoomMemberSummary,
  RoomSyncResponse,
  RoomSummary,
} from '@cloak/protocol';

export interface RoomDetailResponse {
  room: RoomSummary;
  members: RoomMemberSummary[];
  myEpochEnvelopes: EpochKeyEnvelopeDto[];
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

let currentToken: string | null = null;
let onUnauthorizedRefresh: (() => Promise<string | null>) | null = null;

export function setApiAccessToken(token: string | null): void {
  currentToken = token;
}

export function getApiAccessToken(): string | null {
  return currentToken;
}

export function setUnauthorizedRefreshHandler(fn: (() => Promise<string | null>) | null): void {
  onUnauthorizedRefresh = fn;
}

function apiUrl(path: string): string {
  const base = getApiBaseUrl().replace(/\/$/, '');
  return `${base}/api/v1${path}`;
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  retryOn401 = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof Uint8Array) && !(init.body instanceof ArrayBuffer) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (currentToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${currentToken}`);
  }

  const res = await fetch(apiUrl(path), { ...init, headers });

  if (res.status === 401 && retryOn401 && onUnauthorizedRefresh) {
    const newToken = await onUnauthorizedRefresh();
    if (newToken) {
      currentToken = newToken;
      return requestJson<T>(path, init, false);
    }
  }

  if (!res.ok) {
    let code = 'http_error';
    let msg = `Request failed (${res.status})`;
    try {
      const errBody = (await res.json()) as { message?: string; error?: string; code?: string };
      if (errBody.code) code = errBody.code;
      if (errBody.message) msg = errBody.message;
      else if (errBody.error) msg = errBody.error;
    } catch {
      // ignore non-json body
    }
    throw new ApiClientError(res.status, code, msg);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => requestJson<{ status: string; version: string }>('/health', {}, false),

  registerDevice: (payload: {
    deviceId: string;
    ed25519PublicKeyB64: string;
    x25519PublicKeyB64: string;
    displayName?: string;
    avatarColor?: string;
    avatarEmoji?: string | null;
    signatureB64: string;
  }) => requestJson<AuthSessionResponse>('/devices/register', { method: 'POST', body: JSON.stringify(payload) }, false),

  updateProfile: (payload: { displayName?: string; avatarColor?: string; avatarEmoji?: string | null }) =>
    requestJson<DeviceProfile>('/devices/me', { method: 'PATCH', body: JSON.stringify(payload) }),

  requestChallenge: (deviceId: string) =>
    requestJson<AuthChallengeResponse>('/auth/challenge', { method: 'POST', body: JSON.stringify({ deviceId }) }, false),

  exchangeSession: (payload: { deviceId: string; challengeId: string; signatureB64: string }) =>
    requestJson<AuthSessionResponse>('/auth/session', { method: 'POST', body: JSON.stringify(payload) }, false),

  logout: () => requestJson<{ loggedOut: boolean }>('/auth/logout', { method: 'POST' }, false),

  listRooms: () => requestJson<RoomSummary[]>('/rooms'),

  createRoom: (payload: {
    roomId?: string;
    roomKind: 'dm' | 'group' | 'community';
    name: string;
    description?: string;
    defaultDisappearSeconds?: number | null;
    ownerWrappedEpochKeyB64: string;
    ownerX25519PublicKeyB64: string;
  }) => requestJson<RoomDetailResponse>('/rooms', { method: 'POST', body: JSON.stringify(payload) }),

  getRoom: (roomId: string) => requestJson<RoomDetailResponse>(`/rooms/${roomId}`),

  updateRoom: (
    roomId: string,
    payload: { name?: string; description?: string; defaultDisappearSeconds?: number | null },
  ) => requestJson<RoomDetailResponse>(`/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  createChannel: (
    roomId: string,
    payload: {
      categoryName?: string | null;
      name: string;
      topic?: string;
      channelType: 'text' | 'voice' | 'announcement';
      isPrivate?: boolean;
      slowModeSeconds?: number;
      disappearSeconds?: number | null;
    },
  ) => requestJson<ChannelSummary>(`/rooms/${roomId}/channels`, { method: 'POST', body: JSON.stringify(payload) }),

  updateChannel: (
    roomId: string,
    channelId: string,
    payload: {
      categoryName?: string | null;
      name?: string;
      topic?: string;
      isPrivate?: boolean;
      slowModeSeconds?: number;
      disappearSeconds?: number | null;
    },
  ) =>
    requestJson<ChannelSummary>(`/rooms/${roomId}/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteChannel: (roomId: string, channelId: string) =>
    requestJson<{ deleted: boolean }>(`/rooms/${roomId}/channels/${channelId}`, { method: 'DELETE' }),

  rotateEpoch: (
    roomId: string,
    payload: {
      reason?: string;
      senderX25519PublicKeyB64: string;
      envelopes: Array<{ recipientDeviceId: string; wrappedKeyCiphertextB64: string }>;
    },
  ) =>
    requestJson<{ newEpoch: number }>(`/rooms/${roomId}/epochs/rotate`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  burnRoomHistory: (
    roomId: string,
    payload: {
      senderX25519PublicKeyB64: string;
      envelopes: Array<{ recipientDeviceId: string; wrappedKeyCiphertextB64: string }>;
    },
  ) =>
    requestJson<{ burned: boolean; newEpoch: number }>(`/rooms/${roomId}/burn`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  createInvite: (
    roomId: string,
    payload: {
      inviteToken: string;
      roleName?: 'admin' | 'member' | 'readonly';
      accessScope?: 'read_only' | 'read_write';
      requiresApproval?: boolean;
      password?: string;
      wrappedEpoch: number;
      wrappedRoomKeyBlobB64: string;
      maxUses?: number | null;
      expiresInHours?: number | null;
    },
  ) => requestJson<InviteSummary>(`/rooms/${roomId}/invites`, { method: 'POST', body: JSON.stringify(payload) }),

  listInvites: (roomId: string) => requestJson<InviteSummary[]>(`/rooms/${roomId}/invites`),

  revokeInvite: (roomId: string, inviteId: string) =>
    requestJson<{ revoked: boolean }>(`/rooms/${roomId}/invites/${inviteId}`, { method: 'DELETE' }),

  inspectInvite: (token: string) =>
    requestJson<InviteInspectionResponse>(`/invites/inspect?token=${encodeURIComponent(token)}`, {}, false),

  joinInvite: (payload: {
    token: string;
    password?: string;
    selfWrappedEpochKeyB64?: string;
    x25519PublicKeyB64?: string;
  }) =>
    requestJson<{ status: 'active' | 'pending_approval'; roomId: string; roomDetail: RoomDetailResponse | null }>(
      '/invites/join',
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  approveMember: (
    roomId: string,
    deviceId: string,
    payload: {
      senderX25519PublicKeyB64: string;
      envelopes: Array<{ recipientDeviceId: string; wrappedKeyCiphertextB64: string }>;
    },
  ) =>
    requestJson<{ approved: boolean }>(`/rooms/${roomId}/members/${deviceId}/approve`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateMemberRole: (roomId: string, deviceId: string, roleName: Exclude<RoleName, 'owner'>) =>
    requestJson<{ updated: boolean }>(`/rooms/${roomId}/members/${deviceId}/role`, {
      method: 'POST',
      body: JSON.stringify({ roleName }),
    }),

  removeMember: (
    roomId: string,
    deviceId: string,
    payload: {
      action: 'kick' | 'ban';
      senderX25519PublicKeyB64?: string;
      rotatedEnvelopes?: Array<{ recipientDeviceId: string; wrappedKeyCiphertextB64: string }>;
    },
  ) =>
    requestJson<{ removed: boolean }>(`/rooms/${roomId}/members/${deviceId}/remove`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  sendMessage: (
    roomId: string,
    channelId: string,
    payload: {
      messageId: string;
      idempotencyKey: string;
      encryptionEpoch: number;
      ciphertextB64: string;
      replyToMessageId?: string | null;
      threadRootId?: string | null;
      attachmentIds?: string[];
      expireInSeconds?: number | null;
      expireAfterReadSeconds?: number | null;
    },
  ) =>
    requestJson<EncryptedMessageDto>(`/rooms/${roomId}/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getChannelMessages: (roomId: string, channelId: string, beforeSeq?: number, limit = 50) => {
    const qs = new URLSearchParams();
    if (beforeSeq !== undefined) qs.set('beforeSeq', String(beforeSeq));
    qs.set('limit', String(limit));
    return requestJson<EncryptedMessageDto[]>(
      `/rooms/${roomId}/channels/${channelId}/messages?${qs.toString()}`,
    );
  },

  clearChannel: (roomId: string, channelId: string) =>
    requestJson<{ cleared: boolean }>(`/rooms/${roomId}/channels/${channelId}/clear`, { method: 'POST' }),

  syncRoom: (roomId: string, afterSeq: number, limit = 200) =>
    requestJson<RoomSyncResponse>(`/rooms/${roomId}/sync?afterSeq=${afterSeq}&limit=${limit}`),

  editMessage: (roomId: string, messageId: string, ciphertextB64: string) =>
    requestJson<EncryptedMessageDto>(`/rooms/${roomId}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ciphertextB64 }),
    }),

  deleteMessage: (roomId: string, messageId: string, scope: Extract<DeletionScope, 'device' | 'everyone'> | 'me') =>
    requestJson<{ deleted: boolean }>(
      `/rooms/${roomId}/messages/${messageId}?scope=${encodeURIComponent(scope)}`,
      { method: 'DELETE' },
    ),

  reactMessage: (roomId: string, messageId: string, encryptedPayloadB64: string) =>
    requestJson<{ eventSeq: number }>(`/rooms/${roomId}/messages/${messageId}/react`, {
      method: 'POST',
      body: JSON.stringify({ encryptedPayloadB64 }),
    }),

  pinMessage: (roomId: string, messageId: string) =>
    requestJson<{ pinned: boolean }>(`/rooms/${roomId}/messages/${messageId}/pin`, { method: 'POST' }),

  unpinMessage: (roomId: string, messageId: string) =>
    requestJson<{ unpinned: boolean }>(`/rooms/${roomId}/messages/${messageId}/pin`, { method: 'DELETE' }),

  initAttachment: (
    roomId: string,
    payload: {
      encryptionEpoch: number;
      expectedCiphertextBytes: number;
      chunkSizeBytes: number;
      totalChunks: number;
      streamHeaderB64: string;
    },
  ) =>
    requestJson<AttachmentMetadataDto>(`/rooms/${roomId}/attachments/init`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  uploadAttachmentChunk: async (attachmentId: string, chunkIndex: number, encryptedChunk: Uint8Array) => {
    const res = await fetch(apiUrl(`/attachments/${attachmentId}/chunks/${chunkIndex}`), {
      method: 'PUT',
      headers: {
        Authorization: currentToken ? `Bearer ${currentToken}` : '',
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(encryptedChunk).buffer,
    });
    if (!res.ok) {
      throw new ApiClientError(res.status, 'upload_failed', `Chunk ${chunkIndex} failed (${res.status})`);
    }
    return (await res.json()) as { chunkIndex: number; storedBytes: number };
  },

  completeAttachment: (attachmentId: string) =>
    requestJson<AttachmentMetadataDto>(`/attachments/${attachmentId}/complete`, { method: 'POST' }),

  getAttachmentMeta: (attachmentId: string) =>
    requestJson<AttachmentMetadataDto>(`/attachments/${attachmentId}`),

  downloadAttachmentChunk: async (attachmentId: string, chunkIndex: number): Promise<Uint8Array> => {
    const res = await fetch(apiUrl(`/attachments/${attachmentId}/chunks/${chunkIndex}`), {
      headers: currentToken ? { Authorization: `Bearer ${currentToken}` } : {},
    });
    if (!res.ok) {
      throw new ApiClientError(res.status, 'download_failed', `Attachment chunk ${chunkIndex} unavailable`);
    }
    return new Uint8Array(await res.arrayBuffer());
  },

  deleteAttachment: (attachmentId: string) =>
    requestJson<{ deleted: boolean }>(`/attachments/${attachmentId}`, { method: 'DELETE' }),

  listRoomAttachments: (roomId: string) =>
    requestJson<AttachmentMetadataDto[]>(`/rooms/${roomId}/attachments`),

  issueCallToken: (roomId: string, channelId: string) =>
    requestJson<LiveKitCallTokenResponse>(`/rooms/${roomId}/channels/${channelId}/call-token`, {
      method: 'POST',
    }),
};
