import React, { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export interface ToastItem {
  id: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail?: string;
}

export interface ToastRegionProps {
  toasts: readonly ToastItem[];
  onDismiss: (id: string) => void;
  suppressWhenModalOpen?: boolean;
}

const TONE_BORDER: Record<ToastItem['tone'], string> = {
  info: 'border-[var(--cloak-info-border)] bg-[var(--cloak-toast-info-bg)]',
  success: 'border-[var(--cloak-success-border)] bg-[var(--cloak-toast-info-bg)]',
  warning: 'border-[var(--cloak-warn-border)] bg-[var(--cloak-toast-info-bg)]',
  error: 'border-[var(--cloak-danger-border)] bg-[var(--cloak-toast-error-bg)]',
};

/**
 * Uses Top Layer popover="manual" when visible and avoids surfacing inside/under open modal dialogs.
 */
export function ToastRegion({
  toasts,
  onDismiss,
  suppressWhenModalOpen = false,
}: ToastRegionProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const shouldShow = toasts.length > 0 && !suppressWhenModalOpen;

  useEffect(() => {
    const el = popoverRef.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el || typeof el.showPopover !== 'function' || typeof el.hidePopover !== 'function') return;
    try {
      if (shouldShow && !el.matches(':popover-open')) {
        el.showPopover();
      } else if (!shouldShow && el.matches(':popover-open')) {
        el.hidePopover();
      }
    } catch {
      // Safe fallback in JSDOM or environments without popover API
    }
  }, [shouldShow]);

  if (!shouldShow) return null;

  return (
    <div
      ref={popoverRef}
      popover="manual"
      role="region"
      aria-label="Notifications"
      className="cloak-toast-region z-50 flex flex-col gap-2"
    >
      {toasts.map((t) => {
        const Icon =
          t.tone === 'success'
            ? CheckCircle2
            : t.tone === 'warning' || t.tone === 'error'
              ? AlertTriangle
              : Info;
        return (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
            className={`rounded-xl border px-3.5 py-2.5 shadow-xl flex items-start gap-2.5 text-sm ${TONE_BORDER[t.tone]}`}
          >
            <Icon className="w-4 h-4 mt-0.5 shrink-0 text-[var(--cloak-accent-text)]" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-[var(--cloak-text)]">{t.title}</div>
              {t.detail && <div className="text-xs text-[var(--cloak-text-muted)] mt-0.5 break-words">{t.detail}</div>}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label={`Dismiss ${t.title}`}
              className="cloak-icon-btn inline-flex items-center justify-center rounded-md p-1 text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

