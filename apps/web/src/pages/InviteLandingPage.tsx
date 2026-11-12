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
        <div className="bg-[#7c6cff]/15 border-b border-[#7c6cff]/30 px-4 py-2 text-center text-xs text-[#c4b5fd]">
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
    <main className="min-h-screen bg-[#0c0e14] text-[#f1f3f9] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-[#262c3f] bg-[#141722] p-6 shadow-2xl space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-[#7c6cff]/20 border border-[#7c6cff]/40 flex items-center justify-center text-[#a5b4fc]">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Private Room Invitation</h1>
            <p className="text-xs text-[#9aa3b8]">End-to-end encrypted access via URL fragment secret</p>
          </div>
        </div>

        {inspectError && (
          <div role="alert" className="rounded-lg border border-[#ef4444]/50 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#fca5a5]">
            {inspectError}
          </div>
        )}

        {pendingApproval ? (
          <div className="rounded-xl border border-[#f59e0b]/40 bg-[#f59e0b]/10 p-4 text-xs text-[#fde68a] space-y-3">
            <div className="font-semibold text-sm">Awaiting Owner Approval</div>
            <p>
              Your device joined the room&apos;s approval queue. Once the owner approves your device,
              they will wrap the room&apos;s encryption epoch key to your X25519 keypair automatically.
            </p>
            <Link to="/" className="inline-block text-[#a5b4fc] hover:underline">
              Return to Cloak Workspace
            </Link>
          </div>
        ) : inspection ? (
          <form onSubmit={handleAccept} className="space-y-4">
            <div className="rounded-xl border border-[#262c3f] bg-[#10131d] p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-[#8d96ad]">Room</span>
                <span className="font-semibold text-white">{inspection.roomName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8d96ad]">Granted Role</span>
                <span className="capitalize text-[#c4b5fd]">{inspection.roleName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8d96ad]">Epoch</span>
                <span className="font-mono text-[#e2e8f0]">Epoch {inspection.wrappedEpoch}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[#34d399] pt-1">
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
                <label htmlFor="invite-landing-pw" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
                  Invitation Password Required
                </label>
                <input
                  id="invite-landing-pw"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
                />
              </div>
            )}

            <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
              {busy ? 'Decrypting & Joining...' : 'Accept Invite & Enter Room'}
            </Button>
          </form>
        ) : !inspectError ? (
          <div className="text-xs text-[#9aa3b8]">Inspecting invitation metadata...</div>
        ) : null}

        <div className="text-center">
          <Link to="/" className="text-xs text-[#8d96ad] hover:text-white">
            Back to Workspace
          </Link>
        </div>
      </div>
    </main>
  );
}

