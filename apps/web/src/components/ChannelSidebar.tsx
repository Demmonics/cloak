import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Download,
  Flame,
  Hash,
  Lock,
  Megaphone,
  Plus,
  Timer,
  UserPlus,
  Volume2,
} from 'lucide-react';
import { Avatar } from '@cloak/ui';
import type { RoomDetailResponse } from '../lib/api.js';
import { useAppStore } from '../store/useAppStore.js';

export interface ChannelSidebarProps {
  roomDetail: RoomDetailResponse;
  onJoinVoiceChannel: (channelId: string) => void;
}

export function ChannelSidebar({ roomDetail, onJoinVoiceChannel }: ChannelSidebarProps) {
  const activeChannelId = useAppStore((s) => s.activeChannelId);
  const selectChannel = useAppStore((s) => s.selectChannel);
  const unreadByChannel = useAppStore((s) => s.unreadByChannel);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const setMobileNavOpen = useAppStore((s) => s.setMobileNavOpen);
  const presenceByDevice = useAppStore((s) => s.presenceByDevice);
  const profile = useAppStore((s) => s.profile);
  const call = useAppStore((s) => s.call);

  const [textOpen, setTextOpen] = useState(true);
  const [voiceOpen, setVoiceOpen] = useState(true);

  const { room, members } = roomDetail;
  const myMember = members.find((m) => m.deviceId === profile?.id);
  const isAdminOrOwner = myMember?.roleName === 'owner' || myMember?.roleName === 'admin';
  const isOwner = myMember?.roleName === 'owner';

  const textChannels = room.channels.filter((c) => c.channelType !== 'voice');
  const voiceChannels = room.channels.filter((c) => c.channelType === 'voice');
  const activeMembers = members.filter((m) => m.status === 'active');

  return (
    <aside
      aria-label="Room channels and members"
      className="w-64 shrink-0 bg-[var(--cloak-bg-sidebar)] border-r border-[var(--cloak-border)] flex flex-col min-h-0"
    >
      {/* Room Header */}
      <div className="px-4 py-3 border-b border-[var(--cloak-border)]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-sm text-[var(--cloak-text)] truncate" title={room.name}>
            {room.name}
          </h2>
          <span
            title="Current E2EE key epoch"
            className="shrink-0 inline-flex items-center gap-1 rounded-[5px] bg-[var(--cloak-accent-soft)] border border-[var(--cloak-accent-border)] px-1.5 py-0.5 text-[10px] font-mono font-medium text-[var(--cloak-accent-text)]"
          >
            <Lock className="w-2.5 h-2.5" />
            E{room.currentEpoch}
          </span>
        </div>

        {room.description && (
          <p className="text-[11px] text-[var(--cloak-text-dim)] mt-1 line-clamp-2">{room.description}</p>
        )}

        {/* Quick Room Controls */}
        <div className="mt-2.5 grid grid-cols-3 gap-1.5">
          {isAdminOrOwner && (
            <button
              type="button"
              onClick={() => setActiveModal('manage_invites')}
              className="flex items-center justify-center gap-1 rounded-[6px] bg-[var(--cloak-bg-elevated)] border border-[var(--cloak-border)] hover:bg-[var(--cloak-bg-hover)] px-2 py-1 text-[11px] text-[var(--cloak-text-body)] cursor-pointer transition-colors"
            >
              <UserPlus className="w-3 h-3 text-[var(--cloak-accent-text)]" />
              Invite
            </button>
          )}
          <button
            type="button"
            onClick={() => setActiveModal('export_chat')}
            className="flex items-center justify-center gap-1 rounded-[6px] bg-[var(--cloak-bg-elevated)] border border-[var(--cloak-border)] hover:bg-[var(--cloak-bg-hover)] px-2 py-1 text-[11px] text-[var(--cloak-text-body)] cursor-pointer transition-colors"
          >
            <Download className="w-3 h-3 text-[var(--cloak-info-text)]" />
            Export
          </button>
          {isOwner && (
            <button
              type="button"
              onClick={() => setActiveModal('burn_room')}
              title="Wipe room message history & rotate encryption epoch"
              className="flex items-center justify-center gap-1 rounded-[6px] bg-[var(--cloak-danger-soft)] border border-[var(--cloak-danger-border)] px-2 py-1 text-[11px] text-[var(--cloak-danger-text)] cursor-pointer transition-colors"
            >
              <Flame className="w-3 h-3" />
              Burn
            </button>
          )}
        </div>
      </div>

      {/* Channels List */}
      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {/* Text Channels */}
        <div>
          <div className="flex items-center justify-between px-1 mb-1">
            <button
              type="button"
              onClick={() => setTextOpen((v) => !v)}
              aria-expanded={textOpen}
              className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--cloak-text-dim)] hover:text-[var(--cloak-text)] cursor-pointer"
            >
              {textOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Text Channels
            </button>
            {isAdminOrOwner && (
              <button
                type="button"
                aria-label="Create Channel"
                title="Create Channel"
                onClick={() => setActiveModal('create_channel')}
                className="p-0.5 text-[var(--cloak-text-dim)] hover:text-[var(--cloak-text)] rounded cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {textOpen && (
            <div className="space-y-0.5">
              {textChannels.map((ch) => {
                const active = ch.id === activeChannelId;
                const unread = unreadByChannel[ch.id] ?? 0;
                return (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => {
                      selectChannel(ch.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[7px] text-sm cursor-pointer border transition-colors ${
                      active
                        ? 'bg-[var(--cloak-bg-active)] text-[var(--cloak-text)] font-medium border-[var(--cloak-border)] border-l-2 border-l-[var(--cloak-accent)]'
                        : unread > 0
                          ? 'text-[var(--cloak-text)] font-medium border-transparent hover:bg-[var(--cloak-bg-hover)]'
                          : 'text-[var(--cloak-text-muted)] border-transparent hover:bg-[var(--cloak-bg-hover)] hover:text-[var(--cloak-text)]'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {ch.channelType === 'announcement' ? (
                        <Megaphone className="w-4 h-4 shrink-0 text-[var(--cloak-warn-text)]" />
                      ) : (
                        <Hash className="w-4 h-4 shrink-0 text-[var(--cloak-text-dim)]" />
                      )}
                      <span className="truncate">{ch.name}</span>
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      {ch.disappearSeconds && (
                        <span title={`Disappears after ${ch.disappearSeconds}s`}>
                          <Timer className="w-3 h-3 text-[var(--cloak-info-text)]" />
                        </span>
                      )}
                      {unread > 0 && (
                        <span className="min-w-4 h-4 px-1 rounded-full bg-[var(--cloak-danger)] text-[10px] font-bold text-white flex items-center justify-center">
                          {unread}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Voice Channels */}
        <div>
          <div className="flex items-center justify-between px-1 mb-1">
            <button
              type="button"
              onClick={() => setVoiceOpen((v) => !v)}
              aria-expanded={voiceOpen}
              className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--cloak-text-dim)] hover:text-[var(--cloak-text)] cursor-pointer"
            >
              {voiceOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Voice & Video
            </button>
          </div>

          {voiceOpen && (
            <div className="space-y-0.5">
              {voiceChannels.map((ch) => {
                const isConnected = call.channelId === ch.id && call.status !== 'idle';
                return (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => {
                      onJoinVoiceChannel(ch.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[7px] text-sm cursor-pointer border transition-colors ${
                      isConnected
                        ? 'bg-[var(--cloak-success-soft)] text-[var(--cloak-success-text)] border-[var(--cloak-success-border)]'
                        : 'text-[var(--cloak-text-muted)] border-transparent hover:bg-[var(--cloak-bg-hover)] hover:text-[var(--cloak-text)]'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Volume2 className="w-4 h-4 shrink-0 text-[var(--cloak-success-text)]" />
                      <span className="truncate">{ch.name}</span>
                    </span>
                    {isConnected && (
                      <span className="text-[10px] font-semibold uppercase text-[var(--cloak-success-text)]">Live</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Members quick list */}
        <div>
          <div className="px-1 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--cloak-text-dim)]">
            Members — {activeMembers.length}
          </div>
          <div className="space-y-1">
            {activeMembers.slice(0, 12).map((m) => (
              <div
                key={m.deviceId}
                className="flex items-center gap-2 px-1.5 py-1 rounded-md text-xs text-[var(--cloak-text-body)]"
              >
                <Avatar
                  name={m.displayName}
                  color={m.avatarColor}
                  emoji={m.avatarEmoji}
                  status={presenceByDevice[m.deviceId] ?? (m.deviceId === profile?.id ? 'online' : 'offline')}
                  size="sm"
                />
                <span className="truncate flex-1">{m.displayName}</span>
                {m.roleName === 'owner' && (
                  <span className="text-[9px] uppercase tracking-wide text-[var(--cloak-warn-text)]">Owner</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Identity Footer */}
      {profile && (
        <div className="px-3 py-2.5 border-t border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Avatar
              name={profile.displayName}
              color={profile.avatarColor}
              emoji={profile.avatarEmoji}
              status="online"
              size="sm"
            />
            <div className="min-w-0">
              <div className="text-xs font-medium text-[var(--cloak-text)] truncate">{profile.displayName}</div>
              <div className="text-[10px] text-[var(--cloak-text-dim)] font-mono truncate">
                {profile.id.slice(0, 8)}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActiveModal('settings')}
            className="text-[11px] text-[var(--cloak-accent-text)] hover:underline cursor-pointer shrink-0"
          >
            Vault
          </button>
        </div>
      )}
    </aside>
  );
}
