import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Bookmark,
  Check,
  CornerUpRight,
  Download,
  Edit3,
  FileText,
  Forward,
  Lock,
  MessageSquare,
  Pin,
  PinOff,
  RotateCcw,
  ShieldAlert,
  Timer,
  Trash2,
  UserX,
} from 'lucide-react';
import { Avatar, Button, ConfirmDialog, Skeleton } from '@cloak/ui';
import type { DecryptedAttachmentRef, RoomMemberSummary } from '@cloak/protocol';
import { renderMarkdownToUnsafeHtml, sanitizeUntrustedHtml } from '../lib/sanitizeHtml.js';
import { db, type LocalDecryptedMessage } from '../lib/storage.js';
import { downloadAndDecryptAttachment } from '../lib/workspaceClient.js';

export interface MessageListProps {
  messages: LocalDecryptedMessage[];
  members: RoomMemberSummary[];
  currentDeviceId: string;
  isModerator: boolean;
  loading: boolean;
  typingNames: string[];
  bookmarkedIds: Set<string>;
  onReply: (msg: LocalDecryptedMessage) => void;
  onEdit: (msg: LocalDecryptedMessage) => void;
  onDelete: (msg: LocalDecryptedMessage, scope: 'me' | 'everyone') => Promise<void>;
  onReact: (msg: LocalDecryptedMessage, emoji: string) => Promise<void>;
  onTogglePin: (msg: LocalDecryptedMessage) => Promise<void>;
  onToggleBookmark: (msg: LocalDecryptedMessage) => Promise<void>;
  onOpenThread: (msg: LocalDecryptedMessage) => void;
  onForward: (msg: LocalDecryptedMessage) => void;
  onRetry: (msg: LocalDecryptedMessage) => Promise<void>;
}

const QUICK_EMOJIS = ['👍', '❤️', '🔒', '😂'];

function SanitizedMarkdown({ text }: { text: string }) {
  const cleanHtml = useMemo(() => sanitizeUntrustedHtml(renderMarkdownToUnsafeHtml(text)), [text]);
  return (
    <div
      className="cloak-md text-sm text-[#e2e8f0] leading-relaxed break-words"
      // Sanitized strictly via @cloak/web sanitizeUntrustedHtml (DOMParser/DOMPurify/Sanitizer)
      dangerouslySetInnerHTML={{ __html: cleanHtml }}
    />
  );
}

function AttachmentCard({ att }: { att: DecryptedAttachmentRef }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lowerName = att.encryptedFilename.toLowerCase();
  const isSvg = att.mimeType === 'image/svg+xml' || lowerName.endsWith('.svg');
  const isSafePreviewImage = !isSvg && /^image\/(png|jpeg|jpg|webp|gif)$/i.test(att.mimeType);
  const isSafeAudio = /^audio\/(webm|ogg|mpeg|mp4|wav)$/i.test(att.mimeType);
  const isSafeVideo = /^video\/(mp4|webm)$/i.test(att.mimeType);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    if (!isSafePreviewImage && !isSafeAudio && !isSafeVideo) return;

    void (async () => {
      try {
        const cached = await db.attachmentsCache.get(att.attachmentId);
        const bytes = cached?.bytes ?? (await downloadAndDecryptAttachment(att));
        if (cancelled) return;
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        createdUrl = URL.createObjectURL(new Blob([copy], { type: att.mimeType || 'application/octet-stream' }));
        setBlobUrl(createdUrl);
      } catch {
        // Defer error display until user clicks Download
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [att, isSafeAudio, isSafePreviewImage, isSafeVideo]);

  const handleDownload = async () => {
    setLoading(true);
    setError(null);
    try {
      const bytes = await downloadAndDecryptAttachment(att);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const url = URL.createObjectURL(new Blob([copy], { type: att.mimeType || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = att.encryptedFilename;
      a.rel = 'noopener noreferrer';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download unavailable');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2 max-w-md rounded-xl border border-[#283047] bg-[#10131d] p-2.5 space-y-2">
      {isSafePreviewImage && blobUrl && (
        <img
          src={blobUrl}
          alt={att.encryptedFilename}
          loading="lazy"
          className="max-h-72 rounded-lg object-contain bg-[#090b10]"
        />
      )}
      {isSafeAudio && blobUrl && (
        <audio controls src={blobUrl} className="w-full h-9" />
      )}
      {isSafeVideo && blobUrl && (
        <video controls src={blobUrl} className="max-h-72 w-full rounded-lg bg-black" />
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 shrink-0 text-[#a5b4fc]" />
          <div className="min-w-0">
            <div className="text-xs font-medium text-[#f1f3f9] truncate">{att.encryptedFilename}</div>
            <div className="text-[10px] text-[#8d96ad]">
              {(att.plaintextSizeBytes / 1024).toFixed(1)} KiB · Encrypted stream
              {isSvg ? ' · SVG preview disabled (download only)' : ''}
            </div>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={handleDownload} disabled={loading}>
          <Download className="w-3.5 h-3.5" />
          {loading ? 'Decrypting...' : 'Save'}
        </Button>
      </div>
      {error && <div className="text-[11px] text-[#fca5a5]">{error}</div>}
    </div>
  );
}

type TimelineRow =
  | { kind: 'divider'; key: string; label: string }
  | { kind: 'message'; key: string; msg: LocalDecryptedMessage; compact: boolean };

export function MessageList({
  messages,
  members,
  currentDeviceId,
  isModerator,
  loading,
  typingNames,
  bookmarkedIds,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onTogglePin,
  onToggleBookmark,
  onOpenThread,
  onForward,
  onRetry,
}: MessageListProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [confirmDeleteEveryone, setConfirmDeleteEveryone] = useState<LocalDecryptedMessage | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);

  const memberMap = useMemo(() => new Map(members.map((m) => [m.deviceId, m])), [members]);

  const rows: TimelineRow[] = useMemo(() => {
    const out: TimelineRow[] = [];
    let lastDay = '';
    let prevSender = '';
    let prevTimeMs = 0;

    for (const msg of messages) {
      const dateObj = new Date(msg.createdAt);
      const dayKey = dateObj.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      if (dayKey !== lastDay) {
        out.push({ kind: 'divider', key: `div-${dayKey}`, label: dayKey });
        lastDay = dayKey;
        prevSender = '';
      }
      const ts = dateObj.getTime();
      const compact =
        msg.senderDeviceId === prevSender &&
        !msg.replyToMessageId &&
        ts - prevTimeMs < 5 * 60 * 1000;
      out.push({ kind: 'message', key: msg.id, msg, compact });
      prevSender = msg.senderDeviceId;
      prevTimeMs = ts;
    }
    return out;
  }, [messages]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (idx) => (rows[idx]?.kind === 'divider' ? 36 : 84),
    overscan: 8,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (!el || rows.length === 0) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 260) {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    }
  }, [rows.length, virtualizer]);

  if (loading && messages.length === 0) {
    return (
      <div className="flex-1 p-5 space-y-4 overflow-y-auto" aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="w-9 h-9 rounded-xl shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={parentRef} className="flex-1 overflow-y-auto px-4 py-3">
        {rows.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <div className="w-12 h-12 rounded-2xl bg-[#181c29] border border-[#2a3146] flex items-center justify-center text-[#a5b4fc] mb-3">
              <Lock className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-semibold text-[#f1f3f9]">End-to-End Encrypted Channel</h3>
            <p className="text-xs text-[#8d96ad] max-w-sm mt-1">
              Messages, voice notes, and attachments are encrypted on your device before transmission.
            </p>
          </div>
        ) : (
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vRow) => {
              const row = rows[vRow.index];
              if (!row) return null;

              if (row.kind === 'divider') {
                return (
                  <div
                    key={row.key}
                    data-index={vRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vRow.start}px)`,
                    }}
                    className="py-2 flex items-center gap-3"
                  >
                    <div className="flex-1 h-px bg-[#22283a]" />
                    <span className="text-[11px] font-medium text-[#8d96ad] px-2">{row.label}</span>
                    <div className="flex-1 h-px bg-[#22283a]" />
                  </div>
                );
              }

              const { msg, compact } = row;
              const member = memberMap.get(msg.senderDeviceId);
              const senderName = member?.displayName || msg.senderDeviceId.slice(0, 8);
              const isOwn = msg.senderDeviceId === currentDeviceId;
              const canDeleteEveryone = isOwn || isModerator;
              const isBookmarked = bookmarkedIds.has(msg.id);

              return (
                <article
                  key={msg.id}
                  data-index={vRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vRow.start}px)`,
                  }}
                  className={`group relative rounded-xl px-3 hover:bg-[#161a26]/85 focus-within:bg-[#161a26]/85 ${
                    compact ? 'py-1' : 'pt-2.5 pb-1.5 mt-1'
                  }`}
                >
                  {/* Hover / Focus Contextual Action Strip (plain buttons, no role="menu") */}
                  <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity absolute right-3 -top-3 z-10 flex items-center gap-0.5 rounded-lg border border-[#2b334b] bg-[#141722] p-0.5 shadow-lg">
                    {QUICK_EMOJIS.map((em) => (
                      <button
                        key={em}
                        type="button"
                        aria-label={`React ${em}`}
                        onClick={() => void onReact(msg, em)}
                        className="px-1.5 py-1 text-xs rounded hover:bg-[#23293c] cursor-pointer"
                      >
                        {em}
                      </button>
                    ))}
                    <button
                      type="button"
                      title="Reply"
                      aria-label="Reply to message"
                      onClick={() => onReply(msg)}
                      className="p-1.5 text-[#9aa3b8] hover:text-white rounded hover:bg-[#23293c] cursor-pointer"
                    >
                      <CornerUpRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Thread"
                      aria-label="Open thread"
                      onClick={() => onOpenThread(msg)}
                      className="p-1.5 text-[#9aa3b8] hover:text-white rounded hover:bg-[#23293c] cursor-pointer"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Forward"
                      aria-label="Forward message"
                      onClick={() => onForward(msg)}
                      className="p-1.5 text-[#9aa3b8] hover:text-white rounded hover:bg-[#23293c] cursor-pointer"
                    >
                      <Forward className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      title={isBookmarked ? 'Remove bookmark' : 'Bookmark locally'}
                      aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark'}
                      onClick={() => void onToggleBookmark(msg)}
                      className={`p-1.5 rounded hover:bg-[#23293c] cursor-pointer ${
                        isBookmarked ? 'text-[#fbbf24]' : 'text-[#9aa3b8] hover:text-white'
                      }`}
                    >
                      <Bookmark className="w-3.5 h-3.5" />
                    </button>
                    {isModerator && (
                      <button
                        type="button"
                        title={msg.isPinned ? 'Unpin' : 'Pin message'}
                        aria-label={msg.isPinned ? 'Unpin message' : 'Pin message'}
                        onClick={() => void onTogglePin(msg)}
                        className={`p-1.5 rounded hover:bg-[#23293c] cursor-pointer ${
                          msg.isPinned ? 'text-[#a5b4fc]' : 'text-[#9aa3b8] hover:text-white'
                        }`}
                      >
                        {msg.isPinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                      </button>
                    )}
                    {isOwn && (
                      <button
                        type="button"
                        title="Edit"
                        aria-label="Edit message"
                        onClick={() => onEdit(msg)}
                        className="p-1.5 text-[#9aa3b8] hover:text-white rounded hover:bg-[#23293c] cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      title="Delete for me"
                      aria-label="Delete for me"
                      onClick={() => void onDelete(msg, 'me')}
                      className="p-1.5 text-[#9aa3b8] hover:text-[#fbbf24] rounded hover:bg-[#23293c] cursor-pointer"
                    >
                      <UserX className="w-3.5 h-3.5" />
                    </button>
                    {canDeleteEveryone && (
                      <button
                        type="button"
                        title="Delete for everyone"
                        aria-label="Delete for everyone"
                        onClick={() => setConfirmDeleteEveryone(msg)}
                        className="p-1.5 text-[#f87171] hover:bg-[#3a1a21] rounded cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Reply Preview */}
                  {msg.replyToMessageId && (
                    <div className="ml-12 mb-1 pl-2.5 border-l-2 border-[#7c6cff]/60 text-xs text-[#9aa3b8] truncate">
                      <span className="font-medium text-[#c4b5fd] mr-1.5">
                        {msg.replyPreviewSender || 'Reply'}:
                      </span>
                      {msg.replyPreviewText || 'Encrypted message'}
                    </div>
                  )}

                  <div className="flex items-start gap-3">
                    {!compact ? (
                      <Avatar
                        name={senderName}
                        color={member?.avatarColor}
                        emoji={member?.avatarEmoji}
                        size="md"
                      />
                    ) : (
                      <span className="w-9 shrink-0 text-[10px] text-[#64748b] text-right pt-0.5 opacity-0 group-hover:opacity-100">
                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      {!compact && (
                        <div className="flex items-center flex-wrap gap-2 mb-0.5">
                          <span className="text-sm font-semibold text-[#f1f3f9]">{senderName}</span>
                          <time className="text-[11px] text-[#8d96ad]" dateTime={msg.createdAt}>
                            {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </time>
                          {msg.editedAt && <span className="text-[10px] text-[#8d96ad]">(edited)</span>}
                          {msg.isPinned === 1 && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-[#a5b4fc]">
                              <Pin className="w-2.5 h-2.5" /> Pinned
                            </span>
                          )}
                          {msg.expiresAt && (
                            <span
                              title={`Expires ${new Date(msg.expiresAt).toLocaleString()}`}
                              className="inline-flex items-center gap-0.5 text-[10px] text-[#38bdf8]"
                            >
                              <Timer className="w-2.5 h-2.5" /> Disappearing
                            </span>
                          )}
                          {!msg.signatureVerified && (
                            <span
                              title="Sender signature not verified"
                              className="inline-flex items-center gap-0.5 text-[10px] text-[#f59e0b]"
                            >
                              <ShieldAlert className="w-3 h-3" /> Unverified
                            </span>
                          )}
                          {msg.localStatus === 'sending' && (
                            <span className="text-[10px] text-[#9aa3b8]">Sending...</span>
                          )}
                          {msg.localStatus === 'sent' && isOwn && (
                            <span title="Delivered to server event log" className="text-[#34d399]">
                              <Check className="w-3 h-3" />
                            </span>
                          )}
                        </div>
                      )}

                      {msg.text && <SanitizedMarkdown text={msg.text} />}

                      {msg.attachments.map((att) => (
                        <AttachmentCard key={att.attachmentId} att={att} />
                      ))}

                      {msg.localStatus === 'failed' && (
                        <div className="mt-1.5 flex items-center gap-2 text-xs text-[#fca5a5]">
                          <span>Failed to deliver</span>
                          <Button size="sm" variant="secondary" onClick={() => void onRetry(msg)}>
                            <RotateCcw className="w-3 h-3" /> Retry
                          </Button>
                        </div>
                      )}

                      {msg.reactions.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {msg.reactions.map((r) => {
                            const reacted = r.reactorDeviceIds.includes(currentDeviceId);
                            return (
                              <button
                                key={r.emoji}
                                type="button"
                                onClick={() => void onReact(msg, r.emoji)}
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs cursor-pointer cloak-transition ${
                                  reacted
                                    ? 'bg-[#7c6cff]/25 border border-[#7c6cff]/60 text-white'
                                    : 'bg-[#1a1f2e] border border-[#2a3146] text-[#cbd5e1] hover:border-[#414c6b]'
                                }`}
                              >
                                <span>{r.emoji}</span>
                                <span className="text-[11px]">{r.reactorDeviceIds.length}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Live Typing Status Bar */}
      <div className="h-6 px-4 flex items-center text-[11px] text-[#9aa3b8]" aria-live="polite">
        {typingNames.length > 0 && (
          <span>
            {typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing encrypted message...
          </span>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(confirmDeleteEveryone)}
        onCancel={() => setConfirmDeleteEveryone(null)}
        onConfirm={async () => {
          if (!confirmDeleteEveryone) return;
          setBusyDelete(true);
          try {
            await onDelete(confirmDeleteEveryone, 'everyone');
            setConfirmDeleteEveryone(null);
          } finally {
            setBusyDelete(false);
          }
        }}
        title="Delete message for everyone?"
        description="This overwrites the server ciphertext and emits a tombstone across all room devices."
        confirmLabel="Delete for Everyone"
        destructive
        busy={busyDelete}
      />
    </div>
  );
}
