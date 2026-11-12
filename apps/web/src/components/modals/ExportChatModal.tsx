import React, { useRef, useState } from 'react';
import { Archive, Download, Lock, ShieldAlert, XCircle } from 'lucide-react';
import type { ExportContainerMode, ExportFormat, ExportScope } from '@cloak/protocol';
import type { ExportBuildProgress } from '@cloak/archive';
import { Button, ModalDialog } from '@cloak/ui';
import type { RoomDetailResponse } from '../../lib/api.js';
import { runExportInWorker } from '../../lib/exportWorkerClient.js';
import { buildRoomExportInput } from '../../lib/workspaceClient.js';
import { useAppStore } from '../../store/useAppStore.js';

export function ExportChatModal({
  open,
  onClose,
  roomDetail,
  activeChannelId,
}: {
  open: boolean;
  onClose: () => void;
  roomDetail: RoomDetailResponse;
  activeChannelId: string | null;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [format, setFormat] = useState<ExportFormat>('complete');
  const [scope, setScope] = useState<ExportScope>('all');
  const [selectedChannels, setSelectedChannels] = useState<string[]>(() =>
    activeChannelId ? [activeChannelId] : roomDetail.room.channels.map((c) => c.id),
  );
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [containerMode, setContainerMode] = useState<ExportContainerMode>('cloakexport');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [progress, setProgress] = useState<ExportBuildProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isOffline = typeof navigator !== 'undefined' ? !navigator.onLine : false;

  const toggleChannel = (id: string) => {
    setSelectedChannels((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setProgress(null);
  };

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!password) {
      setError('A password is strictly required to encrypt every Cloak export archive.');
      return;
    }
    if (password.length < 8) {
      setError('Export password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Export passwords do not match.');
      return;
    }
    if (scope === 'selected' && selectedChannels.length === 0) {
      setError('Select at least one channel to export.');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setProgress({ phase: 'filtering', percent: 5, detail: 'Collecting decrypted channel history...' });

    try {
      const buildInput = await buildRoomExportInput({
        roomDetail,
        selectedChannelIds: scope === 'selected' ? selectedChannels : undefined,
        dateRangeStartUtc: scope === 'date_range' && dateStart ? new Date(dateStart).toISOString() : undefined,
        dateRangeEndUtc: scope === 'date_range' && dateEnd ? new Date(dateEnd).toISOString() : undefined,
        options: {
          format,
          scope,
          includeAttachments,
          containerMode,
          password,
        },
      });

      buildInput.onProgress = (p) => setProgress(p);
      buildInput.signal = controller.signal;

      const result = await runExportInWorker(buildInput);

      const copy = new Uint8Array(result.bytes.byteLength);
      copy.set(result.bytes);
      const url = URL.createObjectURL(new Blob([copy], { type: result.mimeType }));
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      pushToast({
        tone: 'success',
        title: `Exported ${result.filename}`,
        detail: `${result.manifest.includedMessageCount} message(s), ${result.manifest.includedAttachmentCount} attachment(s).`,
      });
      setPassword('');
      setConfirmPassword('');
      onClose();
    } catch (err) {
      if ((err as { code?: string })?.code === 'CANCELLED') {
        pushToast({ tone: 'info', title: 'Archive export cancelled' });
      } else {
        setError(err instanceof Error ? err.message : 'Export failed');
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <ModalDialog
      open={open}
      onClose={() => {
        if (busy) handleCancel();
        onClose();
      }}
      wide
      title={`Export Encrypted Archive — ${roomDetail.room.name}`}
      description="All exports are built 100% locally in a background Web Worker, exclude deleted/expired history, and require a strong password."
    >
      <form onSubmit={handleExport} className="space-y-4">
        {isOffline && (
          <div className="rounded-xl border border-[#f59e0b]/40 bg-[#f59e0b]/10 p-3 flex items-start gap-2.5 text-xs text-[#fde68a]">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              You appear offline. This archive will be flagged as a historical offline snapshot based on your locally cached vault.
            </span>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-lg border border-[#ef4444]/50 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#fca5a5]">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="exp-format" className="block text-xs font-medium text-[#cbd5e1] mb-1">
              Export Contents
            </label>
            <select
              id="exp-format"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
              className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-2 text-xs text-white"
            >
              <option value="complete">Complete Bundle (Offline HTML + JSON + TXT + Media)</option>
              <option value="html">Offline Interactive HTML Webpage + Media</option>
              <option value="json">Structured Machine JSON + Media</option>
              <option value="txt">Readable Plaintext Transcript</option>
            </select>
          </div>

          <div>
            <label htmlFor="exp-container" className="block text-xs font-medium text-[#cbd5e1] mb-1">
              Encrypted Container Format
            </label>
            <select
              id="exp-container"
              value={containerMode}
              onChange={(e) => setContainerMode(e.target.value as ExportContainerMode)}
              className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-2 text-xs text-white"
            >
              <option value="cloakexport">.cloakexport (Argon2id + XChaCha20, Recommended)</option>
              <option value="aes_zip">.zip (AES-256 Password ZIP)</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
          <div>
            <label htmlFor="exp-scope" className="block text-xs font-medium text-[#cbd5e1] mb-1">
              Message Scope
            </label>
            <select
              id="exp-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as ExportScope)}
              className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-2 text-xs text-white"
            >
              <option value="all">All Channels & Authorized History</option>
              <option value="selected">Selected Channels Only</option>
              <option value="date_range">Custom UTC Date Range</option>
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs text-[#cbd5e1] pt-6 cursor-pointer">
            <input
              type="checkbox"
              checked={includeAttachments}
              onChange={(e) => setIncludeAttachments(e.target.checked)}
              className="rounded border-[#2a3146]"
            />
            Include decrypted attachments & media files
          </label>
        </div>

        {scope === 'selected' && (
          <div className="rounded-xl border border-[#262c3f] bg-[#10131d] p-3">
            <div className="text-xs font-medium text-[#cbd5e1] mb-2">Channels to include:</div>
            <div className="flex flex-wrap gap-2">
              {roomDetail.room.channels.map((ch) => (
                <label
                  key={ch.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#2a3146] bg-[#161a26] px-2.5 py-1 text-xs text-white cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedChannels.includes(ch.id)}
                    onChange={() => toggleChannel(ch.id)}
                  />
                  #{ch.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {scope === 'date_range' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="exp-start" className="block text-xs font-medium text-[#cbd5e1] mb-1">From Date</label>
              <input
                id="exp-start"
                type="date"
                value={dateStart}
                onChange={(e) => setDateStart(e.target.value)}
                className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-2 text-xs text-white"
              />
            </div>
            <div>
              <label htmlFor="exp-end" className="block text-xs font-medium text-[#cbd5e1] mb-1">To Date</label>
              <input
                id="exp-end"
                type="date"
                value={dateEnd}
                onChange={(e) => setDateEnd(e.target.value)}
                className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-2 text-xs text-white"
              />
            </div>
          </div>
        )}

        <div className="rounded-xl border border-[#7c6cff]/40 bg-[#141724] p-3 space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#c4b5fd]">
            <Lock className="w-3.5 h-3.5" />
            Mandatory Export Encryption Password
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="exp-pw" className="block text-[11px] text-[#9aa3b8] mb-1">
                Archive Password (min 8 chars)
              </label>
              <input
                id="exp-pw"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-xs text-white"
              />
            </div>
            <div>
              <label htmlFor="exp-pw2" className="block text-[11px] text-[#9aa3b8] mb-1">
                Confirm Archive Password
              </label>
              <input
                id="exp-pw2"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-xs text-white"
              />
            </div>
          </div>
        </div>

        {progress && (
          <div className="rounded-xl border border-[#262c3f] bg-[#10131d] p-3 space-y-1.5">
            <div className="flex justify-between text-xs text-[#cbd5e1]">
              <span>{progress.detail}</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-[#090b10] overflow-hidden">
              <div
                className="h-full bg-[#7c6cff] transition-all"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <span className="text-[11px] text-[#8d96ad] flex items-center gap-1">
            <Archive className="w-3.5 h-3.5" /> Open anytime offline at /archive
          </span>
          <div className="flex gap-2">
            {busy ? (
              <Button type="button" variant="danger" onClick={handleCancel}>
                <XCircle className="w-4 h-4" /> Cancel Export
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={onClose}>Close</Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!password || password !== confirmPassword || password.length < 8}
                >
                  <Download className="w-4 h-4" /> Encrypt & Export Archive
                </Button>
              </>
            )}
          </div>
        </div>
      </form>
    </ModalDialog>
  );
}

