export type P2pConnectivityMode =
  | { mode: 'direct_only' }
  | { mode: 'assisted'; rendezvous_url?: string | null; stun_servers: string[] };

export type P2pPeerConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'direct_connected'
  | 'reconnecting'
  | 'direct_blocked'
  | 'revoked';

export interface P2pNodeStatus {
  deviceId: string;
  displayName: string;
  ed25519PublicB64: string;
  x25519PublicB64: string;
  listenAddr: string;
  dataDir: string;
  activePeerIds: string[];
  peerStates?: Record<string, P2pPeerConnectionState>;
}

export interface P2pPeerSummary {
  deviceId: string;
  displayName: string;
  ed25519PublicKeyB64: string;
  x25519PublicKeyB64: string;
  directAddr: string;
  alternateAddrs?: string[];
  connectivityMode: P2pConnectivityMode;
  lastSeenAt: string | null;
  revoked?: boolean;
}

export interface P2pRoom {
  id: string;
  name: string;
  currentEpoch: number;
  defaultDisappearSeconds: number | null;
  createdAt: string;
}

export interface P2pChannel {
  id: string;
  roomId: string;
  name: string;
  channelType: string;
  createdAt: string;
}

export interface P2pAttachmentMeta {
  id: string;
  roomId: string;
  filename: string;
  mimeType: string;
  totalSizeBytes: number;
  chunkSizeBytes: number;
  totalChunks: number;
  sha256Hex: string;
}

export interface P2pMessageView {
  id: string;
  roomId: string;
  channelId: string;
  senderDeviceId: string;
  encryptionEpoch: number;
  seq: number;
  text: string;
  signatureVerified: boolean;
  attachments: P2pAttachmentMeta[];
  replyToMessageId: string | null;
  createdAt: string;
  editedAt: string | null;
  expiresAt: string | null;
  viewedAt?: string | null;
  isOutgoing?: boolean;
  expireOnLeave?: boolean;
  expireAfterViewSeconds?: number | null;
}

export type P2pGhostModeLevel =
  | 'off'
  | 'privacy_shield'
  | 'clear_viewed'
  | 'clear_open_conversation';

export type P2pOutgoingViewedPolicy =
  | 'immediate_after_dwell'
  | 'preserve_outgoing'
  | 'immediate_on_send';

export interface P2pGhostTriggers {
  onFocusLoss: boolean;
  onMinimize: boolean;
  onSessionLock: boolean;
  onClose: boolean;
}

export interface P2pGhostPolicy {
  enabled: boolean;
  mode: P2pGhostModeLevel;
  triggers: P2pGhostTriggers;
  clearAttachments: boolean;
  hideSensitiveNames: boolean;
  captureProtection: boolean;
  requirePinUnlock: boolean;
  hasPinConfigured: boolean;
  destructiveConfirmed: boolean;
  viewedDwellMs: number;
  outgoingViewedPolicy: P2pOutgoingViewedPolicy;
}

export interface P2pGhostRoomOverride {
  roomId: string;
  enabled: boolean;
  mode: P2pGhostModeLevel;
  clearAttachments: boolean | null;
}

export type P2pGhostTriggerKind =
  | 'external_focus_loss'
  | 'minimize'
  | 'session_lock'
  | 'app_close'
  | 'manual_lock'
  | 'restore_focus'
  | 'unlock';

export interface P2pGhostDeletionSummary {
  roomId: string;
  channelId: string;
  mode: P2pGhostModeLevel;
  deletedMessages: number;
  deletedAttachments: number;
  preservedUnread: number;
  completedAt: string;
}

export interface P2pGhostRuntimeState {
  enabled: boolean;
  effectiveMode: P2pGhostModeLevel;
  shielded: boolean;
  pinLocked: boolean;
  windowFocused: boolean;
  minimized: boolean;
  sessionLocked: boolean;
  inAppModalDepth: number;
  activeRoomId: string | null;
  activeChannelId: string | null;
  captureProtectionActive: boolean;
  lastCleanup: P2pGhostDeletionSummary | null;
}

export interface P2pNetworkInterfaceCandidate {
  name: string;
  ip: string;
  family: string;
  scope: string;
  suggestedAddr: string;
}

export interface P2pNetworkDiagnostics {
  listenAddr: string;
  primaryLanIp: string | null;
  primaryIpv6: string | null;
  interfaces: P2pNetworkInterfaceCandidate[];
  windowsFirewallRulePresent: boolean | null;
  firewallNote: string;
  vaultDpapiProtected: boolean;
}

export interface P2pCaptureSourceInfo {
  id: string;
  kind: 'monitor' | 'window';
  title: string;
  width: number;
  height: number;
}

export interface P2pWebRtcSignal {
  roomId: string;
  callId: string;
  senderDeviceId: string;
  kind: string;
  payload: string;
}

export type P2pNodeEvent =
  | { event: 'peer_connected'; device_id: string; direct_addr: string }
  | { event: 'peer_disconnected'; device_id: string; reason: string }
  | { event: 'peer_reconnecting'; device_id: string; attempt: number; detail: string }
  | { event: 'peer_connectivity_failed'; device_id: string; mode: P2pConnectivityMode; detail: string }
  | { event: 'session_rekeyed'; device_id: string; key_epoch: number }
  | { event: 'message_received'; room_id: string; channel_id: string; message_id: string }
  | { event: 'message_edited'; room_id: string; message_id: string }
  | { event: 'history_changed'; room_id: string; scope: string }
  | { event: 'attachment_received'; room_id: string; attachment_id: string; filename: string }
  | ({ event: 'web_rtc_signal' } & P2pWebRtcSignal)
  | ({ event: 'ghost_state_changed' } & P2pGhostRuntimeState);

declare global {
  interface Window {
    __CLOAK_SESSION_TOKEN__?: string;
    __CLOAK_NATIVE_SHELL__?: boolean;
  }
}

const SESSION_TOKEN_KEY = 'cloak_p2p_session_token';

export function isNativeDesktopShell(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__CLOAK_NATIVE_SHELL__);
}

export function getP2pSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  if (window.__CLOAK_SESSION_TOKEN__) {
    try {
      window.sessionStorage.setItem(SESSION_TOKEN_KEY, window.__CLOAK_SESSION_TOKEN__);
    } catch {
      // Ignore storage failures in restricted contexts
    }
    return window.__CLOAK_SESSION_TOKEN__;
  }
  const hash = window.location.hash;
  if (hash && hash.includes('cloakToken=')) {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const tok = params.get('cloakToken');
    if (tok) {
      window.__CLOAK_SESSION_TOKEN__ = tok;
      try {
        window.sessionStorage.setItem(SESSION_TOKEN_KEY, tok);
      } catch {
        // Ignore
      }
      params.delete('cloakToken');
      const remaining = params.toString();
      const nextUrl = `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`;
      window.history.replaceState(null, '', nextUrl);
      return tok;
    }
  }
  try {
    return window.sessionStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setP2pSessionToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.__CLOAK_SESSION_TOKEN__ = token;
  try {
    window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Ignore
  }
}

function buildAuthHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const tok = getP2pSessionToken();
  if (tok && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${tok}`);
  }
  return headers;
}

export class P2pApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function p2pRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = buildAuthHeaders(init.headers);
  if (!headers.has('Content-Type') && !(init.body instanceof ArrayBuffer) && !(init.body instanceof Uint8Array)) {
    headers.set('Content-Type', 'application/json');
  }
  const resp = await fetch(`/p2p/v1${path}`, { ...init, headers });
  if (!resp.ok) {
    let code = 'P2P_ERROR';
    let msg = `HTTP ${resp.status}`;
    try {
      const parsed = (await resp.json()) as { code?: string; error?: string };
      if (parsed.code) code = parsed.code;
      if (parsed.error) msg = parsed.error;
    } catch {
      // Keep default status
    }
    throw new P2pApiError(resp.status, code, msg);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export const p2pApi = {
  getStatus: () => p2pRequest<P2pNodeStatus>('/status'),
  updateDisplayName: (displayName: string) =>
    p2pRequest<void>('/identity', { method: 'PATCH', body: JSON.stringify({ displayName }) }),
  getNetworkDiagnostics: () => p2pRequest<P2pNetworkDiagnostics>('/network/diagnostics'),
  listPeers: () => p2pRequest<P2pPeerSummary[]>('/peers'),
  connectPeer: (deviceId: string) =>
    p2pRequest<void>(`/peers/${encodeURIComponent(deviceId)}/connect`, { method: 'POST' }),
  revokePeer: (deviceId: string, revoked = true) =>
    p2pRequest<void>(`/peers/${encodeURIComponent(deviceId)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ revoked }),
    }),
  listRooms: () => p2pRequest<P2pRoom[]>('/rooms'),
  createRoom: (name: string, defaultDisappearSeconds?: number | null) =>
    p2pRequest<{ room: P2pRoom; channel: P2pChannel }>('/rooms', {
      method: 'POST',
      body: JSON.stringify({ name, defaultDisappearSeconds: defaultDisappearSeconds ?? null }),
    }),
  listChannels: (roomId: string) =>
    p2pRequest<P2pChannel[]>(`/rooms/${encodeURIComponent(roomId)}/channels`),
  exportTicket: (roomId: string, advertisedAddr?: string) =>
    p2pRequest<{ uri: string }>(`/rooms/${encodeURIComponent(roomId)}/ticket`, {
      method: 'POST',
      body: JSON.stringify({ advertisedAddr: advertisedAddr || null }),
    }),
  pairWithTicket: (uri: string, connectivityMode: P2pConnectivityMode) =>
    p2pRequest<{ room: P2pRoom; channel: P2pChannel }>('/pair', {
      method: 'POST',
      body: JSON.stringify({ uri, connectivityMode }),
    }),
  listMessages: (roomId: string, channelId: string) =>
    p2pRequest<P2pMessageView[]>(
      `/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}/messages`,
    ),
  sendMessage: (
    roomId: string,
    channelId: string,
    payload: {
      text: string;
      attachmentIds?: string[];
      expireInSeconds?: number | null;
      expireOnLeave?: boolean;
      expireAfterViewSeconds?: number | null;
    },
  ) =>
    p2pRequest<{ id: string }>(
      `/rooms/${encodeURIComponent(roomId)}/channels/${encodeURIComponent(channelId)}/messages`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  editMessage: (roomId: string, messageId: string, text: string) =>
    p2pRequest<void>(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    }),
  deleteMessage: (roomId: string, messageId: string, scope: 'me' | 'everyone') =>
    p2pRequest<void>(
      `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}?scope=${scope}`,
      { method: 'DELETE' },
    ),
  burnRoom: (roomId: string) =>
    p2pRequest<void>(`/rooms/${encodeURIComponent(roomId)}/burn`, { method: 'POST' }),
  uploadAttachment: async (roomId: string, file: File): Promise<P2pAttachmentMeta> => {
    const buf = await file.arrayBuffer();
    const q = new URLSearchParams({
      filename: file.name || 'file.bin',
      mimeType: file.type || 'application/octet-stream',
    });
    const resp = await fetch(`/p2p/v1/rooms/${encodeURIComponent(roomId)}/files?${q.toString()}`, {
      method: 'POST',
      headers: buildAuthHeaders(),
      body: buf,
    });
    if (!resp.ok) {
      throw new P2pApiError(resp.status, 'UPLOAD_FAILED', `Upload failed (${resp.status})`);
    }
    return (await resp.json()) as P2pAttachmentMeta;
  },
  downloadAttachmentBytes: async (attachmentId: string): Promise<Uint8Array> => {
    const resp = await fetch(`/p2p/v1/files/${encodeURIComponent(attachmentId)}`, {
      headers: buildAuthHeaders(),
    });
    if (!resp.ok) throw new P2pApiError(resp.status, 'DOWNLOAD_FAILED', `Download failed (${resp.status})`);
    return new Uint8Array(await resp.arrayBuffer());
  },
  sendWebRtcSignal: (signal: P2pWebRtcSignal) =>
    p2pRequest<void>('/signals', { method: 'POST', body: JSON.stringify(signal) }),
  // Ghost Mode endpoints
  getGhostPolicy: () => p2pRequest<P2pGhostPolicy>('/ghost/policy'),
  updateGhostPolicy: (policy: P2pGhostPolicy) =>
    p2pRequest<P2pGhostPolicy>('/ghost/policy', {
      method: 'PUT',
      body: JSON.stringify(policy),
    }),
  setGhostPin: (pin: string | null) =>
    p2pRequest<{ hasPinConfigured: boolean }>('/ghost/pin', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    }),
  getGhostState: () => p2pRequest<P2pGhostRuntimeState>('/ghost/state'),
  triggerGhost: (kind: P2pGhostTriggerKind) =>
    p2pRequest<P2pGhostRuntimeState>('/ghost/trigger', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    }),
  unlockGhost: (pin?: string) =>
    p2pRequest<P2pGhostRuntimeState>('/ghost/unlock', {
      method: 'POST',
      body: JSON.stringify({ pin: pin ?? null }),
    }),
  markMessagesViewed: (roomId: string, channelId: string, messageIds: string[]) =>
    p2pRequest<{ updated: number }>('/ghost/viewed', {
      method: 'POST',
      body: JSON.stringify({ roomId, channelId, messageIds }),
    }),
  setActiveConversation: (roomId: string | null, channelId: string | null) =>
    p2pRequest<P2pGhostRuntimeState>('/ghost/active', {
      method: 'POST',
      body: JSON.stringify({ roomId, channelId }),
    }),
  setModalOpen: (open: boolean) =>
    p2pRequest<P2pGhostRuntimeState>('/ghost/modal', {
      method: 'POST',
      body: JSON.stringify({ open }),
    }),
  listGhostOverrides: () => p2pRequest<P2pGhostRoomOverride[]>('/ghost/overrides'),
  setGhostOverride: (roomId: string, override: P2pGhostRoomOverride) =>
    p2pRequest<void>(`/ghost/overrides/${encodeURIComponent(roomId)}`, {
      method: 'PUT',
      body: JSON.stringify(override),
    }),
  // Native Windows Capture & File Picker
  listCaptureSources: () => p2pRequest<P2pCaptureSourceInfo[]>('/capture/sources'),
  getCaptureFrameBlob: async (sourceId: string, maxWidth = 1280): Promise<Blob> => {
    const resp = await fetch(
      `/p2p/v1/capture/frame/${encodeURIComponent(sourceId)}?maxWidth=${maxWidth}`,
      { headers: buildAuthHeaders() },
    );
    if (!resp.ok) {
      throw new P2pApiError(resp.status, 'CAPTURE_FAILED', `Capture frame failed (${resp.status})`);
    }
    return await resp.blob();
  },
  pickNativeFiles: (roomId: string) =>
    p2pRequest<P2pAttachmentMeta[]>('/dialog/pick-files', {
      method: 'POST',
      body: JSON.stringify({ roomId }),
    }),
};

export function connectP2pEvents(onEvent: (ev: P2pNodeEvent) => void): () => void {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tok = getP2pSessionToken();
  const q = tok ? `?token=${encodeURIComponent(tok)}` : '';
  const ws = new WebSocket(`${proto}//${window.location.host}/p2p/v1/ws${q}`);
  ws.onmessage = (msg) => {
    try {
      const parsed = JSON.parse(String(msg.data)) as P2pNodeEvent;
      onEvent(parsed);
    } catch {
      // Ignore malformed frame
    }
  };
  return () => {
    ws.close();
  };
}
