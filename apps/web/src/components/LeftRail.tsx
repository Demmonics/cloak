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
      className="w-[70px] shrink-0 bg-[var(--cloak-bg-rail)] border-r border-[var(--cloak-border)] flex flex-col items-center py-3 gap-2 overflow-y-auto"
    >
      <div
        title="Cloak Encrypted Workspace"
        className="w-11 h-11 rounded-[12px] bg-[var(--cloak-accent)] flex items-center justify-center text-[var(--cloak-accent-ink)] mb-1"
      >
        <Shield className="w-5 h-5" />
      </div>

      <div className="w-8 h-px bg-[var(--cloak-border)] my-0.5" />

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
            className={`relative w-11 h-11 rounded-[12px] flex items-center justify-center text-xs font-semibold cursor-pointer border transition-colors ${
              active
                ? 'bg-[var(--cloak-accent)] border-[var(--cloak-accent)] text-[var(--cloak-accent-ink)]'
                : 'bg-[var(--cloak-bg-surface)] border-[var(--cloak-border)] text-[var(--cloak-text-body)] hover:bg-[var(--cloak-bg-hover)] hover:text-[var(--cloak-text)]'
            }`}
          >
            <MessageSquareLock className="w-4 h-4" />
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-[#dc2626] text-[10px] font-bold text-white flex items-center justify-center">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        );
      })}

      {dmRooms.length > 0 && groupRooms.length > 0 && <div className="w-8 h-px bg-[var(--cloak-border)] my-0.5" />}

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
            className={`relative w-11 h-11 rounded-[12px] flex items-center justify-center text-sm font-semibold cursor-pointer border transition-colors ${
              active
                ? 'bg-[var(--cloak-accent)] border-[var(--cloak-accent)] text-[var(--cloak-accent-ink)]'
                : 'bg-[var(--cloak-bg-surface)] border-[var(--cloak-border)] text-[var(--cloak-text-body)] hover:bg-[var(--cloak-bg-hover)] hover:text-[var(--cloak-text)]'
            }`}
          >
            {initials || 'RM'}
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-[#dc2626] text-[10px] font-bold text-white flex items-center justify-center">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-2 pt-2 border-t border-[var(--cloak-border)]">
        <button
          type="button"
          title="Create Private Room or DM"
          aria-label="Create Private Room or DM"
          onClick={() => setActiveModal('create_room')}
          className="w-11 h-11 rounded-[12px] bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] hover:bg-[var(--cloak-accent)] text-[var(--cloak-accent-text)] hover:text-[var(--cloak-accent-ink)] flex items-center justify-center cursor-pointer transition-colors"
        >
          <Plus className="w-5 h-5" />
        </button>

        <button
          type="button"
          title="Join via Invitation Link"
          aria-label="Join via Invitation Link"
          onClick={() => setActiveModal('join_invite')}
          className="w-11 h-11 rounded-[12px] bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] hover:bg-[var(--cloak-bg-hover)] text-[var(--cloak-accent-text)] hover:text-[var(--cloak-text)] flex items-center justify-center cursor-pointer transition-colors"
        >
          <Link2 className="w-4 h-4" />
        </button>

        <Link
          to="/p2p"
          title="Direct P2P Desktop Mode (SQLite Local Vault)"
          aria-label="Direct P2P Desktop Mode"
          className="w-11 h-11 rounded-[12px] bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] hover:bg-[var(--cloak-bg-hover)] text-[var(--cloak-info-text)] hover:text-[var(--cloak-text)] flex items-center justify-center transition-colors"
        >
          <Network className="w-4 h-4" />
        </Link>

        <Link
          to="/archive"
          title="Open Offline Encrypted Archive (.cloakexport)"
          aria-label="Open Encrypted Archive"
          className="w-11 h-11 rounded-[12px] bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] hover:bg-[var(--cloak-bg-hover)] text-[var(--cloak-text-body)] hover:text-[var(--cloak-text)] flex items-center justify-center transition-colors"
        >
          <Archive className="w-4 h-4" />
        </Link>

        <button
          type="button"
          title="Identity & Vault Settings"
          aria-label="Identity & Vault Settings"
          onClick={() => setActiveModal('settings')}
          className="w-11 h-11 rounded-[12px] bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] hover:bg-[var(--cloak-bg-hover)] text-[var(--cloak-text-body)] hover:text-[var(--cloak-text)] flex items-center justify-center cursor-pointer transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </nav>
  );
}

