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
    <main className="min-h-screen bg-[var(--cloak-bg-void)] text-[var(--cloak-text)] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-[12px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[10px] bg-[var(--cloak-accent-soft)] border border-[var(--cloak-accent-border)] flex items-center justify-center text-[var(--cloak-accent-text)]">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-[var(--cloak-text)]">Unlock Local Cloak Vault</h1>
            <p className="text-xs text-[var(--cloak-text-muted)]">
              Enter your browser passphrase to derive Argon2id decryption keys.
            </p>
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-[8px] border border-[var(--cloak-danger-border)] bg-[var(--cloak-danger-soft)] px-3 py-2 text-xs text-[var(--cloak-danger-text)]">
            {error}
          </div>
        )}

        <form onSubmit={handleUnlock} className="space-y-4">
          <div>
            <label htmlFor="vault-unlock-pw" className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">
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
              className="w-full rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-2 text-sm text-[var(--cloak-text)] focus:border-[var(--cloak-accent)] focus:outline-none"
            />
          </div>
          <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
            {busy ? 'Unlocking Vault...' : 'Unlock Workspace'}
          </Button>
        </form>

        <div className="pt-3 border-t border-[var(--cloak-border)] flex items-center justify-between text-xs">
          <Link to="/archive" className="inline-flex items-center gap-1.5 text-[var(--cloak-accent-text)] hover:underline">
            <Archive className="w-3.5 h-3.5" />
            Open Offline Archive
          </Link>
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="inline-flex items-center gap-1 text-[var(--cloak-danger-text)] hover:underline cursor-pointer"
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

