import React from 'react';

export interface AvatarProps {
  name: string;
  color?: string;
  emoji?: string | null;
  status?: 'online' | 'idle' | 'dnd' | 'offline';
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = {
  sm: 'w-7 h-7 text-xs',
  md: 'w-9 h-9 text-sm',
  lg: 'w-12 h-12 text-lg',
};

const STATUS_COLOR = {
  online: 'bg-[#22c55e]',
  idle: 'bg-[#f59e0b]',
  dnd: 'bg-[#ef4444]',
  offline: 'bg-[#64748b]',
};

export function Avatar({ name, color = '#7c6cff', emoji, status, size = 'md' }: AvatarProps) {
  const initial = (name.trim().slice(0, 2) || '?').toUpperCase();
  const safeColor = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : '#7c6cff';

  return (
    <span className="relative inline-flex shrink-0">
      <span
        aria-hidden="true"
        style={{ backgroundColor: safeColor }}
        className={`${SIZES[size]} rounded-xl inline-flex items-center justify-center font-semibold text-white select-none border border-white/10`}
      >
        {emoji || initial}
      </span>
      {status && (
        <span
          title={status}
          className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#141722] ${STATUS_COLOR[status]}`}
        />
      )}
    </span>
  );
}

