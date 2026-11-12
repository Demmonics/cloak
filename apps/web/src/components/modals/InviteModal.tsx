import React, { useEffect, useState } from 'react';
import { Copy, Link2, Trash2 } from 'lucide-react';
import type { InviteSummary } from '@cloak/protocol';
import { Button, ModalDialog } from '@cloak/ui';
import { api } from '../../lib/api.js';
import { createRoomInviteLink, joinRoomWithInvite } from '../../lib/workspaceClient.js';
import { useAppStore } from '../../store/useAppStore.js';

export function ManageInvitesModal({
  open,
  onClose,
  roomId,
  roomName,
  currentEpoch,
}: {
  open: boolean;
  onClose: () => void;
  roomId: string;
  roomName: string;
  currentEpoch: number;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [roleName, setRoleName] = useState<'member' | 'admin' | 'readonly'>('member');
  const [password, setPassword] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [expiresHours, setExpiresHours] = useState('24');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [latestUrl, setLatestUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInvites = React.useCallback(async () => {
    try {
      const list = await api.listInvites(roomId);
      setInvites(list);
    } catch {
      // ignore if user lacks permission
    }
  }, [roomId]);

  useEffect(() => {
    if (open) {
      setLatestUrl('');
      setError(null);
      void loadInvites();
    }
  }, [open, loadInvites]);

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLatestUrl('');
    try {
      const res = await createRoomInviteLink({
        roomId,
        currentEpoch,
        roleName,
        accessScope: roleName === 'readonly' ? 'read_only' : 'read_write',
        requiresApproval,
        password: password.trim() || undefined,
        maxUses: maxUses ? Number(maxUses) : null,
        expiresInHours: expiresHours ? Number(expiresHours) : null,
      });
      setLatestUrl(res.shareUrl);
      await loadInvites();
      pushToast({ tone: 'success', title: 'Encrypted invite link generated' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invite');
    } finally {
      setBusy(false);
    }
  };

  const copyLatest = async () => {
    if (!latestUrl) return;
    await navigator.clipboard.writeText(latestUrl);
    pushToast({ tone: 'info', title: 'Invite link copied to clipboard' });
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      wide
      title={`Invite People to ${roomName}`}
      description="The room decryption secret (#k=...) stays strictly in the URL fragment and is never sent to the server."
    >
      <form onSubmit={handleCreateInvite} className="space-y-4">
        {error && (
          <div role="alert" className="rounded-lg border border-[#ef4444]/50 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#fca5a5]">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="inv-role" className="block text-xs font-medium text-[#cbd5e1] mb-1">Role</label>
            <select
              id="inv-role"
              value={roleName}
              onChange={(e) => setRoleName(e.target.value as 'member' | 'admin' | 'readonly')}
              className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-2 text-xs text-white"
            >
              <option value="member">Member (Read & Write)</option>
              <option value="readonly">Read-Only Visitor</option>
              <option value="admin">Admin (Owner only)</option>
            </select>
          </div>
          <div>
            <label htmlFor="inv-uses" className="block text-xs font-medium text-[#cbd5e1] mb-1">Max Uses</label>
            <input
              id="inv-uses"
              type="number"
              min={1}
              placeholder="Unlimited"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-2 text-xs text-white"
            />
          </div>
          <div>
            <label htmlFor="inv-exp" className="block text-xs font-medium text-[#cbd5e1] mb-1">Expires (hours)</label>
            <input
              id="inv-exp"
              type="number"
              min={1}
              placeholder="Never"
              value={expiresHours}
              onChange={(e) => setExpiresHours(e.target.value)}
              className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-2 text-xs text-white"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <div>
            <label htmlFor="inv-pw" className="block text-xs font-medium text-[#cbd5e1] mb-1">
              Optional Invite Password
            </label>
            <input
              id="inv-pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank for link-only access"
              className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-2 text-xs text-white"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-[#cbd5e1] py-2 cursor-pointer">
            <input
              type="checkbox"
              checked={requiresApproval}
              onChange={(e) => setRequiresApproval(e.target.checked)}
              className="rounded border-[#2a3146]"
            />
            Require owner approval before releasing epoch key
          </label>
        </div>

        <Button type="submit" variant="primary" disabled={busy}>
          <Link2 className="w-4 h-4" />
          {busy ? 'Generating Link...' : 'Generate Private Invite Link'}
        </Button>

        {latestUrl && (
          <div className="rounded-xl border border-[#7c6cff]/50 bg-[#171b28] p-3 space-y-2">
            <div className="text-xs font-medium text-[#c4b5fd]">Generated Invite Link (Share privately):</div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                aria-label="Generated invite URL"
                value={latestUrl}
                className="flex-1 rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-1.5 text-xs font-mono text-[#e2e8f0]"
              />
              <Button size="sm" variant="secondary" onClick={copyLatest}>
                <Copy className="w-3.5 h-3.5" />
                Copy
              </Button>
            </div>
          </div>
        )}
      </form>

      <div className="pt-3 border-t border-[#262c3f] space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#9aa3b8]">
          Existing Invitations ({invites.length})
        </h3>
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {invites.map((inv) => (
            <div
              key={inv.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-[#10131d] border border-[#23293c] px-3 py-2 text-xs"
            >
              <div>
                <span className="font-medium text-white capitalize">{inv.roleName}</span>
                <span className="text-[#8d96ad] ml-2">
                  Uses: {inv.usesCount}/{inv.maxUses ?? '∞'} · Epoch {inv.wrappedEpoch}
                  {inv.hasPassword ? ' · Password' : ''}
                  {inv.requiresApproval ? ' · Approval' : ''}
                  {inv.revokedAt ? ' · REVOKED' : ''}
                </span>
              </div>
              {!inv.revokedAt && (
                <button
                  type="button"
                  onClick={async () => {
                    await api.revokeInvite(roomId, inv.id);
                    await loadInvites();
                    pushToast({ tone: 'info', title: 'Invitation revoked' });
                  }}
                  aria-label="Revoke invitation"
                  className="inline-flex items-center gap-1 text-[#f87171] hover:underline cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </ModalDialog>
  );
}

export function parseInviteLink(input: string): { token: string; fragmentSecret: string } {
  const trimmed = input.trim();
  const hashIdx = trimmed.indexOf('#');
  const basePart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const hashPart = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : '';
  const params = new URLSearchParams(hashPart);
  const fragmentSecret = params.get('k') ?? '';

  let token = basePart;
  try {
    if (basePart.startsWith('http://') || basePart.startsWith('https://')) {
      const url = new URL(basePart);
      const parts = url.pathname.split('/').filter(Boolean);
      token = parts[parts.length - 1] ?? '';
    } else if (basePart.includes('/invite/')) {
      const parts = basePart.split('/invite/');
      token = (parts[parts.length - 1] ?? '').split(/[?#]/)[0] ?? '';
    }
  } catch {
    // use raw token
  }
  return { token, fragmentSecret };
}

export function JoinInviteModal({
  open,
  onClose,
  onJoinedRoom,
}: {
  open: boolean;
  onClose: () => void;
  onJoinedRoom: (roomId: string) => Promise<void>;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [link, setLink] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const { token, fragmentSecret } = parseInviteLink(link);
    if (!token) {
      setError('Paste a valid Cloak invite URL.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await joinRoomWithInvite({
        token,
        linkSecretB64Url: fragmentSecret,
        password: password.trim() || undefined,
      });
      if (res.status === 'pending_approval') {
        pushToast({
          tone: 'info',
          title: 'Join request submitted',
          detail: 'Waiting for room owner/admin approval before the room epoch key is released.',
        });
        onClose();
        return;
      }
      await onJoinedRoom(res.roomId);
      setLink('');
      setPassword('');
      onClose();
      pushToast({ tone: 'success', title: 'Joined encrypted room' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to join with invite link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="Join Room via Private Invite"
      description="Paste the complete invite URL (including #k=... fragment) shared with you."
    >
      <form onSubmit={handleJoin} className="space-y-4">
        {error && (
          <div role="alert" className="rounded-lg border border-[#ef4444]/50 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#fca5a5]">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="join-link-input" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
            Invitation URL
          </label>
          <input
            id="join-link-input"
            type="text"
            required
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://.../invite/...#k=..."
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-xs font-mono text-white focus:border-[#7c6cff] focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="join-pw-input" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
            Invite Password (if required)
          </label>
          <input
            id="join-pw-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white focus:border-[#7c6cff] focus:outline-none"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Verifying & Unwrapping Key...' : 'Join Room'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
