import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Archive,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  Flame,
  Hash,
  Link2,
  Lock,
  Menu,
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
import { Button, ModalDialog } from '@cloak/ui';
import { P2pGhostSettingsModal } from '../components/p2p/P2pGhostSettingsModal.js';
import { PdfReaderShell } from '../components/pdf/PdfReaderShell.js';
import { P2pStealthSettingsModal } from '../components/stealth/P2pStealthSettingsModal.js';
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
  type P2pStealthBootstrapState,
  type P2pStealthConfig,
  type P2pUnlockOutcome,
  type P2pWebRtcSignal,
  type UnlockMethod,
} from '../lib/p2pClient.js';
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
      className="cloak-md text-sm text-[#e2e8f0] leading-relaxed break-words"
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
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [infoBanner, setInfoBanner] = useState<string | null>(null);

  // Composer & Disappearing Presets
  const [composerText, setComposerText] = useState('');
  const [disappearPreset, setDisappearPreset] = useState<string>('off');
  const [customSeconds, setCustomSeconds] = useState<string>('120');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadedAttIds, setUploadedAttIds] = useState<string[]>([]);

  // Modals
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPw, setExportPw] = useState('');
  const [exportPw2, setExportPw2] = useState('');
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [ghostSettingsOpen, setGhostSettingsOpen] = useState(false);
  const [stealthSettingsOpen, setStealthSettingsOpen] = useState(false);

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

  const refreshMessages = useCallback(async (rid: string, cid: string) => {
    if (stealthLockedRef.current) return;
    try {
      const list = await p2pApi.listMessages(rid, cid);
      setMessages(list);
    } catch {
      // Ignore while switching channels or locked
    }
  }, []);

  useEffect(() => {
    void refreshState();
    void refreshDevices();
  }, [refreshState, refreshDevices]);

  useEffect(() => {
    if (stealthBootstrap?.locked) return;
    if (!activeRoomId) {
      setChannels([]);
      setActiveChannelId(null);
      setMessages([]);
      return;
    }
    void p2pApi.listChannels(activeRoomId).then((chs) => {
      setChannels(chs);
      if (chs[0]) setActiveChannelId(chs[0].id);
    }).catch(() => undefined);
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
      void refreshMessages(activeRoomId, activeChannelId);
    }
  }, [activeRoomId, activeChannelId, refreshMessages, applyGhostState, stealthBootReady, stealthLocked]);

  // Report modal state whenever app modals are open
  useEffect(() => {
    const anyOpen = exportOpen || ghostSettingsOpen || stealthSettingsOpen;
    setModalGuarded(anyOpen);
  }, [exportOpen, ghostSettingsOpen, stealthSettingsOpen, setModalGuarded]);

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
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setErrorBanner('2D Canvas context unavailable for native capture bridge');
      return;
    }

    let running = true;
    const drawFrame = async () => {
      if (!running) return;
      try {
        const blob = await p2pApi.getCaptureFrameBlob(source.id, spec.width);
        const bmp = await createImageBitmap(blob);
        ctx.fillStyle = '#05070c';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
        const w = Math.round(bmp.width * scale);
        const h = Math.round(bmp.height * scale);
        ctx.drawImage(bmp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        bmp.close();
      } catch {
        // Keep last drawn frame cleanly
      }
    };

    await drawFrame();
    const intervalMs = Math.max(33, Math.round(1000 / Math.min(spec.fps, 30)));
    const timer = window.setInterval(() => void drawFrame(), intervalMs);

    const stream = canvas.captureStream(spec.fps);
    const track = stream.getVideoTracks()[0];
    captureStopRef.current = () => {
      running = false;
      window.clearInterval(timer);
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

  const handleGenerateTicket = async () => {
    if (!activeRoomId) return;
    setErrorBanner(null);
    const res = await p2pApi.exportTicket(activeRoomId, advertisedAddr.trim() || undefined);
    setTicketUri(res.uri);
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
      await p2pApi.sendMessage(activeRoomId, activeChannelId, {
        text: composerText.trim() || '(attachment)',
        attachmentIds,
        expireInSeconds,
        expireOnLeave,
        expireAfterViewSeconds,
      });
      setComposerText('');
      setPendingFiles([]);
      setUploadedAttIds([]);
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
          { deviceId: status.deviceId, displayName: status.displayName, avatarColor: '#7c6cff' },
          ...peers.map((p) => ({ deviceId: p.deviceId, displayName: p.displayName, avatarColor: '#38bdf8' })),
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
            senderAvatarColor: '#7c6cff',
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
      <main className="min-h-screen bg-[#0c0e14] text-[#f1f3f9] flex items-center justify-center p-6">
        <div className="max-w-lg rounded-2xl border border-[#262c3f] bg-[#141722] p-6 space-y-4">
          <div className="flex items-center gap-3 text-[#38bdf8]">
            <ShieldCheck className="w-6 h-6" />
            <h1 className="text-lg font-semibold text-white">Cloak Direct P2P Desktop Mode</h1>
          </div>
          <p className="text-sm text-[#cbd5e1] leading-relaxed">{unavailableReason}</p>
          <div className="rounded-lg bg-[#0d1017] border border-[#262c3f] p-3 font-mono text-xs text-[#a5b4fc]">
            cargo +stable-x86_64-pc-windows-gnu run --release -p cloak-desktop
          </div>
          <div className="flex gap-2">
            <Link to="/" className="px-3 py-2 rounded-lg bg-[#7c6cff] text-white text-xs font-medium">
              Open Browser Workspace
            </Link>
            <Link to="/archive" className="px-3 py-2 rounded-lg bg-[#1e2334] text-[#cbd5e1] text-xs font-medium">
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
        className="min-h-screen bg-[#0d1017] text-[#94a3b8] flex items-center justify-center p-6 text-xs"
      >
        Initializing local workspace...
      </main>
    );
  }

  const concealSurface = stealthBootstrap.locked || stealthBootstrap.activeSurface !== 'messenger';

  if (concealSurface && (stealthBootstrap.activeSurface === 'pdf_reader' || stealthBootstrap.activeSurface === 'generic_doc_list')) {
    return (
      <>
        {callState !== 'idle' && <audio ref={remoteKeepAliveAudioRef} autoPlay className="hidden" />}
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
      </>
    );
  }

  if (concealSurface) {
    return (
      <main
        data-testid="stealth-lock-screen"
        className="min-h-screen bg-[#0b0d14] text-[#f1f3f9] flex items-center justify-center p-6"
      >
        {callState !== 'idle' && <audio ref={remoteKeepAliveAudioRef} autoPlay className="hidden" />}
        <div className="max-w-md w-full rounded-2xl border border-[#2a3146] bg-[#141722] p-6 space-y-4 shadow-2xl">
          <div className="mx-auto w-12 h-12 rounded-full bg-[#7c6cff]/15 border border-[#7c6cff]/40 flex items-center justify-center text-[#a5b4fc]">
            <Lock className="w-6 h-6" />
          </div>
          <div className="text-center space-y-1">
            <h1 className="text-base font-semibold text-white">
              {stealthBootstrap.activeSurface === 'privacy_shield' ? 'Privacy Shield Active' : 'Workspace Locked'}
            </h1>
            <p className="text-xs text-[#9aa3b8]">
              Local conversations and files remain sealed until unlocked.
              {callState !== 'idle' && stealthBootstrap.callSummary.inCall ? ' Active media session remains connected.' : ''}
            </p>
          </div>

          {stealthBootstrap.lockoutRemainingSeconds > 0 && (
            <div className="rounded-lg border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-3 py-2 text-xs text-[#fde68a]">
              Too many incorrect unlock attempts. Try again in {stealthBootstrap.lockoutRemainingSeconds}s.
            </div>
          )}

          <form onSubmit={handleStealthLockScreenSubmit} className="space-y-3">
            {!lockScreenUseRecovery ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {(['passphrase', 'pin', 'discreet_command'] as UnlockMethod[])
                    .filter((m) => stealthBootstrap.enabledUnlockMethods.includes(m))
                    .map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setLockScreenMethod(m)}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer border ${
                          lockScreenMethod === m
                            ? 'border-[#7c6cff] bg-[#7c6cff]/20 text-white'
                            : 'border-[#2a3146] bg-[#0d1017] text-[#9aa3b8]'
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
                  className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
                  autoFocus
                />
                {lockScreenNeedSecond && (
                  <input
                    type="password"
                    value={lockScreenSecondFactor}
                    onChange={(e) => setLockScreenSecondFactor(e.target.value)}
                    placeholder="Enter secondary passphrase factor..."
                    aria-label="Secondary passphrase factor"
                    className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
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
                className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm font-mono text-white"
                autoFocus
              />
            )}

            {lockScreenMsg && <div className="text-xs text-[#fca5a5]">{lockScreenMsg}</div>}

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setLockScreenUseRecovery((v) => !v);
                  setLockScreenMsg(null);
                }}
                className="text-[11px] text-[#a5b4fc] hover:underline cursor-pointer"
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

  return (
    <div className="h-screen flex bg-[#0d0f17] text-[#f1f3f9] overflow-hidden relative">
      {/* Left Sidebar: Node Info + Network Diagnostics + Rooms + Direct Pairing */}
      <aside
        className={`${
          sidebarOpen ? 'fixed inset-y-0 left-0 z-40 flex' : 'hidden lg:flex'
        } w-80 max-w-[85vw] shrink-0 bg-[#111420] border-r border-[#1f2435] flex-col overflow-y-auto p-3 gap-3`}
      >
        <div className="rounded-xl border border-[#262c3f] bg-[#161a28] p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[#a5b4fc] uppercase tracking-wider">Local SQLite Vault</span>
            <div className="flex items-center gap-1.5">
              {diagnostics?.vaultDpapiProtected && (
                <span className="px-1.5 py-0.5 rounded bg-[#22c55e]/15 text-[#34d399] text-[10px] font-medium">
                  DPAPI
                </span>
              )}
              <button
                type="button"
                aria-label="Close sidebar"
                onClick={() => setSidebarOpen(false)}
                className="lg:hidden text-[#9aa3b8] hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="text-sm font-medium text-white">
            {hideRoomTitle ? '•••••• (Protected)' : status?.displayName}
          </div>
          <div className="text-[11px] font-mono text-[#8d96ad] truncate" title={status?.listenAddr}>
            Listen: {status?.listenAddr}
          </div>
          {diagnostics && (
            <div className="text-[11px] text-[#9aa3b8] leading-snug">
              LAN IPv4: <span className="text-[#34d399] font-mono">{diagnostics.primaryLanIp ?? 'none'}</span>
              {diagnostics.primaryIpv6 ? ` · IPv6 ready` : ''}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1 text-[11px]">
            <Link to="/archive" className="inline-flex items-center gap-1 text-[#38bdf8] hover:underline">
              <Archive className="w-3 h-3" /> /archive
            </Link>
            <span className="text-[#475569]">·</span>
            <Link to="/" className="text-[#9aa3b8] hover:text-white">
              Server Mode
            </Link>
          </div>
        </div>

        {/* Connectivity & Firewall Diagnostics */}
        <div className="rounded-xl border border-[#262c3f] bg-[#161a28] p-3 space-y-2 text-xs">
          <label className="flex items-center gap-2 cursor-pointer text-[#e2e8f0]">
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
              className="w-full rounded-lg bg-[#0c0e14] border border-[#2a3146] px-2 py-1 text-xs text-white"
            />
          )}
          {diagnostics && (
            <div className="text-[11px] text-[#9aa3b8] border-t border-[#262c3f] pt-1.5">
              Firewall:{' '}
              <span className={diagnostics.windowsFirewallRulePresent ? 'text-[#34d399]' : 'text-[#fbbf24]'}>
                {diagnostics.firewallNote}
              </span>
            </div>
          )}
        </div>

        {/* Rooms */}
        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9aa3b8]">Local P2P Rooms</div>
          <form onSubmit={handleCreateRoom} className="flex gap-1.5">
            <input
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="New private room..."
              className="flex-1 rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-1.5 text-xs text-white min-w-0"
            />
            <Button size="sm" type="submit" aria-label="Create P2P Room">
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </form>
          <div className="space-y-1">
            {rooms.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setActiveRoomId(r.id);
                  setSidebarOpen(false);
                }}
                className={`w-full text-left px-2.5 py-2 rounded-lg text-xs font-medium flex items-center justify-between cursor-pointer ${
                  r.id === activeRoomId ? 'bg-[#7c6cff] text-white' : 'bg-[#171b28] text-[#cbd5e1] hover:bg-[#1f2536]'
                }`}
              >
                <span className="truncate">{hideRoomTitle ? 'Protected Room' : r.name}</span>
                <span className="text-[10px] opacity-80">E{r.currentEpoch}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Direct Pairing Ticket */}
        <div className="rounded-xl border border-[#262c3f] bg-[#161a28] p-3 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9aa3b8]">Direct Pairing Ticket</div>
          {activeRoomId && (
            <>
              {diagnostics && diagnostics.interfaces.length > 0 && (
                <select
                  aria-label="Advertised interface address"
                  value={advertisedAddr}
                  onChange={(e) => setAdvertisedAddr(e.target.value)}
                  className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2 py-1 text-[11px] text-[#cbd5e1]"
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
                placeholder={`Optional LAN/IPv6 host:port`}
                className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2 py-1 text-[11px] text-white"
              />
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
                <textarea
                  readOnly
                  rows={2}
                  value={ticketUri}
                  aria-label="Shareable pairing ticket"
                  className="w-full rounded-lg bg-[#0c0e14] border border-[#262c3f] p-1.5 font-mono text-[10px] text-[#a5b4fc]"
                />
              )}
            </>
          )}

          <form onSubmit={handlePair} className="space-y-1.5 pt-2 border-t border-[#262c3f]">
            <input
              value={pairUri}
              onChange={(e) => setPairUri(e.target.value)}
              placeholder="Paste peer cloakp2p://... ticket"
              className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2 py-1.5 text-xs text-white"
            />
            <Button size="sm" variant="primary" type="submit" className="w-full">
              Pair & Connect Directly
            </Button>
          </form>
        </div>

        {/* Peers */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9aa3b8]">Paired Peers ({peers.length})</div>
          {peers.map((p) => {
            const pState = status?.peerStates?.[p.deviceId] ?? (status?.activePeerIds.includes(p.deviceId) ? 'direct_connected' : 'disconnected');
            return (
              <div key={p.deviceId} className="rounded-lg bg-[#161a28] border border-[#242a3d] p-2 text-xs flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-white truncate">
                    {hideRoomTitle ? 'Verified Peer' : p.displayName}
                  </div>
                  <div className="text-[10px] text-[#8d96ad] truncate">{p.directAddr}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {p.revoked ? (
                    <span className="text-[10px] text-[#ef4444] font-semibold">Revoked</span>
                  ) : pState === 'direct_connected' ? (
                    <span className="text-[10px] text-[#34d399] inline-flex items-center gap-1">
                      <Wifi className="w-3 h-3" /> Direct
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        void p2pApi.connectPeer(p.deviceId).catch((e) => setErrorBanner(e instanceof Error ? e.message : 'Connect failed'))
                      }
                      className="text-[10px] text-[#fca5a5] hover:underline inline-flex items-center gap-1 cursor-pointer"
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
                      className="text-[10px] text-[#9aa3b8] hover:text-[#fca5a5] cursor-pointer"
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
      <main className="flex-1 flex flex-col min-w-0 bg-[#141722] relative">
        <header className="px-3 sm:px-4 py-2.5 border-b border-[#1f2435] bg-[#12151f] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              aria-label="Open P2P sidebar"
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-1.5 rounded-lg bg-[#1a1f2e] text-[#cbd5e1] cursor-pointer"
            >
              <Menu className="w-4 h-4" />
            </button>
            <Hash className="w-4 h-4 text-[#a5b4fc] shrink-0" />
            <h1 className="text-sm font-semibold text-white truncate">
              {hideRoomTitle ? 'Protected Conversation' : (activeRoom?.name ?? 'Select or Create a Room')}
            </h1>
            <button
              type="button"
              onClick={() => setGhostSettingsOpen(true)}
              data-testid="ghost-status-pill"
              className={`px-2 py-0.5 rounded-full text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer border ${
                ghostPolicy.enabled || activeRoomOverride
                  ? 'border-[#7c6cff]/60 bg-[#7c6cff]/15 text-[#c4b5fd]'
                  : 'border-[#2a3146] bg-[#171b28] text-[#9aa3b8]'
              }`}
            >
              <Settings2 className="w-3 h-3" />
              {formatModeBadge(effectiveMode, ghostPolicy.enabled || Boolean(activeRoomOverride))}
            </button>
            <button
              type="button"
              onClick={() => setStealthSettingsOpen(true)}
              data-testid="stealth-settings-btn"
              className={`px-2 py-0.5 rounded-full text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer border ${
                stealthBootstrap.stealthEnabled
                  ? 'border-[#38bdf8]/60 bg-[#38bdf8]/15 text-[#bae6fd]'
                  : 'border-[#2a3146] bg-[#171b28] text-[#9aa3b8]'
              }`}
            >
              <FileText className="w-3 h-3" />
              {stealthBootstrap.stealthEnabled ? 'Stealth: PDF Armed' : 'Stealth & PDF'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
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
                  <Search className="w-3.5 h-3.5 text-[#9aa3b8] absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search local history..."
                    aria-label="Search decrypted messages"
                    className="pl-7 pr-2 py-1 rounded-lg bg-[#0d1017] border border-[#262c3f] text-xs text-white w-40"
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
                  onClick={() =>
                    void p2pApi.burnRoom(activeRoomId).then(() => {
                      if (activeChannelId) return refreshMessages(activeRoomId, activeChannelId);
                    })
                  }
                >
                  <Flame className="w-3.5 h-3.5" /> Burn
                </Button>
              </>
            )}
          </div>
        </header>

        {errorBanner && (
          <div role="alert" className="mx-4 mt-3 rounded-lg border border-[#ef4444]/50 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#fca5a5] flex items-center justify-between gap-2">
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
          <div className="mx-4 mt-3 rounded-lg border border-[#22c55e]/40 bg-[#22c55e]/10 px-3 py-2 text-xs text-[#86efac] flex items-center justify-between">
            <span>{infoBanner}</span>
            <button type="button" onClick={() => setInfoBanner(null)} className="text-xs underline cursor-pointer">
              Dismiss
            </button>
          </div>
        )}
        {!isMasked && ghostState?.lastCleanup && (
          <div className="mx-4 mt-3 rounded-lg border border-[#7c6cff]/40 bg-[#7c6cff]/10 px-3 py-1.5 text-[11px] text-[#c4b5fd] flex items-center justify-between gap-2">
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
            className="flex-1 flex items-center justify-center p-6 bg-[#0b0d14]"
          >
            <div className="max-w-md w-full rounded-2xl border border-[#2a3146] bg-[#141722] p-6 space-y-4 text-center shadow-2xl">
              <div className="mx-auto w-12 h-12 rounded-full bg-[#7c6cff]/15 border border-[#7c6cff]/40 flex items-center justify-center text-[#a5b4fc]">
                <ShieldOff className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-white">Ghost Privacy Shield Active</h2>
                <p className="text-xs text-[#9aa3b8] leading-relaxed">
                  Decrypted conversation contents are concealed on this PC while Cloak is inactive or locked.
                  {callState !== 'idle' && ' Direct encrypted call remains connected.'}
                </p>
              </div>
              {ghostState?.pinLocked ? (
                <form onSubmit={handleUnlockPin} className="space-y-2.5 text-left">
                  <input
                    type="password"
                    value={pinUnlockInput}
                    onChange={(e) => setPinUnlockInput(e.target.value)}
                    placeholder="Enter Ghost Privacy PIN..."
                    aria-label="Ghost Privacy PIN"
                    className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
                  />
                  {pinUnlockError && <div className="text-xs text-[#fca5a5]">{pinUnlockError}</div>}
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
          <div ref={messageListRef} className="flex-1 overflow-y-auto p-4 space-y-3" data-testid="p2p-message-list">
            {filteredMessages.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-[#8d96ad]">
                {messages.length === 0
                  ? 'No local messages visible in this channel.'
                  : 'No local messages match your search filter.'}
              </div>
            ) : (
              filteredMessages.map((m) => (
                <article
                  key={m.id}
                  data-message-id={m.id}
                  className="rounded-xl border border-[#23293c] bg-[#181c29] p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-white">
                        {m.senderDeviceId === status?.deviceId
                          ? status.displayName
                          : (peers.find((p) => p.deviceId === m.senderDeviceId)?.displayName ?? m.senderDeviceId.slice(0, 8))}
                      </strong>
                      <span className="text-[11px] text-[#8d96ad]">{new Date(m.createdAt).toLocaleTimeString()}</span>
                      {m.signatureVerified && (
                        <span title="Ed25519 signature verified" className="text-[#34d399] text-[10px]">
                          ✓ Signed
                        </span>
                      )}
                      {m.viewedAt ? (
                        <span className="text-[10px] text-[#94a3b8] inline-flex items-center gap-0.5" title="Viewed in local viewport">
                          <Eye className="w-3 h-3" /> Viewed
                        </span>
                      ) : (
                        <span className="text-[10px] text-[#38bdf8] inline-flex items-center gap-0.5" title="Not yet marked viewed">
                          <EyeOff className="w-3 h-3" /> Unread
                        </span>
                      )}
                      {m.expireOnLeave && (
                        <span className="text-[10px] text-[#fbbf24]">· On-leave</span>
                      )}
                      {m.expireAfterViewSeconds != null && (
                        <span className="text-[10px] text-[#fbbf24]">· {m.expireAfterViewSeconds}s after view</span>
                      )}
                      {m.expiresAt && (
                        <span className="text-[10px] text-[#f59e0b]">
                          · Exp {new Date(m.expiresAt).toLocaleTimeString()}
                        </span>
                      )}
                      {m.editedAt && <span className="text-[10px] text-[#9aa3b8]">(edited)</span>}
                    </div>
                    <button
                      type="button"
                      aria-label="Delete message for everyone"
                      onClick={() =>
                        void p2pApi.deleteMessage(m.roomId, m.id, 'everyone').then(() => refreshMessages(m.roomId, m.channelId))
                      }
                      className="text-[#9aa3b8] hover:text-[#fca5a5] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <SafeMarkdown text={m.text} />
                  {m.attachments.map((att) => (
                    <div key={att.id} className="rounded-lg border border-[#2a3146] bg-[#10131d] px-2.5 py-1.5 text-xs flex items-center justify-between gap-2">
                      <span className="text-[#cbd5e1] truncate">
                        {att.filename} ({(att.totalSizeBytes / 1024).toFixed(1)} KiB · SHA-256)
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleDownloadAttachment(att.id, att.filename)}
                        className="text-[#a5b4fc] hover:underline inline-flex items-center gap-1 cursor-pointer shrink-0"
                      >
                        <Download className="w-3 h-3" /> Save
                      </button>
                    </div>
                  ))}
                </article>
              ))
            )}
          </div>
        )}

        {activeRoomId && activeChannelId && !isMasked && (
          <form onSubmit={handleSend} className="p-3 border-t border-[#1f2435] bg-[#12151f] flex flex-wrap items-center gap-2">
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
              className="p-2 rounded-lg bg-[#1a1f2e] text-[#cbd5e1] cursor-pointer"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <input
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              placeholder={
                pendingFiles.length + uploadedAttIds.length > 0
                  ? `Message (${pendingFiles.length + uploadedAttIds.length} file(s) staged)...`
                  : 'Direct encrypted message (stored in local SQLite)...'
              }
              className="flex-1 min-w-[180px] rounded-lg bg-[#0d1017] border border-[#262c3f] px-3 py-2 text-sm text-white"
            />
            <select
              value={disappearPreset}
              onChange={(e) => setDisappearPreset(e.target.value)}
              aria-label="Disappearing preset"
              className="rounded-lg bg-[#0d1017] border border-[#262c3f] px-2 py-2 text-xs text-[#cbd5e1]"
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
            {disappearPreset === 'custom' && (
              <input
                type="number"
                min={5}
                value={customSeconds}
                onChange={(e) => setCustomSeconds(e.target.value)}
                aria-label="Custom disappearing seconds"
                className="w-20 rounded-lg bg-[#0d1017] border border-[#262c3f] px-2 py-2 text-xs text-white"
              />
            )}
            <Button type="submit" variant="primary" size="sm">
              <Send className="w-3.5 h-3.5" /> Send
            </Button>
          </form>
        )}
      </main>

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

      <ModalDialog open={exportOpen} onClose={() => setExportOpen(false)} title="Export Encrypted Local Archive (.cloakexport)">
        <form onSubmit={handleExportLocal} className="space-y-3">
          {exportErr && <div className="text-xs text-[#fca5a5]">{exportErr}</div>}
          <input
            type="password"
            value={exportPw}
            onChange={(e) => setExportPw(e.target.value)}
            placeholder="Strong export password (min 8 chars)"
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
          />
          <input
            type="password"
            value={exportPw2}
            onChange={(e) => setExportPw2(e.target.value)}
            placeholder="Confirm password"
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Export .cloakexport
            </Button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
