import React, { useRef, useState } from 'react';
import { Link } from 'react-router';
import { Archive, FolderKey, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { Button } from '@cloak/ui';
import {
  createNewDeviceOnboarding,
  restoreDeviceFromBackupFile,
} from '../lib/workspaceClient.js';
import { useAppStore } from '../store/useAppStore.js';

const AVATAR_COLORS = [
  '#0f766e',
  '#0284c7',
  '#10b981',
  '#d97706',
  '#be123c',
  '#334155',
];

const AVATAR_EMOJIS = ['🛡️', '🦊', '🦉', '⚡', '🛰️', '🌑', '🔮', '🗝️'];

export function OnboardingScreen({ onDone }: { onDone?: () => void }) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [mode, setMode] = useState<'create' | 'restore'>('create');
  const [displayName, setDisplayName] = useState('');
  const [avatarColor, setAvatarColor] = useState(AVATAR_COLORS[0]!);
  const [avatarEmoji, setAvatarEmoji] = useState<string>('🛡️');
  const [passphrase, setPassphrase] = useState('');
  const [backupJson, setBackupJson] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [localPassphrase, setLocalPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createNewDeviceOnboarding({
        displayName: displayName.trim() || 'Anonymous',
        avatarColor,
        avatarEmoji,
        passphrase: passphrase.trim() || undefined,
      });
      pushToast({
        tone: 'success',
        title: 'Local cryptographic identity created',
        detail: 'Private Ed25519 & X25519 keys remain stored only in this browser vault.',
      });
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize device identity');
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backupJson.trim() || !backupPassword) {
      setError('Select your .cloakkey backup file and enter its decryption password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await restoreDeviceFromBackupFile({
        backupJson,
        backupPassword,
        localPassphrase: localPassphrase.trim() || undefined,
      });
      pushToast({
        tone: 'success',
        title: 'Identity restored',
        detail: 'Your encrypted keypair was recovered locally without sending secrets to any server.',
      });
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wrong password or corrupted .cloakkey backup');
    } finally {
      setBusy(false);
    }
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setBackupJson(text);
  };

  return (
    <main className="min-h-screen bg-[var(--cloak-bg-void)] text-[var(--cloak-text)] flex items-center justify-center p-4">
      <div className="w-full max-w-xl rounded-[12px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] overflow-hidden">
        <div className="px-6 py-5 border-b border-[var(--cloak-border)] bg-[var(--cloak-bg-sidebar)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-[10px] bg-[var(--cloak-accent-soft)] border border-[var(--cloak-accent-border)] flex items-center justify-center text-[var(--cloak-accent-text)]">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-[var(--cloak-text)]">Cloak Private Workspace</h1>
                <p className="text-xs text-[var(--cloak-text-muted)]">
                  Anonymous-first, end-to-end encrypted communication. No account required.
                </p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 shrink-0">
              <Link
                to="/p2p"
                className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-xs text-[var(--cloak-info-text)] bg-[var(--cloak-bg-elevated)] border border-[var(--cloak-border)] hover:bg-[var(--cloak-bg-hover)]"
              >
                Direct P2P
              </Link>
              <Link
                to="/archive"
                className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-xs text-[var(--cloak-accent-text)] bg-[var(--cloak-bg-elevated)] border border-[var(--cloak-border)] hover:bg-[var(--cloak-bg-hover)]"
              >
                <Archive className="w-3.5 h-3.5" />
                Open Archive
              </Link>
            </div>
          </div>

          <div className="mt-4 flex gap-2" role="tablist" aria-label="Identity setup mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'create'}
              onClick={() => {
                setMode('create');
                setError(null);
              }}
              className={`px-3 py-1.5 rounded-[7px] text-xs font-medium cursor-pointer transition-colors ${
                mode === 'create'
                  ? 'bg-[var(--cloak-accent)] text-[var(--cloak-accent-ink)]'
                  : 'bg-[var(--cloak-bg-elevated)] text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)]'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 inline mr-1.5" />
              New Device Identity
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'restore'}
              onClick={() => {
                setMode('restore');
                setError(null);
              }}
              className={`px-3 py-1.5 rounded-[7px] text-xs font-medium cursor-pointer transition-colors ${
                mode === 'restore'
                  ? 'bg-[var(--cloak-accent)] text-[var(--cloak-accent-ink)]'
                  : 'bg-[var(--cloak-bg-elevated)] text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)]'
              }`}
            >
              <FolderKey className="w-3.5 h-3.5 inline mr-1.5" />
              Restore .cloakkey Backup
            </button>
          </div>
        </div>

        <div className="p-6">
          <div className="mb-4 rounded-[10px] bg-[var(--cloak-bg-elevated)] border border-[var(--cloak-border)] p-3 text-xs text-[var(--cloak-text-body)] leading-relaxed">
            Your device generates an Ed25519 signing identity and X25519 key-exchange key locally.
            If you clear browser storage without exporting a <code className="text-[var(--cloak-accent-text)]">.cloakkey</code> backup,
            room access cannot be recovered by the server.
          </div>

          {error && (
            <div role="alert" className="mb-4 rounded-[8px] border border-[var(--cloak-danger-border)] bg-[var(--cloak-danger-soft)] px-3 py-2 text-xs text-[var(--cloak-danger-text)]">
              {error}
            </div>
          )}

          {mode === 'create' ? (
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label htmlFor="onboard-display-name" className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">
                  Display Nickname (optional)
                </label>
                <input
                  id="onboard-display-name"
                  type="text"
                  maxLength={64}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Anonymous"
                  className="w-full rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-2 text-sm text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)] focus:border-[var(--cloak-accent)] focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <span className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">Avatar Accent</span>
                  <div className="flex flex-wrap gap-2">
                    {AVATAR_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setAvatarColor(color)}
                        aria-label={`Select color ${color}`}
                        aria-pressed={avatarColor === color}
                        style={{ backgroundColor: color }}
                        className={`w-7 h-7 rounded-[7px] cursor-pointer ${
                          avatarColor === color ? 'ring-2 ring-[var(--cloak-text)] ring-offset-2 ring-offset-[var(--cloak-bg-surface)]' : 'opacity-75 hover:opacity-100'
                        }`}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <span className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">Avatar Emblem</span>
                  <div className="flex flex-wrap gap-1.5">
                    {AVATAR_EMOJIS.map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => setAvatarEmoji(em)}
                        aria-pressed={avatarEmoji === em}
                        className={`w-8 h-8 rounded-[7px] flex items-center justify-center text-base cursor-pointer ${
                          avatarEmoji === em
                            ? 'bg-[var(--cloak-accent-soft)] border border-[var(--cloak-accent-border)]'
                            : 'bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] hover:border-[var(--cloak-border-strong)]'
                        }`}
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label htmlFor="onboard-passphrase" className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">
                  Local Vault Passphrase (optional — strengthens IndexedDB key storage with Argon2id)
                </label>
                <input
                  id="onboard-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Leave blank for seamless non-extractable WebCrypto wrapping"
                  className="w-full rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-2 text-sm text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)] focus:border-[var(--cloak-accent)] focus:outline-none"
                />
              </div>

              <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
                {busy ? 'Generating Local Keys...' : 'Generate Identity & Enter Cloak'}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleRestore} className="space-y-4">
              <div>
                <label htmlFor="restore-file-input" className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">
                  Encrypted Identity Backup (.cloakkey)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="restore-file-input"
                    ref={fileRef}
                    type="file"
                    accept=".cloakkey,.json"
                    onChange={handleFilePick}
                    className="sr-only"
                  />
                  <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
                    <Upload className="w-4 h-4" />
                    Choose .cloakkey File
                  </Button>
                  <span className="text-xs text-[var(--cloak-text-muted)]">
                    {backupJson ? 'Backup loaded cleanly' : 'No file selected'}
                  </span>
                </div>
              </div>

              <div>
                <label htmlFor="restore-backup-pw" className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">
                  Backup Decryption Password
                </label>
                <input
                  id="restore-backup-pw"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={backupPassword}
                  onChange={(e) => setBackupPassword(e.target.value)}
                  className="w-full rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-2 text-sm text-[var(--cloak-text)] focus:border-[var(--cloak-accent)] focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="restore-local-pw" className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">
                  New Local Browser Vault Passphrase (optional)
                </label>
                <input
                  id="restore-local-pw"
                  type="password"
                  autoComplete="new-password"
                  value={localPassphrase}
                  onChange={(e) => setLocalPassphrase(e.target.value)}
                  className="w-full rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-2 text-sm text-[var(--cloak-text)] focus:border-[var(--cloak-accent)] focus:outline-none"
                />
              </div>

              <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
                {busy ? 'Decrypting & Re-authenticating...' : 'Restore Device Identity'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}

