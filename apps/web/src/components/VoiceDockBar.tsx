import React, { useState } from 'react';
import {
  Headphones,
  HeadphoneOff,
  Maximize2,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Radio,
  Settings2,
  ShieldCheck,
  Video,
  VideoOff,
} from 'lucide-react';
import { SCREEN_SHARE_PRESETS, type ScreenSharePreset } from '@cloak/config';
import { useAppStore } from '../store/useAppStore.js';

export interface VoiceDockBarProps {
  onToggleMic: () => Promise<void>;
  onToggleDeafen: () => void;
  onToggleCam: () => Promise<void>;
  onToggleScreen: (preset?: ScreenSharePreset) => Promise<void>;
  onDisconnect: () => Promise<void>;
}

export function VoiceDockBar({
  onToggleMic,
  onToggleDeafen,
  onToggleCam,
  onToggleScreen,
  onDisconnect,
}: VoiceDockBarProps) {
  const call = useAppStore((s) => s.call);
  const updateCall = useAppStore((s) => s.updateCall);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const [selectedPresetIdx, setSelectedPresetIdx] = useState(0);

  if (call.status === 'idle') return null;

  const preset = SCREEN_SHARE_PRESETS[selectedPresetIdx] ?? SCREEN_SHARE_PRESETS[0]!;

  return (
    <section
      aria-label="Active voice and video call controls"
      className="border-t border-[var(--cloak-border)] bg-[var(--cloak-bg-sidebar)] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            call.status === 'connected'
              ? 'bg-[var(--cloak-success)]'
              : call.status === 'connecting'
                ? 'bg-[var(--cloak-warn)]'
                : 'bg-[var(--cloak-danger)]'
          }`}
        />
        <div className="min-w-0">
          <div className="text-xs font-semibold text-[var(--cloak-text)] flex items-center gap-1.5 truncate">
            <span>
              {call.roomName} · #{call.channelName}
            </span>
            <span
              title={call.e2eeNote}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] border ${
                call.e2eeActive
                  ? 'bg-[var(--cloak-success-soft)] text-[var(--cloak-success-text)] border-[var(--cloak-success-border)]'
                  : 'bg-[var(--cloak-warn-soft)] text-[var(--cloak-warn-text)] border-[var(--cloak-warn-border)]'
              }`}
            >
              <ShieldCheck className="w-3 h-3" />
              {call.e2eeActive ? 'Media E2EE' : 'DTLS-SRTP'}
            </span>
          </div>
          <div className="text-[11px] text-[var(--cloak-text-muted)] truncate">
            {call.status === 'error'
              ? call.errorNote || 'SFU connection unavailable (check LiveKit server)'
              : `${call.participants.length} participant(s) · Switch text channels freely while staying connected`}
          </div>
        </div>
      </div>

      <div className="flex items-center flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => void onToggleMic()}
          title={call.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
          aria-pressed={!call.micEnabled}
          className={`p-2 rounded-full text-xs inline-flex items-center gap-1 border cursor-pointer transition-colors ${
            call.micEnabled
              ? 'bg-[var(--cloak-bg-surface)] border-[var(--cloak-border)] text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
              : 'bg-[var(--cloak-danger-soft)] text-[var(--cloak-danger-text)] border-[var(--cloak-danger-border)]'
          }`}
        >
          {call.micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={() => updateCall({ pttMode: !call.pttMode })}
          title="Toggle Push-to-Talk (Spacebar)"
          aria-pressed={call.pttMode}
          className={`px-2.5 py-2 rounded-full text-[11px] font-medium inline-flex items-center gap-1 border cursor-pointer transition-colors ${
            call.pttMode
              ? 'bg-[var(--cloak-accent-soft)] text-[var(--cloak-accent-text)] border-[var(--cloak-accent)]'
              : 'bg-[var(--cloak-bg-surface)] border-[var(--cloak-border)] text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)]'
          }`}
        >
          <Radio className="w-3.5 h-3.5" />
          PTT
        </button>

        <button
          type="button"
          onClick={onToggleDeafen}
          title={call.deafened ? 'Undeafen' : 'Deafen'}
          aria-pressed={call.deafened}
          className={`p-2 rounded-full text-xs inline-flex items-center gap-1 border cursor-pointer transition-colors ${
            call.deafened
              ? 'bg-[var(--cloak-danger-soft)] text-[var(--cloak-danger-text)] border-[var(--cloak-danger-border)]'
              : 'bg-[var(--cloak-bg-surface)] border-[var(--cloak-border)] text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
          }`}
        >
          {call.deafened ? <HeadphoneOff className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={() => void onToggleCam()}
          title={call.camEnabled ? 'Disable camera' : 'Enable camera'}
          aria-pressed={call.camEnabled}
          className={`p-2 rounded-full text-xs inline-flex items-center gap-1 border cursor-pointer transition-colors ${
            call.camEnabled
              ? 'bg-[var(--cloak-accent)] border-[var(--cloak-accent)] text-[var(--cloak-accent-ink)]'
              : 'bg-[var(--cloak-bg-surface)] border-[var(--cloak-border)] text-[var(--cloak-text-body)] hover:text-[var(--cloak-text)]'
          }`}
        >
          {call.camEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
        </button>

        <div className="inline-flex items-center rounded-full bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)]">
          <button
            type="button"
            onClick={() => void onToggleScreen(preset)}
            title={call.screenEnabled ? 'Stop screen share' : `Share screen (${preset.label})`}
            aria-pressed={call.screenEnabled}
            className={`px-2.5 py-2 rounded-l-full text-xs inline-flex items-center gap-1 cursor-pointer transition-colors ${
              call.screenEnabled
                ? 'bg-[var(--cloak-success)] text-[var(--cloak-accent-ink)] font-medium'
                : 'text-[var(--cloak-text-body)] hover:text-[var(--cloak-text)]'
            }`}
          >
            <MonitorUp className="w-4 h-4" />
            Share
          </button>
          <select
            aria-label="Screen share preset"
            value={selectedPresetIdx}
            onChange={(e) => setSelectedPresetIdx(Number(e.target.value))}
            className="bg-transparent px-2 py-2 text-[11px] text-[var(--cloak-text-muted)] focus:outline-none cursor-pointer"
          >
            {SCREEN_SHARE_PRESETS.map((p, idx) => (
              <option key={p.label} value={idx} className="bg-[var(--cloak-bg-surface)] text-[var(--cloak-text)]">
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => updateCall({ layout: call.layout === 'dock' ? 'grid' : 'dock' })}
          title="Toggle Video Grid / Stage View"
          className="p-2 rounded-full bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] text-[var(--cloak-text-body)] hover:text-[var(--cloak-text)] cursor-pointer transition-colors"
        >
          <Maximize2 className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => setActiveModal('device_settings')}
          title="Audio & Video Device Settings"
          aria-label="Device Settings"
          className="p-2 rounded-full bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] text-[var(--cloak-text-body)] hover:text-[var(--cloak-text)] cursor-pointer transition-colors"
        >
          <Settings2 className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => void onDisconnect()}
          title="Disconnect from call"
          aria-label="Disconnect call"
          className="px-3.5 py-2 rounded-full bg-[var(--cloak-danger)] hover:bg-[var(--cloak-danger-hover)] text-white text-xs font-medium inline-flex items-center gap-1 cursor-pointer transition-colors"
        >
          <PhoneOff className="w-4 h-4" />
          Leave
        </button>
      </div>
    </section>
  );
}

