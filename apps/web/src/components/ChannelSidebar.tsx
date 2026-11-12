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
      className="w-64 shrink-0 bg-[#12151f] border-r border-[#1f2435] flex flex-col min-h-0"
    >
      {/* Room Header */}
      <div className="px-4 py-3 border-b border-[#1f2435]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-sm text-[#f1f3f9] truncate" title={room.name}>
            {room.name}
          </h2>
          <span
            title="Current E2EE key epoch"
            className="shrink-0 inline-flex items-center gap-1 rounded-md bg-[#7c6cff]/15 border border-[#7c6cff]/30 px-1.5 py-0.5 text-[10px] font-medium text-[#c4b5fd]"
          >
            <Lock className="w-2.5 h-2.5" />
            E{room.currentEpoch}
          </span>
        </div>

        {room.description && (
          <p className="text-[11px] text-[#8d96ad] mt-1 line-clamp-2">{room.description}</p>
        )}

        {/* Quick Room Controls */}
        <div className="mt-2.5 grid grid-cols-3 gap-1.5">
          {isAdminOrOwner && (
            <button
              type="button"
              onClick={() => setActiveModal('manage_invites')}
              className="flex items-center justify-center gap-1 rounded-md bg-[#1a1f2e] hover:bg-[#252c40] px-2 py-1 text-[11px] text-[#cbd5e1] cursor-pointer cloak-transition"
            >
              <UserPlus className="w-3 h-3 text-[#a5b4fc]" />
              Invite
            </button>
          )}
          <button
            type="button"
            onClick={() => setActiveModal('export_chat')}
            className="flex items-center justify-center gap-1 rounded-md bg-[#1a1f2e] hover:bg-[#252c40] px-2 py-1 text-[11px] text-[#cbd5e1] cursor-pointer cloak-transition"
          >
            <Download className="w-3 h-3 text-[#38bdf8]" />
            Export
          </button>
          {isOwner && (
            <button
              type="button"
              onClick={() => setActiveModal('burn_room')}
              title="Wipe room message history & rotate encryption epoch"
              className="flex items-center justify-center gap-1 rounded-md bg-[#26161b] hover:bg-[#3b1c24] px-2 py-1 text-[11px] text-[#fca5a5] cursor-pointer cloak-transition"
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
              className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[#8d96ad] hover:text-[#e2e8f0] cursor-pointer"
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
                className="p-0.5 text-[#8d96ad] hover:text-white rounded cursor-pointer"
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
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-sm cursor-pointer cloak-transition ${
                      active
                        ? 'bg-[#7c6cff]/20 text-white font-medium border border-[#7c6cff]/30'
                        : unread > 0
                          ? 'text-white font-medium hover:bg-[#1a1f2e]'
                          : 'text-[#9aa3b8] hover:bg-[#1a1f2e] hover:text-[#e2e8f0]'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {ch.channelType === 'announcement' ? (
                        <Megaphone className="w-4 h-4 shrink-0 text-[#f59e0b]" />
                      ) : (
                        <Hash className="w-4 h-4 shrink-0 text-[#8d96ad]" />
                      )}
                      <span className="truncate">{ch.name}</span>
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      {ch.disappearSeconds && (
                        <span title={`Disappears after ${ch.disappearSeconds}s`}>
                          <Timer className="w-3 h-3 text-[#38bdf8]" />
                        </span>
                      )}
                      {unread > 0 && (
                        <span className="min-w-4 h-4 px-1 rounded-full bg-[#ef4444] text-[10px] font-bold text-white flex items-center justify-center">
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
              className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[#8d96ad] hover:text-[#e2e8f0] cursor-pointer"
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
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-sm cursor-pointer cloak-transition ${
                      isConnected
                        ? 'bg-[#10b981]/15 text-[#6ee7b7] border border-[#10b981]/30'
                        : 'text-[#9aa3b8] hover:bg-[#1a1f2e] hover:text-[#e2e8f0]'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Volume2 className="w-4 h-4 shrink-0 text-[#34d399]" />
                      <span className="truncate">{ch.name}</span>
                    </span>
                    {isConnected && (
                      <span className="text-[10px] font-semibold uppercase text-[#34d399]">Live</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Members quick list */}
        <div>
          <div className="px-1 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#8d96ad]">
            Members — {activeMembers.length}
          </div>
          <div className="space-y-1">
            {activeMembers.slice(0, 12).map((m) => (
              <div
                key={m.deviceId}
                className="flex items-center gap-2 px-1.5 py-1 rounded-md text-xs text-[#cbd5e1]"
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
                  <span className="text-[9px] uppercase tracking-wide text-[#fbbf24]">Owner</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Identity Footer */}
      {profile && (
        <div className="px-3 py-2.5 border-t border-[#1f2435] bg-[#0f121b] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Avatar
              name={profile.displayName}
              color={profile.avatarColor}
              emoji={profile.avatarEmoji}
              status="online"
              size="sm"
            />
            <div className="min-w-0">
              <div className="text-xs font-medium text-white truncate">{profile.displayName}</div>
              <div className="text-[10px] text-[#8d96ad] font-mono truncate">
                {profile.id.slice(0, 8)}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActiveModal('settings')}
            className="text-[11px] text-[#a5b4fc] hover:underline cursor-pointer shrink-0"
          >
            Vault
          </button>
        </div>
      )}
    </aside>
  );
}
