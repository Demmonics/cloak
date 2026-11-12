import React from 'react';

export interface AvatarProps {
  name: string;
  color?: string;
  emoji?: string | null;
  status?: 'online' | 'idle' | 'dnd' | 'offline';
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = {
  sm: 'w-7 h-7 text-[11px]',
  md: 'w-9 h-9 text-xs',
  lg: 'w-12 h-12 text-base',
};

const STATUS_COLOR = {
  online: 'bg-[var(--cloak-success)]',
  idle: 'bg-[var(--cloak-warn)]',
  dnd: 'bg-[var(--cloak-danger)]',
  offline: 'bg-[var(--cloak-text-dim)]',
};

export function Avatar({ name, color = '#4f6253', emoji, status, size = 'md' }: AvatarProps) {
  const initial = (name.trim().slice(0, 2) || '?').toUpperCase();
  const safeColor = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : '#4f6253';

  return (
    <span className="relative inline-flex shrink-0">
      <span
        aria-hidden="true"
        style={{ backgroundColor: safeColor }}
        className={`${SIZES[size]} rounded-full inline-flex items-center justify-center font-editorial font-normal tracking-wide text-[#f2f1ed] select-none border border-[var(--cloak-border-strong)] shadow-2xs`}
      >
        {emoji || initial}
      </span>
      {status && (
        <span
          title={status}
          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--cloak-bg-card)] ${STATUS_COLOR[status]}`}
        />
      )}
    </span>
  );
}
