import React from 'react';

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div aria-hidden="true" className={`cloak-skeleton rounded-md ${className}`} />;
}

