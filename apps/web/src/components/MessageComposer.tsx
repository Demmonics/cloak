import React, { useEffect, useRef, useState } from 'react';
import {
  Mic,
  Paperclip,
  Send,
  Square,
  Timer,
  X,
} from 'lucide-react';
import { DISAPPEARING_MESSAGE_OPTIONS } from '@cloak/config';
import { Button } from '@cloak/ui';
import type { DecryptedAttachmentRef } from '@cloak/protocol';
import { uploadEncryptedAttachment } from '../lib/workspaceClient.js';
import { db } from '../lib/storage.js';
import { useAppStore } from '../store/useAppStore.js';

export interface MessageComposerProps {
  roomId: string;
  channelId: string;
  channelName: string;
  currentEpoch: number;
  canSend: boolean;
  onSend: (payload: {
    text: string;
    attachments: DecryptedAttachmentRef[];
    voiceNote?: boolean;
    expireInSeconds?: number | null;
  }) => Promise<void>;
  onSaveEdit: (text: string) => Promise<void>;
  onTypingChange: (isTyping: boolean) => void;
}

interface PendingFileItem {
  localId: string;
  file: File;
}

export function MessageComposer({
  roomId,
  channelId,
  channelName,
  currentEpoch,
  canSend,
  onSend,
  onSaveEdit,
  onTypingChange,
}: MessageComposerProps) {
  const replyTarget = useAppStore((s) => s.replyTarget);
  const editingMessage = useAppStore((s) => s.editingMessage);
  const setReplyTarget = useAppStore((s) => s.setReplyTarget);
  const setEditingMessage = useAppStore((s) => s.setEditingMessage);
  const disappearSeconds = useAppStore((s) => s.composerDisappearSeconds);
  const setDisappearSeconds = useAppStore((s) => s.setComposerDisappearSeconds);
  const pushToast = useAppStore((s) => s.pushToast);

  const [text, setText] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFileItem[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    if (editingMessage) {
      setText(editingMessage.text);
      return;
    }
    void db.drafts.get(channelId).then((draft) => {
      if (active) setText(draft?.text ?? '');
    });
    return () => {
      active = false;
    };
  }, [channelId, editingMessage]);

  const handleTextChange = (val: string) => {
    setText(val);
    if (!editingMessage) {
      void db.drafts.put({ channelId, text: val });
    }
    onTypingChange(val.trim().length > 0);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => onTypingChange(false), 3000);
  };

  const addFiles = (files: FileList | File[]) => {
    const incoming = Array.from(files).map((file) => ({
      localId: crypto.randomUUID(),
      file,
    }));
    setPendingFiles((prev) => [...prev, ...incoming].slice(0, 8));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend || sending) return;

    const trimmed = text.trim();
    if (editingMessage) {
      if (!trimmed) return;
      setSending(true);
      try {
        await onSaveEdit(trimmed);
        setEditingMessage(null);
        setText('');
      } catch (err) {
        pushToast({
          tone: 'error',
          title: 'Edit failed',
          detail: err instanceof Error ? err.message : 'Unable to save edit',
        });
      } finally {
        setSending(false);
      }
      return;
    }

    if (!trimmed && pendingFiles.length === 0) return;
    setSending(true);
    try {
      const uploadedRefs: DecryptedAttachmentRef[] = [];
      for (const item of pendingFiles) {
        const ref = await uploadEncryptedAttachment({
          roomId,
          epoch: currentEpoch,
          file: item.file,
          filename: item.file.name,
          mimeType: item.file.type || 'application/octet-stream',
          expiresInSeconds: disappearSeconds,
        });
        uploadedRefs.push(ref);
      }

      await onSend({
        text: trimmed,
        attachments: uploadedRefs,
        expireInSeconds: disappearSeconds,
      });
      setText('');
      setPendingFiles([]);
      setReplyTarget(null);
      await db.drafts.delete(channelId);
      onTypingChange(false);
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Message delivery error',
        detail: err instanceof Error ? err.message : 'Unable to send encrypted message',
      });
    } finally {
      setSending(false);
    }
  };

  // Modern Web Guidance IME-safe Enter submit: block while composing natively or keyCode === 229
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      if (editingMessage) setEditingMessage(null);
      if (replyTarget) setReplyTarget(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
      addFiles(e.clipboardData.files);
    }
  };

  const toggleVoiceRecording = async () => {
    if (recording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setRecording(false);
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      pushToast({
        tone: 'warning',
        title: 'Voice notes unsupported',
        detail: 'This browser context does not expose MediaRecorder microphone recording.',
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size === 0) return;
        setSending(true);
        try {
          const ref = await uploadEncryptedAttachment({
            roomId,
            epoch: currentEpoch,
            file: blob,
            filename: `voice-note-${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}.webm`,
            mimeType: blob.type || 'audio/webm',
            expiresInSeconds: disappearSeconds,
          });
          await onSend({
            text: text.trim() || 'Voice note',
            attachments: [ref],
            voiceNote: true,
            expireInSeconds: disappearSeconds,
          });
          setText('');
        } catch (err) {
          pushToast({
            tone: 'error',
            title: 'Voice note failed',
            detail: err instanceof Error ? err.message : 'Upload failed',
          });
        } finally {
          setSending(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      pushToast({
        tone: 'error',
        title: 'Microphone access denied',
        detail: 'Allow microphone permission to record an encrypted voice note.',
      });
    }
  };

  if (!canSend) {
    return (
      <div className="px-4 py-3 border-t border-[#1f2435] bg-[#12151f] text-xs text-[#9aa3b8]">
        Read-only access in #{channelName}. You can decrypt and export authorized history.
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
      }}
      className={`px-4 pb-4 pt-2 border-t border-[var(--cloak-border)] bg-[var(--cloak-bg-sidebar)] ${
        dragging ? 'ring-2 ring-inset ring-[var(--cloak-accent)]' : ''
      }`}
    >
      {(replyTarget || editingMessage) && (
        <div className="mb-2 flex items-center justify-between rounded-[7px] bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] px-3 py-1.5 text-xs">
          <span className="text-[var(--cloak-accent-text)] truncate">
            {editingMessage
              ? `Editing message: "${editingMessage.text.slice(0, 60)}"`
              : `Replying to: "${replyTarget?.text.slice(0, 60)}"`}
          </span>
          <button
            type="button"
            aria-label="Cancel reply or edit"
            onClick={() => {
              setReplyTarget(null);
              setEditingMessage(null);
              if (editingMessage) setText('');
            }}
            className="text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pendingFiles.map((item) => (
            <div
              key={item.localId}
              className="inline-flex items-center gap-2 rounded-[7px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] px-2.5 py-1 text-xs text-[var(--cloak-text-body)]"
            >
              <span className="truncate max-w-[160px]">{item.file.name}</span>
              <span className="text-[10px] text-[var(--cloak-text-dim)]">
                {(item.file.size / 1024).toFixed(0)} KiB
              </span>
              <button
                type="button"
                aria-label={`Remove ${item.file.name}`}
                onClick={() => setPendingFiles((prev) => prev.filter((p) => p.localId !== item.localId))}
                className="text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <form ref={formRef} onSubmit={handleSubmit} className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] p-2">
        <div className="flex flex-wrap sm:flex-nowrap items-end gap-1.5 sm:gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
            className="sr-only"
          />

          <div className="flex items-center gap-1 order-2 sm:order-1 shrink-0">
            <button
              type="button"
              title="Attach encrypted file"
              aria-label="Attach file"
              onClick={() => fileInputRef.current?.click()}
              className="p-2 rounded-[7px] text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)] cursor-pointer"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            <button
              type="button"
              title={recording ? 'Stop & send encrypted voice note' : 'Record voice note'}
              aria-label={recording ? 'Stop recording' : 'Record voice note'}
              onClick={() => void toggleVoiceRecording()}
              className={`p-2 rounded-[7px] cursor-pointer ${
                recording
                  ? 'bg-[#dc2626] text-white'
                  : 'text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
              }`}
            >
              {recording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          </div>

          <label htmlFor="composer-textarea" className="sr-only">
            Message #{channelName}
          </label>
          <textarea
            id="composer-textarea"
            rows={1}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={`Encrypted message in #${channelName} (Enter to send, Shift+Enter for newline)`}
            className="order-1 sm:order-2 basis-full sm:basis-auto sm:flex-1 min-w-0 resize-none bg-transparent py-2 px-1.5 sm:px-1 text-sm text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)] focus:outline-none max-h-36"
          />

          <div className="flex items-center gap-1.5 order-3 ml-auto shrink-0">
            <label htmlFor="composer-disappear" className="sr-only">
              Disappearing timer
            </label>
            <div className="inline-flex items-center gap-1 rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-2 py-1 text-[11px] text-[var(--cloak-text-muted)]">
              <Timer className="w-3 h-3 text-[var(--cloak-info-text)] shrink-0" />
              <select
                id="composer-disappear"
                value={disappearSeconds === null ? '' : String(disappearSeconds)}
                onChange={(e) => setDisappearSeconds(e.target.value ? Number(e.target.value) : null)}
                className="bg-transparent text-xs text-[var(--cloak-text-body)] focus:outline-none cursor-pointer max-w-[130px] sm:max-w-none"
              >
                {DISAPPEARING_MESSAGE_OPTIONS.map((opt) => (
                  <option
                    key={opt.label}
                    value={opt.seconds === null ? '' : String(opt.seconds)}
                    className="bg-[var(--cloak-bg-surface)] text-[var(--cloak-text)]"
                  >
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <Button type="submit" variant="primary" size="sm" disabled={sending} aria-label="Send message">
              <Send className="w-3.5 h-3.5" />
              {editingMessage ? 'Save' : 'Send'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

