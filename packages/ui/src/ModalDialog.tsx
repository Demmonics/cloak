import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export interface ModalDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  wide?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/**
 * Accessible modal backed by native <dialog>.showModal().
 * Follows HTML Top Layer best practices: no redundant role="dialog", aria-modal,
 * custom focus trap, inert toggling, or custom Escape listener.
 */
export function ModalDialog({
  open,
  onClose,
  title,
  description,
  wide = false,
  children,
  footer,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.returnValue = '';
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
    }
  }, [open]);

  const handleClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = '';
    }
    if (open) {
      onClose();
    }
  };

  const handleBackdropClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) {
      dialogRef.current?.close();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={handleClose}
      onClick={handleBackdropClick}
      className={`cloak-dialog ${wide ? 'cloak-dialog-wide' : ''}`}
    >
      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[#262c3f]">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-semibold text-[#f1f3f9]">
            {title}
          </h2>
          {description && (
            <p id={descId} className="text-xs text-[#9aa3b8] mt-1">
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close modal"
          className="cloak-icon-btn inline-flex items-center justify-center rounded-lg p-1.5 text-[#9aa3b8] hover:text-white hover:bg-[#1f2536] cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 overflow-y-auto flex-1 space-y-4">{children}</div>

      {footer && (
        <div className="px-5 py-3.5 border-t border-[#262c3f] bg-[#141722] rounded-b-[14px] flex flex-wrap justify-end gap-2">
          {footer}
        </div>
      )}
    </dialog>
  );
}

