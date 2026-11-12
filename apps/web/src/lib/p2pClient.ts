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
  | ({ event: 'ghost_state_changed' } & P2pGhostRuntimeState)
  | ({ event: 'stealth_state_changed' } & P2pStealthBootstrapState);

// ==================== Phase 10: Stealth Mode & PDF Decoy Types ====================

export type StealthLaunchView = 'messenger' | 'pdf_reader';
export type StealthVisualAction =
  | 'none'
  | 'blur'
  | 'privacy_shield'
  | 'lock_screen'
  | 'switch_to_pdf'
  | 'switch_to_selected_pdf'
  | 'generic_document_list';
export type StealthPdfReturnBehavior =
  | 'last_opened'
  | 'document_library'
  | 'configured_default'
  | 'neutral_welcome';
export type PdfReaderTheme = 'light' | 'dark';
export type UnlockMethod =
  | 'pdf_search'
  | 'hidden_shortcut_input'
  | 'discreet_command'
  | 'passphrase'
  | 'pin'
  | 'windows_hello';
export type SecretCodeAction =
  | 'open_messenger'
  | 'open_conversation'
  | 'open_privacy_settings'
  | 'return_to_pdf'
  | 'panic_lock';
export type PrivacyTriggerKind =
  | 'focus_loss'
  | 'alt_tab'
  | 'click_other_app'
  | 'minimize'
  | 'show_desktop'
  | 'virtual_desktop_switch'
  | 'session_lock'
  | 'session_unlock'
  | 'restore_taskbar'
  | 'restore_tray'
  | 'window_close'
  | 'app_restart'
  | 'background_away_timeout'
  | 'foreground_inactivity'
  | 'system_idle'
  | 'panic_hotkey'
  | 'manual_lock'
  | 'manual_switch_to_pdf';
export type LocalDeletionAction =
  | 'keep_all'
  | 'delete_incoming_viewed_local'
  | 'delete_outgoing_viewed_local'
  | 'delete_viewed_local'
  | 'delete_active_conversation';
export type AttachmentPurgeAction = 'keep' | 'purge_related';
export type LockAction = 'none' | 'require_unlock' | 'hard_lock';
export type VoiceCallAction = 'continue' | 'auto_mute' | 'end_call' | 'ask_before_ending';
export type CameraAction = 'continue' | 'disable_camera' | 'end_video_stream';
export type ScreenShareAction = 'continue' | 'pause' | 'stop_immediately' | 'ask_if_visible';
export type NotificationPrivacyLevel =
  | 'full_preview'
  | 'sender_only'
  | 'generic_notice'
  | 'silent'
  | 'disabled';
export type ActiveSurface =
  | 'messenger'
  | 'pdf_reader'
  | 'privacy_shield'
  | 'lock_screen'
  | 'generic_doc_list';

export interface NotificationPrivacySettings {
  unlockedLevel: NotificationPrivacyLevel;
  pdfModeLevel: NotificationPrivacyLevel;
  windowsLockedLevel: NotificationPrivacyLevel;
  minimizedLevel: NotificationPrivacyLevel;
  screenSharingLevel: NotificationPrivacyLevel;
  dndLevel: NotificationPrivacyLevel;
  dndEnabled: boolean;
  suppressTaskbarBadge: boolean;
  suppressTrayPreview: boolean;
  suppressSounds: boolean;
  hideContactNames: boolean;
  hideAttachmentThumbnails: boolean;
}

export interface CallPrivacySettings {
  voiceAction: VoiceCallAction;
  cameraAction: CameraAction;
  screenShareAction: ScreenShareAction;
  showCallIndicatorInPdf: boolean;
}

export interface PdfReaderSettings {
  restoreLastDocument: boolean;
  returnBehavior: StealthPdfReturnBehavior;
  defaultDocumentId: string | null;
  theme: PdfReaderTheme;
  neutralWindowTitle: string;
  enableImport: boolean;
  enableSearch: boolean;
  enableTabs: boolean;
}

export interface UnlockPreferences {
  enabledMethods: UnlockMethod[];
  caseSensitive: boolean;
  requireAdditionalAuth: boolean;
  allowMultipleCodes: boolean;
  hiddenShortcut: string;
  panicShortcut: string;
  requireUnlockOnReturn: boolean;
  lockOnRestart: boolean;
}

export interface TimerPreferences {
  backgroundAwayEnabled: boolean;
  backgroundAwaySeconds: number;
  backgroundAwayCancelOnReturn: boolean;
  backgroundAwayPreserveDeadline: boolean;
  backgroundAwayDeletion: LocalDeletionAction;
  foregroundIdleEnabled: boolean;
  foregroundIdleSeconds: number;
  systemIdleEnabled: boolean;
  systemIdleSeconds: number;
}

export interface PrivacyRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: PrivacyTriggerKind;
  delaySeconds: number;
  cancelOnReturn: boolean;
  preserveAbsoluteDeadline: boolean;
  visualAction: StealthVisualAction;
  lockAction: LockAction;
  deletionAction: LocalDeletionAction;
  attachmentAction: AttachmentPurgeAction;
  notificationAction: NotificationPrivacyLevel | null;
  voiceAction: VoiceCallAction | null;
  cameraAction: CameraAction | null;
  screenShareAction: ScreenShareAction | null;
  scopeRoomId: string | null;
  priority: number;
}

export interface P2pStealthConfig {
  enabled: boolean;
  launchView: StealthLaunchView;
  stealthVisualAction: StealthVisualAction;
  unlock: UnlockPreferences;
  pdfReader: PdfReaderSettings;
  timers: TimerPreferences;
  calls: CallPrivacySettings;
  notifications: NotificationPrivacySettings;
  triggerOnAltTab: boolean;
  triggerOnClickOtherApp: boolean;
  triggerOnFocusLoss: boolean;
  triggerOnMinimize: boolean;
  triggerOnShowDesktop: boolean;
  triggerOnVirtualDesktop: boolean;
  triggerOnSessionLock: boolean;
  triggerOnWindowClose: boolean;
  triggerOnRestart: boolean;
  rules: PrivacyRule[];
}

export interface ActiveCallPrivacySummary {
  inCall: boolean;
  micActive: boolean;
  micMuted: boolean;
  cameraActive: boolean;
  screenSharingActive: boolean;
}

export interface P2pStealthBootstrapState {
  stealthEnabled: boolean;
  locked: boolean;
  lifecycleState: string;
  activeSurface: ActiveSurface;
  visualAction: StealthVisualAction;
  launchView: StealthLaunchView;
  pdfReturnBehavior: StealthPdfReturnBehavior;
  defaultPdfId: string | null;
  pdfTheme: PdfReaderTheme;
  windowTitle: string;
  enabledUnlockMethods: UnlockMethod[];
  requireAdditionalAuth: boolean;
  hasPassphraseConfigured: boolean;
  hasPinConfigured: boolean;
  hiddenShortcut: string;
  panicShortcut: string;
  lockoutRemainingSeconds: number;
  failedAttempts: number;
  windowsHelloAvailable: boolean;
  windowsHelloStatus: string;
  callSummary: ActiveCallPrivacySummary;
  notificationLevelNow: NotificationPrivacyLevel;
  awayDeadlineMs: number | null;
  awayRemainingSeconds: number | null;
  foregroundIdleRemainingSeconds: number | null;
  systemIdleSeconds: number;
  pendingNavigationTarget: string | null;
  pendingOpenPrivacySettings: boolean;
}

export interface P2pSecretCodeMeta {
  id: string;
  label: string;
  action: SecretCodeAction;
  targetRoomId: string | null;
  caseSensitive: boolean;
  isWeak: boolean;
  requireAdditionalAuth: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface P2pUnlockOutcome {
  matched: boolean;
  unlocked: boolean;
  action: SecretCodeAction | null;
  targetRoomId: string | null;
  openPrivacySettings: boolean;
  needsAdditionalFactor: boolean;
  lockoutRemainingSeconds: number;
  message: string;
  bootstrap: P2pStealthBootstrapState;
}

export interface P2pPdfDocument {
  id: string;
  title: string;
  filename: string;
  fileSizeBytes: number;
  pageCount: number;
  sha256Hex: string;
  lastPage: number;
  lastZoom: number;
  rotation: number;
  bookmarks: number[];
  isDefaultDecoy: boolean;
  lastOpenedAt: string | null;
  addedAt: string;
}

export interface P2pStealthTestPreviewResult {
  trigger: PrivacyTriggerKind;
  resultingSurface: ActiveSurface;
  wouldLock: boolean;
  wouldDeleteMessages: boolean;
  deletionPolicy: LocalDeletionAction;
  disposableMessagesRemaining: number;
  disposableMessagesCleared: number;
  note: string;
}

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
  // Phase 10 Stealth Mode & PDF Library
  getStealthBootstrap: () => p2pRequest<P2pStealthBootstrapState>('/stealth/bootstrap'),
  unlockStealth: (method: UnlockMethod, secret: string, additionalSecret?: string) =>
    p2pRequest<P2pUnlockOutcome>('/stealth/unlock', {
      method: 'POST',
      body: JSON.stringify({ method, secret, additionalSecret: additionalSecret ?? null }),
    }),
  recoverStealth: (recoveryCode: string) =>
    p2pRequest<P2pUnlockOutcome>('/stealth/recover', {
      method: 'POST',
      body: JSON.stringify({ recoveryCode }),
    }),
  triggerStealth: (trigger: PrivacyTriggerKind) =>
    p2pRequest<P2pStealthBootstrapState>('/stealth/trigger', {
      method: 'POST',
      body: JSON.stringify({ trigger }),
    }),
  recordForegroundActivity: () =>
    p2pRequest<void>('/stealth/foreground-activity', { method: 'POST' }),
  reportSystemIdleMs: (idleMs: number) =>
    p2pRequest<P2pStealthBootstrapState>('/stealth/system-idle', {
      method: 'POST',
      body: JSON.stringify({ idleMs }),
    }),
  updateStealthCallSummary: (summary: ActiveCallPrivacySummary) =>
    p2pRequest<P2pStealthBootstrapState>('/stealth/call-summary', {
      method: 'POST',
      body: JSON.stringify(summary),
    }),
  returnToMessengerIfUnlocked: () =>
    p2pRequest<P2pStealthBootstrapState>('/stealth/return-messenger', { method: 'POST' }),
  advanceStealthClockMs: (deltaMs: number) =>
    p2pRequest<P2pStealthBootstrapState>('/stealth/test-clock-advance', {
      method: 'POST',
      body: JSON.stringify({ deltaMs }),
    }),
  getStealthSettings: () => p2pRequest<P2pStealthConfig>('/stealth/settings'),
  updateStealthSettings: (cfg: P2pStealthConfig) =>
    p2pRequest<P2pStealthConfig>('/stealth/settings', {
      method: 'PUT',
      body: JSON.stringify(cfg),
    }),
  listSecretCodes: () => p2pRequest<P2pSecretCodeMeta[]>('/stealth/codes'),
  createSecretCode: (payload: {
    label: string;
    code: string;
    action: SecretCodeAction;
    targetRoomId?: string | null;
    caseSensitive?: boolean;
    requireAdditionalAuth?: boolean;
  }) =>
    p2pRequest<P2pSecretCodeMeta>('/stealth/codes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteSecretCode: (id: string) =>
    p2pRequest<void>(`/stealth/codes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setStealthPassphrase: (passphrase: string | null) =>
    p2pRequest<{ configured: boolean }>('/stealth/passphrase', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    }),
  generateRecoveryCode: () =>
    p2pRequest<{ recoveryCode: string }>('/stealth/recovery-code', { method: 'POST' }),
  runStealthTestPreview: (payload: {
    trigger: PrivacyTriggerKind;
    disposableTotal: number;
    disposableViewed: number;
    deletionOverride?: LocalDeletionAction | null;
  }) =>
    p2pRequest<P2pStealthTestPreviewResult>('/stealth/test-preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // Local PDF Reader Documents
  listPdfDocuments: () => p2pRequest<P2pPdfDocument[]>('/pdf/documents'),
  uploadPdfDocument: async (
    file: File,
    opts?: { title?: string; pageCount?: number; makeDefault?: boolean },
  ): Promise<P2pPdfDocument> => {
    const buf = await file.arrayBuffer();
    const q = new URLSearchParams({
      filename: file.name || 'document.pdf',
      ...(opts?.title ? { title: opts.title } : {}),
      ...(opts?.pageCount ? { pageCount: String(opts.pageCount) } : {}),
      ...(opts?.makeDefault ? { makeDefault: 'true' } : {}),
    });
    const resp = await fetch(`/p2p/v1/pdf/documents?${q.toString()}`, {
      method: 'POST',
      headers: buildAuthHeaders(),
      body: buf,
    });
    if (!resp.ok) {
      let msg = `PDF import failed (${resp.status})`;
      try {
        const j = (await resp.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        // Ignore
      }
      throw new P2pApiError(resp.status, 'PDF_IMPORT_FAILED', msg);
    }
    return (await resp.json()) as P2pPdfDocument;
  },
  pickNativePdfDocuments: () =>
    p2pRequest<P2pPdfDocument[]>('/pdf/documents/pick', { method: 'POST' }),
  createSamplePdfDocument: () =>
    p2pRequest<P2pPdfDocument>('/pdf/documents/sample', { method: 'POST' }),
  fetchPdfContentBytes: async (docId: string): Promise<Uint8Array> => {
    const resp = await fetch(`/p2p/v1/pdf/documents/${encodeURIComponent(docId)}/content`, {
      headers: buildAuthHeaders(),
    });
    if (!resp.ok) {
      throw new P2pApiError(resp.status, 'PDF_FETCH_FAILED', `PDF read failed (${resp.status})`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  },
  updatePdfDocumentState: (
    docId: string,
    patch: Partial<{
      pageCount: number;
      lastPage: number;
      lastZoom: number;
      rotation: number;
      bookmarks: number[];
      isDefaultDecoy: boolean;
    }>,
  ) =>
    p2pRequest<P2pPdfDocument>(`/pdf/documents/${encodeURIComponent(docId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deletePdfDocument: (docId: string) =>
    p2pRequest<void>(`/pdf/documents/${encodeURIComponent(docId)}`, { method: 'DELETE' }),
};

export function connectP2pEvents(onEvent: (ev: P2pNodeEvent) => void): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;
  let retryTimer: number | null = null;
  let attempt = 0;

  const connect = () => {
    if (disposed) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const tok = getP2pSessionToken();
    const q = tok ? `?token=${encodeURIComponent(tok)}` : '';
    const socket = new WebSocket(`${proto}//${window.location.host}/p2p/v1/ws${q}`);
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
    };
    socket.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(String(msg.data)) as P2pNodeEvent;
        onEvent(parsed);
      } catch {
        // Ignore malformed frame
      }
    };
    socket.onclose = () => {
      if (disposed) return;
      const delay = Math.min(3000, 400 * Math.max(1, 2 ** attempt));
      attempt = Math.min(attempt + 1, 4);
      retryTimer = window.setTimeout(connect, delay);
    };
  };

  connect();
  return () => {
    disposed = true;
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    ws?.close();
    ws = null;
  };
}
