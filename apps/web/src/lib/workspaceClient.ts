import { CLIENT_LIMITS } from '@cloak/config';
import type { ExportBuildInput, ExportMessageRecord } from '@cloak/archive';
import {
  decryptAttachmentChunks,
  decryptMessageCiphertext,
  encryptAttachmentChunks,
  encryptMessageBody,
  ensureCryptoReady,
  fromBase64Std,
  generateDeviceIdentity,
  generateRoomEpochKey,
  importEncryptedDeviceBackup,
  randomBytes,
  signAuthChallenge,
  signRegistrationProof,
  toBase64Std,
  toBase64UrlNoPad,
  unwrapEpochKeyEnvelope,
  unwrapRoomKeyFromInvite,
  utf8Decode,
  utf8Encode,
  wipeBytes,
  wrapEpochKeyForRecipient,
  wrapRoomKeyForInvite,
  type DeviceKeyBundle,
} from '@cloak/crypto';
import type {
  DecryptedAttachmentRef,
  DeviceProfile,
  EncryptedMessageDto,
  EpochKeyEnvelopeDto,
  MessageEventDto,
  RoomMemberSummary,
  RoomSummary,
  WsServerMessage,
} from '@cloak/protocol';
import {
  api,
  ApiClientError,
  setApiAccessToken,
  setUnauthorizedRefreshHandler,
  type RoomDetailResponse,
} from './api.js';
import { clientSearch } from './search.js';
import {
  burnRoomLocally,
  db,
  getActiveChannelMessages,
  loadRoomEpochKey,
  purgeChannelLocally,
  purgeDeletedMessageLocally,
  purgeExpiredMessagesLocally,
  saveVaultWithBrowserWrapping,
  saveVaultWithPassphrase,
  storeRoomEpochKey,
  unlockStoredVault,
  upsertLocalMessages,
  type LocalDecryptedMessage,
  type StoredReaction,
} from './storage.js';
import { useAppStore } from '../store/useAppStore.js';

export async function authenticateWithBundle(
  bundle: DeviceKeyBundle,
  profileHint?: { displayName?: string; avatarColor?: string; avatarEmoji?: string | null },
): Promise<DeviceProfile> {
  const refreshFn = async () => {
    try {
      const ch = await api.requestChallenge(bundle.deviceId);
      const sig = await signAuthChallenge(bundle, ch.challengeId, ch.nonceB64);
      const nextSession = await api.exchangeSession({
        deviceId: bundle.deviceId,
        challengeId: ch.challengeId,
        signatureB64: sig,
      });
      return nextSession.accessToken;
    } catch {
      return null;
    }
  };

  try {
    const challenge = await api.requestChallenge(bundle.deviceId);
    const signatureB64 = await signAuthChallenge(bundle, challenge.challengeId, challenge.nonceB64);
    const session = await api.exchangeSession({
      deviceId: bundle.deviceId,
      challengeId: challenge.challengeId,
      signatureB64,
    });
    setApiAccessToken(session.accessToken);
    setUnauthorizedRefreshHandler(refreshFn);
    return session.device;
  } catch (err) {
    if (err instanceof ApiClientError && (err.status === 404 || err.status === 401)) {
      const signatureB64 = await signRegistrationProof(bundle);
      const reg = await api.registerDevice({
        deviceId: bundle.deviceId,
        ed25519PublicKeyB64: bundle.ed25519PublicKeyB64,
        x25519PublicKeyB64: bundle.x25519PublicKeyB64,
        displayName: profileHint?.displayName ?? 'Anonymous',
        avatarColor: profileHint?.avatarColor ?? '#0f766e',
        avatarEmoji: profileHint?.avatarEmoji ?? null,
        signatureB64,
      });
      setApiAccessToken(reg.accessToken);
      setUnauthorizedRefreshHandler(refreshFn);
      return reg.device;
    }
    throw err;
  }
}

export async function bootVaultOnStartup(): Promise<void> {
  const store = useAppStore.getState();
  const record = await db.vault.get('primary');
  if (!record) {
    store.setVaultState('needs_onboarding');
    return;
  }
  if (record.mode === 'passphrase') {
    store.setVaultState('locked');
    return;
  }

  try {
    const unlocked = await unlockStoredVault();
    if (!unlocked) {
      store.setVaultState('needs_onboarding');
      return;
    }
    const { bundle, record: stored } = unlocked;
    const { mode, profileHint } = stored;
    try {
      const profile = await authenticateWithBundle(bundle, profileHint);
      store.setVaultUnlocked(bundle, profile, mode);
    } catch (err) {
      if (err instanceof ApiClientError || err instanceof TypeError) {
        store.setVaultUnlocked(
          bundle,
          {
            id: bundle.deviceId,
            ed25519PublicKeyB64: profileHint.ed25519PublicKeyB64,
            x25519PublicKeyB64: profileHint.x25519PublicKeyB64,
            displayName: profileHint.displayName,
            avatarColor: profileHint.avatarColor,
            avatarEmoji: profileHint.avatarEmoji ?? null,
            createdAt: profileHint.createdAt,
          },
          mode,
        );
        store.pushToast({
          tone: 'warning',
          title: 'Offline mode',
          detail: 'Server unreachable; displaying locally cached vault.',
        });
      } else {
        throw err;
      }
    }
    await rebuildLocalSearchFromDexie();
  } catch {
    store.setVaultState('needs_onboarding');
  }
}

export async function createNewDeviceOnboarding(params: {
  displayName: string;
  avatarColor: string;
  avatarEmoji?: string | null;
  passphrase?: string;
}): Promise<DeviceProfile> {
  const bundle = await generateDeviceIdentity();
  const profileHint = {
    displayName: params.displayName.trim() || 'Anonymous',
    avatarColor: params.avatarColor,
    avatarEmoji: params.avatarEmoji ?? null,
    ed25519PublicKeyB64: bundle.ed25519PublicKeyB64,
    x25519PublicKeyB64: bundle.x25519PublicKeyB64,
    createdAt: bundle.createdAt,
  };

  if (params.passphrase && params.passphrase.trim().length > 0) {
    await saveVaultWithPassphrase(bundle, profileHint, params.passphrase);
  } else {
    await saveVaultWithBrowserWrapping(bundle, profileHint);
  }

  const profile = await authenticateWithBundle(bundle, profileHint);
  const mode = params.passphrase && params.passphrase.trim().length > 0 ? 'passphrase' : 'browser_key';
  useAppStore.getState().setVaultUnlocked(bundle, profile, mode);
  return profile;
}

export async function unlockPassphraseProtectedVault(passphrase: string): Promise<void> {
  const unlocked = await unlockStoredVault(passphrase);
  if (!unlocked) throw new Error('Vault record missing');
  const { bundle, record } = unlocked;
  const { mode, profileHint } = record;
  let profile: DeviceProfile;
  try {
    profile = await authenticateWithBundle(bundle, profileHint);
  } catch {
    profile = {
      id: bundle.deviceId,
      ed25519PublicKeyB64: profileHint.ed25519PublicKeyB64,
      x25519PublicKeyB64: profileHint.x25519PublicKeyB64,
      displayName: profileHint.displayName,
      avatarColor: profileHint.avatarColor,
      avatarEmoji: profileHint.avatarEmoji ?? null,
      createdAt: profileHint.createdAt,
    };
  }
  useAppStore.getState().setVaultUnlocked(bundle, profile, mode);
  await rebuildLocalSearchFromDexie();
}

export async function restoreDeviceFromBackupFile(params: {
  backupJson: string;
  backupPassword: string;
  localPassphrase?: string;
}): Promise<void> {
  const parsed = JSON.parse(params.backupJson) as Parameters<typeof importEncryptedDeviceBackup>[0];
  const bundle = await importEncryptedDeviceBackup(parsed, params.backupPassword);
  const profileHint = {
    displayName: 'Restored Device',
    avatarColor: '#0f766e',
    avatarEmoji: null,
    ed25519PublicKeyB64: bundle.ed25519PublicKeyB64,
    x25519PublicKeyB64: bundle.x25519PublicKeyB64,
    createdAt: bundle.createdAt,
  };
  if (params.localPassphrase && params.localPassphrase.trim().length > 0) {
    await saveVaultWithPassphrase(bundle, profileHint, params.localPassphrase);
  } else {
    await saveVaultWithBrowserWrapping(bundle, profileHint);
  }
  const profile = await authenticateWithBundle(bundle, profileHint);
  const mode = params.localPassphrase && params.localPassphrase.trim().length > 0 ? 'passphrase' : 'browser_key';
  useAppStore.getState().setVaultUnlocked(bundle, profile, mode);
  await rebuildLocalSearchFromDexie();
}

export async function rebuildLocalSearchFromDexie(): Promise<void> {
  clientSearch.clearAll();
  const expired = await purgeExpiredMessagesLocally();
  if (expired.length > 0) {
    clientSearch.removeMany(expired);
  }
  const all = await db.messages.toArray();
  const active = all.filter(
    (m) => m.deletedForMe === 0 && !m.deletedForEveryoneAt && (!m.expiresAt || Date.parse(m.expiresAt) > Date.now()),
  );
  clientSearch.upsertBatch(active);
}

export async function ingestEpochEnvelopes(
  roomId: string,
  envelopes: EpochKeyEnvelopeDto[],
  bundle: DeviceKeyBundle,
): Promise<void> {
  for (const env of envelopes) {
    const existing = await loadRoomEpochKey(roomId, env.epoch);
    if (existing) continue;
    try {
      const key = await unwrapEpochKeyEnvelope({
        envelope: env,
        expectedRoomId: roomId,
        expectedRecipientDeviceId: bundle.deviceId,
        recipientX25519SecretKeyB64: bundle.x25519SecretKeyB64,
      });
      await storeRoomEpochKey(roomId, env.epoch, key);
    } catch {
      // Envelope not decryptable by this keypair
    }
  }
}

export async function createEncryptedRoom(params: {
  name: string;
  roomKind: 'dm' | 'group' | 'community';
  description?: string;
  defaultDisappearSeconds?: number | null;
}): Promise<RoomDetailResponse> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) throw new Error('Unlock your identity vault before creating a room');

  const roomId = crypto.randomUUID();
  const epochKey = await generateRoomEpochKey();
  try {
    const ownerWrappedEpochKeyB64 = await wrapEpochKeyForRecipient({
      roomId,
      epoch: 1,
      recipientDeviceId: bundle.deviceId,
      recipientX25519PublicKeyB64: bundle.x25519PublicKeyB64,
      senderDeviceId: bundle.deviceId,
      senderX25519SecretKeyB64: bundle.x25519SecretKeyB64,
      epochKey,
    });
    const detail = await api.createRoom({
      roomId,
      roomKind: params.roomKind,
      name: params.name,
      description: params.description,
      defaultDisappearSeconds: params.defaultDisappearSeconds ?? null,
      ownerWrappedEpochKeyB64,
      ownerX25519PublicKeyB64: bundle.x25519PublicKeyB64,
    });
    await storeRoomEpochKey(detail.room.id, 1, epochKey);
    await db.syncCursors.put({
      roomId: detail.room.id,
      lastEventSeq: 0,
      lastSyncedAtUtc: new Date().toISOString(),
    });
    return detail;
  } finally {
    wipeBytes(epochKey);
  }
}

export async function createRoomInviteLink(params: {
  roomId: string;
  currentEpoch: number;
  roleName?: 'admin' | 'member' | 'readonly';
  accessScope?: 'read_only' | 'read_write';
  requiresApproval?: boolean;
  password?: string;
  maxUses?: number | null;
  expiresInHours?: number | null;
}): Promise<{ shareUrl: string; inviteId: string }> {
  const epochKey = await loadRoomEpochKey(params.roomId, params.currentEpoch);
  if (!epochKey) {
    throw new Error(`Missing local encryption key for epoch ${params.currentEpoch}`);
  }
  const inviteToken = toBase64UrlNoPad(await randomBytes(24));
  const wrapped = await wrapRoomKeyForInvite({
    roomId: params.roomId,
    epoch: params.currentEpoch,
    epochKey,
    password: params.password,
  });

  const created = await api.createInvite(params.roomId, {
    inviteToken,
    roleName: params.roleName,
    accessScope: params.accessScope,
    requiresApproval: params.requiresApproval,
    password: params.password,
    wrappedEpoch: params.currentEpoch,
    wrappedRoomKeyBlobB64: wrapped.wrappedRoomKeyBlobB64,
    maxUses: params.maxUses ?? null,
    expiresInHours: params.expiresInHours ?? null,
  });

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const shareUrl = `${origin}/invite/${inviteToken}#k=${wrapped.linkSecretB64Url}`;
  return { shareUrl, inviteId: created.id };
}

export async function joinRoomWithInvite(params: {
  token: string;
  linkSecretB64Url: string;
  password?: string;
}): Promise<{ status: 'active' | 'pending_approval'; roomId: string; roomDetail: RoomDetailResponse | null }> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) throw new Error('Create or unlock your identity before joining a room');

  const inspection = await api.inspectInvite(params.token);
  if (inspection.requiresApproval || !inspection.wrappedRoomKeyBlobB64) {
    return api.joinInvite({
      token: params.token,
      password: params.password,
      x25519PublicKeyB64: bundle.x25519PublicKeyB64,
    });
  }

  if (!params.linkSecretB64Url) {
    throw new Error('This invitation URL is missing its client-side decryption fragment (#k=...)');
  }

  const epochKey = await unwrapRoomKeyFromInvite({
    roomId: inspection.roomId,
    epoch: inspection.wrappedEpoch,
    wrappedRoomKeyBlobB64: inspection.wrappedRoomKeyBlobB64,
    linkSecretB64Url: params.linkSecretB64Url,
    password: params.password,
  });

  try {
    const selfWrapped = await wrapEpochKeyForRecipient({
      roomId: inspection.roomId,
      epoch: inspection.wrappedEpoch,
      recipientDeviceId: bundle.deviceId,
      recipientX25519PublicKeyB64: bundle.x25519PublicKeyB64,
      senderDeviceId: bundle.deviceId,
      senderX25519SecretKeyB64: bundle.x25519SecretKeyB64,
      epochKey,
    });
    const joined = await api.joinInvite({
      token: params.token,
      password: params.password,
      selfWrappedEpochKeyB64: selfWrapped,
      x25519PublicKeyB64: bundle.x25519PublicKeyB64,
    });
    await storeRoomEpochKey(inspection.roomId, inspection.wrappedEpoch, epochKey);
    if (joined.roomDetail) {
      await ingestEpochEnvelopes(inspection.roomId, joined.roomDetail.myEpochEnvelopes, bundle);
    }
    return joined;
  } finally {
    wipeBytes(epochKey);
  }
}

async function wrapEpochForRecipients(params: {
  roomId: string;
  epoch: number;
  epochKey: Uint8Array;
  recipients: Array<{ deviceId: string; x25519PublicKeyB64: string }>;
  senderBundle: DeviceKeyBundle;
}): Promise<Array<{ recipientDeviceId: string; wrappedKeyCiphertextB64: string }>> {
  const envelopes: Array<{ recipientDeviceId: string; wrappedKeyCiphertextB64: string }> = [];
  for (const r of params.recipients) {
    const wrappedKeyCiphertextB64 = await wrapEpochKeyForRecipient({
      roomId: params.roomId,
      epoch: params.epoch,
      recipientDeviceId: r.deviceId,
      recipientX25519PublicKeyB64: r.x25519PublicKeyB64,
      senderDeviceId: params.senderBundle.deviceId,
      senderX25519SecretKeyB64: params.senderBundle.x25519SecretKeyB64,
      epochKey: params.epochKey,
    });
    envelopes.push({ recipientDeviceId: r.deviceId, wrappedKeyCiphertextB64 });
  }
  return envelopes;
}

export async function approvePendingMember(params: {
  roomId: string;
  member: RoomMemberSummary;
  currentEpoch: number;
}): Promise<void> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) throw new Error('Vault locked');
  const epochKey = await loadRoomEpochKey(params.roomId, params.currentEpoch);
  if (!epochKey) throw new Error('Current epoch key unavailable locally');

  const envelopes = await wrapEpochForRecipients({
    roomId: params.roomId,
    epoch: params.currentEpoch,
    epochKey,
    recipients: [{ deviceId: params.member.deviceId, x25519PublicKeyB64: params.member.x25519PublicKeyB64 }],
    senderBundle: bundle,
  });
  await api.approveMember(params.roomId, params.member.deviceId, {
    senderX25519PublicKeyB64: bundle.x25519PublicKeyB64,
    envelopes,
  });
}

export async function removeMemberAndRotateEpoch(params: {
  roomId: string;
  targetDeviceId: string;
  action: 'kick' | 'ban';
  activeMembers: RoomMemberSummary[];
  currentEpoch: number;
}): Promise<number> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) throw new Error('Vault locked');

  const nextEpoch = params.currentEpoch + 1;
  const nextEpochKey = await generateRoomEpochKey();
  try {
    const remaining = params.activeMembers.filter(
      (m) => m.status === 'active' && m.deviceId !== params.targetDeviceId,
    );
    const rotatedEnvelopes = await wrapEpochForRecipients({
      roomId: params.roomId,
      epoch: nextEpoch,
      epochKey: nextEpochKey,
      recipients: remaining.map((m) => ({ deviceId: m.deviceId, x25519PublicKeyB64: m.x25519PublicKeyB64 })),
      senderBundle: bundle,
    });
    await api.removeMember(params.roomId, params.targetDeviceId, {
      action: params.action,
      senderX25519PublicKeyB64: bundle.x25519PublicKeyB64,
      rotatedEnvelopes,
    });
    await storeRoomEpochKey(params.roomId, nextEpoch, nextEpochKey);
    return nextEpoch;
  } finally {
    wipeBytes(nextEpochKey);
  }
}

export async function burnRoomAndRotateEpoch(params: {
  roomId: string;
  activeMembers: RoomMemberSummary[];
  currentEpoch: number;
}): Promise<number> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) throw new Error('Vault locked');

  const nextEpoch = params.currentEpoch + 1;
  const nextEpochKey = await generateRoomEpochKey();
  try {
    const active = params.activeMembers.filter((m) => m.status === 'active');
    const envelopes = await wrapEpochForRecipients({
      roomId: params.roomId,
      epoch: nextEpoch,
      epochKey: nextEpochKey,
      recipients: active.map((m) => ({ deviceId: m.deviceId, x25519PublicKeyB64: m.x25519PublicKeyB64 })),
      senderBundle: bundle,
    });
    const res = await api.burnRoomHistory(params.roomId, {
      senderX25519PublicKeyB64: bundle.x25519PublicKeyB64,
      envelopes,
    });
    await burnRoomLocally(params.roomId, res.newEpoch);
    await storeRoomEpochKey(params.roomId, res.newEpoch, nextEpochKey);
    clientSearch.removeRoom(params.roomId);
    return res.newEpoch;
  } finally {
    wipeBytes(nextEpochKey);
  }
}

export async function rotateRoomKeyManually(params: {
  roomId: string;
  activeMembers: RoomMemberSummary[];
  currentEpoch: number;
}): Promise<number> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) throw new Error('Vault locked');

  const nextEpoch = params.currentEpoch + 1;
  const nextEpochKey = await generateRoomEpochKey();
  try {
    const active = params.activeMembers.filter((m) => m.status === 'active');
    const envelopes = await wrapEpochForRecipients({
      roomId: params.roomId,
      epoch: nextEpoch,
      epochKey: nextEpochKey,
      recipients: active.map((m) => ({ deviceId: m.deviceId, x25519PublicKeyB64: m.x25519PublicKeyB64 })),
      senderBundle: bundle,
    });
    const res = await api.rotateEpoch(params.roomId, {
      reason: 'manual_rotate',
      senderX25519PublicKeyB64: bundle.x25519PublicKeyB64,
      envelopes,
    });
    await storeRoomEpochKey(params.roomId, res.newEpoch, nextEpochKey);
    return res.newEpoch;
  } finally {
    wipeBytes(nextEpochKey);
  }
}

export async function clearChannelAndPurge(roomId: string, channelId: string): Promise<void> {
  await api.clearChannel(roomId, channelId);
  const removedIds = await purgeChannelLocally(roomId, channelId);
  if (removedIds.length > 0) {
    clientSearch.removeMany(removedIds);
  }
}

export async function uploadEncryptedAttachment(params: {
  roomId: string;
  epoch: number;
  file: File | Blob;
  filename: string;
  mimeType: string;
  expiresInSeconds?: number | null;
}): Promise<DecryptedAttachmentRef> {
  const plainBytes = new Uint8Array(await params.file.arrayBuffer());
  const encrypted = await encryptAttachmentChunks(plainBytes, CLIENT_LIMITS.attachmentChunkBytes);
  const meta = await api.initAttachment(params.roomId, {
    encryptionEpoch: params.epoch,
    expectedCiphertextBytes: encrypted.expectedCiphertextBytes,
    chunkSizeBytes: encrypted.encryptedChunks[0]?.byteLength ?? CLIENT_LIMITS.attachmentChunkBytes,
    totalChunks: encrypted.encryptedChunks.length,
    streamHeaderB64: encrypted.streamHeaderB64,
  });

  const concurrency = CLIENT_LIMITS.maxParallelUploads;
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < encrypted.encryptedChunks.length) {
      const idx = nextIdx++;
      const chunk = encrypted.encryptedChunks[idx];
      if (!chunk) continue;
      await api.uploadAttachmentChunk(meta.id, idx, chunk);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, encrypted.encryptedChunks.length) }, () => worker()),
  );

  await api.completeAttachment(meta.id);
  await db.attachmentsCache.put({
    attachmentId: meta.id,
    roomId: params.roomId,
    filename: params.filename,
    mimeType: params.mimeType || 'application/octet-stream',
    sha256Hex: encrypted.plaintextSha256Hex,
    bytes: plainBytes,
    cachedAt: new Date().toISOString(),
  });

  return {
    attachmentId: meta.id,
    encryptedFilename: params.filename,
    mimeType: params.mimeType || 'application/octet-stream',
    fileKeyB64: encrypted.fileKeyB64,
    streamHeaderB64: encrypted.streamHeaderB64,
    plaintextSizeBytes: encrypted.plaintextSizeBytes,
    plaintextSha256Hex: encrypted.plaintextSha256Hex,
  };
}

export async function downloadAndDecryptAttachment(ref: DecryptedAttachmentRef): Promise<Uint8Array> {
  const cached = await db.attachmentsCache.get(ref.attachmentId);
  if (cached) {
    return cached.bytes;
  }

  const meta = await api.getAttachmentMeta(ref.attachmentId);
  if (meta.state !== 'uploaded') {
    throw new Error(`Attachment is ${meta.state}`);
  }
  const encryptedChunks: Uint8Array[] = [];
  for (let i = 0; i < meta.totalChunks; i++) {
    encryptedChunks.push(await api.downloadAttachmentChunk(ref.attachmentId, i));
  }
  const plain = await decryptAttachmentChunks({
    encryptedChunks,
    fileKeyB64: ref.fileKeyB64,
    streamHeaderB64: ref.streamHeaderB64,
    expectedPlaintextSha256Hex: ref.plaintextSha256Hex,
  });

  await db.attachmentsCache.put({
    attachmentId: ref.attachmentId,
    roomId: meta.roomId,
    filename: ref.encryptedFilename,
    mimeType: ref.mimeType,
    sha256Hex: ref.plaintextSha256Hex,
    bytes: plain,
    cachedAt: new Date().toISOString(),
  });
  return plain;
}

export async function sendEncryptedMessage(params: {
  roomId: string;
  channelId: string;
  epoch: number;
  text: string;
  attachments: DecryptedAttachmentRef[];
  members: RoomMemberSummary[];
  replyTo?: LocalDecryptedMessage | null;
  threadRootId?: string | null;
  voiceNote?: boolean;
  expireInSeconds?: number | null;
}): Promise<LocalDecryptedMessage> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) throw new Error('Identity vault is locked');

  const epochKey = await loadRoomEpochKey(params.roomId, params.epoch);
  if (!epochKey) throw new Error(`Missing local encryption key for epoch ${params.epoch}`);

  const messageId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const expiresAt = params.expireInSeconds
    ? new Date(Date.now() + params.expireInSeconds * 1000).toISOString()
    : null;

  const replySenderMember = params.replyTo
    ? params.members.find((m) => m.deviceId === params.replyTo?.senderDeviceId)
    : undefined;

  const ciphertextB64 = await encryptMessageBody({
    roomId: params.roomId,
    channelId: params.channelId,
    messageId,
    encryptionEpoch: params.epoch,
    epochKey,
    senderBundle: bundle,
    body: {
      version: 1,
      text: params.text,
      attachments: params.attachments,
      replyToMessageId: params.replyTo?.id ?? undefined,
      threadRootId: params.threadRootId ?? params.replyTo?.threadRootId ?? undefined,
      voiceNote: params.voiceNote ?? false,
    },
  });

  const optimistic: LocalDecryptedMessage = {
    id: messageId,
    roomId: params.roomId,
    channelId: params.channelId,
    senderDeviceId: bundle.deviceId,
    encryptionEpoch: params.epoch,
    eventSeq: Number.MAX_SAFE_INTEGER,
    createdAt: nowIso,
    editedAt: null,
    expiresAt,
    expireAfterReadSeconds: null,
    deletedForMe: 0,
    deletedForEveryoneAt: null,
    isPinned: 0,
    replyToMessageId: params.replyTo?.id ?? null,
    replyPreviewText: params.replyTo?.text.slice(0, 120) ?? null,
    replyPreviewSender: replySenderMember?.displayName || null,
    threadRootId: params.threadRootId ?? params.replyTo?.threadRootId ?? null,
    text: params.text,
    voiceNote: params.voiceNote ?? false,
    signatureVerified: true,
    reactions: [],
    attachments: params.attachments,
    localStatus: 'sending',
    idempotencyKey,
  };

  await db.messages.put(optimistic);

  try {
    const serverDto = await api.sendMessage(params.roomId, params.channelId, {
      messageId,
      idempotencyKey,
      encryptionEpoch: params.epoch,
      ciphertextB64,
      replyToMessageId: optimistic.replyToMessageId,
      threadRootId: optimistic.threadRootId,
      attachmentIds: params.attachments.map((a) => a.attachmentId),
      expireInSeconds: params.expireInSeconds ?? null,
    });
    const settled: LocalDecryptedMessage = {
      ...optimistic,
      eventSeq: serverDto.eventSeq,
      createdAt: serverDto.createdAt,
      expiresAt: serverDto.expiresAt,
      localStatus: 'sent',
    };
    await db.messages.put(settled);
    clientSearch.upsertMessage(settled);
    return settled;
  } catch (err) {
    const failed: LocalDecryptedMessage = { ...optimistic, localStatus: 'failed' };
    await db.messages.put(failed);
    throw err;
  }
}

export async function retryFailedMessage(
  msg: LocalDecryptedMessage,
  _members: RoomMemberSummary[],
): Promise<LocalDecryptedMessage> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) throw new Error('Vault locked');
  const epochKey = await loadRoomEpochKey(msg.roomId, msg.encryptionEpoch);
  if (!epochKey) throw new Error(`Missing epoch key ${msg.encryptionEpoch}`);

  const ciphertextB64 = await encryptMessageBody({
    roomId: msg.roomId,
    channelId: msg.channelId,
    messageId: msg.id,
    encryptionEpoch: msg.encryptionEpoch,
    epochKey,
    senderBundle: bundle,
    body: {
      version: 1,
      text: msg.text,
      attachments: msg.attachments,
      replyToMessageId: msg.replyToMessageId ?? undefined,
      threadRootId: msg.threadRootId ?? undefined,
      voiceNote: msg.voiceNote,
    },
  });

  const serverDto = await api.sendMessage(msg.roomId, msg.channelId, {
    messageId: msg.id,
    idempotencyKey: msg.idempotencyKey ?? msg.id,
    encryptionEpoch: msg.encryptionEpoch,
    ciphertextB64,
    replyToMessageId: msg.replyToMessageId,
    threadRootId: msg.threadRootId,
    attachmentIds: msg.attachments.map((a) => a.attachmentId),
  });
  const settled: LocalDecryptedMessage = {
    ...msg,
    eventSeq: serverDto.eventSeq,
    createdAt: serverDto.createdAt,
    expiresAt: serverDto.expiresAt,
    localStatus: 'sent',
  };
  await db.messages.put(settled);
  clientSearch.upsertMessage(settled);
  return settled;
}

export async function editEncryptedMessage(params: {
  msg: LocalDecryptedMessage;
  newText: string;
  members: RoomMemberSummary[];
}): Promise<LocalDecryptedMessage> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) throw new Error('Vault locked');
  const epochKey = await loadRoomEpochKey(params.msg.roomId, params.msg.encryptionEpoch);
  if (!epochKey) throw new Error(`Missing encryption key for epoch ${params.msg.encryptionEpoch}`);

  const ct = await encryptMessageBody({
    roomId: params.msg.roomId,
    channelId: params.msg.channelId,
    messageId: params.msg.id,
    encryptionEpoch: params.msg.encryptionEpoch,
    epochKey,
    senderBundle: bundle,
    body: {
      version: 1,
      text: params.newText,
      attachments: params.msg.attachments,
      replyToMessageId: params.msg.replyToMessageId ?? undefined,
      threadRootId: params.msg.threadRootId ?? undefined,
      voiceNote: params.msg.voiceNote,
    },
  });
  const updatedDto = await api.editMessage(params.msg.roomId, params.msg.id, ct);
  const updated: LocalDecryptedMessage = {
    ...params.msg,
    text: params.newText,
    editedAt: updatedDto.editedAt ?? new Date().toISOString(),
  };
  await db.messages.put(updated);
  clientSearch.upsertMessage(updated);
  return updated;
}

export async function deleteMessageByScope(
  msg: LocalDecryptedMessage,
  scope: 'me' | 'everyone',
): Promise<void> {
  await api.deleteMessage(msg.roomId, msg.id, scope);
  if (scope === 'me') {
    await db.messages.update(msg.id, { deletedForMe: 1 });
    await db.bookmarks.delete(msg.id);
    clientSearch.removeMessage(msg.id);
  } else {
    await purgeDeletedMessageLocally(msg.roomId, msg.id);
    clientSearch.removeMessage(msg.id);
  }
}

async function encryptReactionPayload(params: {
  roomId: string;
  messageId: string;
  actorDeviceId: string;
  epoch: number;
  epochKey: Uint8Array;
  emoji: string;
  op: 'add' | 'remove';
}): Promise<string> {
  const s = await ensureCryptoReady();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const aad = utf8Encode(`cloak-react-v1:${params.roomId}:${params.messageId}:${params.actorDeviceId}:${params.epoch}`);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    utf8Encode(JSON.stringify({ emoji: params.emoji, op: params.op })),
    aad,
    null,
    nonce,
    params.epochKey,
  );
  const header = new Uint8Array(5);
  header[0] = 1;
  new DataView(header.buffer).setUint32(1, params.epoch, false);
  const out = new Uint8Array(header.byteLength + nonce.byteLength + ct.byteLength);
  out.set(header, 0);
  out.set(nonce, header.byteLength);
  out.set(ct, header.byteLength + nonce.byteLength);
  return toBase64Std(out);
}

async function decryptReactionPayload(params: {
  roomId: string;
  messageId: string;
  actorDeviceId: string;
  payloadB64: string;
}): Promise<{ emoji: string; op: 'add' | 'remove' } | null> {
  const s = await ensureCryptoReady();
  const raw = fromBase64Std(params.payloadB64);
  if (raw.byteLength < 5 + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES + s.crypto_aead_xchacha20poly1305_ietf_ABYTES) {
    return null;
  }
  if (raw[0] !== 1) return null;
  const epoch = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(1, false);
  const epochKey = await loadRoomEpochKey(params.roomId, epoch);
  if (!epochKey) return null;

  const nonceStart = 5;
  const nonceEnd = nonceStart + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = raw.subarray(nonceStart, nonceEnd);
  const ct = raw.subarray(nonceEnd);
  const aad = utf8Encode(`cloak-react-v1:${params.roomId}:${params.messageId}:${params.actorDeviceId}:${epoch}`);
  try {
    const plain = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, epochKey);
    return JSON.parse(utf8Decode(plain)) as { emoji: string; op: 'add' | 'remove' };
  } catch {
    return null;
  }
}

function applyReactionMutation(
  existing: StoredReaction[],
  emoji: string,
  actorDeviceId: string,
  op: 'add' | 'remove',
): StoredReaction[] {
  const map = new Map<string, Set<string>>();
  for (const r of existing) {
    map.set(r.emoji, new Set(r.reactorDeviceIds));
  }
  const set = map.get(emoji) ?? new Set<string>();
  if (op === 'add') set.add(actorDeviceId);
  else set.delete(actorDeviceId);
  if (set.size === 0) map.delete(emoji);
  else map.set(emoji, set);

  return Array.from(map.entries()).map(([em, ids]) => ({
    emoji: em,
    reactorDeviceIds: Array.from(ids),
  }));
}

export async function toggleMessageReaction(
  msg: LocalDecryptedMessage,
  emoji: string,
): Promise<void> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) throw new Error('Vault locked');
  const existingSet = msg.reactions.find((r) => r.emoji === emoji)?.reactorDeviceIds ?? [];
  const op: 'add' | 'remove' = existingSet.includes(bundle.deviceId) ? 'remove' : 'add';

  const epochKey = await loadRoomEpochKey(msg.roomId, msg.encryptionEpoch);
  if (!epochKey) throw new Error('Missing epoch key to encrypt reaction');

  const payloadB64 = await encryptReactionPayload({
    roomId: msg.roomId,
    messageId: msg.id,
    actorDeviceId: bundle.deviceId,
    epoch: msg.encryptionEpoch,
    epochKey,
    emoji,
    op,
  });

  await api.reactMessage(msg.roomId, msg.id, payloadB64);
  const nextReactions = applyReactionMutation(msg.reactions, emoji, bundle.deviceId, op);
  await db.messages.update(msg.id, { reactions: nextReactions });
}

export async function decryptEncryptedDto(
  dto: EncryptedMessageDto,
  members: RoomMemberSummary[],
  pinnedIds: Set<string>,
): Promise<LocalDecryptedMessage | null> {
  if (dto.deletedForEveryoneAt) return null;
  if (dto.expiresAt && Date.parse(dto.expiresAt) <= Date.now()) return null;

  const existing = await db.messages.get(dto.id);
  if (existing && existing.deletedForMe === 1) return null;

  const epochKey = await loadRoomEpochKey(dto.roomId, dto.encryptionEpoch);
  const senderMember = members.find((m) => m.deviceId === dto.senderDeviceId);

  let text = '[Encrypted with rotated or unavailable room epoch key]';
  let attachments: DecryptedAttachmentRef[] = [];
  let voiceNote = false;
  let signatureVerified = false;
  let replyTo = dto.replyToMessageId;
  let threadRootId = dto.threadRootId;

  if (epochKey && dto.ciphertextB64) {
    try {
      const dec = await decryptMessageCiphertext({
        roomId: dto.roomId,
        channelId: dto.channelId,
        messageId: dto.id,
        senderDeviceId: dto.senderDeviceId,
        encryptionEpoch: dto.encryptionEpoch,
        epochKey,
        ciphertextB64: dto.ciphertextB64,
        senderEd25519PublicKeyB64: senderMember?.ed25519PublicKeyB64,
      });
      text = dec.body.text;
      attachments = dec.body.attachments ?? [];
      voiceNote = dec.body.voiceNote ?? false;
      replyTo = dec.body.replyToMessageId ?? replyTo;
      threadRootId = dec.body.threadRootId ?? threadRootId;
      signatureVerified = dec.signatureVerified;
    } catch {
      text = '[Unable to decrypt message — integrity check failed or key missing]';
    }
  }

  let replyPreviewText = existing?.replyPreviewText ?? null;
  let replyPreviewSender = existing?.replyPreviewSender ?? null;
  if (replyTo && !replyPreviewText) {
    const parent = await db.messages.get(replyTo);
    if (parent) {
      replyPreviewText = parent.text.slice(0, 120);
      const pm = members.find((m) => m.deviceId === parent.senderDeviceId);
      replyPreviewSender = pm?.displayName || null;
    }
  }

  const record: LocalDecryptedMessage = {
    id: dto.id,
    roomId: dto.roomId,
    channelId: dto.channelId,
    senderDeviceId: dto.senderDeviceId,
    encryptionEpoch: dto.encryptionEpoch,
    eventSeq: dto.eventSeq,
    createdAt: dto.createdAt,
    editedAt: dto.editedAt,
    expiresAt: dto.expiresAt,
    expireAfterReadSeconds: dto.expireAfterReadSeconds,
    deletedForMe: existing?.deletedForMe ?? 0,
    deletedForEveryoneAt: dto.deletedForEveryoneAt,
    isPinned: pinnedIds.has(dto.id) ? 1 : 0,
    replyToMessageId: replyTo,
    replyPreviewText,
    replyPreviewSender,
    threadRootId,
    text,
    voiceNote,
    signatureVerified,
    reactions: existing?.reactions ?? [],
    attachments,
    localStatus: 'sent',
    idempotencyKey: dto.idempotencyKey,
  };
  return record;
}

async function applyRoomEvent(
  event: MessageEventDto,
  room: RoomSummary,
  members: RoomMemberSummary[],
): Promise<void> {
  if (event.eventType === 'message.edited' && event.messageId && event.encryptedPayloadB64) {
    const msg = await db.messages.get(event.messageId);
    if (!msg) return;
    const epochKey = await loadRoomEpochKey(event.roomId, msg.encryptionEpoch);
    if (!epochKey) return;
    const senderMember = members.find((m) => m.deviceId === msg.senderDeviceId);
    try {
      const dec = await decryptMessageCiphertext({
        roomId: event.roomId,
        channelId: msg.channelId,
        messageId: msg.id,
        senderDeviceId: msg.senderDeviceId,
        encryptionEpoch: msg.encryptionEpoch,
        epochKey,
        ciphertextB64: event.encryptedPayloadB64,
        senderEd25519PublicKeyB64: senderMember?.ed25519PublicKeyB64,
      });
      const updatedMsg: LocalDecryptedMessage = {
        ...msg,
        text: dec.body.text,
        attachments: dec.body.attachments ?? [],
        editedAt: event.createdAt,
        signatureVerified: dec.signatureVerified,
      };
      await db.messages.put(updatedMsg);
      clientSearch.upsertMessage(updatedMsg);
    } catch {
      // Ignore undecryptable edit
    }
  } else if (event.eventType === 'message.reacted' && event.messageId && event.encryptedPayloadB64) {
    const msg = await db.messages.get(event.messageId);
    if (!msg) return;
    const dec = await decryptReactionPayload({
      roomId: event.roomId,
      messageId: event.messageId,
      actorDeviceId: event.actorDeviceId,
      payloadB64: event.encryptedPayloadB64,
    });
    if (!dec) return;
    const next = applyReactionMutation(msg.reactions, dec.emoji, event.actorDeviceId, dec.op);
    await db.messages.update(msg.id, { reactions: next });
  } else if (event.eventType === 'message.pinned' && event.messageId) {
    await db.messages.update(event.messageId, { isPinned: 1 });
  } else if (event.eventType === 'message.unpinned' && event.messageId) {
    await db.messages.update(event.messageId, { isPinned: 0 });
  } else if (event.eventType === 'message.deleted' && event.channelId && !event.messageId) {
    const removed = await purgeChannelLocally(event.roomId, event.channelId);
    if (removed.length > 0) clientSearch.removeMany(removed);
  } else if (event.eventType === 'room.burned') {
    await burnRoomLocally(event.roomId, room.currentEpoch);
    clientSearch.removeRoom(event.roomId);
  }
}

export async function syncRoomWithServer(detail: RoomDetailResponse): Promise<void> {
  const bundle = useAppStore.getState().keyBundle;
  if (!bundle) return;

  await ingestEpochEnvelopes(detail.room.id, detail.myEpochEnvelopes, bundle);

  const cursor = (await db.syncCursors.get(detail.room.id))?.lastEventSeq ?? 0;
  let afterSeq = cursor;
  let latestSyncedAt = new Date().toISOString();
  let lastPinnedMap: Record<string, string[]> = {};

  for (let page = 0; page < 10; page++) {
    const syncResp = await api.syncRoom(detail.room.id, afterSeq, 500);
    await ingestEpochEnvelopes(detail.room.id, syncResp.epochEnvelopes, bundle);
    latestSyncedAt = syncResp.syncedAt;
    lastPinnedMap = syncResp.pinnedMessageIds;

    for (const tomb of syncResp.tombstones) {
      if (tomb.scope === 'burned') {
        await burnRoomLocally(detail.room.id, syncResp.currentEpoch);
        clientSearch.removeRoom(detail.room.id);
      } else if (tomb.scope === 'everyone' || tomb.scope === 'expired' || tomb.scope === 'cleared') {
        const removed = await purgeDeletedMessageLocally(detail.room.id, tomb.messageId);
        if (removed.length > 0) clientSearch.removeMany(removed);
      } else if (tomb.scope === 'device' && tomb.targetDeviceId === bundle.deviceId) {
        await db.messages.update(tomb.messageId, { deletedForMe: 1 });
        await db.bookmarks.delete(tomb.messageId);
        clientSearch.removeMessage(tomb.messageId);
      }
    }

    for (const ev of syncResp.events) {
      await applyRoomEvent(ev, detail.room, detail.members);
    }

    if (syncResp.events.length === 0 && syncResp.tombstones.length === 0) {
      afterSeq = Math.max(afterSeq, syncResp.latestEventSeq);
      break;
    }
    const maxEventSeq = Math.max(
      afterSeq,
      ...syncResp.events.map((e) => e.eventSeq),
      ...syncResp.tombstones.map((t) => t.eventSeq),
    );
    afterSeq = Math.max(maxEventSeq, syncResp.latestEventSeq);
    if (syncResp.events.length < 500) break;
  }

  const allPinnedIds = new Set(Object.values(lastPinnedMap).flat());
  const roomMsgs = await db.messages.where('roomId').equals(detail.room.id).toArray();
  for (const m of roomMsgs) {
    const shouldPin = allPinnedIds.has(m.id) ? 1 : 0;
    if (m.isPinned !== shouldPin) {
      await db.messages.update(m.id, { isPinned: shouldPin });
    }
  }

  await db.syncCursors.put({
    roomId: detail.room.id,
    lastEventSeq: afterSeq,
    lastSyncedAtUtc: latestSyncedAt,
  });

  const expiredIds = await purgeExpiredMessagesLocally();
  if (expiredIds.length > 0) clientSearch.removeMany(expiredIds);
}

export async function loadChannelMessages(params: {
  roomId: string;
  channelId: string;
  members: RoomMemberSummary[];
  pinnedIds?: Set<string>;
}): Promise<LocalDecryptedMessage[]> {
  try {
    const dtos = await api.getChannelMessages(params.roomId, params.channelId, undefined, 100);
    const decrypted: LocalDecryptedMessage[] = [];
    const pinSet = params.pinnedIds ?? new Set<string>();

    for (const dto of dtos) {
      const dec = await decryptEncryptedDto(dto, params.members, pinSet);
      if (dec) {
        decrypted.push(dec);
        clientSearch.upsertMessage(dec);
      }
    }
    await upsertLocalMessages(decrypted);
  } catch {
    // Offline fallback uses Dexie cache below
  }

  return getActiveChannelMessages(params.roomId, params.channelId);
}

export async function handleIncomingWsMessage(
  msg: WsServerMessage,
  context: {
    roomDetail: RoomDetailResponse | null;
    activeChannelId: string | null;
    onRoomChange: (roomId: string) => void;
    onChannelMessagesChange: (roomId: string, channelId: string) => void;
  },
): Promise<void> {
  const store = useAppStore.getState();

  if (msg.type === 'typing') {
    store.setTyping(msg.channelId, msg.deviceId, msg.isTyping);
    return;
  }
  if (msg.type === 'presence') {
    store.setPresence(msg.deviceId, msg.status);
    return;
  }
  if (msg.type === 'tombstone') {
    const t = msg.tombstone;
    if (t.scope === 'burned') {
      await burnRoomLocally(t.roomId);
      clientSearch.removeRoom(t.roomId);
    } else if (t.scope === 'device') {
      if (t.targetDeviceId === store.keyBundle?.deviceId) {
        await db.messages.update(t.messageId, { deletedForMe: 1 });
        clientSearch.removeMessage(t.messageId);
      }
    } else {
      await purgeDeletedMessageLocally(t.roomId, t.messageId);
      clientSearch.removeMessage(t.messageId);
    }
    context.onChannelMessagesChange(t.roomId, t.channelId);
    return;
  }
  if (msg.type === 'message.created') {
    const dto = msg.message;
    const members = context.roomDetail?.room.id === dto.roomId ? context.roomDetail.members : [];
    const dec = await decryptEncryptedDto(dto, members, new Set());
    if (dec) {
      await db.messages.put(dec);
      clientSearch.upsertMessage(dec);
      if (dec.channelId !== context.activeChannelId) {
        store.incrementUnread(dec.channelId);
      }
      context.onChannelMessagesChange(dec.roomId, dec.channelId);
    }
    return;
  }
  if (msg.type === 'event') {
    const ev = msg.event;
    if (
      ev.eventType === 'epoch.rotated' ||
      ev.eventType === 'channel.updated' ||
      ev.eventType === 'member.updated' ||
      ev.eventType === 'room.burned'
    ) {
      if (ev.eventType === 'room.burned') {
        await burnRoomLocally(ev.roomId);
        clientSearch.removeRoom(ev.roomId);
      }
      context.onRoomChange(ev.roomId);
      return;
    }
    if (context.roomDetail?.room.id === ev.roomId) {
      await applyRoomEvent(ev, context.roomDetail.room, context.roomDetail.members);
      if (ev.channelId) {
        context.onChannelMessagesChange(ev.roomId, ev.channelId);
      }
    }
  }
}

export async function buildRoomExportInput(params: {
  roomDetail: RoomDetailResponse;
  options: ExportBuildInput['options'];
  selectedChannelIds?: string[];
  selectedMessageIds?: string[];
  dateRangeStartUtc?: string;
  dateRangeEndUtc?: string;
}): Promise<ExportBuildInput> {
  const now = Date.now();
  await purgeExpiredMessagesLocally(now);

  const cursor = await db.syncCursors.get(params.roomDetail.room.id);
  const channelMap = new Map(params.roomDetail.room.channels.map((c) => [c.id, c.name]));
  const memberMap = new Map(params.roomDetail.members.map((m) => [m.deviceId, m]));

  const localMsgs = await db.messages
    .where('roomId')
    .equals(params.roomDetail.room.id)
    .toArray();

  const activeMsgs = localMsgs
    .filter((m) => m.deletedForMe === 0 && !m.deletedForEveryoneAt)
    .filter((m) => !m.expiresAt || Date.parse(m.expiresAt) > now)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const exportMessages: ExportMessageRecord[] = [];
  for (const m of activeMsgs) {
    const member = memberMap.get(m.senderDeviceId);
    const attachments: ExportMessageRecord['attachments'] = [];
    for (const att of m.attachments) {
      if (!params.options.includeAttachments) {
        attachments.push({
          attachmentId: att.attachmentId,
          filename: att.encryptedFilename,
          mimeType: att.mimeType,
          plaintextSizeBytes: att.plaintextSizeBytes,
          plaintextSha256Hex: att.plaintextSha256Hex,
          unavailableReason: 'Attachment binaries omitted by export option',
        });
        continue;
      }
      try {
        const bytes = await downloadAndDecryptAttachment(att);
        attachments.push({
          attachmentId: att.attachmentId,
          filename: att.encryptedFilename,
          mimeType: att.mimeType,
          plaintextSizeBytes: att.plaintextSizeBytes,
          plaintextSha256Hex: att.plaintextSha256Hex,
          bytes,
        });
      } catch (err) {
        attachments.push({
          attachmentId: att.attachmentId,
          filename: att.encryptedFilename,
          mimeType: att.mimeType,
          plaintextSizeBytes: att.plaintextSizeBytes,
          plaintextSha256Hex: att.plaintextSha256Hex,
          unavailableReason: err instanceof Error ? err.message : 'Attachment unavailable on server',
        });
      }
    }

    exportMessages.push({
      id: m.id,
      channelId: m.channelId,
      channelName: channelMap.get(m.channelId) ?? 'deleted-channel',
      senderDeviceId: m.senderDeviceId,
      senderDisplayName: member?.displayName || m.senderDeviceId.slice(0, 8),
      senderAvatarColor: member?.avatarColor || '#0f766e',
      createdAtUtc: m.createdAt,
      editedAtUtc: m.editedAt,
      expiresAtUtc: m.expiresAt,
      deletedForMe: false,
      deletedForEveryoneAtUtc: null,
      text: m.text,
      replyToMessageId: m.replyToMessageId,
      replyPreviewText: m.replyPreviewText,
      threadRootId: m.threadRootId,
      isPinned: m.isPinned === 1,
      reactions: m.reactions.map((r) => ({
        emoji: r.emoji,
        count: r.reactorDeviceIds.length,
        reactorDeviceIds: r.reactorDeviceIds,
      })),
      attachments,
      signatureVerified: m.signatureVerified,
    });
  }

  return {
    roomId: params.roomDetail.room.id,
    roomDisplayName: params.roomDetail.room.name,
    syncCursorSeq: cursor?.lastEventSeq ?? 0,
    lastSuccessfulSyncAtUtc: cursor?.lastSyncedAtUtc ?? null,
    isHistoricalOfflineSnapshot: typeof navigator !== 'undefined' ? !navigator.onLine : false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    channels: params.roomDetail.room.channels.map((c) => ({
      id: c.id,
      name: c.name,
      channelType: c.channelType,
      topic: c.topic,
    })),
    participants: params.roomDetail.members.map((m) => ({
      deviceId: m.deviceId,
      displayName: m.displayName,
      avatarColor: m.avatarColor,
    })),
    messages: exportMessages,
    options: {
      ...params.options,
      selectedChannelIds: params.selectedChannelIds,
      selectedMessageIds: params.selectedMessageIds,
      dateRangeStartUtc: params.dateRangeStartUtc,
      dateRangeEndUtc: params.dateRangeEndUtc,
    },
  };
}
