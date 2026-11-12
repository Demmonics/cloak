import React from 'react';
import { Link } from 'react-router';
import { Archive, Link2, MessageSquareLock, Network, Plus, Settings, Shield } from 'lucide-react';
import type { RoomSummary } from '@cloak/protocol';
import { useAppStore } from '../store/useAppStore.js';

export interface LeftRailProps {
  rooms: RoomSummary[];
  onSelectRoom: (room: RoomSummary) => void;
}

export function LeftRail({ rooms, onSelectRoom }: LeftRailProps) {
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const unreadByChannel = useAppStore((s) => s.unreadByChannel);
  const setActiveModal = useAppStore((s) => s.setActiveModal);

  const dmRooms = rooms.filter((r) => r.roomKind === 'dm');
  const groupRooms = rooms.filter((r) => r.roomKind !== 'dm');

  const getRoomUnread = (room: RoomSummary) =>
    room.channels.reduce((sum, ch) => sum + (unreadByChannel[ch.id] ?? 0), 0);

  return (
    <nav
      aria-label="Rooms and workspaces"
      className="w-[70px] shrink-0 bg-[#0d0f17] border-r border-[#1f2435] flex flex-col items-center py-3 gap-2 overflow-y-auto"
    >
      <div
        title="Cloak Encrypted Workspace"
        className="w-11 h-11 rounded-2xl bg-gradient-to-br from-[#7c6cff] to-[#4f46e5] flex items-center justify-center text-white shadow-lg mb-1"
      >
        <Shield className="w-5 h-5" />
      </div>

      <div className="w-8 h-px bg-[#23293c] my-0.5" />

      {dmRooms.map((room) => {
        const active = room.id === activeRoomId;
        const unread = getRoomUnread(room);
        return (
          <button
            key={room.id}
            type="button"
            title={`DM: ${room.name}`}
            aria-label={`Direct message ${room.name}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelectRoom(room)}
            className={`relative w-11 h-11 rounded-2xl flex items-center justify-center text-xs font-semibold cursor-pointer cloak-transition ${
              active
                ? 'bg-[#38bdf8] text-[#081018] rounded-xl ring-2 ring-[#7dd3fc]/60'
                : 'bg-[#181c29] text-[#cbd5e1] hover:bg-[#23293d] hover:text-white'
            }`}
          >
            <MessageSquareLock className="w-4 h-4" />
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-[#ef4444] text-[10px] font-bold text-white flex items-center justify-center">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        );
      })}

      {dmRooms.length > 0 && groupRooms.length > 0 && <div className="w-8 h-px bg-[#23293c] my-0.5" />}

      {groupRooms.map((room) => {
        const active = room.id === activeRoomId;
        const unread = getRoomUnread(room);
        const initials = room.name
          .split(/\s+/)
          .map((w) => w[0] ?? '')
          .join('')
          .slice(0, 2)
          .toUpperCase();
        return (
          <button
            key={room.id}
            type="button"
            title={room.name}
            aria-label={`Room ${room.name}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelectRoom(room)}
            className={`relative w-11 h-11 flex items-center justify-center text-sm font-semibold cursor-pointer cloak-transition ${
              active
                ? 'rounded-xl bg-[#7c6cff] text-white shadow-md ring-2 ring-[#a5b4fc]/50'
                : 'rounded-2xl bg-[#181c29] text-[#cbd5e1] hover:rounded-xl hover:bg-[#242b3f] hover:text-white'
            }`}
          >
            {initials || 'RM'}
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-[#ef4444] text-[10px] font-bold text-white flex items-center justify-center">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-2 pt-2 border-t border-[#1f2435]">
        <button
          type="button"
          title="Create Private Room or DM"
          aria-label="Create Private Room or DM"
          onClick={() => setActiveModal('create_room')}
          className="w-11 h-11 rounded-2xl bg-[#181c29] hover:bg-[#10b981] text-[#34d399] hover:text-[#042319] flex items-center justify-center cursor-pointer cloak-transition"
        >
          <Plus className="w-5 h-5" />
        </button>

        <button
          type="button"
          title="Join via Invitation Link"
          aria-label="Join via Invitation Link"
          onClick={() => setActiveModal('join_invite')}
          className="w-11 h-11 rounded-2xl bg-[#181c29] hover:bg-[#2a3147] text-[#a5b4fc] hover:text-white flex items-center justify-center cursor-pointer cloak-transition"
        >
          <Link2 className="w-4 h-4" />
        </button>

        <Link
          to="/p2p"
          title="Direct P2P Desktop Mode (SQLite Local Vault)"
          aria-label="Direct P2P Desktop Mode"
          className="w-11 h-11 rounded-2xl bg-[#181c29] hover:bg-[#2a3147] text-[#38bdf8] hover:text-white flex items-center justify-center cloak-transition"
        >
          <Network className="w-4 h-4" />
        </Link>

        <Link
          to="/archive"
          title="Open Offline Encrypted Archive (.cloakexport)"
          aria-label="Open Encrypted Archive"
          className="w-11 h-11 rounded-2xl bg-[#181c29] hover:bg-[#2a3147] text-[#cbd5e1] hover:text-white flex items-center justify-center cloak-transition"
        >
          <Archive className="w-4 h-4" />
        </Link>

        <button
          type="button"
          title="Identity & Vault Settings"
          aria-label="Identity & Vault Settings"
          onClick={() => setActiveModal('settings')}
          className="w-11 h-11 rounded-2xl bg-[#181c29] hover:bg-[#2a3147] text-[#cbd5e1] hover:text-white flex items-center justify-center cursor-pointer cloak-transition"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </nav>
  );
}

