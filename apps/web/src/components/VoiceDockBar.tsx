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
      className="border-t border-[#262c3f] bg-[#10131c] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            call.status === 'connected'
              ? 'bg-[#22c55e]'
              : call.status === 'connecting'
                ? 'bg-[#f59e0b]'
                : 'bg-[#ef4444]'
          }`}
        />
        <div className="min-w-0">
          <div className="text-xs font-semibold text-[#f1f3f9] flex items-center gap-1.5 truncate">
            <span>
              {call.roomName} · #{call.channelName}
            </span>
            <span
              title={call.e2eeNote}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                call.e2eeActive
                  ? 'bg-[#10b981]/20 text-[#6ee7b7]'
                  : 'bg-[#f59e0b]/20 text-[#fcd34d]'
              }`}
            >
              <ShieldCheck className="w-3 h-3" />
              {call.e2eeActive ? 'Media E2EE' : 'DTLS-SRTP'}
            </span>
          </div>
          <div className="text-[11px] text-[#8d96ad] truncate">
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
          className={`p-2 rounded-lg text-xs inline-flex items-center gap-1 cursor-pointer ${
            call.micEnabled
              ? 'bg-[#1f2536] text-white hover:bg-[#2a3147]'
              : 'bg-[#dc2626]/20 text-[#fca5a5] border border-[#dc2626]/40'
          }`}
        >
          {call.micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={() => updateCall({ pttMode: !call.pttMode })}
          title="Toggle Push-to-Talk (Spacebar)"
          aria-pressed={call.pttMode}
          className={`px-2 py-2 rounded-lg text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer ${
            call.pttMode
              ? 'bg-[#7c6cff]/25 text-[#c4b5fd] border border-[#7c6cff]/50'
              : 'bg-[#1f2536] text-[#9aa3b8] hover:text-white'
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
          className={`p-2 rounded-lg text-xs inline-flex items-center gap-1 cursor-pointer ${
            call.deafened
              ? 'bg-[#dc2626]/20 text-[#fca5a5] border border-[#dc2626]/40'
              : 'bg-[#1f2536] text-white hover:bg-[#2a3147]'
          }`}
        >
          {call.deafened ? <HeadphoneOff className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={() => void onToggleCam()}
          title={call.camEnabled ? 'Disable camera' : 'Enable camera'}
          aria-pressed={call.camEnabled}
          className={`p-2 rounded-lg text-xs inline-flex items-center gap-1 cursor-pointer ${
            call.camEnabled
              ? 'bg-[#7c6cff] text-white'
              : 'bg-[#1f2536] text-[#cbd5e1] hover:text-white'
          }`}
        >
          {call.camEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
        </button>

        <div className="inline-flex items-center rounded-lg bg-[#1f2536] border border-[#2d354f]">
          <button
            type="button"
            onClick={() => void onToggleScreen(preset)}
            title={call.screenEnabled ? 'Stop screen share' : `Share screen (${preset.label})`}
            aria-pressed={call.screenEnabled}
            className={`px-2.5 py-2 rounded-l-lg text-xs inline-flex items-center gap-1 cursor-pointer ${
              call.screenEnabled ? 'bg-[#10b981] text-[#052e16] font-medium' : 'text-[#cbd5e1] hover:text-white'
            }`}
          >
            <MonitorUp className="w-4 h-4" />
            Share
          </button>
          <select
            aria-label="Screen share preset"
            value={selectedPresetIdx}
            onChange={(e) => setSelectedPresetIdx(Number(e.target.value))}
            className="bg-transparent px-1.5 py-2 text-[11px] text-[#9aa3b8] focus:outline-none cursor-pointer"
          >
            {SCREEN_SHARE_PRESETS.map((p, idx) => (
              <option key={p.label} value={idx} className="bg-[#141722]">
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => updateCall({ layout: call.layout === 'dock' ? 'grid' : 'dock' })}
          title="Toggle Video Grid / Stage View"
          className="p-2 rounded-lg bg-[#1f2536] text-[#cbd5e1] hover:text-white cursor-pointer"
        >
          <Maximize2 className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => setActiveModal('device_settings')}
          title="Audio & Video Device Settings"
          aria-label="Device Settings"
          className="p-2 rounded-lg bg-[#1f2536] text-[#cbd5e1] hover:text-white cursor-pointer"
        >
          <Settings2 className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => void onDisconnect()}
          title="Disconnect from call"
          aria-label="Disconnect call"
          className="px-3 py-2 rounded-lg bg-[#dc2626] hover:bg-[#ef4444] text-white text-xs font-medium inline-flex items-center gap-1 cursor-pointer"
        >
          <PhoneOff className="w-4 h-4" />
          Leave
        </button>
      </div>
    </section>
  );
}

