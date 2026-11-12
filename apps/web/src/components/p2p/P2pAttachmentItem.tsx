import React, { useEffect, useState } from 'react';
import { Download, Eye, FileText, ShieldCheck } from 'lucide-react';
import { Button, ModalDialog } from '@cloak/ui';
import { p2pApi, type P2pAttachmentMeta } from '../../lib/p2pClient.js';

interface Props {
  attachment: P2pAttachmentMeta;
  onDownload: (id: string, filename: string) => Promise<void> | void;
}

export function P2pAttachmentItem({ attachment, onDownload }: Props) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const lower = attachment.filename.toLowerCase();
  const isSvg = attachment.mimeType === 'image/svg+xml' || lower.endsWith('.svg');
  const isImage =
    !isSvg &&
    (/^image\/(png|jpeg|jpg|webp|gif)$/i.test(attachment.mimeType) ||
      /\.(png|jpe?g|webp|gif)$/i.test(lower));
  const isAudio =
    /^audio\/(webm|ogg|mpeg|mp4|wav|flac)$/i.test(attachment.mimeType) ||
    /\.(mp3|wav|ogg|m4a|webm)$/i.test(lower);
  const isVideo =
    /^video\/(mp4|webm)$/i.test(attachment.mimeType) || /\.(mp4|webm)$/i.test(lower);

  useEffect(() => {
    if (!isImage && !isAudio && !isVideo) return;
    let cancelled = false;
    let createdUrl: string | null = null;

    void p2pApi
      .downloadAttachmentBytes(attachment.id)
      .then((bytes) => {
        if (cancelled) return;
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const mime =
          attachment.mimeType && attachment.mimeType !== 'application/octet-stream'
            ? attachment.mimeType
            : isImage
              ? 'image/png'
              : isAudio
                ? 'audio/mpeg'
                : 'video/mp4';
        createdUrl = URL.createObjectURL(new Blob([copy], { type: mime }));
        setPreviewUrl(createdUrl);
      })
      .catch(() => {
        // Fallback to standard verified download row cleanly
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [attachment.id, attachment.mimeType, isAudio, isImage, isVideo]);

  return (
    <div className="rounded-2xl border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)]/80 p-2.5 space-y-2">
      {isImage && previewUrl && (
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="group relative block overflow-hidden rounded-xl border border-[var(--cloak-border)] bg-[var(--cloak-bg-void)] cursor-pointer max-w-sm"
          title={`Preview ${attachment.filename}`}
        >
          <img
            src={previewUrl}
            alt={attachment.filename}
            className="max-h-56 w-auto object-contain transition-transform duration-200 group-hover:scale-[1.015]"
          />
          <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-[var(--cloak-bg-card)]/90 border border-[var(--cloak-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--cloak-text)] opacity-0 group-hover:opacity-100 transition-opacity">
            <Eye className="w-3 h-3" /> Preview
          </span>
        </button>
      )}

      {isAudio && previewUrl && (
        <audio controls src={previewUrl} className="w-full max-w-md h-9" />
      )}

      {isVideo && previewUrl && (
        <video
          controls
          playsInline
          src={previewUrl}
          className="max-h-60 rounded-xl border border-[var(--cloak-border)] bg-[#0E1A18]"
        />
      )}

      <div className="flex items-center justify-between gap-3 px-1 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--cloak-bg-card)] border border-[var(--cloak-border)] text-[var(--cloak-accent-text)]">
            <FileText className="w-3.5 h-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[var(--cloak-text)] font-medium truncate">
              {attachment.filename} ({(attachment.totalSizeBytes / 1024).toFixed(1)} KiB · SHA-256)
            </div>
            <div className="inline-flex items-center gap-1 text-[10px] font-mono-tabular text-[var(--cloak-text-dim)] truncate">
              <ShieldCheck className="w-3 h-3 text-[var(--cloak-success-text)] shrink-0" />
              {attachment.sha256Hex.slice(0, 16)}…
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onDownload(attachment.id, attachment.filename)}
          className="cloak-transition shrink-0 inline-flex items-center gap-1 rounded-full border border-[var(--cloak-border)] bg-[var(--cloak-bg-card)] hover:bg-[var(--cloak-bg-elevated)] px-3 py-1 text-[11px] font-medium text-[var(--cloak-text)] cursor-pointer"
        >
          <Download className="w-3 h-3" /> Save
        </button>
      </div>

      {isImage && previewUrl && (
        <ModalDialog
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          title={attachment.filename}
          description={`${(attachment.totalSizeBytes / 1024).toFixed(1)} KiB · Verified SHA-256 ${attachment.sha256Hex.slice(0, 24)}…`}
          wide
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setLightboxOpen(false)}>
                Close
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onDownload(attachment.id, attachment.filename)}
              >
                <Download className="w-3.5 h-3.5" /> Save File
              </Button>
            </>
          }
        >
          <div className="flex items-center justify-center rounded-2xl bg-[var(--cloak-bg-void)] border border-[var(--cloak-border)] p-3">
            <img
              src={previewUrl}
              alt={attachment.filename}
              className="max-h-[65vh] w-auto object-contain rounded-xl"
            />
          </div>
        </ModalDialog>
      )}
    </div>
  );
}

