import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerUpLeft,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  Flame,
  Hash,
  Link2,
  Lock,
  Menu,
  MoreHorizontal,
  Paperclip,
  Phone,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Video,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { DISAPPEARING_MESSAGE_OPTIONS } from '@cloak/config';
import { Avatar, Button, ConfirmDialog, ModalDialog, Skeleton } from '@cloak/ui';
import { ThemeToggle } from '../components/ThemeToggle.js';
import { P2pAttachmentItem } from '../components/p2p/P2pAttachmentItem.js';
import {
  P2pMediaDock,
  SCREEN_PRESETS,
  type MediaRtpStats,
  type ScreenQualityPreset,
} from '../components/p2p/P2pMediaDock.js';
import { runExportInWorker } from '../lib/exportWorkerClient.js';
import {
  connectP2pEvents,
  getP2pSessionToken,
  isNativeDesktopShell,
  p2pApi,
  P2pApiError,
  type P2pCaptureSourceInfo,
  type P2pChannel,
  type P2pGhostModeLevel,
  type P2pGhostPolicy,
  type P2pGhostRoomOverride,
  type P2pGhostRuntimeState,
  type P2pMessageView,
  type P2pNetworkDiagnostics,
  type P2pNodeStatus,
  type P2pPdfDocument,
  type P2pPeerSummary,
  type P2pRoom,
  type P2pRoomInvitation,
  type P2pRoomMember,
  type P2pStealthBootstrapState,
  type P2pStealthConfig,
  type P2pUnlockOutcome,
  type P2pWebRtcSignal,
  type UnlockMethod,
} from '../lib/p2pClient.js';

const P2pGhostSettingsModal = React.lazy(() =>
  import('../components/p2p/P2pGhostSettingsModal.js').then((m) => ({
    default: m.P2pGhostSettingsModal,
  })),
);
const PdfReaderShell = React.lazy(() =>
  import('../components/pdf/PdfReaderShell.js').then((m) => ({
    default: m.PdfReaderShell,
  })),
);
const P2pStealthSettingsModal = React.lazy(() =>
  import('../components/stealth/P2pStealthSettingsModal.js').then((m) => ({
    default: m.P2pStealthSettingsModal,
  })),
);
import {
  escapeHtmlText,
  renderMarkdownToUnsafeHtml,
  sanitizeUntrustedHtml,
  trySanitizeUntrustedHtmlSync,
} from '../lib/sanitizeHtml.js';

function SafeMarkdown({ text }: { text: string }) {
  const unsafe = renderMarkdownToUnsafeHtml(text);
  const [html, setHtml] = useState<string>(
    () => trySanitizeUntrustedHtmlSync(unsafe) ?? escapeHtmlText(text),
  );

  useEffect(() => {
    const sync = trySanitizeUntrustedHtmlSync(unsafe);
    if (sync !== null) {
      setHtml(sync);
      return;
    }
    let cancelled = false;
    void sanitizeUntrustedHtml(unsafe).then((clean) => {
      if (!cancelled) setHtml(clean);
    });
    return () => {
      cancelled = true;
    };
  }, [unsafe]);

  return (
    <div
      className="cloak-md text-sm text-[var(--cloak-text-body)] leading-relaxed break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const DEFAULT_GHOST_POLICY: P2pGhostPolicy = {
  enabled: false,
  mode: 'off',
  triggers: { onFocusLoss: true, onMinimize: true, onSessionLock: true, onClose: true },
  clearAttachments: true,
  hideSensitiveNames: true,
  captureProtection: false,
  requirePinUnlock: false,
  hasPinConfigured: false,
  destructiveConfirmed: false,
  viewedDwellMs: 800,
  outgoingViewedPolicy: 'immediate_after_dwell',
};

const DEFAULT_STEALTH_CONFIG: P2pStealthConfig = {
  enabled: false,
  launchView: 'messenger',
  stealthVisualAction: 'switch_to_pdf',
  unlock: {
    enabledMethods: ['pdf_search', 'hidden_shortcut_input', 'discreet_command'],
    caseSensitive: true,
    requireAdditionalAuth: false,
    allowMultipleCodes: true,
    hiddenShortcut: 'Ctrl+Shift+U',
    panicShortcut: 'Ctrl+Shift+L',
    requireUnlockOnReturn: true,
    lockOnRestart: true,
  },
  pdfReader: {
    restoreLastDocument: true,
    returnBehavior: 'last_opened',
    defaultDocumentId: null,
    theme: 'light',
    neutralWindowTitle: 'Document Reader',
    enableImport: true,
    enableSearch: true,
    enableTabs: true,
  },
  timers: {
    backgroundAwayEnabled: false,
    backgroundAwaySeconds: 60,
    backgroundAwayCancelOnReturn: true,
    backgroundAwayPreserveDeadline: false,
    backgroundAwayDeletion: 'keep_all',
    foregroundIdleEnabled: false,
    foregroundIdleSeconds: 120,
    systemIdleEnabled: false,
    systemIdleSeconds: 300,
  },
  calls: {
    voiceAction: 'continue',
    cameraAction: 'continue',
    screenShareAction: 'continue',
    showCallIndicatorInPdf: true,
  },
  notifications: {
    unlockedLevel: 'full_preview',
    pdfModeLevel: 'generic_notice',
    windowsLockedLevel: 'silent',
    minimizedLevel: 'generic_notice',
    screenSharingLevel: 'silent',
    dndLevel: 'silent',
    dndEnabled: false,
    suppressTaskbarBadge: false,
    suppressTrayPreview: false,
    suppressSounds: false,
    hideContactNames: true,
    hideAttachmentThumbnails: true,
  },
  triggerOnAltTab: true,
  triggerOnClickOtherApp: true,
  triggerOnFocusLoss: true,
  triggerOnMinimize: true,
  triggerOnShowDesktop: true,
  triggerOnVirtualDesktop: true,
  triggerOnSessionLock: true,
  triggerOnWindowClose: true,
  triggerOnRestart: true,
  rules: [],
};

function formatModeBadge(mode: P2pGhostModeLevel, enabled: boolean): string {
  if (!enabled || mode === 'off') return 'Ghost: Off';
  if (mode === 'privacy_shield') return 'Ghost: Shield';
  if (mode === 'clear_viewed') return 'Ghost: Clear Viewed';
  return 'Ghost: Clear Open';
}

export function P2pWorkspacePage() {
  // Bootstrap auth token from window global or #cloakToken fragment before API calls
  useMemo(() => getP2pSessionToken(), []);

  const [status, setStatus] = useState<P2pNodeStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<P2pNetworkDiagnostics | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [rooms, setRooms] = useState<P2pRoom[]>([]);
  const [peers, setPeers] = useState<P2pPeerSummary[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [channels, setChannels] = useState<P2pChannel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<P2pMessageView[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [newRoomName, setNewRoomName] = useState('');
  const [pairUri, setPairUri] = useState('');
  const [strictDirectOnly, setStrictDirectOnly] = useState(true);
  const [stunUrl, setStunUrl] = useState('stun:stun.l.google.com:19302');
  const [advertisedAddr, setAdvertisedAddr] = useState('');
  const [ticketUri, setTicketUri] = useState('');
  const [copiedTicket, setCopiedTicket] = useState(false);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [inviteTtlSec, setInviteTtlSec] = useState<number>(900);
  const [inviteMaxUses, setInviteMaxUses] = useState<number>(1);
  const [lastTicketMeta, setLastTicketMeta] = useState<{
    inviteId: string;
    expiresAtMs: number;
    maxUses: number;
  } | null>(null);
  const [roomInvitations, setRoomInvitations] = useState<P2pRoomInvitation[]>([]);
  const [roomMembers, setRoomMembers] = useState<P2pRoomMember[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [infoBanner, setInfoBanner] = useState<string | null>(null);

  // Composer & Disappearing Presets
  const [composerText, setComposerText] = useState('');
  const [disappearPreset, setDisappearPreset] = useState<string>('off');
  const [customSeconds, setCustomSeconds] = useState<string>('120');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadedAttIds, setUploadedAttIds] = useState<string[]>([]);

  // Modals & Interactive Messaging States
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPw, setExportPw] = useState('');
  const [exportPw2, setExportPw2] = useState('');
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [ghostSettingsOpen, setGhostSettingsOpen] = useState(false);
  const [stealthSettingsOpen, setStealthSettingsOpen] = useState(false);
  const [burnConfirmOpen, setBurnConfirmOpen] = useState(false);
  const [burnBusy, setBurnBusy] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [replyQuote, setReplyQuote] = useState<{ id: string; sender: string; snippet: string } | null>(null);
  const [editingMsg, setEditingMsg] = useState<P2pMessageView | null>(null);
  const [contextMenu, setContextMenu] = useState<{ msg: P2pMessageView; x: number; y: number } | null>(null);

  // Stealth Mode Authoritative State
  const [stealthBootstrap, setStealthBootstrap] = useState<P2pStealthBootstrapState | null>(null);
  const [stealthConfig, setStealthConfig] = useState<P2pStealthConfig>(DEFAULT_STEALTH_CONFIG);
  const [pdfDocs, setPdfDocs] = useState<P2pPdfDocument[]>([]);
  const [lockScreenMethod, setLockScreenMethod] = useState<UnlockMethod>('passphrase');
  const [lockScreenSecret, setLockScreenSecret] = useState('');
  const [lockScreenSecondFactor, setLockScreenSecondFactor] = useState('');
  const [lockScreenNeedSecond, setLockScreenNeedSecond] = useState(false);
  const [lockScreenRecovery, setLockScreenRecovery] = useState('');
  const [lockScreenUseRecovery, setLockScreenUseRecovery] = useState(false);
  const [lockScreenMsg, setLockScreenMsg] = useState<string | null>(null);

  // Ghost Mode Authoritative State
  const [ghostPolicy, setGhostPolicy] = useState<P2pGhostPolicy>(DEFAULT_GHOST_POLICY);
  const [ghostState, setGhostState] = useState<P2pGhostRuntimeState | null>(null);
  const [ghostOverrides, setGhostOverrides] = useState<P2pGhostRoomOverride[]>([]);
  const [pinUnlockInput, setPinUnlockInput] = useState('');
  const [pinUnlockError, setPinUnlockError] = useState<string | null>(null);

  // Direct P2P WebRTC state
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const captureStopRef = useRef<(() => void) | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [callState, setCallState] = useState<'idle' | 'calling' | 'connected'>('idle');
  const [micMuted, setMicMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenLabel, setScreenLabel] = useState<string | null>(null);
  const [screenQuality, setScreenQuality] = useState<ScreenQualityPreset>('720p30');
  const [iceStatus, setIceStatus] = useState<string>('idle');
  const [rtpStats, setRtpStats] = useState<MediaRtpStats>({
    bytesReceived: 0,
    bytesSent: 0,
    frameWidth: 0,
    frameHeight: 0,
    framesPerSecond: 0,
    packetsLost: 0,
  });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState('');
  const [selectedCamId, setSelectedCamId] = useState('');
  const [selectedSpeakerId, setSelectedSpeakerId] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const activeRoomRef = useRef<string | null>(null);
  activeRoomRef.current = activeRoomId;
  const activeChannelRef = useRef<string | null>(null);
  activeChannelRef.current = activeChannelId;
  const inAppModalRef = useRef(false);
  const ghostSeqRef = useRef(0);
  const stealthLockedRef = useRef(false);
  const prevSurfaceRef = useRef<string>('messenger');
  const stealthCfgRef = useRef<P2pStealthConfig>(DEFAULT_STEALTH_CONFIG);
  const lastForegroundPingRef = useRef(0);
  const remoteKeepAliveAudioRef = useRef<HTMLAudioElement | null>(null);
  const applyGhostState = useCallback((next: P2pGhostRuntimeState) => {
    ghostSeqRef.current += 1;
    setGhostState(next);
  }, []);

  const clearSensitiveTransientState = useCallback((fullLock: boolean) => {
    setComposerText('');
    setPendingFiles([]);
    setUploadedAttIds([]);
    setSearchQuery('');
    setTicketUri('');
    setPairUri('');
    setExportOpen(false);
    setExportPw('');
    setExportPw2('');
    setGhostSettingsOpen(false);
    setStealthSettingsOpen(false);
    setBurnConfirmOpen(false);
    setReplyQuote(null);
    setEditingMsg(null);
    setContextMenu(null);
    if (fullLock) {
      setMessages([]);
    }
  }, []);

  const isMasked = Boolean(ghostState && (ghostState.shielded || ghostState.pinLocked));

  const setModalGuarded = useCallback((next: boolean) => {
    inAppModalRef.current = next;
    void p2pApi.setModalOpen(next).catch(() => undefined);
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
    } catch {
      // Ignore permission constraints before initial capture
    }
  }, []);

  const refreshState = useCallback(async () => {
    const startSeq = ghostSeqRef.current;
    try {
      const [boot, docs] = await Promise.all([
        p2pApi.getStealthBootstrap(),
        p2pApi.listPdfDocuments().catch(() => [] as P2pPdfDocument[]),
      ]);
      setStealthBootstrap(boot);
      stealthLockedRef.current = boot.locked;
      prevSurfaceRef.current = boot.activeSurface;
      document.title = boot.windowTitle || 'Cloak';
      setPdfDocs(docs);
      setUnavailableReason(null);

      if (boot.locked) {
        clearSensitiveTransientState(true);
        return;
      }

      const [st, diag, rList, pList, gPol, gSt, gOv, sCfg] = await Promise.all([
        p2pApi.getStatus(),
        p2pApi.getNetworkDiagnostics().catch(() => null),
        p2pApi.listRooms(),
        p2pApi.listPeers(),
        p2pApi.getGhostPolicy().catch(() => DEFAULT_GHOST_POLICY),
        p2pApi.getGhostState().catch(() => null),
        p2pApi.listGhostOverrides().catch(() => []),
        p2pApi.getStealthSettings().catch(() => DEFAULT_STEALTH_CONFIG),
      ]);
      setStatus(st);
      if (diag) {
        setDiagnostics(diag);
        setAdvertisedAddr((prev) => {
          if (prev) return prev;
          const isLoopback = st.listenAddr.startsWith('127.') || st.listenAddr.startsWith('[::1]');
          if (isLoopback) return '';
          const preferred = diag.interfaces.find((i) => i.ip === diag.primaryLanIp);
          return preferred?.suggestedAddr ?? diag.interfaces[0]?.suggestedAddr ?? '';
        });
      }
      setRooms(rList);
      setPeers(pList);
      setGhostPolicy(gPol);
      if (gSt && ghostSeqRef.current === startSeq) setGhostState(gSt);
      setGhostOverrides(gOv);
      setStealthConfig(sCfg);
      stealthCfgRef.current = sCfg;
      if (!activeRoomRef.current && rList[0]) {
        setActiveRoomId(rList[0].id);
      }
    } catch (err) {
      if (err instanceof P2pApiError && err.status === 401) {
        setUnavailableReason(
          'Cloak Desktop API rejected the session token (401 Unauthorized). Launch via cloak-desktop.exe or pass the desktop session token.',
        );
      } else if (err instanceof P2pApiError && err.status === 423) {
        // Stealth Mode locked mid-refresh; re-fetch locked-safe bootstrap & decoy metadata instead of treating 423 as offline.
        try {
          const [boot, docs] = await Promise.all([
            p2pApi.getStealthBootstrap(),
            p2pApi.listPdfDocuments().catch(() => [] as P2pPdfDocument[]),
          ]);
          stealthLockedRef.current = boot.locked;
          prevSurfaceRef.current = boot.activeSurface;
          setStealthBootstrap(boot);
          document.title = boot.windowTitle || 'Cloak';
          setPdfDocs(docs);
          setUnavailableReason(null);
          if (boot.locked) {
            clearSensitiveTransientState(true);
          }
        } catch {
          setUnavailableReason(
            'Native P2P desktop daemon is not running on this origin. Launch Cloak Desktop (cloak-desktop.exe) to use local SQLite + direct P2P mode.',
          );
        }
      } else {
        setUnavailableReason(
          'Native P2P desktop daemon is not running on this origin. Launch Cloak Desktop (cloak-desktop.exe) to use local SQLite + direct P2P mode.',
        );
      }
    }
  }, [clearSensitiveTransientState]);

  const refreshMessages = useCallback(async (rid: string, cid: string, showLoader = false) => {
    if (stealthLockedRef.current) return;
    if (showLoader) setLoadingMessages(true);
    try {
      const list = await p2pApi.listMessages(rid, cid);
      setMessages(list);
    } catch {
      // Ignore while switching channels or locked
    } finally {
      if (showLoader) setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    void refreshState();
    void refreshDevices();
  }, [refreshState, refreshDevices]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (stealthBootstrap?.locked) return;
    if (!activeRoomId) {
      setChannels([]);
      setActiveChannelId(null);
      setMessages([]);
      setRoomInvitations([]);
      setRoomMembers([]);
      return;
    }
    setTicketUri('');
    setLastTicketMeta(null);
    setLoadingMessages(true);
    void p2pApi.listChannels(activeRoomId).then((chs) => {
      setChannels(chs);
      if (chs[0]) setActiveChannelId(chs[0].id);
      else setLoadingMessages(false);
    }).catch(() => setLoadingMessages(false));
    void p2pApi.listRoomInvitations(activeRoomId).then(setRoomInvitations).catch(() => setRoomInvitations([]));
    void p2pApi.listRoomMembers(activeRoomId).then(setRoomMembers).catch(() => setRoomMembers([]));
  }, [activeRoomId, stealthBootstrap?.locked]);

  const stealthBootReady = stealthBootstrap !== null;
  const stealthLocked = Boolean(stealthBootstrap?.locked);
  const stealthEnabled = Boolean(stealthBootstrap?.stealthEnabled);
  const stealthActiveSurface = stealthBootstrap?.activeSurface ?? 'messenger';
  const stealthPanicShortcut = stealthBootstrap?.panicShortcut ?? 'Ctrl+Shift+L';

  useEffect(() => {
    if (!stealthBootReady || stealthLocked) return;
    void p2pApi.setActiveConversation(activeRoomId, activeChannelId).then(applyGhostState).catch(() => undefined);
    if (activeRoomId && activeChannelId) {
      void refreshMessages(activeRoomId, activeChannelId, true);
    }
  }, [activeRoomId, activeChannelId, refreshMessages, applyGhostState, stealthBootReady, stealthLocked]);

  // Report modal state whenever app modals are open
  useEffect(() => {
    const anyOpen = exportOpen || ghostSettingsOpen || stealthSettingsOpen || burnConfirmOpen;
    setModalGuarded(anyOpen);
  }, [exportOpen, ghostSettingsOpen, stealthSettingsOpen, burnConfirmOpen, setModalGuarded]);

  const applyStealthBootstrap = useCallback(
    (next: P2pStealthBootstrapState) => {
      const wasUnlockedMessenger = prevSurfaceRef.current === 'messenger' && !stealthLockedRef.current;
      const nowConcealed = next.locked || next.activeSurface !== 'messenger';
      const justUnlockedMessenger =
        (stealthLockedRef.current || prevSurfaceRef.current !== 'messenger') &&
        !next.locked &&
        next.activeSurface === 'messenger';

      stealthLockedRef.current = next.locked;
      prevSurfaceRef.current = next.activeSurface;
      setStealthBootstrap(next);
      setUnavailableReason(null);
      document.title = next.windowTitle || 'Cloak';

      if (nowConcealed) {
        clearSensitiveTransientState(next.locked);
        if (wasUnlockedMessenger && pcRef.current) {
          const callsCfg = stealthCfgRef.current.calls;
          if (callsCfg.voiceAction === 'auto_mute') {
            setMicMuted(true);
            localStreamRef.current?.getAudioTracks().forEach((t) => {
              t.enabled = false;
            });
          } else if (callsCfg.voiceAction === 'end_call') {
            captureStopRef.current?.();
            captureStopRef.current = null;
            pendingIceRef.current = [];
            pcRef.current.close();
            pcRef.current = null;
            localStreamRef.current?.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
            setLocalStream(null);
            setRemoteStream(null);
            setScreenSharing(false);
            setScreenLabel(null);
            setCallState('idle');
          }
          if (callsCfg.cameraAction === 'disable_camera' || callsCfg.cameraAction === 'end_video_stream') {
            setVideoOn(false);
            localStreamRef.current?.getVideoTracks().forEach((t) => {
              t.enabled = false;
            });
          }
          if (callsCfg.screenShareAction === 'stop_immediately') {
            captureStopRef.current?.();
            captureStopRef.current = null;
            setScreenSharing(false);
            setScreenLabel(null);
          }
        }
      } else if (justUnlockedMessenger) {
        void refreshState();
      }
    },
    [clearSensitiveTransientState, refreshState],
  );

  // Sync live call metadata to Stealth engine (zero peer/room leak)
  const lastCallSummaryKeyRef = useRef<string>('');
  const hasLocalAudio = Boolean(localStream?.getAudioTracks().length);
  useEffect(() => {
    if (!stealthBootReady || stealthLocked) return;
    const key = `${callState}:${hasLocalAudio}:${micMuted}:${videoOn}:${screenSharing}`;
    if (lastCallSummaryKeyRef.current === key) return;
    lastCallSummaryKeyRef.current = key;
    void p2pApi
      .updateStealthCallSummary({
        inCall: callState !== 'idle',
        micActive: hasLocalAudio,
        micMuted,
        cameraActive: videoOn,
        screenSharingActive: screenSharing,
      })
      .catch(() => undefined);
  }, [callState, hasLocalAudio, micMuted, videoOn, screenSharing, stealthBootReady, stealthLocked]);

  // Keep remote audio playing smoothly during PDF decoy mode without mounting messenger DOM
  useEffect(() => {
    const el = remoteKeepAliveAudioRef.current;
    if (!el) return;
    el.srcObject = remoteStream;
    el.muted = deafened;
  }, [remoteStream, deafened, stealthActiveSurface, stealthLocked]);

  // Foreground user interaction tracker (never counts background network packets)
  useEffect(() => {
    if (!stealthBootReady || stealthLocked || stealthActiveSurface !== 'messenger') {
      return;
    }
    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastForegroundPingRef.current < 3000) return;
      lastForegroundPingRef.current = now;
      void p2pApi.recordForegroundActivity().catch(() => undefined);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      ping();
      const targetPanic = stealthPanicShortcut.toLowerCase();
      const pressed = [
        e.ctrlKey ? 'ctrl' : '',
        e.shiftKey ? 'shift' : '',
        e.altKey ? 'alt' : '',
        e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join('+');
      if (pressed === targetPanic) {
        e.preventDefault();
        void p2pApi.triggerStealth('panic_hotkey').then(applyStealthBootstrap).catch(() => undefined);
      }
    };
    window.addEventListener('pointerdown', ping, { passive: true });
    window.addEventListener('wheel', ping, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', ping);
      window.removeEventListener('wheel', ping);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [stealthBootReady, stealthLocked, stealthActiveSurface, stealthPanicShortcut, applyStealthBootstrap]);

  // Browser fallback visibility & focus hooks (supplementary to native Win32 HWND events)
  useEffect(() => {
    if (isNativeDesktopShell() || !stealthBootReady) return;

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (stealthEnabled) {
          void p2pApi.triggerStealth('minimize').then(applyStealthBootstrap).catch(() => undefined);
        }
        void p2pApi.triggerGhost('minimize').then(applyGhostState).catch(() => undefined);
      } else {
        if (stealthEnabled) {
          void p2pApi.triggerStealth('restore_taskbar').then(applyStealthBootstrap).catch(() => undefined);
        }
        void p2pApi.triggerGhost('restore_focus').then(applyGhostState).catch(() => undefined);
      }
    };

    const handleBlur = () => {
      if (inAppModalRef.current) return;
      if (stealthEnabled) {
        void p2pApi.triggerStealth('focus_loss').then(applyStealthBootstrap).catch(() => undefined);
      }
      if (ghostPolicy.enabled) {
        void p2pApi.triggerGhost('external_focus_loss').then(applyGhostState).catch(() => undefined);
      }
    };

    const handleFocus = () => {
      void p2pApi.triggerGhost('restore_focus').then(applyGhostState).catch(() => undefined);
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, [stealthBootReady, stealthEnabled, ghostPolicy.enabled, applyStealthBootstrap, applyGhostState]);

  // Authoritative viewport dwell tracking for Ghost ClearViewed mode
  useEffect(() => {
    if (isMasked || !activeRoomId || !activeChannelId || messages.length === 0) return;
    if (document.visibilityState !== 'visible') return;

    const container = messageListRef.current;
    if (!container) return;

    const dwellMs = Math.max(200, ghostPolicy.viewedDwellMs || 800);
    const timers = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const msgId = (entry.target as HTMLElement).dataset.messageId;
          if (!msgId) continue;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (!timers.has(msgId)) {
              const handle = window.setTimeout(() => {
                timers.delete(msgId);
                if (document.visibilityState !== 'visible') return;
                void p2pApi
                  .markMessagesViewed(activeRoomId, activeChannelId, [msgId])
                  .then((res) => {
                    if (res.updated > 0) {
                      const nowIso = new Date().toISOString();
                      setMessages((prev) =>
                        prev.map((m) => (m.id === msgId && !m.viewedAt ? { ...m, viewedAt: nowIso } : m)),
                      );
                    }
                  })
                  .catch(() => undefined);
              }, dwellMs);
              timers.set(msgId, handle);
            }
          } else {
            const existing = timers.get(msgId);
            if (existing !== undefined) {
              window.clearTimeout(existing);
              timers.delete(msgId);
            }
          }
        }
      },
      { root: container, threshold: [0.5] },
    );

    const nodes = container.querySelectorAll<HTMLElement>('[data-message-id]');
    nodes.forEach((node) => {
      const msgId = node.dataset.messageId;
      const msg = messages.find((m) => m.id === msgId);
      if (msg && !msg.viewedAt) {
        observer.observe(node);
      }
    });

    return () => {
      observer.disconnect();
      for (const t of timers.values()) window.clearTimeout(t);
    };
  }, [isMasked, activeRoomId, activeChannelId, messages, searchQuery, ghostPolicy.viewedDwellMs]);

  const cleanupMediaSession = useCallback(() => {
    captureStopRef.current?.();
    captureStopRef.current = null;
    pendingIceRef.current = [];
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setScreenSharing(false);
    setScreenLabel(null);
    setCallState('idle');
    setIceStatus('closed');
  }, []);

  const createPeerConnection = useCallback(
    (roomId: string, deviceId: string) => {
      const pc = new RTCPeerConnection(
        strictDirectOnly ? { iceServers: [] } : { iceServers: [{ urls: stunUrl }] },
      );
      pc.ontrack = (ev) => {
        if (ev.streams[0]) {
          setRemoteStream(ev.streams[0]);
        } else {
          setRemoteStream((prev) => {
            const next = prev ? new MediaStream(prev.getTracks()) : new MediaStream();
            next.addTrack(ev.track);
            return next;
          });
        }
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          void p2pApi.sendWebRtcSignal({
            roomId,
            callId: 'direct-call',
            senderDeviceId: deviceId,
            kind: 'ice_candidate',
            payload: JSON.stringify(ev.candidate),
          });
        }
      };
      pc.oniceconnectionstatechange = () => {
        const next = pc.iceConnectionState;
        setIceStatus(next);
        if (next === 'disconnected' || next === 'failed') {
          pc.restartIce();
        }
      };
      return pc;
    },
    [strictDirectOnly, stunUrl],
  );

  // Live RTP stats poller while in a WebRTC call
  useEffect(() => {
    if (callState === 'idle') return;
    const timer = window.setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let bytesReceived = 0;
        let bytesSent = 0;
        let frameWidth = 0;
        let frameHeight = 0;
        let framesPerSecond = 0;
        let packetsLost = 0;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp') {
            bytesReceived += Number(report.bytesReceived ?? 0);
            packetsLost += Number(report.packetsLost ?? 0);
            if (report.kind === 'video') {
              frameWidth = Math.max(frameWidth, Number(report.frameWidth ?? 0));
              frameHeight = Math.max(frameHeight, Number(report.frameHeight ?? 0));
              framesPerSecond = Math.max(framesPerSecond, Number(report.framesPerSecond ?? 0));
            }
          } else if (report.type === 'outbound-rtp') {
            bytesSent += Number(report.bytesSent ?? 0);
          }
        });
        setRtpStats({ bytesReceived, bytesSent, frameWidth, frameHeight, framesPerSecond, packetsLost });
      } catch {
        // Ignore transient getStats error
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [callState]);

  const selectedMicIdRef = useRef(selectedMicId);
  selectedMicIdRef.current = selectedMicId;
  const statusDeviceId = status?.deviceId ?? null;
  const statusDeviceIdRef = useRef<string | null>(null);
  statusDeviceIdRef.current = statusDeviceId;

  const handleIncomingWebRtcSignal = useCallback(
    async (sig: P2pWebRtcSignal) => {
      const myDeviceId = statusDeviceIdRef.current;
      if (!myDeviceId) return;
      try {
        if (sig.kind === 'hangup') {
          cleanupMediaSession();
          return;
        }
        if (sig.kind === 'offer_sdp') {
          let pc = pcRef.current;
          if (!pc) {
            pc = createPeerConnection(sig.roomId, myDeviceId);
            pcRef.current = pc;
            const micId = selectedMicIdRef.current;
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: micId ? { deviceId: { exact: micId } } : true,
              video: false,
            });
            localStreamRef.current = stream;
            setLocalStream(stream);
            stream.getTracks().forEach((track) => pc!.addTrack(track, stream));
            void refreshDevices();
          }
          await pc.setRemoteDescription(JSON.parse(sig.payload) as RTCSessionDescriptionInit);
          while (pendingIceRef.current.length > 0) {
            const candidate = pendingIceRef.current.shift()!;
            await pc.addIceCandidate(candidate).catch(() => undefined);
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await p2pApi.sendWebRtcSignal({
            roomId: sig.roomId,
            callId: sig.callId,
            senderDeviceId: myDeviceId,
            kind: 'answer_sdp',
            payload: JSON.stringify(answer),
          });
          setCallState('connected');
        } else if (sig.kind === 'answer_sdp' && pcRef.current) {
          await pcRef.current.setRemoteDescription(JSON.parse(sig.payload) as RTCSessionDescriptionInit);
          while (pendingIceRef.current.length > 0) {
            const candidate = pendingIceRef.current.shift()!;
            await pcRef.current.addIceCandidate(candidate).catch(() => undefined);
          }
          setCallState('connected');
        } else if (sig.kind === 'ice_candidate') {
          const candidate = JSON.parse(sig.payload) as RTCIceCandidateInit;
          if (pcRef.current && pcRef.current.remoteDescription) {
            await pcRef.current.addIceCandidate(candidate);
          } else {
            pendingIceRef.current.push(candidate);
          }
        }
      } catch (err) {
        setErrorBanner(err instanceof Error ? err.message : 'WebRTC P2P signaling error');
      }
    },
    [cleanupMediaSession, createPeerConnection, refreshDevices],
  );

  const hasStealthBootstrapped = stealthBootstrap !== null;
  useEffect(() => {
    if (!hasStealthBootstrapped) return;
    return connectP2pEvents((ev) => {
      if (ev.event === 'stealth_state_changed') {
        applyStealthBootstrap(ev);
      } else if (
        ev.event === 'peer_connected' ||
        ev.event === 'peer_disconnected' ||
        ev.event === 'peer_reconnecting'
      ) {
        if (!stealthLockedRef.current) void refreshState();
      } else if (ev.event === 'peer_connectivity_failed') {
        if (!stealthLockedRef.current) setErrorBanner(ev.detail);
      } else if (ev.event === 'ghost_state_changed') {
        applyGhostState(ev);
        if (ev.shielded) {
          setMessages([]);
        } else if (!stealthLockedRef.current && activeRoomRef.current && activeChannelRef.current) {
          void refreshMessages(activeRoomRef.current, activeChannelRef.current);
        }
      } else if (ev.event === 'message_received' || ev.event === 'message_edited' || ev.event === 'history_changed') {
        if (!stealthLockedRef.current && activeRoomRef.current && activeChannelRef.current) {
          void refreshMessages(activeRoomRef.current, activeChannelRef.current);
        }
      } else if (ev.event === 'attachment_received') {
        if (!stealthLockedRef.current) {
          setInfoBanner(`Received verified P2P file: ${ev.filename}`);
          if (activeRoomRef.current && activeChannelRef.current) {
            void refreshMessages(activeRoomRef.current, activeChannelRef.current);
          }
        }
      } else if (ev.event === 'web_rtc_signal') {
        void handleIncomingWebRtcSignal(ev);
      }
    });
  }, [hasStealthBootstrapped, applyStealthBootstrap, refreshState, refreshMessages, handleIncomingWebRtcSignal, applyGhostState]);

  const startDirectCall = async (withVideo: boolean) => {
    if (!activeRoomId || !status) return;
    setErrorBanner(null);
    try {
      const pc = createPeerConnection(activeRoomId, status.deviceId);
      pcRef.current = pc;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true,
        video: withVideo
          ? selectedCamId
            ? { deviceId: { exact: selectedCamId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { width: { ideal: 1280 }, height: { ideal: 720 } }
          : false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      setVideoOn(withVideo);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      void refreshDevices();

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await p2pApi.sendWebRtcSignal({
        roomId: activeRoomId,
        callId: 'direct-call',
        senderDeviceId: status.deviceId,
        kind: 'offer_sdp',
        payload: JSON.stringify(offer),
      });
      setCallState('calling');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Unable to start direct WebRTC call');
    }
  };

  const applyVideoTrackToCall = async (track: MediaStreamTrack, stream: MediaStream, label: string, preset: ScreenQualityPreset) => {
    const pc = pcRef.current;
    if (!pc || !activeRoomId || !status) return;
    const spec = SCREEN_PRESETS[preset];
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) {
      await sender.replaceTrack(track);
      const params = sender.getParameters();
      params.encodings = [{ maxBitrate: spec.maxBitrate, maxFramerate: spec.fps }];
      await sender.setParameters(params).catch(() => undefined);
    } else {
      const newSender = pc.addTrack(track, stream);
      const params = newSender.getParameters();
      params.encodings = [{ maxBitrate: spec.maxBitrate, maxFramerate: spec.fps }];
      await newSender.setParameters(params).catch(() => undefined);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await p2pApi.sendWebRtcSignal({
        roomId: activeRoomId,
        callId: 'direct-call',
        senderDeviceId: status.deviceId,
        kind: 'offer_sdp',
        payload: JSON.stringify(offer),
      });
    }
    setScreenSharing(true);
    setScreenLabel(label);
    setInfoBanner(`Live screen share active (${label} · ${spec.label})`);
  };

  const handleStartNativeCapture = async (source: P2pCaptureSourceInfo, preset: ScreenQualityPreset) => {
    captureStopRef.current?.();
    captureStopRef.current = null;

    const spec = SCREEN_PRESETS[preset];
    const canvas = document.createElement('canvas');
    canvas.width = spec.width;
    canvas.height = spec.height;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) {
      setErrorBanner('2D Canvas context unavailable for native capture bridge');
      return;
    }

    let running = true;
    let inFlight = false;
    let timer: number | null = null;
    let ws: WebSocket | null = null;
    let receivedWsFrame = false;
    let reusableImageData: ImageData | null = null;

    const drawHttpFrame = async () => {
      if (!running || inFlight) return;
      inFlight = true;
      try {
        const blob = await p2pApi.getCaptureFrameBlob(source.id, spec.width);
        const bmp = await createImageBitmap(blob);
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close();
      } catch {
        // Keep last drawn frame cleanly
      } finally {
        inFlight = false;
      }
    };

    const startHttpFallback = () => {
      if (!running || timer !== null) return;
      const intervalMs = Math.max(16, Math.round(1000 / spec.fps));
      void drawHttpFrame();
      timer = window.setInterval(() => void drawHttpFrame(), intervalMs);
    };

    try {
      ws = p2pApi.openCaptureStreamSocket(source.id, spec.width, spec.fps);
      ws.onmessage = (evt) => {
        if (!running || !(evt.data instanceof ArrayBuffer) || evt.data.byteLength <= 8) return;
        const view = new DataView(evt.data);
        const w = view.getUint32(0, true);
        const h = view.getUint32(4, true);
        const expected = 8 + w * h * 4;
        if (w < 2 || h < 2 || evt.data.byteLength !== expected) return;
        receivedWsFrame = true;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          reusableImageData = null;
        }
        const srcBytes = new Uint8ClampedArray(evt.data, 8, w * h * 4);
        if (!reusableImageData || reusableImageData.width !== w || reusableImageData.height !== h) {
          reusableImageData = ctx.createImageData(w, h);
        }
        reusableImageData.data.set(srcBytes);
        ctx.putImageData(reusableImageData, 0, 0);
      };
      ws.onerror = () => {
        if (running && !receivedWsFrame) {
          startHttpFallback();
        }
      };
      ws.onclose = () => {
        if (running && !receivedWsFrame) {
          startHttpFallback();
        }
      };
    } catch {
      startHttpFallback();
    }

    const stream = canvas.captureStream(spec.fps);
    const track = stream.getVideoTracks()[0];
    captureStopRef.current = () => {
      running = false;
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore already closed socket
        }
        ws = null;
      }
      track?.stop();
    };
    if (track) {
      await applyVideoTrackToCall(track, stream, source.title, preset);
    }
  };

  const handleStartBrowserDisplayCapture = async (preset: ScreenQualityPreset) => {
    captureStopRef.current?.();
    captureStopRef.current = null;
    try {
      const spec = SCREEN_PRESETS[preset];
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: spec.width }, height: { ideal: spec.height }, frameRate: { ideal: spec.fps } },
        audio: false,
      });
      const track = screen.getVideoTracks()[0];
      if (!track) return;
      captureStopRef.current = () => track.stop();
      track.onended = () => {
        void handleStopScreenShare();
      };
      await applyVideoTrackToCall(track, screen, 'Browser Display', preset);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Screen share cancelled or blocked');
    }
  };

  const handleStopScreenShare = async () => {
    captureStopRef.current?.();
    captureStopRef.current = null;
    setScreenSharing(false);
    setScreenLabel(null);
    const pc = pcRef.current;
    if (!pc) return;
    const camTrack = videoOn ? localStreamRef.current?.getVideoTracks()[0] ?? null : null;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) {
      await sender.replaceTrack(camTrack);
    }
  };

  const handleRestartIce = async () => {
    const pc = pcRef.current;
    if (!pc || !activeRoomId || !status) return;
    pc.restartIce();
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await p2pApi.sendWebRtcSignal({
      roomId: activeRoomId,
      callId: 'direct-call',
      senderDeviceId: status.deviceId,
      kind: 'offer_sdp',
      payload: JSON.stringify(offer),
    });
    setInfoBanner('Triggered direct ICE restart over P2P tunnel');
  };

  const hangupCall = async () => {
    cleanupMediaSession();
    if (activeRoomId && status) {
      await p2pApi
        .sendWebRtcSignal({
          roomId: activeRoomId,
          callId: 'direct-call',
          senderDeviceId: status.deviceId,
          kind: 'hangup',
          payload: '',
        })
        .catch(() => undefined);
    }
  };

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoomName.trim()) return;
    setErrorBanner(null);
    const created = await p2pApi.createRoom(newRoomName.trim());
    setNewRoomName('');
    await refreshState();
    setActiveRoomId(created.room.id);
    setActiveChannelId(created.channel.id);
  };

  const refreshRoomMetadata = useCallback(async (roomId: string) => {
    const [invs, members] = await Promise.all([
      p2pApi.listRoomInvitations(roomId).catch(() => []),
      p2pApi.listRoomMembers(roomId).catch(() => []),
    ]);
    setRoomInvitations(invs);
    setRoomMembers(members);
  }, []);

  const handleGenerateTicket = async () => {
    if (!activeRoomId) return;
    setErrorBanner(null);
    const res = await p2pApi.exportTicket(activeRoomId, advertisedAddr.trim() || undefined, {
      ttlSeconds: inviteTtlSec,
      maxUses: inviteMaxUses,
    });
    setTicketUri(res.uri);
    setLastTicketMeta({
      inviteId: res.inviteId,
      expiresAtMs: res.expiresAtMs,
      maxUses: res.maxUses,
    });
    await refreshRoomMetadata(activeRoomId);
  };

  const handleRevokeInvitation = async (inviteId: string) => {
    if (!activeRoomId) return;
    setErrorBanner(null);
    try {
      await p2pApi.revokeRoomInvitation(activeRoomId, inviteId);
      if (lastTicketMeta?.inviteId === inviteId) {
        setTicketUri('');
        setLastTicketMeta(null);
      }
      await refreshRoomMetadata(activeRoomId);
      setInfoBanner('Invitation revoked immediately.');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to revoke invitation');
    }
  };

  const handlePair = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pairUri.trim()) return;
    setErrorBanner(null);
    try {
      const joined = await p2pApi.pairWithTicket(
        pairUri.trim(),
        strictDirectOnly
          ? { mode: 'direct_only' }
          : { mode: 'assisted', rendezvous_url: null, stun_servers: [stunUrl] },
      );
      setPairUri('');
      setInfoBanner(`Connected directly to "${joined.room.name}"`);
      await refreshState();
      setActiveRoomId(joined.room.id);
      setActiveChannelId(joined.channel.id);
    } catch (err) {
      setErrorBanner(err instanceof P2pApiError ? err.message : 'Direct P2P pairing failed');
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRoomId || !activeChannelId) return;

    if (editingMsg) {
      const nextText = composerText.trim();
      if (!nextText) return;
      try {
        await p2pApi.editMessage(activeRoomId, editingMsg.id, nextText);
        setEditingMsg(null);
        setComposerText('');
        await refreshMessages(activeRoomId, activeChannelId);
      } catch (err) {
        setErrorBanner(err instanceof Error ? err.message : 'Failed to edit P2P message');
      }
      return;
    }

    if (!composerText.trim() && pendingFiles.length === 0 && uploadedAttIds.length === 0) return;

    let expireInSeconds: number | null = null;
    let expireOnLeave = false;
    let expireAfterViewSeconds: number | null = null;

    if (disappearPreset === 'on_leave') {
      expireOnLeave = true;
    } else if (disappearPreset.startsWith('after_view:')) {
      expireAfterViewSeconds = Number(disappearPreset.split(':')[1]) || 30;
    } else if (disappearPreset === 'custom') {
      const parsed = Number(customSeconds);
      if (!Number.isFinite(parsed) || parsed < 5) {
        setErrorBanner('Custom disappearing timer must be at least 5 seconds.');
        return;
      }
      expireInSeconds = Math.round(parsed);
    } else if (disappearPreset !== 'off') {
      expireInSeconds = Number(disappearPreset) || null;
    }

    try {
      const attachmentIds = [...uploadedAttIds];
      for (const file of pendingFiles) {
        const meta = await p2pApi.uploadAttachment(activeRoomId, file);
        attachmentIds.push(meta.id);
      }
      const rawBody = composerText.trim();
      const textPayload = replyQuote
        ? `> **${replyQuote.sender}:** ${replyQuote.snippet}\n\n${rawBody || '(reply)'}`
        : rawBody || '(attachment)';
      await p2pApi.sendMessage(activeRoomId, activeChannelId, {
        text: textPayload,
        attachmentIds,
        expireInSeconds,
        expireOnLeave,
        expireAfterViewSeconds,
      });
      setComposerText('');
      setPendingFiles([]);
      setUploadedAttIds([]);
      setReplyQuote(null);
      await refreshMessages(activeRoomId, activeChannelId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to send P2P message');
    }
  };

  const handleDownloadAttachment = async (attId: string, filename: string) => {
    try {
      const bytes = await p2pApi.downloadAttachmentBytes(attId);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const url = URL.createObjectURL(new Blob([copy]));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Attachment download failed');
    }
  };

  const handleNativeOrBrowserPick = async () => {
    if (!activeRoomId) return;
    if (isNativeDesktopShell()) {
      setModalGuarded(true);
      try {
        const metas = await p2pApi.pickNativeFiles(activeRoomId);
        if (metas.length > 0) {
          setUploadedAttIds((prev) => [...prev, ...metas.map((m) => m.id)]);
          setInfoBanner(`Staged ${metas.length} encrypted file(s) from Windows picker.`);
        }
      } finally {
        setModalGuarded(false);
      }
      return;
    }
    setModalGuarded(true);
    fileInputRef.current?.click();
    window.setTimeout(() => setModalGuarded(false), 1200);
  };

  const handleUnlockPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinUnlockError(null);
    try {
      const next = await p2pApi.unlockGhost(ghostState?.pinLocked ? pinUnlockInput : undefined);
      applyGhostState(next);
      setPinUnlockInput('');
      if (!next.shielded && !next.pinLocked && activeRoomId && activeChannelId) {
        void refreshMessages(activeRoomId, activeChannelId);
      }
    } catch (err) {
      setPinUnlockError(err instanceof P2pApiError ? err.message : 'Invalid Ghost Privacy PIN');
    }
  };

  const handleExportLocal = async (e: React.FormEvent) => {
    e.preventDefault();
    setExportErr(null);
    if (!activeRoomId || !status) return;
    if (exportPw.length < 8 || exportPw !== exportPw2) {
      setExportErr('Enter matching passwords of at least 8 characters.');
      return;
    }
    try {
      const room = rooms.find((r) => r.id === activeRoomId);
      const result = await runExportInWorker({
        roomId: activeRoomId,
        roomDisplayName: room?.name ?? 'Direct P2P Room',
        syncCursorSeq: messages.at(-1)?.seq ?? 0,
        lastSuccessfulSyncAtUtc: new Date().toISOString(),
        isHistoricalOfflineSnapshot: true,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        channels: channels.map((c) => ({
          id: c.id,
          name: c.name,
          channelType: (c.channelType === 'voice' || c.channelType === 'announcement' ? c.channelType : 'text') as
            | 'text'
            | 'voice'
            | 'announcement',
          topic: undefined,
        })),
        participants: [
          { deviceId: status.deviceId, displayName: status.displayName, avatarColor: '#0f766e' },
          ...peers.map((p) => ({ deviceId: p.deviceId, displayName: p.displayName, avatarColor: '#0284c7' })),
        ],
        messages: await Promise.all(
          messages.map(async (m) => ({
            id: m.id,
            channelId: m.channelId,
            channelName: channels.find((c) => c.id === m.channelId)?.name ?? 'general',
            senderDeviceId: m.senderDeviceId,
            senderDisplayName:
              m.senderDeviceId === status.deviceId
                ? status.displayName
                : (peers.find((p) => p.deviceId === m.senderDeviceId)?.displayName ?? m.senderDeviceId.slice(0, 8)),
            senderAvatarColor: '#0f766e',
            createdAtUtc: m.createdAt,
            editedAtUtc: m.editedAt,
            expiresAtUtc: m.expiresAt,
            deletedForMe: false,
            deletedForEveryoneAtUtc: null,
            text: m.text,
            replyToMessageId: m.replyToMessageId,
            replyPreviewText: null,
            threadRootId: null,
            isPinned: false,
            reactions: [],
            attachments: await Promise.all(
              m.attachments.map(async (a) => {
                try {
                  const bytes = await p2pApi.downloadAttachmentBytes(a.id);
                  return {
                    attachmentId: a.id,
                    filename: a.filename,
                    mimeType: a.mimeType,
                    plaintextSizeBytes: a.totalSizeBytes,
                    plaintextSha256Hex: a.sha256Hex,
                    bytes,
                  };
                } catch {
                  return {
                    attachmentId: a.id,
                    filename: a.filename,
                    mimeType: a.mimeType,
                    plaintextSizeBytes: a.totalSizeBytes,
                    plaintextSha256Hex: a.sha256Hex,
                    unavailableReason: 'Blob not cached locally',
                  };
                }
              }),
            ),
            signatureVerified: m.signatureVerified,
          })),
        ),
        options: {
          format: 'complete',
          scope: 'all',
          includeAttachments: true,
          containerMode: 'cloakexport',
          password: exportPw,
        },
      });
      const copy = new Uint8Array(result.bytes.byteLength);
      copy.set(result.bytes);
      const url = URL.createObjectURL(new Blob([copy], { type: result.mimeType }));
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExportOpen(false);
      setExportPw('');
      setExportPw2('');
      setInfoBanner(`Exported encrypted archive ${result.filename}`);
    } catch (err) {
      setExportErr(err instanceof Error ? err.message : 'Export failed');
    }
  };

  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter(
      (m) =>
        m.text.toLowerCase().includes(q) ||
        m.attachments.some((a) => a.filename.toLowerCase().includes(q)),
    );
  }, [messages, searchQuery]);

  const handleStealthUnlockOutcome = useCallback(
    async (outcome: P2pUnlockOutcome) => {
      applyStealthBootstrap(outcome.bootstrap);
      if (outcome.unlocked) {
        setLockScreenSecret('');
        setLockScreenSecondFactor('');
        setLockScreenNeedSecond(false);
        setLockScreenRecovery('');
        setLockScreenUseRecovery(false);
        setLockScreenMsg(null);
        await refreshState();
        if (outcome.targetRoomId) {
          setActiveRoomId(outcome.targetRoomId);
        }
        if (outcome.openPrivacySettings) {
          setStealthSettingsOpen(true);
        }
      }
    },
    [applyStealthBootstrap, refreshState],
  );

  const handleStealthLockScreenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLockScreenMsg(null);
    try {
      const outcome = lockScreenUseRecovery
        ? await p2pApi.recoverStealth(lockScreenRecovery)
        : await p2pApi.unlockStealth(
          lockScreenMethod,
          lockScreenSecret,
          lockScreenNeedSecond ? lockScreenSecondFactor : undefined,
        );
      if (outcome.needsAdditionalFactor) {
        setLockScreenNeedSecond(true);
        setLockScreenMsg(outcome.message);
        applyStealthBootstrap(outcome.bootstrap);
        return;
      }
      if (!outcome.unlocked) {
        setLockScreenMsg(outcome.message || 'Verification failed.');
        applyStealthBootstrap(outcome.bootstrap);
        return;
      }
      await handleStealthUnlockOutcome(outcome);
    } catch (err) {
      setLockScreenMsg(err instanceof P2pApiError ? err.message : 'Unlock verification failed');
    }
  };

  if (unavailableReason) {
    return (
      <main className="min-h-screen bg-[var(--cloak-bg-void)] text-[var(--cloak-text)] flex items-center justify-center p-6">
        <div className="cloak-panel-enter max-w-lg w-full rounded-3xl border border-[var(--cloak-border-strong)] bg-[var(--cloak-bg-card)] shadow-[var(--cloak-dialog-shadow)] p-7 space-y-5">
          <div className="flex items-start justify-between gap-3 pb-4 border-b border-[var(--cloak-border)]">
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.16em] font-medium text-[var(--cloak-text-muted)]">
                Desktop Runtime Required
              </div>
              <div className="flex items-center gap-2.5 text-[var(--cloak-accent-text)]">
                <ShieldCheck className="w-5 h-5 shrink-0" />
                <h1 className="font-editorial text-2xl font-normal text-[var(--cloak-text)] tracking-tight">
                  Cloak Direct P2P Desktop Mode
                </h1>
              </div>
            </div>
            <ThemeToggle />
          </div>
          <p className="text-sm text-[var(--cloak-text-body)] leading-relaxed">{unavailableReason}</p>
          <div className="rounded-2xl bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] p-3.5 font-mono-tabular text-xs text-[var(--cloak-accent-text)]">
            cargo +stable-x86_64-pc-windows-gnu run --release -p cloak-desktop
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Link
              to="/"
              className="cloak-transition px-4 py-2 rounded-full bg-[var(--cloak-accent)] hover:bg-[var(--cloak-accent-hover)] text-[var(--cloak-accent-ink)] text-xs font-medium"
            >
              Open Browser Workspace
            </Link>
            <Link
              to="/archive"
              className="cloak-transition px-4 py-2 rounded-full bg-[var(--cloak-bg-surface)] hover:bg-[var(--cloak-bg-elevated)] border border-[var(--cloak-border)] text-[var(--cloak-text-body)] text-xs font-medium"
            >
              Open Offline Archive Viewer
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (!stealthBootstrap) {
    return (
      <main
        data-testid="stealth-booting"
        className="min-h-screen bg-[var(--cloak-bg-void)] text-[var(--cloak-text-muted)] flex items-center justify-center p-6"
      >
        <div className="max-w-sm w-full rounded-3xl border border-[var(--cloak-border)] bg-[var(--cloak-bg-card)] p-6 space-y-4 shadow-[var(--cloak-card-shadow)]">
          <div className="flex items-center justify-between">
            <span className="font-editorial text-xl text-[var(--cloak-text)]">Cloak</span>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--cloak-text-dim)]">
              Vault Boot
            </span>
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-3/4 rounded-full" />
            <Skeleton className="h-3 w-1/2 rounded-full" />
          </div>
          <p className="text-xs text-[var(--cloak-text-muted)]">Initializing local workspace...</p>
        </div>
      </main>
    );
  }

  const concealSurface = stealthBootstrap.locked || stealthBootstrap.activeSurface !== 'messenger';

  if (concealSurface && (stealthBootstrap.activeSurface === 'pdf_reader' || stealthBootstrap.activeSurface === 'generic_doc_list')) {
    return (
      <>
        {callState !== 'idle' && <audio ref={remoteKeepAliveAudioRef} autoPlay className="hidden" />}
        <Suspense
          fallback={
            <div className="min-h-screen bg-[#f4f3ef] text-[#3a3c3a] flex items-center justify-center text-xs">
              Opening Document Reader...
            </div>
          }
        >
          <PdfReaderShell
            bootstrap={stealthBootstrap}
            onUnlockOutcome={(outcome) => void handleStealthUnlockOutcome(outcome)}
            onReturnToMessenger={
              !stealthBootstrap.locked
                ? () => void p2pApi.returnToMessengerIfUnlocked().then(applyStealthBootstrap).catch(() => undefined)
                : undefined
            }
            onEmergencyLock={() =>
              void p2pApi.triggerStealth('panic_hotkey').then(applyStealthBootstrap).catch(() => undefined)
            }
          />
        </Suspense>
      </>
    );
  }

  if (concealSurface) {
    return (
      <main
        data-testid="stealth-lock-screen"
        className="min-h-screen bg-[var(--cloak-bg-void)] text-[var(--cloak-text)] flex items-center justify-center p-6"
      >
        {callState !== 'idle' && <audio ref={remoteKeepAliveAudioRef} autoPlay className="hidden" />}
        <div className="cloak-panel-enter max-w-md w-full rounded-3xl border border-[var(--cloak-border-strong)] bg-[var(--cloak-bg-card)] shadow-[var(--cloak-dialog-shadow)] p-7 space-y-5">
          <div className="mx-auto w-12 h-12 rounded-full bg-[var(--cloak-bg-sage-soft)] border border-[var(--cloak-accent-border)] flex items-center justify-center text-[var(--cloak-accent-text)]">
            <Lock className="w-5 h-5" />
          </div>
          <div className="text-center space-y-1.5">
            <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--cloak-text-dim)]">
              Cloak Local Vault
            </div>
            <h1 className="font-editorial text-2xl font-normal text-[var(--cloak-text)] tracking-tight">
              {stealthBootstrap.activeSurface === 'privacy_shield' ? 'Privacy Shield Active' : 'Workspace Locked'}
            </h1>
            <p className="text-xs text-[var(--cloak-text-muted)] leading-relaxed">
              Local conversations and files remain sealed until unlocked.
              {callState !== 'idle' && stealthBootstrap.callSummary.inCall ? ' Active media session remains connected.' : ''}
            </p>
          </div>

          {stealthBootstrap.lockoutRemainingSeconds > 0 && (
            <div className="rounded-2xl border border-[var(--cloak-warn-border)] bg-[var(--cloak-warn-soft)] px-3.5 py-2.5 text-xs text-[var(--cloak-warn-text)]">
              Too many incorrect unlock attempts. Try again in {stealthBootstrap.lockoutRemainingSeconds}s.
            </div>
          )}

          <form onSubmit={handleStealthLockScreenSubmit} className="space-y-3.5">
            {!lockScreenUseRecovery ? (
              <>
                <div className="flex flex-wrap gap-1.5 justify-center">
                  {(['passphrase', 'pin', 'discreet_command'] as UnlockMethod[])
                    .filter((m) => stealthBootstrap.enabledUnlockMethods.includes(m))
                    .map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setLockScreenMethod(m)}
                        className={`px-3 py-1 rounded-full text-[11px] font-medium cursor-pointer border cloak-transition ${lockScreenMethod === m
                            ? 'border-transparent bg-[var(--cloak-accent)] text-[var(--cloak-accent-ink)]'
                            : 'border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)]'
                          }`}
                      >
                        {m === 'passphrase' ? 'Passphrase' : m === 'pin' ? 'PIN' : 'Command'}
                      </button>
                    ))}
                </div>
                <input
                  type="password"
                  value={lockScreenSecret}
                  onChange={(e) => setLockScreenSecret(e.target.value)}
                  placeholder="Enter unlock code or passphrase..."
                  aria-label="Stealth unlock secret"
                  className="w-full rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-4 py-2 text-sm text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
                  autoFocus
                />
                {lockScreenNeedSecond && (
                  <input
                    type="password"
                    value={lockScreenSecondFactor}
                    onChange={(e) => setLockScreenSecondFactor(e.target.value)}
                    placeholder="Enter secondary passphrase factor..."
                    aria-label="Secondary passphrase factor"
                    className="w-full rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-4 py-2 text-sm text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
                  />
                )}
              </>
            ) : (
              <input
                type="text"
                value={lockScreenRecovery}
                onChange={(e) => setLockScreenRecovery(e.target.value)}
                placeholder="Enter offline recovery code..."
                aria-label="Offline recovery code"
                className="w-full rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-4 py-2 text-sm font-mono text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
                autoFocus
              />
            )}

            {lockScreenMsg && <div className="text-xs text-[var(--cloak-danger-text)]">{lockScreenMsg}</div>}

            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setLockScreenUseRecovery((v) => !v);
                  setLockScreenMsg(null);
                }}
                className="text-[11px] text-[var(--cloak-accent-text)] hover:underline cursor-pointer"
              >
                {lockScreenUseRecovery ? 'Use secret code' : 'Use recovery key'}
              </button>
              <Button type="submit" variant="primary" size="sm">
                <Lock className="w-3.5 h-3.5" /> Unlock
              </Button>
            </div>
          </form>
        </div>
      </main>
    );
  }

  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? null;
  const activeRoomOverride = activeRoomId
    ? ghostOverrides.find((o) => o.roomId === activeRoomId && o.enabled) ?? null
    : null;
  const effectiveMode = ghostState?.effectiveMode ?? ghostPolicy.mode;
  const hideRoomTitle = isMasked && ghostPolicy.hideSensitiveNames;
  const activePeersCount = status?.activePeerIds.length ?? 0;

  return (
    <div className="h-screen flex bg-[var(--cloak-bg-void)] text-[var(--cloak-text)] overflow-hidden relative">
      {sidebarOpen && (
        <div
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-[var(--cloak-backdrop)] lg:hidden"
        />
      )}

      {/* Left Sidebar: Editorial Vault Plate + Connectivity + Rooms + Direct Pairing + Peers */}
      <aside
        aria-label="Vault navigation and peer directory"
        className={`${sidebarOpen ? 'fixed inset-y-0 left-0 z-40 flex shadow-2xl' : 'hidden lg:flex'
          } w-[308px] max-w-[88vw] shrink-0 bg-[var(--cloak-bg-sidebar)] border-r border-[var(--cloak-border)] flex-col overflow-y-auto p-3.5 gap-3.5`}
      >
        {/* Editorial Node Identity Card */}
        <div className="shrink-0 rounded-2xl overflow-hidden border border-[var(--cloak-border-strong)] bg-[var(--cloak-bg-card)] shadow-[var(--cloak-card-shadow)]">
          <div className="bg-[var(--cloak-bg-sage)] text-[#F2F1ED] px-4 py-3 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[#E3E7E2]">
                Local SQLite Vault
              </span>
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[#F2F1ED]/30 bg-[#0E1A18]/25 text-[#F2F1ED] text-[10px] font-medium"
                  title={
                    activePeersCount > 0
                      ? `${activePeersCount} direct peer link(s) active`
                      : 'Encrypted vault ready (no active peer links)'
                  }
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${activePeersCount > 0 ? 'bg-emerald-300' : 'bg-[#E3E7E2]/70'
                      }`}
                  />
                  {activePeersCount > 0 ? `${activePeersCount} Linked` : 'Local Ready'}
                </span>
                <button
                  type="button"
                  aria-label="Close sidebar"
                  onClick={() => setSidebarOpen(false)}
                  className="lg:hidden text-[#F2F1ED]/85 hover:text-[#F2F1ED] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="font-editorial text-xl font-normal tracking-tight text-[#F6F5F0] truncate">
              {hideRoomTitle ? '•••••• (Protected)' : status?.displayName}
            </div>
          </div>

          <div className="px-4 py-2 text-[11px] flex items-center justify-between gap-2">
            <span className="text-[var(--cloak-text-muted)]">
              {strictDirectOnly ? 'Strict Direct P2P' : 'Assisted P2P'}
            </span>
            <button
              type="button"
              aria-expanded={diagnosticsExpanded}
              onClick={() => setDiagnosticsExpanded((v) => !v)}
              className="inline-flex items-center gap-1 text-[var(--cloak-accent-text)] font-medium hover:underline cursor-pointer"
            >
              <span>Advanced Connection & Vault Diagnostics</span>
              {diagnosticsExpanded ? (
                <ChevronUp className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 shrink-0" />
              )}
            </button>
          </div>

          {diagnosticsExpanded && (
            <div className="px-4 pb-3 pt-2 border-t border-[var(--cloak-border)] space-y-2 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono-tabular text-[var(--cloak-text-muted)] truncate" title={status?.listenAddr}>
                  Listen: {status?.listenAddr}
                </span>
                {diagnostics?.vaultDpapiProtected && (
                  <span className="shrink-0 px-2 py-0.5 rounded-full border border-[var(--cloak-accent-border)] bg-[var(--cloak-bg-sage-soft)] text-[var(--cloak-accent-text)] text-[10px] font-mono-tabular font-medium">
                    DPAPI
                  </span>
                )}
              </div>
              {diagnostics && (
                <div className="text-[var(--cloak-text-muted)] leading-snug">
                  LAN IPv4:{' '}
                  <span className="text-[var(--cloak-success-text)] font-mono-tabular font-medium">
                    {diagnostics.primaryLanIp ?? 'none'}
                  </span>
                  {diagnostics.primaryIpv6 ? ' · IPv6 ready' : ''}
                </div>
              )}
              <label className="flex items-center gap-2 cursor-pointer text-[var(--cloak-text-body)] pt-1">
                <input
                  type="checkbox"
                  checked={strictDirectOnly}
                  onChange={(e) => setStrictDirectOnly(e.target.checked)}
                />
                <span>Strict Direct-Only (zero silent relay)</span>
              </label>
              {!strictDirectOnly && (
                <input
                  value={stunUrl}
                  onChange={(e) => setStunUrl(e.target.value)}
                  placeholder="stun:stun.example.org:3478"
                  className="w-full rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-1.5 text-xs text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
                />
              )}
              {diagnostics && (
                <div className="text-[11px] text-[var(--cloak-text-muted)] border-t border-[var(--cloak-border)] pt-2 leading-relaxed">
                  Firewall:{' '}
                  <span className={diagnostics.windowsFirewallRulePresent ? 'text-[var(--cloak-success-text)]' : 'text-[var(--cloak-warn-text)]'}>
                    {diagnostics.firewallNote}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2.5 pt-1.5 border-t border-[var(--cloak-border)] text-[11px]">
                <Link to="/archive" className="inline-flex items-center gap-1 text-[var(--cloak-info-text)] hover:underline">
                  <Archive className="w-3 h-3" /> /archive
                </Link>
                <span className="text-[var(--cloak-border-strong)]">·</span>
                <Link to="/" className="text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)]">
                  Server Mode
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* Rooms */}
        <div className="shrink-0 space-y-2">
          <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cloak-text-muted)]">
            Local P2P Rooms
          </div>
          <form onSubmit={handleCreateRoom} className="flex gap-1.5">
            <input
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="New private room..."
              className="flex-1 rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3.5 py-1.5 text-xs text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)] min-w-0"
            />
            <Button size="sm" type="submit" aria-label="Create P2P Room" className="px-2.5">
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </form>
          <div className="space-y-1">
            {rooms.map((r) => {
              const active = r.id === activeRoomId;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    setActiveRoomId(r.id);
                    setSidebarOpen(false);
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs flex items-center justify-between cursor-pointer border cloak-transition ${active
                      ? 'bg-[var(--cloak-bg-active)] border-[var(--cloak-accent-border)] border-l-[3px] border-l-[var(--cloak-accent)] text-[var(--cloak-text)] shadow-2xs'
                      : 'bg-[var(--cloak-bg-card)]/70 border-transparent text-[var(--cloak-text-body)] hover:bg-[var(--cloak-bg-card)] hover:border-[var(--cloak-border)]'
                    }`}
                >
                  <span className={`truncate ${active ? 'font-editorial text-sm text-[var(--cloak-text)]' : 'font-medium'}`}>
                    {hideRoomTitle ? 'Protected Room' : r.name}
                  </span>
                  <span className="font-mono-tabular text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] text-[var(--cloak-text-muted)]">
                    E{r.currentEpoch}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Direct Pairing Ticket */}
        <div className="shrink-0 rounded-2xl border border-[var(--cloak-border)] bg-[var(--cloak-bg-card)] p-3.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cloak-text-muted)]">
              Direct Pairing Ticket
            </span>
            {activeRoomId && (
              <span className="text-[10px] text-[var(--cloak-text-dim)] font-mono-tabular">
                {roomMembers.filter((m) => !m.revoked).length || 1} authorized
              </span>
            )}
          </div>
          {activeRoomId && (
            <>
              {diagnostics && diagnostics.interfaces.length > 0 && (
                <select
                  aria-label="Advertised interface address"
                  value={advertisedAddr}
                  onChange={(e) => setAdvertisedAddr(e.target.value)}
                  className="w-full rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-1.5 text-[11px] text-[var(--cloak-text-body)]"
                >
                  <option value="">Loopback Default ({status?.listenAddr})</option>
                  {diagnostics.interfaces.map((iface) => (
                    <option key={iface.suggestedAddr} value={iface.suggestedAddr}>
                      {iface.name} ({iface.family} {iface.scope}) — {iface.suggestedAddr}
                    </option>
                  ))}
                </select>
              )}
              <input
                value={advertisedAddr}
                onChange={(e) => setAdvertisedAddr(e.target.value)}
                placeholder="Optional LAN/IPv6 host:port"
                className="w-full rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-1.5 text-[11px] text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
              />
              <div className="grid grid-cols-2 gap-1.5">
                <select
                  aria-label="Invitation expiration"
                  value={inviteTtlSec}
                  onChange={(e) => setInviteTtlSec(Number(e.target.value))}
                  className="rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-2.5 py-1 text-[11px] text-[var(--cloak-text-body)]"
                >
                  <option value={600}>10 min TTL</option>
                  <option value={900}>15 min TTL</option>
                  <option value={3600}>1 hour TTL</option>
                  <option value={86400}>24 hour TTL</option>
                </select>
                <select
                  aria-label="Invitation max uses"
                  value={inviteMaxUses}
                  onChange={(e) => setInviteMaxUses(Number(e.target.value))}
                  className="rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-2.5 py-1 text-[11px] text-[var(--cloak-text-body)]"
                >
                  <option value={1}>Single-use (1)</option>
                  <option value={3}>Up to 3 uses</option>
                  <option value={10}>Up to 10 uses</option>
                </select>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => void handleGenerateTicket()} className="flex-1">
                  <Link2 className="w-3.5 h-3.5" /> Generate Ticket
                </Button>
                {ticketUri && (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label="Copy pairing ticket"
                    onClick={() => {
                      void navigator.clipboard.writeText(ticketUri);
                      setCopiedTicket(true);
                      setTimeout(() => setCopiedTicket(false), 1800);
                    }}
                  >
                    {copiedTicket ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </Button>
                )}
              </div>
              {ticketUri && (
                <div className="space-y-1">
                  {lastTicketMeta && (
                    <div className="flex items-center justify-between text-[10px] text-[var(--cloak-text-muted)]">
                      <span>
                        {lastTicketMeta.maxUses === 1 ? 'Single-use' : `${lastTicketMeta.maxUses} uses`} · signed
                      </span>
                      <span className="font-mono-tabular">
                        Exp {new Date(lastTicketMeta.expiresAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  )}
                  <textarea
                    readOnly
                    rows={2}
                    value={ticketUri}
                    aria-label="Shareable pairing ticket"
                    className="w-full rounded-xl bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] p-2 font-mono text-[10px] text-[var(--cloak-accent-text)]"
                  />
                </div>
              )}
              {roomInvitations.filter((inv) => !inv.revoked).length > 0 && (
                <div className="pt-1 border-t border-[var(--cloak-border)] space-y-1">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--cloak-text-dim)]">
                    Active Signed Invites
                  </div>
                  {roomInvitations
                    .filter((inv) => !inv.revoked)
                    .slice(0, 3)
                    .map((inv) => (
                      <div
                        key={inv.inviteId}
                        className="flex items-center justify-between gap-1.5 text-[10px] rounded-lg bg-[var(--cloak-bg-surface)] px-2 py-1"
                      >
                        <span className="font-mono-tabular text-[var(--cloak-text-muted)] truncate">
                          {inv.usesCount}/{inv.maxUses} used ·{' '}
                          {inv.expiresAtMs <= Date.now()
                            ? 'Expired'
                            : `Exp ${new Date(inv.expiresAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleRevokeInvitation(inv.inviteId)}
                          className="text-[var(--cloak-danger-text)] hover:underline shrink-0 cursor-pointer"
                        >
                          Revoke Invite
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}

          <form onSubmit={handlePair} className="space-y-2 pt-2.5 border-t border-[var(--cloak-border)]">
            <input
              value={pairUri}
              onChange={(e) => setPairUri(e.target.value)}
              placeholder="Paste peer cloakp2p://... ticket"
              className="w-full rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3.5 py-1.5 text-xs text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
            />
            <Button size="sm" variant="primary" type="submit" className="w-full">
              Pair & Connect Directly
            </Button>
          </form>
        </div>

        {/* Peers */}
        <div className="shrink-0 space-y-2">
          <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cloak-text-muted)]">
            Paired Peers ({peers.length})
          </div>
          {peers.map((p) => {
            const pState = status?.peerStates?.[p.deviceId] ?? (status?.activePeerIds.includes(p.deviceId) ? 'direct_connected' : 'disconnected');
            const peerDisplay = hideRoomTitle ? 'Verified Peer' : p.displayName;
            return (
              <div
                key={p.deviceId}
                className="rounded-2xl bg-[var(--cloak-bg-card)] border border-[var(--cloak-border)] px-3 py-2.5 text-xs flex items-center justify-between gap-2"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar
                    size="sm"
                    name={peerDisplay}
                    color="#4D6153"
                    status={p.revoked ? 'offline' : pState === 'direct_connected' ? 'online' : 'idle'}
                  />
                  <div className="min-w-0">
                    <div className="font-medium text-[var(--cloak-text)] truncate">{peerDisplay}</div>
                    <div className="text-[10px] font-mono-tabular text-[var(--cloak-text-dim)] truncate">{p.directAddr}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {p.revoked ? (
                    <span className="text-[10px] text-[var(--cloak-danger-text)] font-semibold">Revoked</span>
                  ) : pState === 'direct_connected' ? (
                    <span className="text-[10px] text-[var(--cloak-success-text)] inline-flex items-center gap-1 font-medium">
                      <Wifi className="w-3 h-3" /> Direct
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        void p2pApi.connectPeer(p.deviceId).catch((e) => setErrorBanner(e instanceof Error ? e.message : 'Connect failed'))
                      }
                      className="text-[10px] text-[var(--cloak-danger-text)] hover:underline inline-flex items-center gap-1 cursor-pointer"
                    >
                      <WifiOff className="w-3 h-3" /> {pState === 'reconnecting' ? 'Retrying' : 'Retry'}
                    </button>
                  )}
                  {!p.revoked && (
                    <button
                      type="button"
                      title="Revoke peer trust"
                      onClick={() =>
                        void p2pApi
                          .revokePeer(p.deviceId)
                          .then(() => {
                            setInfoBanner(`Revoked peer ${p.displayName}`);
                            return refreshState();
                          })
                          .catch((e) => setErrorBanner(e instanceof Error ? e.message : 'Revoke failed'))
                      }
                      className="text-[10px] text-[var(--cloak-text-muted)] hover:text-[var(--cloak-danger-text)] cursor-pointer"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main P2P Workspace */}
      <main className="flex-1 flex flex-col min-w-0 bg-[var(--cloak-bg-void)] relative">
        <header className="px-4 sm:px-5 py-2.5 border-b border-[var(--cloak-border)] bg-[var(--cloak-bg-sidebar)]/90 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            <button
              type="button"
              aria-label="Open P2P sidebar"
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 rounded-full bg-[var(--cloak-bg-card)] border border-[var(--cloak-border)] text-[var(--cloak-text-body)] hover:bg-[var(--cloak-bg-elevated)] cursor-pointer cloak-transition"
            >
              <Menu className="w-4 h-4" />
            </button>
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--cloak-bg-sage-soft)] border border-[var(--cloak-accent-border)] text-[var(--cloak-accent-text)] shrink-0">
              <Hash className="w-4 h-4" />
            </span>
            <h1 className="font-editorial text-xl sm:text-2xl font-normal tracking-tight text-[var(--cloak-text)] truncate leading-none">
              {hideRoomTitle ? 'Protected Conversation' : (activeRoom?.name ?? 'Select or Create a Room')}
            </h1>
            <button
              type="button"
              onClick={() => setGhostSettingsOpen(true)}
              data-testid="ghost-status-pill"
              className={`cloak-transition px-3 py-1 rounded-full text-[11px] font-medium inline-flex items-center gap-1.5 cursor-pointer border ${ghostPolicy.enabled || activeRoomOverride
                  ? 'border-[var(--cloak-accent-border)] bg-[var(--cloak-bg-sage-soft)] text-[var(--cloak-accent-text)]'
                  : 'border-[var(--cloak-border)] bg-[var(--cloak-bg-card)] text-[var(--cloak-text-muted)] hover:border-[var(--cloak-border-strong)] hover:text-[var(--cloak-text)]'
                }`}
            >
              <Settings2 className="w-3 h-3" />
              {formatModeBadge(effectiveMode, ghostPolicy.enabled || Boolean(activeRoomOverride))}
            </button>
            <button
              type="button"
              onClick={() => setStealthSettingsOpen(true)}
              data-testid="stealth-settings-btn"
              className={`cloak-transition px-3 py-1 rounded-full text-[11px] font-medium inline-flex items-center gap-1.5 cursor-pointer border ${stealthBootstrap.stealthEnabled
                  ? 'border-[var(--cloak-info-border)] bg-[var(--cloak-info-soft)] text-[var(--cloak-info-text)]'
                  : 'border-[var(--cloak-border)] bg-[var(--cloak-bg-card)] text-[var(--cloak-text-muted)] hover:border-[var(--cloak-border-strong)] hover:text-[var(--cloak-text)]'
                }`}
            >
              <FileText className="w-3 h-3" />
              {stealthBootstrap.stealthEnabled ? 'Stealth: PDF Armed' : 'Stealth & PDF'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <ThemeToggle />
            {!isMasked && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="switch-pdf-btn"
                  onClick={() =>
                    void p2pApi
                      .triggerStealth('manual_switch_to_pdf')
                      .then(applyStealthBootstrap)
                      .catch(() => undefined)
                  }
                  title="Switch to PDF Reader Cover"
                >
                  <FileText className="w-3.5 h-3.5" /> PDF Cover
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="stealth-lock-btn"
                  onClick={() => {
                    if (stealthBootstrap.stealthEnabled) {
                      void p2pApi.triggerStealth('manual_lock').then(applyStealthBootstrap).catch(() => undefined);
                    } else {
                      void p2pApi.triggerGhost('manual_lock').then(applyGhostState).catch(() => undefined);
                    }
                  }}
                  title="Lock / Mask Now"
                >
                  <Lock className="w-3.5 h-3.5" /> Lock
                </Button>
              </>
            )}
            {activeRoomId && !isMasked && (
              <>
                <div className="relative hidden sm:block">
                  <Search className="w-3.5 h-3.5 text-[var(--cloak-text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search history..."
                    aria-label="Search decrypted messages"
                    className="pl-8 pr-2.5 py-1.5 rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] text-xs text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)] w-32 xl:w-44 cloak-transition focus:border-[var(--cloak-border-strong)]"
                  />
                </div>
                <Button size="sm" variant="secondary" onClick={() => void startDirectCall(false)} disabled={callState !== 'idle'}>
                  <Phone className="w-3.5 h-3.5" /> Voice
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void startDirectCall(true)} disabled={callState !== 'idle'}>
                  <Video className="w-3.5 h-3.5" /> Video
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setExportOpen(true)}>
                  <Download className="w-3.5 h-3.5" /> .cloakexport
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setBurnConfirmOpen(true)}
                >
                  <Flame className="w-3.5 h-3.5" /> Burn
                </Button>
              </>
            )}
          </div>
        </header>

        {errorBanner && (
          <div role="alert" className="mx-4 sm:mx-6 mt-3 rounded-2xl border border-[var(--cloak-danger-border)] bg-[var(--cloak-danger-soft)] px-4 py-2.5 text-xs text-[var(--cloak-danger-text)] flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              {errorBanner}
            </span>
            <button type="button" onClick={() => setErrorBanner(null)} className="text-xs underline cursor-pointer">
              Dismiss
            </button>
          </div>
        )}
        {infoBanner && (
          <div className="mx-4 sm:mx-6 mt-3 rounded-2xl border border-[var(--cloak-success-border)] bg-[var(--cloak-success-soft)] px-4 py-2.5 text-xs text-[var(--cloak-success-text)] flex items-center justify-between">
            <span>{infoBanner}</span>
            <button type="button" onClick={() => setInfoBanner(null)} className="text-xs underline cursor-pointer">
              Dismiss
            </button>
          </div>
        )}
        {!isMasked && ghostState?.lastCleanup && (
          <div className="mx-4 sm:mx-6 mt-3 rounded-2xl border border-[var(--cloak-accent-border)] bg-[var(--cloak-bg-sage-soft)]/70 px-4 py-2 text-[11px] text-[var(--cloak-accent-text)] flex items-center justify-between gap-2">
            <span>
              Ghost ({ghostState.lastCleanup.mode}): cleared {ghostState.lastCleanup.deletedMessages} local message(s),
              purged {ghostState.lastCleanup.deletedAttachments} attachment blob(s), preserved{' '}
              {ghostState.lastCleanup.preservedUnread} unread item(s).
            </span>
          </div>
        )}

        {/* Active Call Media Stage (remains mounted so ongoing voice/video calls survive Privacy Shield) */}
        <P2pMediaDock
          callState={callState}
          iceStatus={iceStatus}
          videoOn={videoOn}
          screenSharing={screenSharing}
          screenLabel={screenLabel}
          micMuted={micMuted}
          deafened={deafened}
          screenQuality={screenQuality}
          localStream={localStream}
          remoteStream={remoteStream}
          rtpStats={rtpStats}
          devices={devices}
          selectedMicId={selectedMicId}
          selectedCamId={selectedCamId}
          selectedSpeakerId={selectedSpeakerId}
          onSelectMic={setSelectedMicId}
          onSelectCam={setSelectedCamId}
          onSelectSpeaker={setSelectedSpeakerId}
          onToggleMute={() => {
            const next = !micMuted;
            setMicMuted(next);
            localStreamRef.current?.getAudioTracks().forEach((t) => {
              t.enabled = !next;
            });
          }}
          onToggleDeafen={() => {
            const next = !deafened;
            setDeafened(next);
            localStreamRef.current?.getAudioTracks().forEach((t) => {
              t.enabled = !(next || micMuted);
            });
          }}
          onChangeScreenQuality={setScreenQuality}
          onStartNativeCapture={handleStartNativeCapture}
          onStartBrowserDisplayCapture={handleStartBrowserDisplayCapture}
          onStopScreenShare={handleStopScreenShare}
          onRestartIce={handleRestartIce}
          onHangup={hangupCall}
          onModalStateChange={setModalGuarded}
        />

        {/* Conversation Body OR Privacy Shield Overlay (never mounts plaintext messages while shielded!) */}
        {isMasked ? (
          <div
            data-testid="ghost-privacy-overlay"
            className="flex-1 flex items-center justify-center p-6 bg-[var(--cloak-bg-void)]"
          >
            <div className="cloak-panel-enter max-w-md w-full rounded-3xl border border-[var(--cloak-border-strong)] bg-[var(--cloak-bg-card)] shadow-[var(--cloak-dialog-shadow)] p-7 space-y-5 text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-[var(--cloak-bg-sage-soft)] border border-[var(--cloak-accent-border)] flex items-center justify-center text-[var(--cloak-accent-text)]">
                <ShieldOff className="w-5 h-5" />
              </div>
              <div className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--cloak-text-dim)]">
                  Ghost Protection
                </div>
                <h2 className="font-editorial text-2xl font-normal text-[var(--cloak-text)] tracking-tight">
                  Ghost Privacy Shield Active
                </h2>
                <p className="text-xs text-[var(--cloak-text-muted)] leading-relaxed">
                  Decrypted conversation contents are concealed on this PC while Cloak is inactive or locked.
                  {callState !== 'idle' && ' Direct encrypted call remains connected.'}
                </p>
              </div>
              {ghostState?.pinLocked ? (
                <form onSubmit={handleUnlockPin} className="space-y-3 text-left">
                  <input
                    type="password"
                    value={pinUnlockInput}
                    onChange={(e) => setPinUnlockInput(e.target.value)}
                    placeholder="Enter Ghost Privacy PIN..."
                    aria-label="Ghost Privacy PIN"
                    className="w-full rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-4 py-2 text-sm text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
                  />
                  {pinUnlockError && <div className="text-xs text-[var(--cloak-danger-text)]">{pinUnlockError}</div>}
                  <Button type="submit" variant="primary" className="w-full">
                    <Lock className="w-3.5 h-3.5" /> Unlock Cloak View
                  </Button>
                </form>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  className="w-full"
                  onClick={() => void handleUnlockPin({ preventDefault: () => undefined } as React.FormEvent)}
                >
                  Resume Session View
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div ref={messageListRef} className="flex-1 overflow-y-auto overflow-x-hidden" data-testid="p2p-message-list">
            <div className="max-w-[920px] mx-auto w-full min-h-full px-4 sm:px-8 py-6 flex flex-col">
              {loadingMessages && messages.length === 0 ? (
                <div className="space-y-3 my-auto max-w-xl w-full mx-auto">
                  {[0, 1, 2].map((idx) => (
                    <div
                      key={idx}
                      className="rounded-2xl border border-[var(--cloak-border)] bg-[var(--cloak-bg-card)] p-4 space-y-2.5"
                    >
                      <div className="flex items-center gap-2.5">
                        <Skeleton className="w-7 h-7 rounded-full" />
                        <Skeleton className="h-3 w-28 rounded-full" />
                      </div>
                      <Skeleton className="h-3 w-4/5 rounded-full" />
                      <Skeleton className="h-3 w-3/5 rounded-full" />
                    </div>
                  ))}
                </div>
              ) : filteredMessages.length === 0 ? (
                <div className="m-auto max-w-md w-full rounded-3xl border border-[var(--cloak-border)] bg-[var(--cloak-bg-card)] p-8 text-center space-y-2.5 shadow-[var(--cloak-card-shadow)]">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--cloak-text-dim)]">
                    Direct Room Ledger
                  </div>
                  <p className="font-editorial italic text-xl text-[var(--cloak-text)]">
                    {messages.length === 0
                      ? 'An unlogged room awaits.'
                      : 'Nothing matches that filter.'}
                  </p>
                  <p className="text-xs text-[var(--cloak-text-muted)] leading-relaxed">
                    {messages.length === 0
                      ? 'No local messages visible in this channel.'
                      : 'No local messages match your search filter.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-3 pb-2 text-[11px] text-[var(--cloak-text-dim)]">
                    <div className="h-px flex-1 bg-[var(--cloak-border)]" />
                    <span className="font-editorial italic">
                      {hideRoomTitle ? 'Protected Channel' : activeRoom?.name ?? 'Conversation'} · E2EE Verified
                    </span>
                    <div className="h-px flex-1 bg-[var(--cloak-border)]" />
                  </div>

                  {filteredMessages.map((m, idx) => {
                    const prev = idx > 0 ? filteredMessages[idx - 1] : null;
                    const isOwn = m.senderDeviceId === status?.deviceId;
                    const senderName = isOwn
                      ? (status?.displayName ?? 'You')
                      : (peers.find((p) => p.deviceId === m.senderDeviceId)?.displayName ?? m.senderDeviceId.slice(0, 8));
                    const withinGroupWindow = prev
                      ? Math.abs(new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()) <= 5 * 60 * 1000
                      : false;
                    const isGroupedContinuation = Boolean(
                      prev && prev.senderDeviceId === m.senderDeviceId && withinGroupWindow && !m.replyToMessageId,
                    );
                    const actionButtons = (
                      <div className="flex items-center gap-1 shrink-0 opacity-85 group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          aria-label="Reply to message"
                          title="Reply"
                          onClick={() => {
                            setEditingMsg(null);
                            setReplyQuote({
                              id: m.id,
                              sender: senderName,
                              snippet: m.text.slice(0, 96).replace(/\s+/g, ' '),
                            });
                          }}
                          className="p-1 rounded-full text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-elevated)] cursor-pointer"
                        >
                          <CornerUpLeft className="w-3.5 h-3.5" />
                        </button>
                        {isOwn && (
                          <button
                            type="button"
                            aria-label="Edit message"
                            title="Edit"
                            onClick={() => {
                              setReplyQuote(null);
                              setEditingMsg(m);
                              setComposerText(m.text);
                            }}
                            className="p-1 rounded-full text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-elevated)] cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label="Message options"
                          title="More actions"
                          onClick={(e) => {
                            e.stopPropagation();
                            const rect = e.currentTarget.getBoundingClientRect();
                            setContextMenu({ msg: m, x: rect.left, y: rect.bottom + 6 });
                          }}
                          className="p-1 rounded-full text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-elevated)] cursor-pointer"
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete message for everyone"
                          title="Delete for everyone"
                          onClick={() =>
                            void p2pApi.deleteMessage(m.roomId, m.id, 'everyone').then(() => refreshMessages(m.roomId, m.channelId))
                          }
                          className="p-1 rounded-full text-[var(--cloak-text-muted)] hover:text-[var(--cloak-danger-text)] hover:bg-[var(--cloak-danger-soft)] cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );

                    return (
                      <article
                        key={m.id}
                        data-message-id={m.id}
                        data-grouped={isGroupedContinuation ? 'true' : 'false'}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({ msg: m, x: e.clientX, y: e.clientY });
                        }}
                        className={`group cloak-msg-enter rounded-2xl border cloak-transition ${isGroupedContinuation ? 'px-3.5 sm:px-4 py-2.5' : 'mt-2.5 p-3.5 sm:p-4 space-y-2'
                          } ${isOwn
                            ? 'bg-[var(--cloak-bg-sage-soft)]/55 border-[var(--cloak-accent-border)]'
                            : 'bg-[var(--cloak-bg-card)] border-[var(--cloak-border)] hover:border-[var(--cloak-border-strong)]'
                          }`}
                      >
                        {!isGroupedContinuation ? (
                          <div className="flex items-start justify-between gap-2 text-xs">
                            <div className="flex flex-wrap items-center gap-2 min-w-0">
                              <Avatar
                                size="sm"
                                name={senderName}
                                color={isOwn ? '#243C34' : '#5F6F63'}
                              />
                              <strong className="text-[var(--cloak-text)] font-semibold">
                                {senderName}
                              </strong>
                              <span className="font-mono-tabular text-[11px] text-[var(--cloak-text-dim)]">
                                {new Date(m.createdAt).toLocaleTimeString()}
                              </span>
                              {m.signatureVerified && (
                                <span title="Ed25519 signature verified" className="text-[var(--cloak-success-text)] text-[10px] font-medium">
                                  ✓ Signed
                                </span>
                              )}
                              {m.viewedAt ? (
                                <span className="text-[10px] text-[var(--cloak-text-muted)] inline-flex items-center gap-0.5" title="Viewed in local viewport">
                                  <Eye className="w-3 h-3" /> Viewed
                                </span>
                              ) : (
                                <span className="text-[10px] text-[var(--cloak-info-text)] inline-flex items-center gap-0.5" title="Not yet marked viewed">
                                  <EyeOff className="w-3 h-3" /> Unread
                                </span>
                              )}
                              {m.expireOnLeave && (
                                <span className="text-[10px] text-[var(--cloak-warn-text)]">· On-leave</span>
                              )}
                              {m.expireAfterViewSeconds != null && (
                                <span className="text-[10px] text-[var(--cloak-warn-text)]">· {m.expireAfterViewSeconds}s after view</span>
                              )}
                              {m.expiresAt && (
                                <span className="text-[10px] text-[var(--cloak-warn-text)]">
                                  · Exp {new Date(m.expiresAt).toLocaleTimeString()}
                                </span>
                              )}
                              {m.editedAt && <span className="text-[10px] text-[var(--cloak-text-muted)]">(edited)</span>}
                            </div>
                            {actionButtons}
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2 pl-9 mb-0.5 text-[10px] text-[var(--cloak-text-dim)]">
                            <div className="flex items-center gap-2 min-w-0 opacity-75 group-hover:opacity-100 transition-opacity">
                              <span className="font-mono-tabular">{new Date(m.createdAt).toLocaleTimeString()}</span>
                              {m.viewedAt ? (
                                <span className="inline-flex items-center gap-0.5 text-[var(--cloak-text-muted)]">
                                  <Eye className="w-2.5 h-2.5" /> Viewed
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-0.5 text-[var(--cloak-info-text)]">
                                  <EyeOff className="w-2.5 h-2.5" /> Unread
                                </span>
                              )}
                              {m.expireOnLeave && <span className="text-[var(--cloak-warn-text)]">· On-leave</span>}
                              {m.expireAfterViewSeconds != null && (
                                <span className="text-[var(--cloak-warn-text)]">· {m.expireAfterViewSeconds}s after view</span>
                              )}
                              {m.expiresAt && (
                                <span className="text-[var(--cloak-warn-text)]">
                                  · Exp {new Date(m.expiresAt).toLocaleTimeString()}
                                </span>
                              )}
                              {m.editedAt && <span>(edited)</span>}
                            </div>
                            {actionButtons}
                          </div>
                        )}

                        <div className="pl-9 space-y-2">
                          <SafeMarkdown text={m.text} />
                          {m.attachments.map((att) => (
                            <P2pAttachmentItem
                              key={att.id}
                              attachment={att}
                              onDownload={handleDownloadAttachment}
                            />
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {activeRoomId && activeChannelId && !isMasked && (
          <div className="px-4 sm:px-8 pb-4 pt-2 border-t border-[var(--cloak-border)] bg-[var(--cloak-bg-sidebar)]/70">
            <div className="max-w-[920px] mx-auto w-full space-y-2">
              {(replyQuote || editingMsg || pendingFiles.length > 0 || uploadedAttIds.length > 0) && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--cloak-border)] bg-[var(--cloak-bg-card)] px-3.5 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    {replyQuote && (
                      <span className="inline-flex items-center gap-1.5 text-[var(--cloak-text-body)] truncate">
                        <CornerUpLeft className="w-3.5 h-3.5 text-[var(--cloak-accent-text)] shrink-0" />
                        <span>
                          Replying to <strong>{replyQuote.sender}</strong>: {replyQuote.snippet}
                        </span>
                      </span>
                    )}
                    {editingMsg && (
                      <span className="inline-flex items-center gap-1.5 text-[var(--cloak-accent-text)] font-medium">
                        <Edit3 className="w-3.5 h-3.5 shrink-0" />
                        Editing encrypted message
                      </span>
                    )}
                    {pendingFiles.map((f, idx) => (
                      <span
                        key={`${f.name}-${idx}`}
                        className="inline-flex items-center gap-1.5 rounded-full bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] px-2.5 py-0.5 text-[11px]"
                      >
                        {f.name}
                        <button
                          type="button"
                          aria-label={`Remove ${f.name}`}
                          onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== idx))}
                          className="text-[var(--cloak-text-muted)] hover:text-[var(--cloak-danger-text)] cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    {uploadedAttIds.length > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--cloak-bg-sage-soft)] border border-[var(--cloak-accent-border)] px-2.5 py-0.5 text-[11px] text-[var(--cloak-accent-text)]">
                        {uploadedAttIds.length} native encrypted file(s) staged
                      </span>
                    )}
                  </div>
                  {(replyQuote || editingMsg) && (
                    <button
                      type="button"
                      onClick={() => {
                        setReplyQuote(null);
                        setEditingMsg(null);
                        setComposerText('');
                      }}
                      className="text-[11px] text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] cursor-pointer"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}

              <form
                onSubmit={handleSend}
                className="rounded-2xl border border-[var(--cloak-border-strong)] bg-[var(--cloak-bg-card)] shadow-[var(--cloak-card-shadow)] p-2 flex flex-wrap items-center gap-2"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={(e) => {
                    if (e.target.files) setPendingFiles(Array.from(e.target.files));
                    e.target.value = '';
                  }}
                  className="sr-only"
                />
                <button
                  type="button"
                  onClick={() => void handleNativeOrBrowserPick()}
                  aria-label="Attach P2P file"
                  className="p-2 rounded-full bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] text-[var(--cloak-text-body)] hover:bg-[var(--cloak-bg-elevated)] cursor-pointer cloak-transition"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <input
                  value={composerText}
                  onChange={(e) => setComposerText(e.target.value)}
                  placeholder={
                    editingMsg
                      ? 'Edit encrypted message...'
                      : pendingFiles.length + uploadedAttIds.length > 0
                        ? `Message (${pendingFiles.length + uploadedAttIds.length} file(s) staged)...`
                        : 'Direct encrypted message (stored in local SQLite)...'
                  }
                  className="flex-1 min-w-[180px] rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-4 py-2 text-sm text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
                />
                {!editingMsg && (
                  <select
                    value={disappearPreset}
                    onChange={(e) => setDisappearPreset(e.target.value)}
                    aria-label="Disappearing preset"
                    className="rounded-full bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] px-3 py-2 text-xs text-[var(--cloak-text-body)]"
                  >
                    <option value="off">Persist (Local)</option>
                    <option value="on_leave">On Leave Chat</option>
                    <option value="after_view:30">30s After View</option>
                    <option value="after_view:300">5m After View</option>
                    {DISAPPEARING_MESSAGE_OPTIONS.filter((o) => o.seconds !== null).map((o) => (
                      <option key={o.label} value={String(o.seconds)}>
                        {o.label}
                      </option>
                    ))}
                    <option value="custom">Custom (sec)...</option>
                  </select>
                )}
                {!editingMsg && disappearPreset === 'custom' && (
                  <input
                    type="number"
                    min={5}
                    value={customSeconds}
                    onChange={(e) => setCustomSeconds(e.target.value)}
                    aria-label="Custom disappearing seconds"
                    className="w-20 rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-2 text-xs text-[var(--cloak-text)]"
                  />
                )}
                <Button type="submit" variant="primary" size="sm">
                  <Send className="w-3.5 h-3.5" /> {editingMsg ? 'Save' : 'Send'}
                </Button>
              </form>
            </div>
          </div>
        )}

        {/* Message Floating Context Menu */}
        {contextMenu && !isMasked && (
          <div
            role="menu"
            style={{
              left: Math.min(contextMenu.x, Math.max(12, window.innerWidth - 210)),
              top: Math.min(contextMenu.y, Math.max(12, window.innerHeight - 230)),
            }}
            onClick={(e) => e.stopPropagation()}
            className="cloak-menu-enter fixed z-50 w-48 rounded-2xl border border-[var(--cloak-border-strong)] bg-[var(--cloak-bg-card)] shadow-[var(--cloak-dialog-shadow)] p-1.5 text-xs space-y-0.5"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const m = contextMenu.msg;
                const sender =
                  m.senderDeviceId === status?.deviceId
                    ? (status?.displayName ?? 'You')
                    : (peers.find((p) => p.deviceId === m.senderDeviceId)?.displayName ?? m.senderDeviceId.slice(0, 8));
                setEditingMsg(null);
                setReplyQuote({ id: m.id, sender, snippet: m.text.slice(0, 96).replace(/\s+/g, ' ') });
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-2 rounded-xl hover:bg-[var(--cloak-bg-hover)] text-[var(--cloak-text)] flex items-center gap-2 cursor-pointer"
            >
              <CornerUpLeft className="w-3.5 h-3.5" /> Reply Quote
            </button>
            {contextMenu.msg.senderDeviceId === status?.deviceId && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const m = contextMenu.msg;
                  setReplyQuote(null);
                  setEditingMsg(m);
                  setComposerText(m.text);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-2 rounded-xl hover:bg-[var(--cloak-bg-hover)] text-[var(--cloak-text)] flex items-center gap-2 cursor-pointer"
              >
                <Edit3 className="w-3.5 h-3.5" /> Edit Message
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void navigator.clipboard.writeText(contextMenu.msg.text);
                setInfoBanner('Copied message text to clipboard.');
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-2 rounded-xl hover:bg-[var(--cloak-bg-hover)] text-[var(--cloak-text)] flex items-center gap-2 cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5" /> Copy Text
            </button>
            <div className="my-1 border-t border-[var(--cloak-border)]" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const m = contextMenu.msg;
                setContextMenu(null);
                void p2pApi.deleteMessage(m.roomId, m.id, 'me').then(() => refreshMessages(m.roomId, m.channelId));
              }}
              className="w-full text-left px-3 py-2 rounded-xl hover:bg-[var(--cloak-danger-soft)] text-[var(--cloak-warn-text)] flex items-center gap-2 cursor-pointer"
            >
              <EyeOff className="w-3.5 h-3.5" /> Delete for Me
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const m = contextMenu.msg;
                setContextMenu(null);
                void p2pApi.deleteMessage(m.roomId, m.id, 'everyone').then(() => refreshMessages(m.roomId, m.channelId));
              }}
              className="w-full text-left px-3 py-2 rounded-xl hover:bg-[var(--cloak-danger-soft)] text-[var(--cloak-danger-text)] flex items-center gap-2 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete for Everyone
            </button>
          </div>
        )}
      </main>

      {ghostSettingsOpen && (
        <Suspense fallback={null}>
          <P2pGhostSettingsModal
            open={ghostSettingsOpen}
            onClose={() => setGhostSettingsOpen(false)}
            policy={ghostPolicy}
            activeRoomId={activeRoomId}
            activeRoomName={activeRoom?.name ?? null}
            roomOverride={activeRoomOverride}
            onSaved={(nextPolicy, nextOverride) => {
              setGhostPolicy(nextPolicy);
              if (activeRoomId) {
                setGhostOverrides((prev) => {
                  const filtered = prev.filter((o) => o.roomId !== activeRoomId);
                  return nextOverride ? [...filtered, nextOverride] : filtered;
                });
              }
              void refreshState();
            }}
          />
        </Suspense>
      )}

      {stealthSettingsOpen && (
        <Suspense fallback={null}>
          <P2pStealthSettingsModal
            open={stealthSettingsOpen}
            onClose={() => setStealthSettingsOpen(false)}
            bootstrap={stealthBootstrap}
            stealthConfig={stealthConfig}
            ghostPolicy={ghostPolicy}
            rooms={rooms}
            activeRoomId={activeRoomId}
            overrides={ghostOverrides}
            pdfDocs={pdfDocs}
            onSaved={async (nextCfg, nextGhost) => {
              setStealthConfig(nextCfg);
              stealthCfgRef.current = nextCfg;
              setGhostPolicy(nextGhost);
              await refreshState();
            }}
            onLockNow={() => {
              setStealthSettingsOpen(false);
              void p2pApi.triggerStealth('manual_lock').then(applyStealthBootstrap).catch(() => undefined);
            }}
          />
        </Suspense>
      )}

      <ModalDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Export Encrypted Local Archive (.cloakexport)"
        description="Creates an offline encrypted archive bundled with verified local attachments."
      >
        <form onSubmit={handleExportLocal} className="space-y-3">
          {exportErr && <div className="text-xs text-[var(--cloak-danger-text)]">{exportErr}</div>}
          <input
            type="password"
            value={exportPw}
            onChange={(e) => setExportPw(e.target.value)}
            placeholder="Strong export password (min 8 chars)"
            className="w-full rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-4 py-2 text-sm text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
          />
          <input
            type="password"
            value={exportPw2}
            onChange={(e) => setExportPw2(e.target.value)}
            placeholder="Confirm password"
            className="w-full rounded-full bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-4 py-2 text-sm text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Export .cloakexport
            </Button>
          </div>
        </form>
      </ModalDialog>

      <ConfirmDialog
        open={burnConfirmOpen}
        onCancel={() => setBurnConfirmOpen(false)}
        onConfirm={() => {
          if (!activeRoomId) return;
          setBurnBusy(true);
          void p2pApi
            .burnRoom(activeRoomId)
            .then(async () => {
              setBurnConfirmOpen(false);
              if (activeChannelId) await refreshMessages(activeRoomId, activeChannelId);
            })
            .catch((e) => setErrorBanner(e instanceof Error ? e.message : 'Burn room failed'))
            .finally(() => setBurnBusy(false));
        }}
        title="Burn Room History?"
        description="This permanently erases local messages in this room and increments its cryptographic epoch."
        confirmLabel="Burn Room History"
        destructive
        busy={burnBusy}
      />
    </div>
  );
}
