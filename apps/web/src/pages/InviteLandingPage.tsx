import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Lock, ShieldCheck } from 'lucide-react';
import type { InviteInspectionResponse } from '@cloak/protocol';
import { Button } from '@cloak/ui';
import { OnboardingScreen } from '../components/OnboardingScreen.js';
import { UnlockVaultScreen } from '../components/UnlockVaultScreen.js';
import { api } from '../lib/api.js';
import { joinRoomWithInvite } from '../lib/workspaceClient.js';
import { useAppStore } from '../store/useAppStore.js';

export function InviteLandingPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const vaultState = useAppStore((s) => s.vaultState);
  const selectRoom = useAppStore((s) => s.selectRoom);
  const pushToast = useAppStore((s) => s.pushToast);

  const [inspection, setInspection] = useState<InviteInspectionResponse | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);

  const fragmentParams = new URLSearchParams(
    typeof window !== 'undefined' && window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : '',
  );
  const linkSecret = fragmentParams.get('k') ?? '';

  useEffect(() => {
    setInspectError(null);
    setInspection(null);
    setPendingApproval(false);
    setPassword('');
    if (!token) {
      setInspectError('No invitation token found in URL.');
      return;
    }
    void api
      .inspectInvite(token)
      .then(setInspection)
      .catch((err) => setInspectError(err instanceof Error ? err.message : 'Invitation invalid, expired, or revoked.'));
  }, [token]);

  if (vaultState === 'needs_onboarding') {
    return (
      <div>
        <div className="bg-[var(--cloak-accent-soft)] border-b border-[var(--cloak-accent-border)] px-4 py-2 text-center text-xs text-[var(--cloak-accent-text)]">
          Step 1 of 2: Create or restore your local Cloak identity to accept invitation {inspection ? `to "${inspection.roomName}"` : ''}.
        </div>
        <OnboardingScreen />
      </div>
    );
  }

  if (vaultState === 'locked') {
    return <UnlockVaultScreen />;
  }

  const handleAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setInspectError(null);
    try {
      const res = await joinRoomWithInvite({
        token,
        linkSecretB64Url: linkSecret,
        password: password.trim() || undefined,
      });
      if (res.status === 'pending_approval') {
        setPendingApproval(true);
        return;
      }
      if (res.roomDetail) {
        selectRoom(res.roomDetail.room);
      }
      pushToast({ tone: 'success', title: `Joined "${inspection?.roomName ?? 'room'}"` });
      navigate('/');
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'Failed to join room');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[var(--cloak-bg-void)] text-[var(--cloak-text)] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-[12px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-[10px] bg-[var(--cloak-accent-soft)] border border-[var(--cloak-accent-border)] flex items-center justify-center text-[var(--cloak-accent-text)]">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-[var(--cloak-text)]">Private Room Invitation</h1>
            <p className="text-xs text-[var(--cloak-text-muted)]">End-to-end encrypted access via URL fragment secret</p>
          </div>
        </div>

        {inspectError && (
          <div role="alert" className="rounded-[8px] border border-[var(--cloak-danger-border)] bg-[var(--cloak-danger-soft)] px-3 py-2 text-xs text-[var(--cloak-danger-text)]">
            {inspectError}
          </div>
        )}

        {pendingApproval ? (
          <div className="rounded-[10px] border border-[var(--cloak-warn-border)] bg-[var(--cloak-warn-soft)] p-4 text-xs text-[var(--cloak-warn-text)] space-y-3">
            <div className="font-semibold text-sm">Awaiting Owner Approval</div>
            <p>
              Your device joined the room&apos;s approval queue. Once the owner approves your device,
              they will wrap the room&apos;s encryption epoch key to your X25519 keypair automatically.
            </p>
            <Link to="/" className="inline-block text-[var(--cloak-accent-text)] hover:underline">
              Return to Cloak Workspace
            </Link>
          </div>
        ) : inspection ? (
          <form onSubmit={handleAccept} className="space-y-4">
            <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-[var(--cloak-text-dim)]">Room</span>
                <span className="font-semibold text-[var(--cloak-text)]">{inspection.roomName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--cloak-text-dim)]">Granted Role</span>
                <span className="capitalize text-[var(--cloak-accent-text)]">{inspection.roleName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--cloak-text-dim)]">Epoch</span>
                <span className="font-mono text-[var(--cloak-text-body)]">Epoch {inspection.wrappedEpoch}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[var(--cloak-success-text)] pt-1">
                <Lock className="w-3.5 h-3.5" />
                <span>
                  {inspection.requiresApproval
                    ? 'Approval required — epoch key released after owner approval'
                    : linkSecret
                      ? 'Client decryption fragment (#k=...) present locally'
                      : 'Warning: Missing #k= fragment in URL'}
                </span>
              </div>
            </div>

            {inspection.hasPassword && (
              <div>
                <label htmlFor="invite-landing-pw" className="block text-xs font-medium text-[var(--cloak-text-body)] mb-1.5">
                  Invitation Password Required
                </label>
                <input
                  id="invite-landing-pw"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-[7px] bg-[var(--cloak-bg-input)] border border-[var(--cloak-border)] px-3 py-2 text-sm text-[var(--cloak-text)]"
                />
              </div>
            )}

            <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
              {busy ? 'Decrypting & Joining...' : 'Accept Invite & Enter Room'}
            </Button>
          </form>
        ) : !inspectError ? (
          <div className="text-xs text-[var(--cloak-text-muted)]">Inspecting invitation metadata...</div>
        ) : null}

        <div className="text-center">
          <Link to="/" className="text-xs text-[var(--cloak-text-dim)] hover:text-[var(--cloak-text)]">
            Back to Workspace
          </Link>
        </div>
      </div>
    </main>
  );
}

