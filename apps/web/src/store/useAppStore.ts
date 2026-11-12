import { create } from 'zustand';
import type { DeviceKeyBundle } from '@cloak/crypto';
import type { DeviceProfile, RoomSummary } from '@cloak/protocol';
import type { ToastItem } from '@cloak/ui';
import type { WsConnectionStatus } from '../lib/wsClient.js';
import type { CallParticipantView } from '../lib/livekitCall.js';
import type { LocalDecryptedMessage } from '../lib/storage.js';

export type RightDrawerTab = 'members' | 'pins' | 'files' | 'search' | 'info' | 'bookmarks' | null;
export type CallStageLayout = 'dock' | 'grid' | 'focus';

export interface ActiveCallState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  roomId: string | null;
  roomName: string | null;
  channelId: string | null;
  channelName: string | null;
  micEnabled: boolean;
  deafened: boolean;
  camEnabled: boolean;
  screenEnabled: boolean;
  pttMode: boolean;
  e2eeActive: boolean;
  e2eeNote: string;
  errorNote: string | null;
  layout: CallStageLayout;
  participants: CallParticipantView[];
}

interface AppState {
  // Identity & Vault
  vaultState: 'loading' | 'needs_onboarding' | 'locked' | 'unlocked';
  vaultMode: 'browser_key' | 'passphrase';
  keyBundle: DeviceKeyBundle | null;
  profile: DeviceProfile | null;

  // Navigation & UI
  activeRoomId: string | null;
  activeChannelId: string | null;
  rightDrawer: RightDrawerTab;
  mobileNavOpen: boolean;
  activeModal:
    | null
    | 'create_room'
    | 'join_invite'
    | 'manage_invites'
    | 'create_channel'
    | 'edit_channel'
    | 'export_chat'
    | 'settings'
    | 'burn_room'
    | 'device_settings';

  // Messaging interactions
  replyTarget: LocalDecryptedMessage | null;
  editingMessage: LocalDecryptedMessage | null;
  threadRootMessage: LocalDecryptedMessage | null;
  forwardingMessage: LocalDecryptedMessage | null;
  composerDisappearSeconds: number | null;
  unreadByChannel: Record<string, number>;

  // Live Realtime State
  wsStatus: WsConnectionStatus;
  typingByChannel: Record<string, Record<string, number>>; // channelId -> { deviceId: expiresAtMs }
  presenceByDevice: Record<string, 'online' | 'idle' | 'dnd' | 'offline'>;

  // Voice / Video Call
  call: ActiveCallState;

  // Global notifications
  toasts: ToastItem[];

  // Actions
  setVaultUnlocked: (bundle: DeviceKeyBundle, profile: DeviceProfile, mode: 'browser_key' | 'passphrase') => void;
  setVaultState: (state: AppState['vaultState']) => void;
  lockVault: () => void;
  setProfile: (profile: DeviceProfile) => void;
  selectRoom: (room: RoomSummary | null) => void;
  selectChannel: (channelId: string | null) => void;
  setRightDrawer: (tab: RightDrawerTab) => void;
  setMobileNavOpen: (open: boolean) => void;
  setActiveModal: (modal: AppState['activeModal']) => void;
  setReplyTarget: (msg: LocalDecryptedMessage | null) => void;
  setEditingMessage: (msg: LocalDecryptedMessage | null) => void;
  setThreadRootMessage: (msg: LocalDecryptedMessage | null) => void;
  setForwardingMessage: (msg: LocalDecryptedMessage | null) => void;
  setComposerDisappearSeconds: (seconds: number | null) => void;
  incrementUnread: (channelId: string) => void;
  clearUnread: (channelId: string) => void;
  setWsStatus: (status: WsConnectionStatus) => void;
  setTyping: (channelId: string, deviceId: string, isTyping: boolean) => void;
  setPresence: (deviceId: string, status: 'online' | 'idle' | 'dnd' | 'offline') => void;
  updateCall: (partial: Partial<ActiveCallState>) => void;
  resetCall: () => void;
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;
  dismissToast: (id: string) => void;
}

const INITIAL_CALL_STATE: ActiveCallState = {
  status: 'idle',
  roomId: null,
  roomName: null,
  channelId: null,
  channelName: null,
  micEnabled: true,
  deafened: false,
  camEnabled: false,
  screenEnabled: false,
  pttMode: false,
  e2eeActive: false,
  e2eeNote: '',
  errorNote: null,
  layout: 'dock',
  participants: [],
};

export const useAppStore = create<AppState>((set) => ({
  vaultState: 'loading',
  vaultMode: 'browser_key',
  keyBundle: null,
  profile: null,
  activeRoomId: null,
  activeChannelId: null,
  rightDrawer: null,
  mobileNavOpen: false,
  activeModal: null,
  replyTarget: null,
  editingMessage: null,
  threadRootMessage: null,
  forwardingMessage: null,
  composerDisappearSeconds: null,
  unreadByChannel: {},
  wsStatus: 'disconnected',
  typingByChannel: {},
  presenceByDevice: {},
  call: INITIAL_CALL_STATE,
  toasts: [],

  setVaultUnlocked: (keyBundle, profile, vaultMode) =>
    set({ vaultState: 'unlocked', keyBundle, profile, vaultMode }),
  setVaultState: (vaultState) => set({ vaultState }),
  lockVault: () => set({ vaultState: 'locked', keyBundle: null }),
  setProfile: (profile) => set({ profile }),

  selectRoom: (room) =>
    set((state) => {
      if (!room) {
        return { activeRoomId: null, activeChannelId: null, replyTarget: null, editingMessage: null };
      }
      const firstText = room.channels.find((c) => c.channelType !== 'voice') ?? room.channels[0] ?? null;
      const nextUnread = { ...state.unreadByChannel };
      if (firstText) delete nextUnread[firstText.id];
      return {
        activeRoomId: room.id,
        activeChannelId: firstText?.id ?? null,
        composerDisappearSeconds: firstText?.disappearSeconds ?? room.defaultDisappearSeconds ?? null,
        replyTarget: null,
        editingMessage: null,
        threadRootMessage: null,
        mobileNavOpen: false,
        unreadByChannel: nextUnread,
      };
    }),

  selectChannel: (channelId) =>
    set((state) => {
      const nextUnread = { ...state.unreadByChannel };
      if (channelId) delete nextUnread[channelId];
      return {
        activeChannelId: channelId,
        replyTarget: null,
        editingMessage: null,
        threadRootMessage: null,
        mobileNavOpen: false,
        unreadByChannel: nextUnread,
      };
    }),

  setRightDrawer: (rightDrawer) =>
    set((state) => ({ rightDrawer: state.rightDrawer === rightDrawer ? null : rightDrawer })),
  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
  setActiveModal: (activeModal) => set({ activeModal }),
  setReplyTarget: (replyTarget) => set({ replyTarget, editingMessage: null }),
  setEditingMessage: (editingMessage) => set({ editingMessage, replyTarget: null }),
  setThreadRootMessage: (threadRootMessage) => set({ threadRootMessage }),
  setForwardingMessage: (forwardingMessage) => set({ forwardingMessage }),
  setComposerDisappearSeconds: (composerDisappearSeconds) => set({ composerDisappearSeconds }),

  incrementUnread: (channelId) =>
    set((state) => {
      if (state.activeChannelId === channelId) return state;
      return {
        unreadByChannel: {
          ...state.unreadByChannel,
          [channelId]: (state.unreadByChannel[channelId] ?? 0) + 1,
        },
      };
    }),

  clearUnread: (channelId) =>
    set((state) => {
      if (!state.unreadByChannel[channelId]) return state;
      const copy = { ...state.unreadByChannel };
      delete copy[channelId];
      return { unreadByChannel: copy };
    }),

  setWsStatus: (wsStatus) => set({ wsStatus }),

  setTyping: (channelId, deviceId, isTyping) =>
    set((state) => {
      const chMap = { ...(state.typingByChannel[channelId] ?? {}) };
      if (isTyping) {
        chMap[deviceId] = Date.now() + 5000;
      } else {
        delete chMap[deviceId];
      }
      return {
        typingByChannel: { ...state.typingByChannel, [channelId]: chMap },
      };
    }),

  setPresence: (deviceId, status) =>
    set((state) => ({
      presenceByDevice: { ...state.presenceByDevice, [deviceId]: status },
    })),

  updateCall: (partial) => set((state) => ({ call: { ...state.call, ...partial } })),
  resetCall: () => set({ call: INITIAL_CALL_STATE }),

  pushToast: (toast) =>
    set((state) => {
      const id = crypto.randomUUID();
      setTimeout(() => {
        useAppStore.getState().dismissToast(id);
      }, 5500);
      return { toasts: [...state.toasts.slice(-3), { ...toast, id }] };
    }),

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

