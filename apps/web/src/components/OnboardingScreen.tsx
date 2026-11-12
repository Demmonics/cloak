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
  '#7c6cff',
  '#38bdf8',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#6366f1',
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
    <main className="min-h-screen bg-[#0c0e14] text-[#f1f3f9] flex items-center justify-center p-4">
      <div className="w-full max-w-xl rounded-2xl border border-[#262c3f] bg-[#141722] shadow-2xl overflow-hidden">
        <div className="px-6 py-5 border-b border-[#262c3f] bg-gradient-to-br from-[#191d2b] to-[#12151f]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#7c6cff]/20 border border-[#7c6cff]/40 flex items-center justify-center text-[#a5b4fc]">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight">Cloak Private Workspace</h1>
                <p className="text-xs text-[#9aa3b8]">
                  Anonymous-first, end-to-end encrypted communication. No account required.
                </p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 shrink-0">
              <Link
                to="/p2p"
                className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-[#38bdf8] bg-[#1e2334] border border-[#323a54] hover:bg-[#272e44]"
              >
                Direct P2P
              </Link>
              <Link
                to="/archive"
                className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-[#a5b4fc] bg-[#1e2334] border border-[#323a54] hover:bg-[#272e44]"
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
              className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer cloak-transition ${
                mode === 'create'
                  ? 'bg-[#7c6cff] text-white'
                  : 'bg-[#1a1f2e] text-[#9aa3b8] hover:text-white'
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
              className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer cloak-transition ${
                mode === 'restore'
                  ? 'bg-[#7c6cff] text-white'
                  : 'bg-[#1a1f2e] text-[#9aa3b8] hover:text-white'
              }`}
            >
              <FolderKey className="w-3.5 h-3.5 inline mr-1.5" />
              Restore .cloakkey Backup
            </button>
          </div>
        </div>

        <div className="p-6">
          <div className="mb-4 rounded-xl bg-[#10131d] border border-[#23293c] p-3 text-xs text-[#a8b1c7] leading-relaxed">
            Your device generates an Ed25519 signing identity and X25519 key-exchange key locally.
            If you clear browser storage without exporting a <code className="text-[#c4b5fd]">.cloakkey</code> backup,
            room access cannot be recovered by the server.
          </div>

          {error && (
            <div role="alert" className="mb-4 rounded-lg border border-[#ef4444]/50 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#fca5a5]">
              {error}
            </div>
          )}

          {mode === 'create' ? (
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label htmlFor="onboard-display-name" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
                  Display Nickname (optional)
                </label>
                <input
                  id="onboard-display-name"
                  type="text"
                  maxLength={64}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Anonymous"
                  className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white placeholder-[#64748b] focus:border-[#7c6cff] focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <span className="block text-xs font-medium text-[#cbd5e1] mb-1.5">Avatar Accent</span>
                  <div className="flex flex-wrap gap-2">
                    {AVATAR_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setAvatarColor(color)}
                        aria-label={`Select color ${color}`}
                        aria-pressed={avatarColor === color}
                        style={{ backgroundColor: color }}
                        className={`w-7 h-7 rounded-lg cursor-pointer ${
                          avatarColor === color ? 'ring-2 ring-white ring-offset-2 ring-offset-[#141722]' : 'opacity-75 hover:opacity-100'
                        }`}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <span className="block text-xs font-medium text-[#cbd5e1] mb-1.5">Avatar Emblem</span>
                  <div className="flex flex-wrap gap-1.5">
                    {AVATAR_EMOJIS.map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => setAvatarEmoji(em)}
                        aria-pressed={avatarEmoji === em}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center text-base cursor-pointer ${
                          avatarEmoji === em
                            ? 'bg-[#7c6cff]/30 border border-[#7c6cff]'
                            : 'bg-[#0d1017] border border-[#262c3f] hover:border-[#414c6b]'
                        }`}
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label htmlFor="onboard-passphrase" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
                  Local Vault Passphrase (optional — strengthens IndexedDB key storage with Argon2id)
                </label>
                <input
                  id="onboard-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Leave blank for seamless non-extractable WebCrypto wrapping"
                  className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white placeholder-[#64748b] focus:border-[#7c6cff] focus:outline-none"
                />
              </div>

              <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
                {busy ? 'Generating Local Keys...' : 'Generate Identity & Enter Cloak'}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleRestore} className="space-y-4">
              <div>
                <label htmlFor="restore-file-input" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
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
                  <span className="text-xs text-[#9aa3b8]">
                    {backupJson ? 'Backup loaded cleanly' : 'No file selected'}
                  </span>
                </div>
              </div>

              <div>
                <label htmlFor="restore-backup-pw" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
                  Backup Decryption Password
                </label>
                <input
                  id="restore-backup-pw"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={backupPassword}
                  onChange={(e) => setBackupPassword(e.target.value)}
                  className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white focus:border-[#7c6cff] focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="restore-local-pw" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
                  New Local Browser Vault Passphrase (optional)
                </label>
                <input
                  id="restore-local-pw"
                  type="password"
                  autoComplete="new-password"
                  value={localPassphrase}
                  onChange={(e) => setLocalPassphrase(e.target.value)}
                  className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white focus:border-[#7c6cff] focus:outline-none"
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

