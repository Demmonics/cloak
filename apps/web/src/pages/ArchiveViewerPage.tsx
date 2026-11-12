import React, { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Archive,
  ArrowLeft,
  Download,
  FileCheck2,
  Lock,
  Printer,
  Search,
  ShieldAlert,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import type { ArchiveAttachmentEntry, OpenedArchiveData } from '@cloak/archive';
import { Button } from '@cloak/ui';
import { ThemeToggle } from '../components/ThemeToggle.js';
import { openArchiveInWorker } from '../lib/exportWorkerClient.js';

export function ArchiveViewerPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [password, setPassword] = useState('');
  const [opened, setOpened] = useState<OpenedArchiveData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [channelFilter, setChannelFilter] = useState('all');
  const [authorFilter, setAuthorFilter] = useState('all');

  const handleFile = async (file: File) => {
    setSelectedFile(file);
    setOpened(null);
    setError(null);
    const bytes = new Uint8Array(await file.arrayBuffer());
    setFileBytes(bytes);
  };

  const handleDecrypt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fileBytes) {
      setError('Select a .cloakexport or password-protected .zip archive first.');
      return;
    }
    if (!password) {
      setError('Password is required to decrypt and verify integrity.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await openArchiveInWorker(fileBytes, password);
      setOpened(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to decrypt or verify archive integrity.');
    } finally {
      setBusy(false);
    }
  };

  const downloadAttachment = (att: ArchiveAttachmentEntry) => {
    const copy = new Uint8Array(att.bytes.byteLength);
    copy.set(att.bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: att.mimeType || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = att.filename;
    a.rel = 'noopener noreferrer';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const downloadOfflineHtml = () => {
    if (!opened?.htmlContent) return;
    const blob = new Blob([opened.htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${opened.manifest.roomDisplayName.replace(/[^a-z0-9-_]+/gi, '_')}-transcript.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const filteredMessages = useMemo(() => {
    if (!opened?.messagesDoc) return [];
    const q = query.trim().toLowerCase();
    return opened.messagesDoc.messages.filter((m) => {
      if (channelFilter !== 'all' && m.channelId !== channelFilter) return false;
      if (authorFilter !== 'all' && m.senderDeviceId !== authorFilter) return false;
      if (!q) return true;
      const inText = m.text.toLowerCase().includes(q);
      const inAuthor = m.senderDisplayName.toLowerCase().includes(q);
      const inAtt = m.attachments.some((a) => a.filename.toLowerCase().includes(q));
      return inText || inAuthor || inAtt;
    });
  }, [authorFilter, channelFilter, opened, query]);

  return (
    <main className="min-h-screen bg-[var(--cloak-bg-void)] text-[var(--cloak-text)] p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--cloak-border)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-[10px] bg-[var(--cloak-accent-soft)] border border-[var(--cloak-accent-border)] flex items-center justify-center text-[var(--cloak-accent-text)]">
              <Archive className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-[var(--cloak-text)]">Cloak Encrypted Archive Viewer</h1>
              <p className="text-xs text-[var(--cloak-text-muted)]">
                Opens <code className="text-[var(--cloak-accent-text)]">.cloakexport</code> and AES-256 <code className="text-[var(--cloak-accent-text)]">.zip</code> backups 100% locally offline. Zero uploads.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] text-xs text-[var(--cloak-text-body)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Return to Workspace
            </Link>
          </div>
        </header>

        {/* Unlock Form */}
        <section className="rounded-[12px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] p-5 space-y-4">
          {error && (
            <div role="alert" className="rounded-[8px] border border-[var(--cloak-danger-border)] bg-[var(--cloak-danger-soft)] px-3.5 py-2.5 text-xs text-[var(--cloak-danger-text)] flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleDecrypt} className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div>
              <span className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">Archive File (.cloakexport / .zip)</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".cloakexport,.zip"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
                className="sr-only"
              />
              <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()} className="w-full justify-start">
                <Upload className="w-4 h-4 shrink-0" />
                <span className="truncate">{selectedFile ? selectedFile.name : 'Choose Encrypted Archive...'}</span>
              </Button>
            </div>

            <div>
              <label htmlFor="arch-pw" className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">
                Archive Password
              </label>
              <input
                id="arch-pw"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter archive passphrase"
                className="w-full rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-2 text-sm text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
              />
            </div>

            <Button type="submit" variant="primary" disabled={busy || !fileBytes}>
              <Lock className="w-4 h-4" />
              {busy ? 'Decrypting & Verifying SHA-256...' : 'Unlock Archive'}
            </Button>
          </form>
        </section>

        {/* Decrypted Archive View */}
        {opened && (
          <section className="space-y-4">
            {/* Verification & Offline Snapshot Banner */}
            <div className="rounded-[12px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-[var(--cloak-text)]">
                    {opened.manifest.roomDisplayName}
                  </h2>
                  <p className="text-xs text-[var(--cloak-text-muted)]">
                    Exported {new Date(opened.manifest.createdAtUtc).toLocaleString()} ({opened.manifest.timezone}) ·{' '}
                    {opened.manifest.includedMessageCount} message(s) · {opened.manifest.includedAttachmentCount} attachment(s)
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-xs font-medium border ${
                      opened.integrityVerified
                        ? 'bg-[var(--cloak-success-soft)] text-[var(--cloak-success-text)] border-[var(--cloak-success-border)]'
                        : 'bg-[var(--cloak-danger-soft)] text-[var(--cloak-danger-text)] border-[var(--cloak-danger-border)]'
                    }`}
                  >
                    {opened.integrityVerified ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
                    {opened.integrityVerified ? 'Integrity SHA-256 Verified' : 'Integrity Warning'}
                  </span>

                  {opened.htmlContent && (
                    <Button size="sm" variant="secondary" onClick={downloadOfflineHtml}>
                      <Download className="w-3.5 h-3.5" /> Save Offline HTML
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => window.print()}>
                    <Printer className="w-3.5 h-3.5" /> Print / PDF
                  </Button>
                </div>
              </div>

              <div className="rounded-[8px] bg-[var(--cloak-bg-elevated)] border border-[var(--cloak-border)] p-3 text-xs text-[var(--cloak-text-body)] flex flex-wrap gap-x-6 gap-y-1">
                <span>Container: <strong>{opened.containerMode}</strong></span>
                <span>Sync Cursor: <strong>Seq #{opened.manifest.syncCursorSeq}</strong></span>
                <span>
                  Snapshot Type:{' '}
                  <strong>
                    {opened.manifest.isHistoricalOfflineSnapshot ? 'Historical Offline Snapshot' : 'Synced Local Export'}
                  </strong>
                </span>
                <span>
                  Files Authenticated: <strong>{Object.keys(opened.integritySha256).length}</strong>
                </span>
              </div>

              {opened.manifest.warnings.length > 0 && (
                <div className="rounded-[8px] border border-[var(--cloak-warn-border)] bg-[var(--cloak-warn-soft)] p-3 text-xs text-[var(--cloak-warn-text)]">
                  <strong>Warnings:</strong> {opened.manifest.warnings.join(' · ')}
                </div>
              )}
            </div>

            {/* Filters for Structured Messages */}
            {opened.messagesDoc && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-[12px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] p-4">
                  <div className="relative">
                    <label htmlFor="arch-search" className="sr-only">Filter messages</label>
                    <Search className="w-4 h-4 text-[var(--cloak-text-dim)] absolute left-3 top-2.5" />
                    <input
                      id="arch-search"
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search decrypted messages..."
                      className="w-full rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] pl-9 pr-3 py-2 text-xs text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]"
                    />
                  </div>

                  <div>
                    <label htmlFor="arch-ch" className="sr-only">Filter by channel</label>
                    <select
                      id="arch-ch"
                      value={channelFilter}
                      onChange={(e) => setChannelFilter(e.target.value)}
                      className="w-full rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-2 text-xs text-[var(--cloak-text)]"
                    >
                      <option value="all">All Channels ({opened.messagesDoc.channels.length})</option>
                      {opened.messagesDoc.channels.map((c) => (
                        <option key={c.id} value={c.id}>#{c.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="arch-author" className="sr-only">Filter by participant</label>
                    <select
                      id="arch-author"
                      value={authorFilter}
                      onChange={(e) => setAuthorFilter(e.target.value)}
                      className="w-full rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-2 text-xs text-[var(--cloak-text)]"
                    >
                      <option value="all">All Authors ({opened.manifest.participants.length})</option>
                      {opened.manifest.participants.map((p) => (
                        <option key={p.deviceId} value={p.deviceId}>{p.displayName}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Messages List */}
                <div className="space-y-2.5">
                  {filteredMessages.map((msg) => (
                    <article
                      key={msg.id}
                      className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] p-4 space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-[var(--cloak-accent-text)]">{msg.senderDisplayName}</span>
                          <span className="text-[var(--cloak-text-dim)]">#{msg.channelName}</span>
                        </div>
                        <div className="flex items-center gap-2 text-[var(--cloak-text-dim)]">
                          <time dateTime={msg.createdAtUtc}>
                            {new Date(msg.createdAtUtc).toLocaleString()}
                          </time>
                          {msg.signatureVerified && (
                            <span title="Sender Ed25519 signature verified" className="text-[var(--cloak-success-text)]">
                              <FileCheck2 className="w-3.5 h-3.5" />
                            </span>
                          )}
                        </div>
                      </div>

                      {msg.replyPreviewText && (
                        <div className="pl-2.5 border-l-2 border-[var(--cloak-accent)] text-xs text-[var(--cloak-text-muted)]">
                          Reply to: {msg.replyPreviewText}
                        </div>
                      )}

                      <p className="text-sm text-[var(--cloak-text-body)] whitespace-pre-wrap break-words">{msg.text}</p>

                      {msg.reactions.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {msg.reactions.map((r) => (
                            <span
                              key={r.emoji}
                              className="inline-flex items-center gap-1 rounded-full bg-[var(--cloak-bg-elevated)] border border-[var(--cloak-border)] px-2 py-0.5 text-xs"
                            >
                              {r.emoji} {r.count}
                            </span>
                          ))}
                        </div>
                      )}

                      {msg.attachments.length > 0 && (
                        <div className="pt-1 flex flex-wrap gap-2">
                          {msg.attachments.map((att) => {
                            const entry = att.archivePath ? opened.attachments.get(att.archivePath) : undefined;
                            return (
                              <div
                                key={att.attachmentId}
                                className="inline-flex items-center gap-2 rounded-[7px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] px-2.5 py-1.5 text-xs"
                              >
                                <span className="text-[var(--cloak-text)]">{att.filename}</span>
                                <span className="text-[10px] text-[var(--cloak-text-dim)]">
                                  {(att.plaintextSizeBytes / 1024).toFixed(1)} KiB
                                </span>
                                {entry ? (
                                  <Button size="sm" variant="secondary" onClick={() => downloadAttachment(entry)}>
                                    <Download className="w-3 h-3" /> Save
                                  </Button>
                                ) : (
                                  <span className="text-[10px] text-[var(--cloak-danger-text)]">
                                    {att.unavailableReason ?? 'Binary not included'}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  ))}
                  {filteredMessages.length === 0 && (
                    <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] p-6 text-center text-xs text-[var(--cloak-text-dim)]">
                      No decrypted messages match the current filters.
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Plaintext-only fallback */}
            {!opened.messagesDoc && opened.transcriptTxt && (
              <pre className="rounded-[12px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] p-5 text-xs font-mono text-[var(--cloak-text-body)] whitespace-pre-wrap overflow-x-auto">
                {opened.transcriptTxt}
              </pre>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

