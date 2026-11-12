import React, { useState } from 'react';
import { Download, KeyRound, Lock, LogOut, Trash2 } from 'lucide-react';
import { exportEncryptedDeviceBackup } from '@cloak/crypto';
import { Button, ConfirmDialog, ModalDialog } from '@cloak/ui';
import { api } from '../../lib/api.js';
import { db, saveVaultWithBrowserWrapping, saveVaultWithPassphrase } from '../../lib/storage.js';
import { useAppStore } from '../../store/useAppStore.js';

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const profile = useAppStore((s) => s.profile);
  const keyBundle = useAppStore((s) => s.keyBundle);
  const vaultMode = useAppStore((s) => s.vaultMode);
  const setProfile = useAppStore((s) => s.setProfile);
  const lockVault = useAppStore((s) => s.lockVault);
  const setVaultState = useAppStore((s) => s.setVaultState);
  const pushToast = useAppStore((s) => s.pushToast);

  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [backupPw, setBackupPw] = useState('');
  const [vaultPw, setVaultPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);

  if (!profile || !keyBundle) return null;

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const updated = await api.updateProfile({
        displayName: displayName.trim() || 'Anonymous',
      });
      setProfile(updated);
      pushToast({ tone: 'success', title: 'Device profile updated' });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Update failed',
        detail: err instanceof Error ? err.message : 'Unable to save profile',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadKeyBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (backupPw.length < 8) {
      pushToast({ tone: 'warning', title: 'Password too short', detail: 'Use at least 8 characters for backup encryption.' });
      return;
    }
    setBusy(true);
    try {
      const backup = await exportEncryptedDeviceBackup(keyBundle, backupPw);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cloak-identity-${profile.id.slice(0, 8)}.cloakkey`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setBackupPw('');
      pushToast({ tone: 'success', title: 'Encrypted .cloakkey backup downloaded' });
    } finally {
      setBusy(false);
    }
  };

  const handleSetPassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const hint = {
        displayName: profile.displayName,
        avatarColor: profile.avatarColor,
        avatarEmoji: profile.avatarEmoji,
        ed25519PublicKeyB64: keyBundle.ed25519PublicKeyB64,
        x25519PublicKeyB64: keyBundle.x25519PublicKeyB64,
        createdAt: keyBundle.createdAt,
      };
      if (vaultPw.trim()) {
        await saveVaultWithPassphrase(keyBundle, hint, vaultPw.trim());
        useAppStore.getState().setVaultUnlocked(keyBundle, profile, 'passphrase');
        pushToast({ tone: 'success', title: 'Local vault locked with Argon2id passphrase' });
      } else {
        await saveVaultWithBrowserWrapping(keyBundle, hint);
        useAppStore.getState().setVaultUnlocked(keyBundle, profile, 'browser_key');
        pushToast({ tone: 'info', title: 'Switched to seamless WebCrypto vault wrapping' });
      }
      setVaultPw('');
    } finally {
      setBusy(false);
    }
  };

  const handleWipeAllLocal = async () => {
    try {
      await api.logout();
    } catch {
      // ignore if offline
    }
    await db.delete();
    await db.open();
    setConfirmWipe(false);
    onClose();
    setVaultState('needs_onboarding');
  };

  return (
    <ModalDialog open={open} onClose={onClose} wide title="Identity, Security & Vault Settings">
      <div className="space-y-5">
        <div className="rounded-xl border border-[#262c3f] bg-[#10131d] p-3 text-xs space-y-1">
          <div className="text-[#8d96ad]">Local Device ID</div>
          <div className="font-mono text-[#e2e8f0] break-all">{profile.id}</div>
          <div className="text-[#8d96ad] pt-1">Ed25519 Public Key Fingerprint</div>
          <div className="font-mono text-[#a5b4fc] break-all">{profile.ed25519PublicKeyB64}</div>
        </div>

        <form onSubmit={handleSaveProfile} className="space-y-2.5">
          <label htmlFor="set-name" className="block text-xs font-medium text-[#cbd5e1]">
            Nickname
          </label>
          <div className="flex gap-2">
            <input
              id="set-name"
              type="text"
              maxLength={64}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="flex-1 rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
            />
            <Button type="submit" variant="secondary" disabled={busy}>Save</Button>
          </div>
        </form>

        <form onSubmit={handleDownloadKeyBackup} className="rounded-xl border border-[#262c3f] bg-[#161a26] p-3.5 space-y-2.5">
          <div className="text-xs font-semibold text-white flex items-center gap-1.5">
            <KeyRound className="w-4 h-4 text-[#a5b4fc]" />
            Export Encrypted Identity Backup (.cloakkey)
          </div>
          <p className="text-[11px] text-[#9aa3b8]">
            Encrypts your Ed25519 & X25519 private keys locally with Argon2id + XChaCha20-Poly1305. Never uploaded.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              aria-label="Identity backup encryption password"
              placeholder="Backup password (min 8 chars)"
              value={backupPw}
              onChange={(e) => setBackupPw(e.target.value)}
              className="flex-1 rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-xs text-white"
            />
            <Button type="submit" variant="primary" size="sm" disabled={busy}>
              <Download className="w-3.5 h-3.5" /> Backup Key
            </Button>
          </div>
        </form>

        <form onSubmit={handleSetPassphrase} className="rounded-xl border border-[#262c3f] bg-[#161a26] p-3.5 space-y-2.5">
          <div className="text-xs font-semibold text-white flex items-center gap-1.5">
            <Lock className="w-4 h-4 text-[#38bdf8]" />
            Browser Vault Protection ({vaultMode === 'passphrase' ? 'Passphrase Locked' : 'WebCrypto Key'})
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              aria-label="Vault passphrase"
              placeholder="Enter new passphrase (or leave blank to disable prompt)"
              value={vaultPw}
              onChange={(e) => setVaultPw(e.target.value)}
              className="flex-1 rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-xs text-white"
            />
            <Button type="submit" variant="secondary" size="sm" disabled={busy}>
              Apply
            </Button>
          </div>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#262c3f]">
          {vaultMode === 'passphrase' && (
            <Button
              variant="secondary"
              onClick={() => {
                onClose();
                lockVault();
              }}
            >
              <LogOut className="w-4 h-4" /> Lock Vault Now
            </Button>
          )}
          <Button variant="danger" onClick={() => setConfirmWipe(true)} className="ml-auto">
            <Trash2 className="w-4 h-4" /> Destroy Local Vault
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmWipe}
        onCancel={() => setConfirmWipe(false)}
        onConfirm={handleWipeAllLocal}
        title="Destroy local cryptographic vault?"
        description="Permanently deletes your device private keys, offline encrypted messages, and cached attachments from this browser."
        confirmLabel="Destroy Vault"
        destructive
      />
    </ModalDialog>
  );
}
