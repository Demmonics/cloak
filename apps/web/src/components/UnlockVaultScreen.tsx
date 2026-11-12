import React, { useState } from 'react';
import { Link } from 'react-router';
import { Archive, KeyRound, Trash2 } from 'lucide-react';
import { Button, ConfirmDialog } from '@cloak/ui';
import { unlockPassphraseProtectedVault } from '../lib/workspaceClient.js';
import { db } from '../lib/storage.js';
import { useAppStore } from '../store/useAppStore.js';

export function UnlockVaultScreen() {
  const setVaultState = useAppStore((s) => s.setVaultState);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlockPassphraseProtectedVault(passphrase);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Incorrect passphrase');
    } finally {
      setBusy(false);
    }
  };

  const handleResetLocal = async () => {
    await db.delete();
    await db.open();
    setConfirmReset(false);
    setVaultState('needs_onboarding');
  };

  return (
    <main className="min-h-screen bg-[#0c0e14] text-[#f1f3f9] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-[#262c3f] bg-[#141722] p-6 shadow-2xl space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#7c6cff]/20 border border-[#7c6cff]/40 flex items-center justify-center text-[#a5b4fc]">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Unlock Local Cloak Vault</h1>
            <p className="text-xs text-[#9aa3b8]">
              Enter your browser passphrase to derive Argon2id decryption keys.
            </p>
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-[#ef4444]/50 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#fca5a5]">
            {error}
          </div>
        )}

        <form onSubmit={handleUnlock} className="space-y-4">
          <div>
            <label htmlFor="vault-unlock-pw" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
              Vault Passphrase
            </label>
            <input
              id="vault-unlock-pw"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white focus:border-[#7c6cff] focus:outline-none"
            />
          </div>
          <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
            {busy ? 'Unlocking Vault...' : 'Unlock Workspace'}
          </Button>
        </form>

        <div className="pt-3 border-t border-[#262c3f] flex items-center justify-between text-xs">
          <Link to="/archive" className="inline-flex items-center gap-1.5 text-[#a5b4fc] hover:underline">
            <Archive className="w-3.5 h-3.5" />
            Open Offline Archive
          </Link>
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="inline-flex items-center gap-1 text-[#f87171] hover:underline cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Wipe & Start Fresh
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onCancel={() => setConfirmReset(false)}
        onConfirm={handleResetLocal}
        title="Wipe local device vault?"
        description="This permanently erases your local keys, offline cached messages, and device identity on this browser. Without a .cloakkey backup, room access cannot be restored."
        confirmLabel="Erase Local Vault"
        destructive
      />
    </main>
  );
}

