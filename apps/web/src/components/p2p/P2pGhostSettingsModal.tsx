import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Lock, ShieldCheck } from 'lucide-react';
import { Button, ModalDialog } from '@cloak/ui';
import {
  p2pApi,
  type P2pGhostModeLevel,
  type P2pGhostPolicy,
  type P2pGhostRoomOverride,
  type P2pOutgoingViewedPolicy,
} from '../../lib/p2pClient.js';

interface Props {
  open: boolean;
  onClose: () => void;
  policy: P2pGhostPolicy;
  activeRoomId: string | null;
  activeRoomName: string | null;
  roomOverride: P2pGhostRoomOverride | null;
  onSaved: (policy: P2pGhostPolicy, override: P2pGhostRoomOverride | null) => void;
}

const MODE_LABELS: {
  id: P2pGhostModeLevel;
  title: string;
  desc: string;
  destructive?: boolean;
}[] = [
  {
    id: 'off',
    title: 'Off',
    desc: 'Standard encrypted persistence. Messages stay visible on focus loss.',
  },
  {
    id: 'privacy_shield',
    title: 'Privacy Shield (Safe)',
    desc: 'Masks open conversation and requires optional PIN on blur, minimize, or Windows lock. Keeps local messages.',
  },
  {
    id: 'clear_viewed',
    title: 'Clear Viewed Messages (Snapchat-style)',
    desc: 'Erases locally viewed messages when triggered while preserving unread messages and remote peer history.',
  },
  {
    id: 'clear_open_conversation',
    title: 'Clear Entire Open Conversation (Destructive)',
    desc: 'Erases ALL local messages in the active open channel on this PC when triggered. Cannot be undone locally.',
    destructive: true,
  },
];

export function P2pGhostSettingsModal({
  open,
  onClose,
  policy,
  activeRoomId,
  activeRoomName,
  roomOverride,
  onSaved,
}: Props) {
  const [draft, setDraft] = useState<P2pGhostPolicy>(policy);
  const [pinInput, setPinInput] = useState('');
  const [confirmClearInput, setConfirmClearInput] = useState(policy.destructiveConfirmed);
  const [useRoomOverride, setUseRoomOverride] = useState<boolean>(Boolean(roomOverride));
  const [overrideMode, setOverrideMode] = useState<P2pGhostModeLevel>(
    roomOverride?.mode ?? policy.mode,
  );
  const [overrideClearAtt, setOverrideClearAtt] = useState<boolean>(
    roomOverride?.clearAttachments ?? true,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setDraft(policy);
    setConfirmClearInput(policy.destructiveConfirmed);
    setPinInput('');
    setUseRoomOverride(Boolean(roomOverride));
    setOverrideMode(roomOverride?.mode ?? policy.mode);
    setOverrideClearAtt(roomOverride?.clearAttachments ?? policy.clearAttachments);
    setError(null);
  }, [open, policy, roomOverride]);

  const needsDestructiveConfirm =
    (draft.enabled && draft.mode === 'clear_open_conversation') ||
    (useRoomOverride && overrideMode === 'clear_open_conversation');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (needsDestructiveConfirm && !confirmClearInput) {
      setError('You must confirm the local destructive erasure warning to enable Clear Entire Open Conversation.');
      return;
    }

    setSaving(true);
    try {
      let hasPin = draft.hasPinConfigured;
      if (pinInput.trim().length > 0) {
        if (pinInput.trim().length < 4) {
          setError('Privacy PIN must be at least 4 characters.');
          setSaving(false);
          return;
        }
        const pinRes = await p2pApi.setGhostPin(pinInput.trim());
        hasPin = pinRes.hasPinConfigured;
      }

      const nextPolicy = await p2pApi.updateGhostPolicy({
        ...draft,
        hasPinConfigured: hasPin,
        destructiveConfirmed: confirmClearInput,
      });

      let savedOverride: P2pGhostRoomOverride | null = null;
      if (activeRoomId && (useRoomOverride || Boolean(roomOverride))) {
        savedOverride = {
          roomId: activeRoomId,
          enabled: useRoomOverride,
          mode: useRoomOverride ? overrideMode : nextPolicy.mode,
          clearAttachments: useRoomOverride ? overrideClearAtt : null,
        };
        await p2pApi.setGhostOverride(activeRoomId, savedOverride);
      }

      onSaved(nextPolicy, useRoomOverride ? savedOverride : null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Ghost Mode settings');
    } finally {
      setSaving(false);
    }
  };

  const handleClearPin = async () => {
    setError(null);
    await p2pApi.setGhostPin(null);
    setDraft((prev) => ({ ...prev, hasPinConfigured: false, requirePinUnlock: false }));
    setPinInput('');
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="Ghost Mode — Local Privacy & Ephemeral Controls"
      wide
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="ghost-settings-form" variant="primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save Ghost Policy'}
          </Button>
        </>
      }
    >
      <form id="ghost-settings-form" onSubmit={handleSave} className="space-y-4 text-xs text-[#e2e8f0]">
        <div className="rounded-xl border border-[#2a3146] bg-[#101420] p-3 flex items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="w-5 h-5 text-[#7c6cff] shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-white text-sm">Enable Ghost Mode Protection</div>
              <div className="text-[#9aa3b8] leading-snug">
                Acts strictly on this computer&apos;s local SQLite vault and window. It never clears your peer&apos;s device.
              </div>
            </div>
          </div>
          <label className="inline-flex items-center gap-2 cursor-pointer font-medium">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  enabled: e.target.checked,
                  mode: e.target.checked && prev.mode === 'off' ? 'privacy_shield' : prev.mode,
                }))
              }
            />
            <span>{draft.enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[11px] font-semibold uppercase tracking-wider text-[#9aa3b8]">
            Behavior Level
          </legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {MODE_LABELS.map((item) => {
              const selected = draft.mode === item.id;
              return (
                <label
                  key={item.id}
                  className={`rounded-xl border p-2.5 cursor-pointer flex gap-2 items-start ${
                    selected
                      ? item.destructive
                        ? 'border-[#ef4444] bg-[#ef4444]/10'
                        : 'border-[#7c6cff] bg-[#7c6cff]/10'
                      : 'border-[#262c3f] bg-[#121623] hover:border-[#37405b]'
                  }`}
                >
                  <input
                    type="radio"
                    name="ghost-mode-level"
                    value={item.id}
                    checked={selected}
                    onChange={() => {
                      setError(null);
                      setDraft((prev) => ({
                        ...prev,
                        mode: item.id,
                        enabled: item.id === 'off' ? false : true,
                      }));
                    }}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="font-semibold text-white">{item.title}</div>
                    <div className="text-[11px] text-[#9aa3b8] leading-snug">{item.desc}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </fieldset>

        {needsDestructiveConfirm && (
          <div className="rounded-xl border border-[#ef4444]/70 bg-[#ef4444]/10 p-3 space-y-2">
            <div className="flex items-center gap-2 text-[#fca5a5] font-semibold">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Explicit Destructive Local History Confirmation Required
            </div>
            <p className="text-[11px] text-[#fecaca] leading-relaxed">
              This mode wipes ALL locally stored decrypted/cached messages in the currently open channel as soon as
              you switch windows, minimize, lock Windows (Win+L), or close Cloak. Unread and viewed messages on this
              PC will both be removed and prevented from re-syncing automatically.
            </p>
            <label className="flex items-center gap-2 cursor-pointer font-medium text-white">
              <input
                type="checkbox"
                checked={confirmClearInput}
                onChange={(e) => setConfirmClearInput(e.target.checked)}
              />
              <span>I understand this deletes local conversation history on trigger</span>
            </label>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-xl border border-[#262c3f] bg-[#121623] p-3 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9aa3b8]">
              Activation Triggers
            </div>
            {(
              [
                ['onFocusLoss', 'Leaving app / switching to external window'],
                ['onMinimize', 'Minimizing desktop window'],
                ['onSessionLock', 'Windows screen lock (Win+L)'],
                ['onClose', 'Closing Cloak Desktop'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.triggers[key]}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      triggers: { ...prev.triggers, [key]: e.target.checked },
                    }))
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          <div className="rounded-xl border border-[#262c3f] bg-[#121623] p-3 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9aa3b8]">
              Privacy & Forensics Hardening
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.clearAttachments}
                onChange={(e) => setDraft((p) => ({ ...p, clearAttachments: e.target.checked }))}
              />
              <span>Purge orphaned attachment blobs after erasure</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.hideSensitiveNames}
                onChange={(e) => setDraft((p) => ({ ...p, hideSensitiveNames: e.target.checked }))}
              />
              <span>Hide room & peer names while Privacy Shield is active</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.captureProtection}
                onChange={(e) => setDraft((p) => ({ ...p, captureProtection: e.target.checked }))}
              />
              <span>Exclude window from Windows capture (SetWindowDisplayAffinity)</span>
            </label>
            <div className="pt-1 flex items-center justify-between gap-2">
              <label htmlFor="viewed-dwell-select" className="text-[#9aa3b8]">
                Viewed dwell threshold
              </label>
              <select
                id="viewed-dwell-select"
                value={draft.viewedDwellMs}
                onChange={(e) => setDraft((p) => ({ ...p, viewedDwellMs: Number(e.target.value) }))}
                className="rounded-lg bg-[#0d1017] border border-[#2a3146] px-2 py-1 text-white"
              >
                <option value={250}>250 ms (Fast)</option>
                <option value={800}>800 ms (Default)</option>
                <option value={1500}>1500 ms (Deliberate)</option>
              </select>
            </div>
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="outgoing-viewed-select" className="text-[#9aa3b8]">
                Sent messages policy
              </label>
              <select
                id="outgoing-viewed-select"
                value={draft.outgoingViewedPolicy}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    outgoingViewedPolicy: e.target.value as P2pOutgoingViewedPolicy,
                  }))
                }
                className="rounded-lg bg-[#0d1017] border border-[#2a3146] px-2 py-1 text-white"
              >
                <option value="immediate_after_dwell">Clear after viewed dwell</option>
                <option value="preserve_outgoing">Preserve my outgoing messages</option>
                <option value="immediate_on_send">Mark viewed immediately on send</option>
              </select>
            </div>
          </div>
        </div>

        {/* Argon2id Privacy PIN */}
        <div className="rounded-xl border border-[#262c3f] bg-[#121623] p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-white inline-flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-[#38bdf8]" /> Privacy Shield PIN Lock (Argon2id)
            </div>
            {draft.hasPinConfigured && (
              <button
                type="button"
                onClick={() => void handleClearPin()}
                className="text-[11px] text-[#fca5a5] hover:underline cursor-pointer"
              >
                Remove configured PIN
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.requirePinUnlock}
                onChange={(e) => setDraft((p) => ({ ...p, requirePinUnlock: e.target.checked }))}
              />
              <span>Require PIN to unlock after Privacy Shield</span>
            </label>
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              placeholder={draft.hasPinConfigured ? 'Enter new PIN to replace...' : 'Set 4+ char PIN...'}
              className="flex-1 min-w-[180px] rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-1.5 text-white"
            />
          </div>
        </div>

        {/* Per-Room Override */}
        {activeRoomId && (
          <div className="rounded-xl border border-[#262c3f] bg-[#121623] p-3 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer font-medium text-white">
              <input
                type="checkbox"
                checked={useRoomOverride}
                onChange={(e) => setUseRoomOverride(e.target.checked)}
              />
              <span>Override Ghost Mode for &ldquo;{activeRoomName ?? 'Active Room'}&rdquo;</span>
            </label>
            {useRoomOverride && (
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <select
                  aria-label="Room Ghost Mode override"
                  value={overrideMode}
                  onChange={(e) => setOverrideMode(e.target.value as P2pGhostModeLevel)}
                  className="rounded-lg bg-[#0d1017] border border-[#2a3146] px-2.5 py-1 text-white"
                >
                  <option value="off">Off</option>
                  <option value="privacy_shield">Privacy Shield</option>
                  <option value="clear_viewed">Clear Viewed</option>
                  <option value="clear_open_conversation">Clear Open Conversation</option>
                </select>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={overrideClearAtt}
                    onChange={(e) => setOverrideClearAtt(e.target.checked)}
                  />
                  <span>Purge cached attachments</span>
                </label>
              </div>
            )}
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-lg border border-[#ef4444]/60 bg-[#ef4444]/10 p-2 text-[#fca5a5]">
            {error}
          </div>
        )}
      </form>
    </ModalDialog>
  );
}

