import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDexieLiveQuery as useLiveQuery } from '../lib/useLiveQuery.js';
import {
  Bookmark,
  Download,
  FileText,
  Hash,
  Info,
  Link2,
  Menu,
  Pin,
  Plus,
  Search,
  Shield,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import type { ScreenSharePreset } from '@cloak/config';
import type { RoomSummary } from '@cloak/protocol';
import { Button, Skeleton, ToastRegion } from '@cloak/ui';
import { ChannelSidebar } from '../components/ChannelSidebar.js';
import { CallStageView } from '../components/CallStageView.js';
import { LeftRail } from '../components/LeftRail.js';
import { MessageComposer } from '../components/MessageComposer.js';
import { MessageList } from '../components/MessageList.js';
import {
  BurnRoomModal,
  CreateChannelModal,
  CreateRoomModal,
  DeviceSettingsModal,
  ExportChatModal,
  ForwardModal,
  JoinInviteModal,
  ManageInvitesModal,
  SettingsModal,
} from '../components/Modals.js';
import { OnboardingScreen } from '../components/OnboardingScreen.js';
import { RightSidebar } from '../components/RightSidebar.js';
import { ThemeToggle } from '../components/ThemeToggle.js';
import { UnlockVaultScreen } from '../components/UnlockVaultScreen.js';
import { VoiceDockBar } from '../components/VoiceDockBar.js';
import { api, getApiAccessToken, type RoomDetailResponse } from '../lib/api.js';
import { CloakLiveKitController } from '../lib/livekitCall.js';
import { clientSearch } from '../lib/search.js';
import {
  db,
  getActiveChannelMessages,
  loadRoomEpochKey,
  purgeExpiredMessagesLocally,
  type StoredBookmarkRecord,
} from '../lib/storage.js';
import {
  deleteMessageByScope,
  editEncryptedMessage,
  handleIncomingWsMessage,
  loadChannelMessages,
  retryFailedMessage,
  sendEncryptedMessage,
  syncRoomWithServer,
  toggleMessageReaction,
} from '../lib/workspaceClient.js';
import { CloakWsClient } from '../lib/wsClient.js';
import { useAppStore } from '../store/useAppStore.js';

export function WorkspacePage() {
  const queryClient = useQueryClient();
  const vaultState = useAppStore((s) => s.vaultState);
  const profile = useAppStore((s) => s.profile);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const activeChannelId = useAppStore((s) => s.activeChannelId);
  const rightDrawer = useAppStore((s) => s.rightDrawer);
  const mobileNavOpen = useAppStore((s) => s.mobileNavOpen);
  const activeModal = useAppStore((s) => s.activeModal);
  const editingMessage = useAppStore((s) => s.editingMessage);
  const replyTarget = useAppStore((s) => s.replyTarget);
  const forwardingMessage = useAppStore((s) => s.forwardingMessage);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const typingByChannel = useAppStore((s) => s.typingByChannel);
  const call = useAppStore((s) => s.call);
  const toasts = useAppStore((s) => s.toasts);

  const selectRoom = useAppStore((s) => s.selectRoom);
  const selectChannel = useAppStore((s) => s.selectChannel);
  const setRightDrawer = useAppStore((s) => s.setRightDrawer);
  const setMobileNavOpen = useAppStore((s) => s.setMobileNavOpen);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const setEditingMessage = useAppStore((s) => s.setEditingMessage);
  const setReplyTarget = useAppStore((s) => s.setReplyTarget);
  const setThreadRootMessage = useAppStore((s) => s.setThreadRootMessage);
  const setForwardingMessage = useAppStore((s) => s.setForwardingMessage);
  const setWsStatus = useAppStore((s) => s.setWsStatus);
  const updateCall = useAppStore((s) => s.updateCall);
  const resetCall = useAppStore((s) => s.resetCall);
  const pushToast = useAppStore((s) => s.pushToast);
  const dismissToast = useAppStore((s) => s.dismissToast);

  const [channelLoading, setChannelLoading] = useState(false);
  const wsClientRef = useRef<CloakWsClient | null>(null);
  const livekitRef = useRef<CloakLiveKitController | null>(null);
  const remoteAudioRefs = useRef<HTMLDivElement | null>(null);

  const roomsQuery = useQuery({
    queryKey: ['rooms'],
    queryFn: () => api.listRooms(),
    enabled: vaultState === 'unlocked',
    staleTime: 15_000,
  });

  const roomDetailQuery = useQuery({
    queryKey: ['room', activeRoomId],
    queryFn: () => api.getRoom(activeRoomId!),
    enabled: vaultState === 'unlocked' && Boolean(activeRoomId),
    staleTime: 10_000,
  });

  const rooms = useMemo(() => roomsQuery.data ?? [], [roomsQuery.data]);
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const roomDetail: RoomDetailResponse | null = roomDetailQuery.data ?? null;

  // Auto-select first room cleanly
  useEffect(() => {
    if (!activeRoomId && rooms.length > 0 && rooms[0]) {
      selectRoom(rooms[0]);
    }
  }, [activeRoomId, rooms, selectRoom]);

  // Ensure activeChannelId stays valid inside selected room
  useEffect(() => {
    if (!roomDetail) return;
    const textChannels = roomDetail.room.channels.filter((c) => c.channelType !== 'voice');
    const exists = roomDetail.room.channels.some((c) => c.id === activeChannelId);
    if ((!activeChannelId || !exists) && textChannels[0]) {
      selectChannel(textChannels[0].id);
    }
  }, [roomDetail, activeChannelId, selectChannel]);

  // Sync epoch envelopes + room event cursor + channel history
  useEffect(() => {
    if (!roomDetail) return;
    let cancelled = false;
    void (async () => {
      try {
        await syncRoomWithServer(roomDetail);
        if (!cancelled && activeChannelId) {
          setChannelLoading(true);
          await loadChannelMessages({
            roomId: roomDetail.room.id,
            channelId: activeChannelId,
            members: roomDetail.members,
          });
        }
      } finally {
        if (!cancelled) setChannelLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomDetail, activeChannelId]);

  // Periodic local expiration sweep so disappearing messages vanish on schedule
  useEffect(() => {
    if (vaultState !== 'unlocked') return;
    const timer = setInterval(() => {
      void purgeExpiredMessagesLocally().then((expiredIds) => {
        if (expiredIds.length > 0) clientSearch.removeMany(expiredIds);
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [vaultState]);

  // Live messages & bookmarks from IndexedDB (reactive across local sends, WS & sync)
  const activeMessages = useLiveQuery(
    () =>
      activeRoomId && activeChannelId
        ? getActiveChannelMessages(activeRoomId, activeChannelId)
        : Promise.resolve([]),
    [activeRoomId, activeChannelId],
    [],
  );

  const bookmarkRows = useLiveQuery<StoredBookmarkRecord[]>(
    () => (activeRoomId ? db.bookmarks.where('roomId').equals(activeRoomId).toArray() : Promise.resolve([])),
    [activeRoomId],
    [],
  );
  const bookmarkedIds = useMemo(() => new Set<string>(bookmarkRows.map((b) => b.messageId)), [bookmarkRows]);

  // WebSocket Realtime Sync
  const roomDetailRef = useRef<RoomDetailResponse | null>(null);
  roomDetailRef.current = roomDetail;
  const activeChannelIdRef = useRef<string | null>(null);
  activeChannelIdRef.current = activeChannelId;

  useEffect(() => {
    if (vaultState !== 'unlocked') {
      wsClientRef.current?.disconnect();
      wsClientRef.current = null;
      return;
    }
    const token = getApiAccessToken();
    if (!token) return;

    const client = new CloakWsClient(
      (msg) => {
        void handleIncomingWsMessage(msg, {
          roomDetail: roomDetailRef.current,
          activeChannelId: activeChannelIdRef.current,
          onRoomChange: (rid) => {
            void queryClient.invalidateQueries({ queryKey: ['room', rid] });
            void queryClient.invalidateQueries({ queryKey: ['rooms'] });
          },
          onChannelMessagesChange: () => {
            // useLiveQuery reflects Dexie updates automatically
          },
        });
      },
      (status) => setWsStatus(status),
    );
    wsClientRef.current = client;
    client.connect(
      token,
      roomsRef.current.map((r) => r.id),
    );

    return () => {
      client.disconnect();
      wsClientRef.current = null;
    };
  }, [vaultState, queryClient, setWsStatus]);

  useEffect(() => {
    if (wsClientRef.current) {
      wsClientRef.current.updateRooms(rooms.map((r) => r.id));
    }
  }, [rooms]);

  // Initialize LiveKit controller
  useEffect(() => {
    const controller = new CloakLiveKitController({
      onParticipantsChanged: (participants) => {
        updateCall({ participants });
        // Attach remote audio tracks to hidden container respecting deafen
        const box = remoteAudioRefs.current;
        if (box) {
          box.innerHTML = '';
          for (const item of controller.getRemoteAudioTracks()) {
            const el = item.track.attach() as HTMLMediaElement;
            el.muted = useAppStore.getState().call.deafened;
            box.appendChild(el);
          }
        }
      },
      onAudioLevelChanged: () => {
        // Refreshed inside participants snapshot
      },
      onDisconnected: () => {
        resetCall();
      },
      onE2EEState: (enabled, note) => {
        updateCall({ e2eeActive: enabled, e2eeNote: note });
      },
    });
    livekitRef.current = controller;
    return () => {
      void controller.disconnect();
    };
  }, [resetCall, updateCall]);

  // Keyboard shortcuts: Ctrl/Cmd+K Search, PTT Spacebar when enabled
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setRightDrawer('search');
        return;
      }
      if (e.code === 'Space' && call.pttMode && call.status === 'connected') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (!call.micEnabled) {
          void livekitRef.current?.setMicrophoneEnabled(true);
          updateCall({ micEnabled: true });
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && call.pttMode && call.status === 'connected') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        void livekitRef.current?.setMicrophoneEnabled(false);
        updateCall({ micEnabled: false });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [call.micEnabled, call.pttMode, call.status, setRightDrawer, updateCall]);

  const handleJoinVoiceChannel = useCallback(
    async (channelId: string) => {
      if (!roomDetail || !livekitRef.current) return;
      const ch = roomDetail.room.channels.find((c) => c.id === channelId);
      if (!ch) return;
      const epochKey = await loadRoomEpochKey(roomDetail.room.id, roomDetail.room.currentEpoch);
      if (!epochKey) {
        pushToast({ tone: 'error', title: 'Missing room epoch key for media E2EE' });
        return;
      }
      updateCall({
        status: 'connecting',
        roomId: roomDetail.room.id,
        roomName: roomDetail.room.name,
        channelId: ch.id,
        channelName: ch.name,
        errorNote: null,
      });
      try {
        const tk = await api.issueCallToken(roomDetail.room.id, ch.id);
        await livekitRef.current.connect({
          livekitUrl: tk.livekitUrl,
          token: tk.token,
          epochKey,
          roomId: roomDetail.room.id,
          epoch: roomDetail.room.currentEpoch,
        });
        updateCall({ status: 'connected', micEnabled: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'SFU unavailable';
        updateCall({ status: 'error', errorNote: msg });
        pushToast({
          tone: 'warning',
          title: 'Voice server unreachable',
          detail: 'Token signed and local media E2EE worker initialized, but LiveKit SFU did not answer on configured URL.',
        });
      }
    },
    [pushToast, roomDetail, updateCall],
  );

  const refreshActiveRoom = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['rooms'] });
    if (activeRoomId) {
      await queryClient.invalidateQueries({ queryKey: ['room', activeRoomId] });
    }
  }, [activeRoomId, queryClient]);

  if (vaultState === 'loading') {
    return (
      <main className="min-h-screen bg-[var(--cloak-bg-void)] p-8 space-y-4">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-[70vh] w-full rounded-[12px]" />
      </main>
    );
  }
  if (vaultState === 'needs_onboarding') return <OnboardingScreen />;
  if (vaultState === 'locked') return <UnlockVaultScreen />;

  const activeChannel =
    roomDetail?.room.channels.find((c) => c.id === activeChannelId) ?? null;
  const myMember = roomDetail?.members.find((m) => m.deviceId === profile?.id);
  const isModerator = myMember?.roleName === 'owner' || myMember?.roleName === 'admin';
  const canSend = myMember?.roleName !== 'readonly' && myMember?.status === 'active';

  const typingDevices = Object.entries(typingByChannel[activeChannelId ?? ''] ?? {})
    .filter(([devId, exp]) => devId !== profile?.id && exp > Date.now())
    .map(([devId]) => {
      const m = roomDetail?.members.find((x) => x.deviceId === devId);
      return m?.displayName || devId.slice(0, 6);
    });

  return (
    <div className="h-screen w-screen bg-[var(--cloak-bg-void)] text-[var(--cloak-text)] flex flex-col overflow-hidden">
      <div ref={remoteAudioRefs} className="hidden" aria-hidden="true" />

      {/* Reconnection Banner */}
      {(wsStatus === 'reconnecting' || wsStatus === 'disconnected') && (
        <div
          role="status"
          className="bg-[var(--cloak-warn-soft)] border-b border-[var(--cloak-warn-border)] px-4 py-1.5 text-xs text-[var(--cloak-warn-text)] flex items-center justify-center gap-2"
        >
          <WifiOff className="w-3.5 h-3.5" />
          <span>
            {wsStatus === 'reconnecting'
              ? 'Reconnecting to Cloak realtime relay — local encrypted queue active.'
              : 'Realtime socket disconnected — viewing encrypted offline vault cache.'}
          </span>
        </div>
      )}

      <div className="flex-1 flex min-h-0 relative">
        {/* Desktop Rail + Sidebar, Responsive Drawer on Mobile (<768px) */}
        <div
          className={`${
            mobileNavOpen ? 'fixed inset-0 z-40 flex bg-black/60 md:static md:bg-transparent' : 'hidden md:flex'
          } shrink-0 min-h-0`}
        >
          <LeftRail
            rooms={rooms}
            onSelectRoom={(r: RoomSummary) => {
              selectRoom(r);
              setMobileNavOpen(false);
            }}
          />
          {roomDetail && (
            <ChannelSidebar
              roomDetail={roomDetail}
              onJoinVoiceChannel={handleJoinVoiceChannel}
            />
          )}
          {mobileNavOpen && (
            <button
              type="button"
              aria-label="Close navigation menu"
              onClick={() => setMobileNavOpen(false)}
              className="flex-1 md:hidden cursor-pointer flex items-start justify-end p-4"
            >
              <span className="p-2 rounded-[7px] bg-[var(--cloak-bg-surface)] text-[var(--cloak-text)] border border-[var(--cloak-border)]">
                <X className="w-5 h-5" />
              </span>
            </button>
          )}
        </div>

        {/* Main Chat / Call Area */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--cloak-bg-void)]">
          {roomDetail && activeChannel ? (
            <>
              {/* Top Header Bar */}
              <header className="px-3 sm:px-4 py-2.5 border-b border-[var(--cloak-border)] bg-[var(--cloak-bg-sidebar)] flex items-center justify-between gap-2 sm:gap-3">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <button
                    type="button"
                    aria-label="Open navigation menu"
                    onClick={() => setMobileNavOpen(true)}
                    className="md:hidden p-1.5 rounded-[7px] bg-[var(--cloak-bg-elevated)] border border-[var(--cloak-border)] text-[var(--cloak-text-body)] cursor-pointer shrink-0"
                  >
                    <Menu className="w-4 h-4" />
                  </button>
                  <Hash className="w-4 h-4 text-[var(--cloak-accent-text)] shrink-0" />
                  <div className="min-w-0">
                    <h1 className="text-sm font-semibold text-[var(--cloak-text)] truncate">{activeChannel.name}</h1>
                    {activeChannel.topic && (
                      <p className="text-[11px] text-[var(--cloak-text-dim)] truncate hidden sm:block">{activeChannel.topic}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-0.5 sm:gap-1 shrink-0 overflow-x-auto max-w-[54vw] sm:max-w-none">
                  <ThemeToggle />
                  <button
                    type="button"
                    onClick={() => setRightDrawer('search')}
                    title="Local Search (Ctrl+K)"
                    aria-label="Local Search"
                    className={`p-2 rounded-[7px] cursor-pointer ${
                      rightDrawer === 'search'
                        ? 'bg-[var(--cloak-accent-soft)] text-[var(--cloak-accent-text)]'
                        : 'text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
                    }`}
                  >
                    <Search className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightDrawer('pins')}
                    title="Pinned Messages"
                    aria-label="Pinned Messages"
                    className={`p-2 rounded-[7px] cursor-pointer ${
                      rightDrawer === 'pins'
                        ? 'bg-[var(--cloak-accent-soft)] text-[var(--cloak-accent-text)]'
                        : 'text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
                    }`}
                  >
                    <Pin className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightDrawer('files')}
                    title="Shared Encrypted Files"
                    aria-label="Shared Files"
                    className={`p-2 rounded-[7px] cursor-pointer ${
                      rightDrawer === 'files'
                        ? 'bg-[var(--cloak-accent-soft)] text-[var(--cloak-accent-text)]'
                        : 'text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
                    }`}
                  >
                    <FileText className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightDrawer('bookmarks')}
                    title="Local Bookmarks"
                    aria-label="Bookmarks"
                    className={`p-2 rounded-[7px] cursor-pointer ${
                      rightDrawer === 'bookmarks'
                        ? 'bg-[var(--cloak-accent-soft)] text-[var(--cloak-accent-text)]'
                        : 'text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
                    }`}
                  >
                    <Bookmark className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightDrawer('members')}
                    title="Members & Approvals"
                    aria-label="Members"
                    className={`p-2 rounded-[7px] cursor-pointer ${
                      rightDrawer === 'members'
                        ? 'bg-[var(--cloak-accent-soft)] text-[var(--cloak-accent-text)]'
                        : 'text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
                    }`}
                  >
                    <Users className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightDrawer('info')}
                    title="Room Security & Storage Quota"
                    aria-label="Room Info"
                    className={`p-2 rounded-[7px] cursor-pointer ${
                      rightDrawer === 'info'
                        ? 'bg-[var(--cloak-accent-soft)] text-[var(--cloak-accent-text)]'
                        : 'text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
                    }`}
                  >
                    <Info className="w-4 h-4" />
                  </button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setActiveModal('export_chat')}
                    className="hidden sm:inline-flex ml-1"
                  >
                    <Download className="w-3.5 h-3.5" /> Export
                  </Button>
                </div>
              </header>

              <CallStageView participants={call.participants} />

              <MessageList
                messages={activeMessages}
                members={roomDetail.members}
                currentDeviceId={profile?.id ?? ''}
                isModerator={isModerator}
                loading={channelLoading}
                typingNames={typingDevices}
                bookmarkedIds={bookmarkedIds}
                onReply={(m) => setReplyTarget(m)}
                onEdit={(m) => setEditingMessage(m)}
                onDelete={async (m, scope) => {
                  await deleteMessageByScope(m, scope);
                  pushToast({
                    tone: 'info',
                    title: scope === 'me' ? 'Hidden on this device' : 'Deleted for everyone',
                  });
                }}
                onReact={(m, emoji) => toggleMessageReaction(m, emoji)}
                onTogglePin={async (m) => {
                  if (m.isPinned) {
                    await api.unpinMessage(roomDetail.room.id, m.id);
                    await db.messages.update(m.id, { isPinned: 0 });
                  } else {
                    await api.pinMessage(roomDetail.room.id, m.id);
                    await db.messages.update(m.id, { isPinned: 1 });
                  }
                }}
                onToggleBookmark={async (m) => {
                  if (bookmarkedIds.has(m.id)) {
                    await db.bookmarks.delete(m.id);
                  } else {
                    await db.bookmarks.put({
                      messageId: m.id,
                      roomId: m.roomId,
                      channelId: m.channelId,
                      createdAt: new Date().toISOString(),
                    });
                  }
                }}
                onOpenThread={(m) => setThreadRootMessage(m)}
                onForward={(m) => setForwardingMessage(m)}
                onRetry={async (m) => {
                  await retryFailedMessage(m, roomDetail.members);
                }}
              />

              <MessageComposer
                roomId={roomDetail.room.id}
                channelId={activeChannel.id}
                channelName={activeChannel.name}
                currentEpoch={roomDetail.room.currentEpoch}
                canSend={canSend}
                onSend={async ({ text, attachments, voiceNote, expireInSeconds }) => {
                  await sendEncryptedMessage({
                    roomId: roomDetail.room.id,
                    channelId: activeChannel.id,
                    epoch: roomDetail.room.currentEpoch,
                    text,
                    attachments,
                    members: roomDetail.members,
                    replyTo: replyTarget,
                    voiceNote,
                    expireInSeconds: expireInSeconds ?? activeChannel.disappearSeconds ?? roomDetail.room.defaultDisappearSeconds,
                  });
                }}
                onSaveEdit={async (newText) => {
                  if (!editingMessage) return;
                  await editEncryptedMessage({
                    msg: editingMessage,
                    newText,
                    members: roomDetail.members,
                  });
                }}
                onTypingChange={(isTyping) => {
                  wsClientRef.current?.sendTyping(roomDetail.room.id, activeChannel.id, isTyping);
                }}
              />
            </>
          ) : (
            /* Empty Workspace CTA */
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-4">
              <div className="w-full flex items-center justify-between md:justify-end">
                <button
                  type="button"
                  aria-label="Open navigation menu"
                  onClick={() => setMobileNavOpen(true)}
                  className="md:hidden p-2 rounded-[7px] bg-[var(--cloak-bg-elevated)] border border-[var(--cloak-border)] text-[var(--cloak-text)]"
                >
                  <Menu className="w-4 h-4" />
                </button>
                <ThemeToggle />
              </div>
              <div className="w-14 h-14 rounded-[12px] bg-[var(--cloak-accent-soft)] border border-[var(--cloak-accent-border)] flex items-center justify-center text-[var(--cloak-accent-text)]">
                <Shield className="w-7 h-7" />
              </div>
              <div className="max-w-md space-y-1.5">
                <h1 className="text-xl font-semibold text-[var(--cloak-text)]">Welcome to Cloak, {profile?.displayName}</h1>
                <p className="text-sm text-[var(--cloak-text-muted)]">
                  Create a private E2EE room or join an existing workspace using an invitation link.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-3">
                <Button variant="primary" onClick={() => setActiveModal('create_room')}>
                  <Plus className="w-4 h-4" /> Create Private Room
                </Button>
                <Button variant="secondary" onClick={() => setActiveModal('join_invite')}>
                  <Link2 className="w-4 h-4" /> Join Invite Link
                </Button>
              </div>
            </div>
          )}

          {/* Persistent Voice / Call Control Bar */}
          <VoiceDockBar
            onToggleMic={async () => {
              const next = !call.micEnabled;
              await livekitRef.current?.setMicrophoneEnabled(next);
              updateCall({ micEnabled: next });
            }}
            onToggleDeafen={() => {
              const next = !call.deafened;
              livekitRef.current?.setDeafened(next);
              if (remoteAudioRefs.current) {
                remoteAudioRefs.current.querySelectorAll('audio').forEach((a) => {
                  a.muted = next;
                });
              }
              updateCall({ deafened: next });
            }}
            onToggleCam={async () => {
              const next = !call.camEnabled;
              await livekitRef.current?.setCameraEnabled(next);
              updateCall({ camEnabled: next, layout: next && call.layout === 'dock' ? 'grid' : call.layout });
            }}
            onToggleScreen={async (preset?: ScreenSharePreset) => {
              const next = !call.screenEnabled;
              await livekitRef.current?.setScreenShareEnabled(next, preset);
              updateCall({ screenEnabled: next, layout: next ? 'focus' : call.layout });
            }}
            onDisconnect={async () => {
              await livekitRef.current?.disconnect();
              resetCall();
            }}
          />
        </main>

        {/* Right Utility Sidebar */}
        {roomDetail && (
          <RightSidebar
            roomDetail={roomDetail}
            activeChannelId={activeChannelId}
            onRefreshRoom={refreshActiveRoom}
            onSendThreadReply={async (root, text) => {
              await sendEncryptedMessage({
                roomId: roomDetail.room.id,
                channelId: root.channelId,
                epoch: roomDetail.room.currentEpoch,
                text,
                attachments: [],
                members: roomDetail.members,
                threadRootId: root.id,
              });
            }}
          />
        )}
      </div>

      {/* Modals */}
      <CreateRoomModal
        open={activeModal === 'create_room'}
        onClose={() => setActiveModal(null)}
        onCreated={async (detail) => {
          await refreshActiveRoom();
          selectRoom(detail.room);
        }}
      />

      <JoinInviteModal
        open={activeModal === 'join_invite'}
        onClose={() => setActiveModal(null)}
        onJoinedRoom={async (rid) => {
          const list = await api.listRooms();
          queryClient.setQueryData(['rooms'], list);
          const found = list.find((r) => r.id === rid) ?? null;
          selectRoom(found);
        }}
      />

      {roomDetail && (
        <>
          <ManageInvitesModal
            open={activeModal === 'manage_invites'}
            onClose={() => setActiveModal(null)}
            roomId={roomDetail.room.id}
            roomName={roomDetail.room.name}
            currentEpoch={roomDetail.room.currentEpoch}
          />
          <CreateChannelModal
            open={activeModal === 'create_channel'}
            onClose={() => setActiveModal(null)}
            roomId={roomDetail.room.id}
            onCreated={refreshActiveRoom}
          />
          <ExportChatModal
            open={activeModal === 'export_chat'}
            onClose={() => setActiveModal(null)}
            roomDetail={roomDetail}
            activeChannelId={activeChannelId}
          />
          <BurnRoomModal
            open={activeModal === 'burn_room'}
            onClose={() => setActiveModal(null)}
            roomDetail={roomDetail}
            onBurned={refreshActiveRoom}
          />
        </>
      )}

      <SettingsModal open={activeModal === 'settings'} onClose={() => setActiveModal(null)} />
      <ForwardModal
        open={Boolean(forwardingMessage)}
        onClose={() => setForwardingMessage(null)}
        msg={forwardingMessage}
        rooms={rooms}
      />
      <DeviceSettingsModal
        open={activeModal === 'device_settings'}
        onClose={() => setActiveModal(null)}
        controller={livekitRef.current}
      />

      <ToastRegion
        toasts={toasts}
        onDismiss={dismissToast}
        suppressWhenModalOpen={Boolean(activeModal || forwardingMessage)}
      />
    </div>
  );
}
