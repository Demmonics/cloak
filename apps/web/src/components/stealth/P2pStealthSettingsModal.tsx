import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Eye,
  KeyRound,
  Layers,
  Lock,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button, ModalDialog } from '@cloak/ui';
import {
  p2pApi,
  type ActiveSurface,
  type CameraAction,
  type LocalDeletionAction,
  type LockAction,
  type NotificationPrivacyLevel,
  type P2pGhostModeLevel,
  type P2pGhostPolicy,
  type P2pGhostRoomOverride,
  type P2pOutgoingViewedPolicy,
  type P2pPdfDocument,
  type P2pRoom,
  type P2pSecretCodeMeta,
  type P2pStealthBootstrapState,
  type P2pStealthConfig,
  type P2pStealthTestPreviewResult,
  type PrivacyRule,
  type PrivacyTriggerKind,
  type ScreenShareAction,
  type SecretCodeAction,
  type StealthPdfReturnBehavior,
  type StealthVisualAction,
  type UnlockMethod,
  type VoiceCallAction,
} from '../../lib/p2pClient.js';

type StealthTab = 'appearance' | 'unlock' | 'triggers' | 'actions' | 'ghost' | 'advanced';

interface P2pStealthSettingsModalProps {
  open: boolean;
  onClose: () => void;
  bootstrap: P2pStealthBootstrapState | null;
  stealthConfig: P2pStealthConfig;
  ghostPolicy: P2pGhostPolicy;
  rooms: P2pRoom[];
  activeRoomId: string | null;
  overrides: P2pGhostRoomOverride[];
  pdfDocs: P2pPdfDocument[];
  onSaved: (cfg: P2pStealthConfig, ghost: P2pGhostPolicy) => Promise<void> | void;
  onLockNow: () => void;
}

const AWAY_PRESETS: Array<[number, string]> = [
  [0, 'Immediately (0s)'],
  [5, '5 seconds'],
  [15, '15 seconds'],
  [30, '30 seconds'],
  [60, '60 seconds'],
  [120, '2 minutes'],
  [300, '5 minutes'],
  [600, '10 minutes'],
  [900, '15 minutes'],
  [1800, '30 minutes'],
  [3600, '1 hour'],
];

const FG_PRESETS: Array<[number, string]> = [
  [30, '30 seconds'],
  [60, '60 seconds'],
  [120, '2 minutes'],
  [300, '5 minutes'],
  [600, '10 minutes'],
  [900, '15 minutes'],
];

export function P2pStealthSettingsModal({
  open,
  onClose,
  bootstrap,
  stealthConfig,
  ghostPolicy,
  rooms,
  activeRoomId,
  overrides,
  pdfDocs,
  onSaved,
  onLockNow,
}: P2pStealthSettingsModalProps) {
  const [tab, setTab] = useState<StealthTab>('appearance');
  const [cfg, setCfg] = useState<P2pStealthConfig>(stealthConfig);
  const [ghost, setGhost] = useState<P2pGhostPolicy>(ghostPolicy);
  const [codes, setCodes] = useState<P2pSecretCodeMeta[]>([]);
  const [newCodeLabel, setNewCodeLabel] = useState('');
  const [newCodeValue, setNewCodeValue] = useState('');
  const [newCodeAction, setNewCodeAction] = useState<SecretCodeAction>('open_messenger');
  const [newCodeRoomId, setNewCodeRoomId] = useState<string>('');
  const [newCodeCaseSensitive, setNewCodeCaseSensitive] = useState(true);
  const [newCodeAdditionalAuth, setNewCodeAdditionalAuth] = useState(false);

  const [passphraseInput, setPassphraseInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [recoveryKeyShown, setRecoveryKeyShown] = useState<string | null>(null);

  // Room ghost override state
  const currentOverride = overrides.find((o) => o.roomId === activeRoomId);
  const [ovEnabled, setOvEnabled] = useState(false);
  const [ovMode, setOvMode] = useState<P2pGhostModeLevel>('privacy_shield');

  // Test mode sandbox state
  const [testTrigger, setTestTrigger] = useState<PrivacyTriggerKind>('alt_tab');
  const [testTotal, setTestTotal] = useState(5);
  const [testViewed, setTestViewed] = useState(3);
  const [testDeletion, setTestDeletion] = useState<LocalDeletionAction>('keep_all');
  const [testResult, setTestResult] = useState<P2pStealthTestPreviewResult | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setCfg(stealthConfig);
    setGhost(ghostPolicy);
    setOvEnabled(Boolean(currentOverride?.enabled));
    setOvMode(currentOverride?.mode ?? 'privacy_shield');
    setError(null);
    setInfo(null);
    setRecoveryKeyShown(null);
    setTestResult(null);
    void p2pApi
      .listSecretCodes()
      .then(setCodes)
      .catch(() => setCodes([]));
  }, [open, stealthConfig, ghostPolicy, currentOverride]);

  const toggleMethod = (m: UnlockMethod) => {
    setCfg((prev) => {
      const has = prev.unlock.enabledMethods.includes(m);
      const next = has
        ? prev.unlock.enabledMethods.filter((x) => x !== m)
        : [...prev.unlock.enabledMethods, m];
      return { ...prev, unlock: { ...prev.unlock, enabledMethods: next } };
    });
  };

  const handleAddSecretCode = async () => {
    setError(null);
    setInfo(null);
    if (!newCodeValue) {
      setError('Enter a secret code value before adding.');
      return;
    }
    try {
      const created = await p2pApi.createSecretCode({
        label: newCodeLabel || 'Secret Access Code',
        code: newCodeValue,
        action: newCodeAction,
        targetRoomId: newCodeAction === 'open_conversation' && newCodeRoomId ? newCodeRoomId : null,
        caseSensitive: newCodeCaseSensitive,
        requireAdditionalAuth: newCodeAdditionalAuth,
      });
      setNewCodeValue('');
      setNewCodeLabel('');
      setCodes((prev) => [...prev, created]);
      setInfo(
        created.isWeak
          ? `Added "${created.label}" — warning: short codes are weak and should not be your sole protection.`
          : `Secret code "${created.label}" saved securely with salted Argon2id verifier.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create secret code');
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (ghost.mode === 'clear_open_conversation' && !ghost.destructiveConfirmed) {
      setError('Check explicit destructive confirmation before enabling Full Open Conversation wipe.');
      return;
    }
    setSaving(true);
    try {
      if (passphraseInput.trim()) {
        await p2pApi.setStealthPassphrase(passphraseInput.trim());
        setPassphraseInput('');
      }
      if (pinInput.trim()) {
        await p2pApi.setGhostPin(pinInput.trim());
        setPinInput('');
      }
      const savedStealth = await p2pApi.updateStealthSettings(cfg);
      const savedGhost = await p2pApi.updateGhostPolicy(ghost);
      if (activeRoomId && (ovEnabled || currentOverride !== undefined)) {
        await p2pApi.setGhostOverride(activeRoomId, {
          roomId: activeRoomId,
          enabled: ovEnabled,
          mode: ovMode,
          clearAttachments: null,
        });
      }
      await onSaved(savedStealth, savedGhost);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Stealth settings');
    } finally {
      setSaving(false);
    }
  };

  const handleRunTestPreview = async () => {
    setError(null);
    try {
      // Save rule evaluation inputs cleanly in disposable preview request
      const res = await p2pApi.runStealthTestPreview({
        trigger: testTrigger,
        disposableTotal: testTotal,
        disposableViewed: testViewed,
        deletionOverride: testDeletion,
      });
      setTestResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test preview failed');
    }
  };

  const addRule = () => {
    const id = `rule-${Date.now()}`;
    const newRule: PrivacyRule = {
      id,
      name: 'Custom Privacy Rule',
      enabled: true,
      trigger: 'alt_tab',
      delaySeconds: 0,
      cancelOnReturn: false,
      preserveAbsoluteDeadline: false,
      visualAction: 'switch_to_pdf',
      lockAction: 'require_unlock',
      deletionAction: 'keep_all',
      attachmentAction: 'keep',
      notificationAction: 'disabled',
      voiceAction: null,
      cameraAction: null,
      screenShareAction: null,
      scopeRoomId: null,
      priority: 50,
    };
    setCfg((p) => ({ ...p, rules: [...p.rules, newRule] }));
  };

  const codeWeakPreview =
    newCodeValue.length > 0 &&
    (newCodeValue.trim().length < 8 || newCodeValue.trim().replace(/^#+|#+$/g, '').length < 6);

  const selectCls =
    'w-full rounded-[7px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-input)] px-2.5 py-1.5 text-xs text-[var(--cloak-text)] placeholder:text-[var(--cloak-text-dim)]';

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="Privacy, Stealth Mode & Ghost Automation"
      wide
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onClose();
              onLockNow();
            }}
          >
            Lock & Shield Now
          </Button>
          <Button type="submit" variant="primary" form="stealth-settings-form" disabled={saving}>
            {saving ? 'Saving...' : 'Save Privacy & Stealth Settings'}
          </Button>
        </>
      }
    >
      <form id="stealth-settings-form" onSubmit={handleSave} className="space-y-4 text-[var(--cloak-text-body)]">
        {/* Top Master Banner */}
        <label className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] px-3.5 py-2.5 text-xs cursor-pointer">
          <div>
            <div className="font-semibold text-[var(--cloak-text)]">Enable Stealth & Cover System</div>
            <div className="text-[11px] text-[var(--cloak-text-muted)]">
              Controls launch view, PDF decoy switching, unlock passcodes, timers, and independent
              rules. Visual concealment stays separate from local message deletion unless enabled.
            </div>
          </div>
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => setCfg((p) => ({ ...p, enabled: e.target.checked }))}
          />
        </label>

        {/* Tab Strip */}
        <div className="flex flex-wrap gap-1 border-b border-[var(--cloak-border)] pb-2 text-xs">
          {(
            [
              ['appearance', 'Appearance', Eye],
              ['unlock', 'Unlock & Codes', KeyRound],
              ['triggers', 'Triggers & Timers', Zap],
              ['actions', 'Actions, Calls & Notices', Layers],
              ['ghost', 'Ghost Mode', ShieldAlert],
              ['advanced', 'Rules & Test Mode', Sliders],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 rounded-[7px] flex items-center gap-1.5 cursor-pointer transition-colors ${
                tab === id
                  ? 'bg-[var(--cloak-accent)] text-[var(--cloak-accent-ink)] font-semibold'
                  : 'text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* TAB 1: APPEARANCE */}
        {tab === 'appearance' && (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-[var(--cloak-text-body)] font-medium">Default Launch Interface</span>
                <select
                  aria-label="Default Launch Interface"
                  value={cfg.launchView}
                  onChange={(e) =>
                    setCfg((p) => ({
                      ...p,
                      launchView: e.target.value as 'messenger' | 'pdf_reader',
                    }))
                  }
                  className={selectCls}
                >
                  <option value="messenger">Cloak Private Messenger</option>
                  <option value="pdf_reader">Real PDF Document Reader (Stealth Launch)</option>
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-[var(--cloak-text-body)] font-medium">PDF Return Behavior</span>
                <select
                  aria-label="PDF Return Behavior"
                  value={cfg.pdfReader.returnBehavior}
                  onChange={(e) =>
                    setCfg((p) => ({
                      ...p,
                      pdfReader: {
                        ...p.pdfReader,
                        returnBehavior: e.target.value as StealthPdfReturnBehavior,
                      },
                    }))
                  }
                  className={selectCls}
                >
                  <option value="last_opened">Restore last opened PDF</option>
                  <option value="document_library">Show generic PDF document library</option>
                  <option value="configured_default">Show selected default decoy PDF</option>
                  <option value="neutral_welcome">Show empty PDF-reader welcome screen</option>
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-[var(--cloak-text-body)] font-medium">Selected Decoy PDF</span>
                <select
                  aria-label="Selected Decoy PDF"
                  value={cfg.pdfReader.defaultDocumentId ?? ''}
                  onChange={(e) =>
                    setCfg((p) => ({
                      ...p,
                      pdfReader: { ...p.pdfReader, defaultDocumentId: e.target.value || null },
                    }))
                  }
                  className={selectCls}
                >
                  <option value="">None (use return behavior)</option>
                  {pdfDocs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title} ({d.pageCount}p)
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-[var(--cloak-text-body)] font-medium">PDF Reader Theme</span>
                <select
                  aria-label="PDF Reader Theme"
                  value={cfg.pdfReader.theme}
                  onChange={(e) =>
                    setCfg((p) => ({
                      ...p,
                      pdfReader: { ...p.pdfReader, theme: e.target.value as 'light' | 'dark' },
                    }))
                  }
                  className={selectCls}
                >
                  <option value="light">Light Productivity Reader</option>
                  <option value="dark">Dark Slate Reader</option>
                </select>
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-[var(--cloak-text-body)] font-medium">
                Neutral Window Title While Concealed
              </span>
              <input
                type="text"
                value={cfg.pdfReader.neutralWindowTitle}
                onChange={(e) =>
                  setCfg((p) => ({
                    ...p,
                    pdfReader: { ...p.pdfReader, neutralWindowTitle: e.target.value },
                  }))
                }
                className={selectCls}
              />
            </label>
          </div>
        )}

        {/* TAB 2: UNLOCK & SECRET CODES */}
        {tab === 'unlock' && (
          <div className="space-y-4 text-xs">
            <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2">
              <div className="font-semibold text-[var(--cloak-text)]">Authorized Unlock Pathways</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {(
                  [
                    ['pdf_search', 'Secret code entered into PDF search field (Enter)'],
                    ['hidden_shortcut_input', `Hidden overlay (${cfg.unlock.hiddenShortcut})`],
                    ['discreet_command', 'Discreet command prompt'],
                    ['passphrase', 'Standard passphrase unlock'],
                    ['pin', 'PIN unlock (rate-limited)'],
                    ['windows_hello', `Windows Hello (${bootstrap?.windowsHelloStatus ?? 'Check OS'})`],
                  ] as const
                ).map(([m, label]) => (
                  <label key={m} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={cfg.unlock.enabledMethods.includes(m)}
                      onChange={() => toggleMethod(m)}
                    />
                    <span className="text-[var(--cloak-text-body)]">{label}</span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-4 pt-1 border-t border-[var(--cloak-border)]">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cfg.unlock.caseSensitive}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        unlock: { ...p.unlock, caseSensitive: e.target.checked },
                      }))
                    }
                  />
                  Case-sensitive matching
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cfg.unlock.requireAdditionalAuth}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        unlock: { ...p.unlock, requireAdditionalAuth: e.target.checked },
                      }))
                    }
                  />
                  Require additional passphrase/PIN after secret code
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cfg.unlock.lockOnRestart}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        unlock: { ...p.unlock, lockOnRestart: e.target.checked },
                      }))
                    }
                  />
                  Always restore locked state on restart
                </label>
              </div>
            </div>

            {/* Add Secret Code */}
            <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2.5">
              <div className="font-semibold text-[var(--cloak-text)]">Create Secret Unlock Code</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  value={newCodeLabel}
                  onChange={(e) => setNewCodeLabel(e.target.value)}
                  placeholder="Label (e.g. Primary Access)"
                  className={selectCls}
                />
                <input
                  type="password"
                  value={newCodeValue}
                  onChange={(e) => setNewCodeValue(e.target.value)}
                  placeholder="Secret code or phrase (hashed with Argon2id)"
                  autoComplete="off"
                  className={selectCls}
                />
                <select
                  aria-label="Secret Code Action"
                  value={newCodeAction}
                  onChange={(e) => setNewCodeAction(e.target.value as SecretCodeAction)}
                  className={selectCls}
                >
                  <option value="open_messenger">Open Private Messenger</option>
                  <option value="open_conversation">Open Specific Conversation</option>
                  <option value="open_privacy_settings">Open Privacy Settings</option>
                  <option value="return_to_pdf">Return to PDF Reader</option>
                  <option value="panic_lock">Activate Panic Lock</option>
                </select>
                {newCodeAction === 'open_conversation' && (
                  <select
                    aria-label="Target Room"
                    value={newCodeRoomId}
                    onChange={(e) => setNewCodeRoomId(e.target.value)}
                    className={selectCls}
                  >
                    <option value="">Select conversation...</option>
                    {rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {codeWeakPreview && (
                <div className="flex items-center gap-1.5 text-[var(--cloak-warn-text)] text-[11px]">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  Weak code: short codes or 4-digit tags should not be your sole protection.
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-3">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={newCodeCaseSensitive}
                      onChange={(e) => setNewCodeCaseSensitive(e.target.checked)}
                    />
                    Case-sensitive
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={newCodeAdditionalAuth}
                      onChange={(e) => setNewCodeAdditionalAuth(e.target.checked)}
                    />
                    Require 2nd factor
                  </label>
                </div>
                <Button type="button" size="sm" onClick={() => void handleAddSecretCode()}>
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add Secret Code
                </Button>
              </div>

              {/* Existing Secret Codes List (labels + actions only — hashes/plaintext never sent to UI!) */}
              <div className="space-y-1 pt-2 border-t border-[var(--cloak-border)]">
                {codes.length === 0 && (
                  <div className="text-[var(--cloak-text-muted)]">No secret codes configured yet.</div>
                )}
                {codes.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded-[7px] bg-[var(--cloak-bg-surface)] px-2.5 py-1.5 border border-[var(--cloak-border)]"
                  >
                    <div>
                      <span className="font-medium text-[var(--cloak-text)]">{c.label}</span>
                      <span className="ml-2 text-[var(--cloak-text-muted)]">({c.action})</span>
                      {c.isWeak && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-[var(--cloak-warn-soft)] text-[var(--cloak-warn-text)] border border-[var(--cloak-warn-border)]">
                          Weak
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${c.label}`}
                      onClick={() => {
                        void p2pApi.deleteSecretCode(c.id).then(() => {
                          setCodes((prev) => prev.filter((x) => x.id !== c.id));
                        });
                      }}
                      className="text-[var(--cloak-danger-text)] hover:opacity-80 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Passphrase, PIN & Recovery */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2">
                <div className="font-semibold text-[var(--cloak-text)]">Standard Passphrase & PIN</div>
                <input
                  type="password"
                  value={passphraseInput}
                  onChange={(e) => setPassphraseInput(e.target.value)}
                  placeholder="Set/update passphrase (on Save)"
                  className={selectCls}
                />
                <input
                  type="password"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  placeholder="Set/update 4-64 char PIN (on Save)"
                  className={selectCls}
                />
              </div>

              <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2">
                <div className="font-semibold text-[var(--cloak-text)]">Recovery Key</div>
                <p className="text-[11px] text-[var(--cloak-text-muted)]">
                  Generates an offline Argon2id-hashed recovery key in case passcodes are forgotten.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void p2pApi.generateRecoveryCode().then((r) => setRecoveryKeyShown(r.recoveryCode));
                  }}
                >
                  Generate Recovery Key
                </Button>
                {recoveryKeyShown && (
                  <div className="font-mono text-[11px] p-2 rounded-[7px] bg-[var(--cloak-success-soft)] border border-[var(--cloak-success-border)] text-[var(--cloak-success-text)] select-all">
                    {recoveryKeyShown}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: TRIGGERS & TIMERS */}
        {tab === 'triggers' && (
          <div className="space-y-3 text-xs">
            <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2">
              <div className="font-semibold text-[var(--cloak-text)]">Window & OS Lifecycle Triggers</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {(
                  [
                    ['triggerOnFocusLoss', 'Focus Loss'],
                    ['triggerOnAltTab', 'Alt+Tab Away'],
                    ['triggerOnClickOtherApp', 'Click Another App'],
                    ['triggerOnMinimize', 'Minimize Window'],
                    ['triggerOnShowDesktop', 'Show Desktop'],
                    ['triggerOnVirtualDesktop', 'Virtual Desktop Switch'],
                    ['triggerOnSessionLock', 'Windows Lock (Win+L)'],
                    ['triggerOnWindowClose', 'Window Close Request'],
                    ['triggerOnRestart', 'Application Restart'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={cfg[key]}
                      onChange={(e) => setCfg((p) => ({ ...p, [key]: e.target.checked }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {/* Background-Away Timer */}
            <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2.5">
              <label className="flex items-center justify-between font-semibold text-[var(--cloak-text)]">
                <span>Background-Away Timer (Does NOT reset while using other apps)</span>
                <input
                  type="checkbox"
                  checked={cfg.timers.backgroundAwayEnabled}
                  onChange={(e) =>
                    setCfg((p) => ({
                      ...p,
                      timers: { ...p.timers, backgroundAwayEnabled: e.target.checked },
                    }))
                  }
                />
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <label className="block space-y-1">
                  <span className="text-[var(--cloak-text-muted)]">Away Preset</span>
                  <select
                    aria-label="Background Away Preset"
                    value={cfg.timers.backgroundAwaySeconds}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        timers: { ...p.timers, backgroundAwaySeconds: Number(e.target.value) },
                      }))
                    }
                    className={selectCls}
                  >
                    {AWAY_PRESETS.map(([sec, lbl]) => (
                      <option key={sec} value={sec}>
                        {lbl}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-[var(--cloak-text-muted)]">Custom Duration (sec)</span>
                  <input
                    type="number"
                    min={1}
                    max={86400}
                    value={cfg.timers.backgroundAwaySeconds}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        timers: {
                          ...p.timers,
                          backgroundAwaySeconds: Math.max(1, Number(e.target.value) || 30),
                        },
                      }))
                    }
                    className={selectCls}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[var(--cloak-text-muted)]">Action After Away Expiry</span>
                  <select
                    aria-label="Background Away Deletion"
                    value={cfg.timers.backgroundAwayDeletion}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        timers: {
                          ...p.timers,
                          backgroundAwayDeletion: e.target.value as LocalDeletionAction,
                        },
                      }))
                    }
                    className={selectCls}
                  >
                    <option value="keep_all">Keep all messages (PDF cover only)</option>
                    <option value="delete_viewed_local">Delete viewed messages locally</option>
                    <option value="delete_incoming_viewed_local">Delete viewed received messages</option>
                    <option value="delete_outgoing_viewed_local">Delete viewed sent messages</option>
                    <option value="delete_active_conversation">Delete open conversation locally</option>
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cfg.timers.backgroundAwayCancelOnReturn}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        timers: {
                          ...p.timers,
                          backgroundAwayCancelOnReturn: e.target.checked,
                          backgroundAwayPreserveDeadline: e.target.checked
                            ? false
                            : p.timers.backgroundAwayPreserveDeadline,
                        },
                      }))
                    }
                  />
                  Cancel pending timer if returned before expiry
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cfg.timers.backgroundAwayPreserveDeadline}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        timers: {
                          ...p.timers,
                          backgroundAwayPreserveDeadline: e.target.checked,
                          backgroundAwayCancelOnReturn: e.target.checked
                            ? false
                            : p.timers.backgroundAwayCancelOnReturn,
                        },
                      }))
                    }
                  />
                  Preserve original absolute deadline across brief returns
                </label>
              </div>
            </div>

            {/* Foreground Idle & Windows System Idle */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2">
                <label className="flex items-center justify-between font-semibold text-[var(--cloak-text)]">
                  <span>Foreground App Inactivity</span>
                  <input
                    type="checkbox"
                    checked={cfg.timers.foregroundIdleEnabled}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        timers: { ...p.timers, foregroundIdleEnabled: e.target.checked },
                      }))
                    }
                  />
                </label>
                <select
                  aria-label="Foreground Inactivity Duration"
                  value={cfg.timers.foregroundIdleSeconds}
                  onChange={(e) =>
                    setCfg((p) => ({
                      ...p,
                      timers: { ...p.timers, foregroundIdleSeconds: Number(e.target.value) },
                    }))
                  }
                  className={selectCls}
                >
                  {FG_PRESETS.map(([sec, lbl]) => (
                    <option key={sec} value={sec}>
                      {lbl}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-[var(--cloak-text-muted)]">
                  Only direct interactions in the messenger window reset this timer (passive
                  messages/video do not).
                </p>
              </div>

              <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2">
                <label className="flex items-center justify-between font-semibold text-[var(--cloak-text)]">
                  <span>Windows OS Idle (GetLastInputInfo)</span>
                  <input
                    type="checkbox"
                    checked={cfg.timers.systemIdleEnabled}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        timers: { ...p.timers, systemIdleEnabled: e.target.checked },
                      }))
                    }
                  />
                </label>
                <input
                  type="number"
                  min={5}
                  max={86400}
                  value={cfg.timers.systemIdleSeconds}
                  onChange={(e) =>
                    setCfg((p) => ({
                      ...p,
                      timers: {
                        ...p.timers,
                        systemIdleSeconds: Math.max(5, Number(e.target.value) || 600),
                      },
                    }))
                  }
                  className={selectCls}
                />
                <p className="text-[11px] text-[var(--cloak-text-muted)]">
                  Tracks whole-session Windows idle cleanly without global keystroke hooks.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: ACTIONS, CALLS & NOTIFICATIONS */}
        {tab === 'actions' && (
          <div className="space-y-3 text-xs">
            <label className="block space-y-1">
              <span className="text-[var(--cloak-text-body)] font-medium">Visual Stealth Action</span>
              <select
                aria-label="Visual Stealth Action"
                value={cfg.stealthVisualAction}
                onChange={(e) =>
                  setCfg((p) => ({
                    ...p,
                    stealthVisualAction: e.target.value as StealthVisualAction,
                  }))
                }
                className={selectCls}
              >
                <option value="switch_to_pdf">Switch to PDF Reader</option>
                <option value="switch_to_selected_pdf">Switch to Selected Decoy PDF</option>
                <option value="generic_document_list">Show Generic Document List</option>
                <option value="privacy_shield">Show Neutral Privacy Shield</option>
                <option value="blur">Blur Conversations</option>
                <option value="lock_screen">Show Lock Screen</option>
                <option value="none">No Visual Change</option>
              </select>
            </label>

            <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2">
              <div className="font-semibold text-[var(--cloak-text)]">Active Call & Screen-Share Privacy</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <label className="block space-y-1">
                  <span className="text-[var(--cloak-text-muted)]">Voice Call</span>
                  <select
                    value={cfg.calls.voiceAction}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        calls: { ...p.calls, voiceAction: e.target.value as VoiceCallAction },
                      }))
                    }
                    className={selectCls}
                  >
                    <option value="continue">Continue voice call</option>
                    <option value="auto_mute">Automatically mute mic</option>
                    <option value="end_call">End call</option>
                    <option value="ask_before_ending">Ask before ending</option>
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-[var(--cloak-text-muted)]">Camera</span>
                  <select
                    value={cfg.calls.cameraAction}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        calls: { ...p.calls, cameraAction: e.target.value as CameraAction },
                      }))
                    }
                    className={selectCls}
                  >
                    <option value="disable_camera">Disable camera</option>
                    <option value="end_video_stream">End video stream</option>
                    <option value="continue">Continue where authorized</option>
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-[var(--cloak-text-muted)]">Screen Sharing</span>
                  <select
                    value={cfg.calls.screenShareAction}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        calls: {
                          ...p.calls,
                          screenShareAction: e.target.value as ScreenShareAction,
                        },
                      }))
                    }
                    className={selectCls}
                  >
                    <option value="stop_immediately">Stop sharing immediately</option>
                    <option value="pause">Pause share</option>
                    <option value="continue">Continue approved share</option>
                    <option value="ask_if_visible">Ask if interaction available</option>
                  </select>
                </label>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={cfg.calls.showCallIndicatorInPdf}
                  onChange={(e) =>
                    setCfg((p) => ({
                      ...p,
                      calls: { ...p.calls, showCallIndicatorInPdf: e.target.checked },
                    }))
                  }
                />
                Show generic audio-active status pill in PDF reader status bar (no peer names)
              </label>
            </div>

            <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2">
              <div className="font-semibold text-[var(--cloak-text)]">Notification Content Privacy</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(
                  [
                    ['unlockedLevel', 'Unlocked Messenger'],
                    ['pdfModeLevel', 'PDF Mode Active'],
                    ['windowsLockedLevel', 'Windows Locked'],
                    ['minimizedLevel', 'App Minimized'],
                    ['screenSharingLevel', 'Screen Sharing Active'],
                    ['dndLevel', 'Do Not Disturb'],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field} className="block space-y-1">
                    <span className="text-[var(--cloak-text-muted)]">{label}</span>
                    <select
                      value={cfg.notifications[field]}
                      onChange={(e) =>
                        setCfg((p) => ({
                          ...p,
                          notifications: {
                            ...p.notifications,
                            [field]: e.target.value as NotificationPrivacyLevel,
                          },
                        }))
                      }
                      className={selectCls}
                    >
                      <option value="full_preview">Full preview</option>
                      <option value="sender_only">Sender name only</option>
                      <option value="generic_notice">Generic incoming notice</option>
                      <option value="silent">Silent notification</option>
                      <option value="disabled">No notification</option>
                    </select>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-3 pt-1">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cfg.notifications.suppressTaskbarBadge}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        notifications: { ...p.notifications, suppressTaskbarBadge: e.target.checked },
                      }))
                    }
                  />
                  Suppress taskbar unread badges
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cfg.notifications.suppressTrayPreview}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        notifications: { ...p.notifications, suppressTrayPreview: e.target.checked },
                      }))
                    }
                  />
                  Hide tray tooltips
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cfg.notifications.hideContactNames}
                    onChange={(e) =>
                      setCfg((p) => ({
                        ...p,
                        notifications: { ...p.notifications, hideContactNames: e.target.checked },
                      }))
                    }
                  />
                  Hide contact names when locked
                </label>
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: GHOST MODE (Independent Local Message Deletion) */}
        {tab === 'ghost' && (
          <div className="space-y-3 text-xs">
            <label className="flex items-center justify-between rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3">
              <div>
                <div className="font-semibold text-[var(--cloak-text)]">Enable Ghost Mode Local Retention Engine</div>
                <div className="text-[11px] text-[var(--cloak-text-muted)]">
                  Controls local SQLite & attachment erasure independently of Stealth UI cover.
                </div>
              </div>
              <input
                type="checkbox"
                checked={ghost.enabled}
                onChange={(e) =>
                  setGhost((p) => ({
                    ...p,
                    enabled: e.target.checked,
                    mode: e.target.checked && p.mode === 'off' ? 'privacy_shield' : p.mode,
                  }))
                }
              />
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(
                [
                  ['off', 'Keep Everything', 'No local Ghost clearing or masking'],
                  ['privacy_shield', 'Privacy Shield (Keep Messages)', 'Masks UI without deleting local DB'],
                  ['clear_viewed', 'Delete Viewed Messages', 'Erases viewed local messages; preserves unread & peer copy'],
                  ['clear_open_conversation', 'Delete Active Conversation', 'Requires destructive confirmation below'],
                ] as const
              ).map(([m, title, desc]) => (
                <label
                  key={m}
                  className={`p-2.5 rounded-[8px] border cursor-pointer flex gap-2 transition-colors ${
                    ghost.mode === m
                      ? 'border-[var(--cloak-accent-border)] bg-[var(--cloak-accent-soft)]'
                      : 'border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] hover:border-[var(--cloak-border-strong)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="ghost-mode-tier"
                    checked={ghost.mode === m}
                    onChange={() => setGhost((p) => ({ ...p, mode: m }))}
                  />
                  <div>
                    <div className="font-semibold text-[var(--cloak-text)]">{title}</div>
                    <div className="text-[11px] text-[var(--cloak-text-muted)]">{desc}</div>
                  </div>
                </label>
              ))}
            </div>

            {ghost.mode === 'clear_open_conversation' && (
              <label className="flex items-start gap-2 rounded-[8px] border border-[var(--cloak-danger-border)] bg-[var(--cloak-danger-soft)] p-3 text-[var(--cloak-danger-text)]">
                <input
                  type="checkbox"
                  checked={ghost.destructiveConfirmed}
                  onChange={(e) =>
                    setGhost((p) => ({ ...p, destructiveConfirmed: e.target.checked }))
                  }
                />
                <span>
                  I confirm Ghost Mode should permanently wipe local messages in the active room on
                  this PC (remote peer history is preserved).
                </span>
              </label>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3">
              <label className="block space-y-1">
                <span className="text-[var(--cloak-text-muted)]">Outgoing Message Viewed Rule</span>
                <select
                  value={ghost.outgoingViewedPolicy}
                  onChange={(e) =>
                    setGhost((p) => ({
                      ...p,
                      outgoingViewedPolicy: e.target.value as P2pOutgoingViewedPolicy,
                    }))
                  }
                  className={selectCls}
                >
                  <option value="immediate_after_dwell">Delete outgoing once viewed</option>
                  <option value="preserve_outgoing">Preserve my outgoing messages</option>
                  <option value="immediate_on_send">Mark outgoing viewed immediately</option>
                </select>
              </label>
              <div className="space-y-1.5 pt-1">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ghost.clearAttachments}
                    onChange={(e) => setGhost((p) => ({ ...p, clearAttachments: e.target.checked }))}
                  />
                  Purge matching attachment blobs
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ghost.captureProtection}
                    onChange={(e) =>
                      setGhost((p) => ({ ...p, captureProtection: e.target.checked }))
                    }
                  />
                  Enable Win32 SetWindowDisplayAffinity capture protection
                </label>
              </div>
            </div>

            {activeRoomId && (
              <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2">
                <label className="flex items-center justify-between font-semibold text-[var(--cloak-text)]">
                  <span>Per-Conversation Override (Active Room)</span>
                  <input
                    type="checkbox"
                    checked={ovEnabled}
                    onChange={(e) => setOvEnabled(e.target.checked)}
                  />
                </label>
                {ovEnabled && (
                  <select
                    value={ovMode}
                    onChange={(e) => setOvMode(e.target.value as P2pGhostModeLevel)}
                    className={selectCls}
                  >
                    <option value="privacy_shield">Privacy Shield only</option>
                    <option value="clear_viewed">Clear viewed in this room</option>
                    <option value="clear_open_conversation">Wipe this room</option>
                  </select>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 6: ADVANCED RULES ENGINE & SAFE TEST MODE */}
        {tab === 'advanced' && (
          <div className="space-y-4 text-xs">
            <div className="rounded-[10px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[var(--cloak-text)]">
                  WHEN [Trigger] OCCURS → PERFORM [Actions] ({cfg.rules.length})
                </span>
                <Button type="button" size="sm" variant="secondary" onClick={addRule}>
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add Rule
                </Button>
              </div>
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {cfg.rules.map((rule, idx) => (
                  <div
                    key={rule.id}
                    className="rounded-[8px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-surface)] p-2.5 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) =>
                          setCfg((p) => ({
                            ...p,
                            rules: p.rules.map((r, i) =>
                              i === idx ? { ...r, enabled: e.target.checked } : r,
                            ),
                          }))
                        }
                      />
                      <input
                        type="text"
                        value={rule.name}
                        onChange={(e) =>
                          setCfg((p) => ({
                            ...p,
                            rules: p.rules.map((r, i) =>
                              i === idx ? { ...r, name: e.target.value } : r,
                            ),
                          }))
                        }
                        className="flex-1 rounded-[7px] border border-[var(--cloak-border)] bg-[var(--cloak-bg-input)] px-2 py-1 text-xs text-[var(--cloak-text)]"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setCfg((p) => ({ ...p, rules: p.rules.filter((_, i) => i !== idx) }))
                        }
                        className="text-[var(--cloak-danger-text)] hover:opacity-80 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <select
                        value={rule.trigger}
                        onChange={(e) =>
                          setCfg((p) => ({
                            ...p,
                            rules: p.rules.map((r, i) =>
                              i === idx
                                ? { ...r, trigger: e.target.value as PrivacyTriggerKind }
                                : r,
                            ),
                          }))
                        }
                        className={selectCls}
                      >
                        <option value="focus_loss">Focus Loss</option>
                        <option value="alt_tab">Alt+Tab</option>
                        <option value="minimize">Minimize</option>
                        <option value="session_lock">Windows Lock</option>
                        <option value="background_away_timeout">Away Timeout</option>
                        <option value="foreground_inactivity">Foreground Idle</option>
                        <option value="system_idle">System Idle</option>
                        <option value="panic_hotkey">Panic Hotkey</option>
                      </select>
                      <select
                        value={rule.visualAction}
                        onChange={(e) =>
                          setCfg((p) => ({
                            ...p,
                            rules: p.rules.map((r, i) =>
                              i === idx
                                ? { ...r, visualAction: e.target.value as StealthVisualAction }
                                : r,
                            ),
                          }))
                        }
                        className={selectCls}
                      >
                        <option value="switch_to_pdf">Show PDF Reader</option>
                        <option value="privacy_shield">Privacy Shield</option>
                        <option value="lock_screen">Lock Screen</option>
                        <option value="blur">Blur</option>
                        <option value="none">No visual change</option>
                      </select>
                      <select
                        value={rule.lockAction}
                        onChange={(e) =>
                          setCfg((p) => ({
                            ...p,
                            rules: p.rules.map((r, i) =>
                              i === idx ? { ...r, lockAction: e.target.value as LockAction } : r,
                            ),
                          }))
                        }
                        className={selectCls}
                      >
                        <option value="require_unlock">Lock UI</option>
                        <option value="hard_lock">Hard Lock</option>
                        <option value="none">No lock</option>
                      </select>
                      <select
                        value={rule.deletionAction}
                        onChange={(e) =>
                          setCfg((p) => ({
                            ...p,
                            rules: p.rules.map((r, i) =>
                              i === idx
                                ? {
                                    ...r,
                                    deletionAction: e.target.value as LocalDeletionAction,
                                  }
                                : r,
                            ),
                          }))
                        }
                        className={selectCls}
                      >
                        <option value="keep_all">Keep all</option>
                        <option value="delete_viewed_local">Delete viewed</option>
                        <option value="delete_active_conversation">Delete conversation</option>
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Safe Test Mode Sandbox */}
            <div className="rounded-[10px] border border-[var(--cloak-success-border)] bg-[var(--cloak-success-soft)] p-3 space-y-2">
              <div className="flex items-center gap-2 font-semibold text-[var(--cloak-success-text)]">
                <ShieldCheck className="w-4 h-4" />
                Safe Test Mode Sandbox (Non-Destructive)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <select
                  aria-label="Test Mode Trigger"
                  value={testTrigger}
                  onChange={(e) => setTestTrigger(e.target.value as PrivacyTriggerKind)}
                  className={selectCls}
                >
                  <option value="alt_tab">Alt+Tab</option>
                  <option value="minimize">Minimize</option>
                  <option value="session_lock">Session Lock</option>
                  <option value="background_away_timeout">Away Timeout</option>
                  <option value="panic_hotkey">Panic Hotkey</option>
                </select>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={testTotal}
                  onChange={(e) => setTestTotal(Number(e.target.value) || 5)}
                  aria-label="Mock total messages"
                  className={selectCls}
                />
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={testViewed}
                  onChange={(e) => setTestViewed(Number(e.target.value) || 0)}
                  aria-label="Mock viewed messages"
                  className={selectCls}
                />
                <select
                  aria-label="Mock deletion policy"
                  value={testDeletion}
                  onChange={(e) => setTestDeletion(e.target.value as LocalDeletionAction)}
                  className={selectCls}
                >
                  <option value="keep_all">Keep all</option>
                  <option value="delete_viewed_local">Delete viewed</option>
                  <option value="delete_active_conversation">Wipe active</option>
                </select>
              </div>
              <Button type="button" size="sm" onClick={() => void handleRunTestPreview()}>
                Run Safe Test Preview
              </Button>
              {testResult && (
                <div
                  data-testid="stealth-test-preview-result"
                  className="rounded-[8px] bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] p-2.5 text-[11px] space-y-1 text-[var(--cloak-text-body)]"
                >
                  <div>
                    Resulting Surface: <strong className="text-[var(--cloak-text)]">{testResult.resultingSurface as ActiveSurface}</strong> ·
                    Locks UI: <strong>{String(testResult.wouldLock)}</strong>
                  </div>
                  <div>
                    Mock Cleared: <strong>{testResult.disposableMessagesCleared}</strong> · Mock
                    Remaining: <strong>{testResult.disposableMessagesRemaining}</strong>
                  </div>
                  <div className="text-[var(--cloak-success-text)]">{testResult.note}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-[8px] border border-[var(--cloak-danger-border)] bg-[var(--cloak-danger-soft)] px-3 py-2 text-xs text-[var(--cloak-danger-text)] flex items-center gap-2">
            <Lock className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}
        {info && (
          <div className="rounded-[8px] border border-[var(--cloak-success-border)] bg-[var(--cloak-success-soft)] px-3 py-2 text-xs text-[var(--cloak-success-text)]">
            {info}
          </div>
        )}
      </form>
    </ModalDialog>
  );
}

