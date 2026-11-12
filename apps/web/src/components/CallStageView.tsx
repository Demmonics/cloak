import React, { useEffect, useRef } from 'react';
import type { Track } from 'livekit-client';
import { Columns2, LayoutGrid, Minimize2, MicOff, MonitorUp } from 'lucide-react';
import { Avatar } from '@cloak/ui';
import type { CallParticipantView } from '../lib/livekitCall.js';
import { useAppStore } from '../store/useAppStore.js';

function VideoTrackPlayer({ track, label }: { track: Track; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      aria-label={label}
      className="w-full h-full object-contain rounded-lg bg-black"
    />
  );
}

export function CallStageView({ participants }: { participants: CallParticipantView[] }) {
  const call = useAppStore((s) => s.call);
  const updateCall = useAppStore((s) => s.updateCall);

  if (call.status === 'idle' || call.layout === 'dock') return null;

  const focusedScreen = participants.find((p) => p.screenTrack);

  return (
    <section
      aria-label="Live call video and screen share stage"
      className="border-b border-[var(--cloak-border)] bg-[var(--cloak-bg-void)] p-4 max-h-[55vh] flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-[var(--cloak-text-body)] flex items-center gap-2">
          <span className="font-editorial text-sm font-semibold text-[var(--cloak-text)]">Stage View</span>
          <span>— #{call.channelName} ({call.e2eeActive ? 'Media E2EE Enabled' : call.e2eeNote})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => updateCall({ layout: call.layout === 'focus' ? 'grid' : 'focus' })}
            className="px-2.5 py-1 rounded-full bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] text-[11px] text-[var(--cloak-text-body)] hover:text-[var(--cloak-text)] inline-flex items-center gap-1 cursor-pointer"
          >
            {call.layout === 'focus' ? <LayoutGrid className="w-3.5 h-3.5" /> : <Columns2 className="w-3.5 h-3.5" />}
            {call.layout === 'focus' ? 'Grid' : 'Focus'}
          </button>
          <button
            type="button"
            onClick={() => updateCall({ layout: 'dock' })}
            className="px-2.5 py-1 rounded-full bg-[var(--cloak-bg-surface)] border border-[var(--cloak-border)] text-[11px] text-[var(--cloak-text-body)] hover:text-[var(--cloak-text)] inline-flex items-center gap-1 cursor-pointer"
          >
            <Minimize2 className="w-3.5 h-3.5" /> Dock
          </button>
        </div>
      </div>

      {call.layout === 'focus' && focusedScreen?.screenTrack && (
        <div className="flex-1 min-h-[220px] rounded-2xl border border-[var(--cloak-border)] overflow-hidden bg-[#0D1815]">
          <VideoTrackPlayer track={focusedScreen.screenTrack} label={`${focusedScreen.name} screen share`} />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 overflow-y-auto">
        {participants.map((p) => (
          <div
            key={p.identity}
            className={`relative rounded-2xl border p-3 bg-[var(--cloak-bg-surface)] flex flex-col items-center justify-center min-h-[150px] ${
              p.isSpeaking ? 'border-[var(--cloak-success)] ring-1 ring-[var(--cloak-success)]/45' : 'border-[var(--cloak-border)]'
            }`}
          >
            {p.videoTrack ? (
              <div className="w-full h-36">
                <VideoTrackPlayer track={p.videoTrack} label={`${p.name} video`} />
              </div>
            ) : (
              <Avatar name={p.name} size="lg" />
            )}

            <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--cloak-text)]">
              <span>{p.name}{p.isLocal ? ' (You)' : ''}</span>
              {!p.micEnabled && <MicOff className="w-3.5 h-3.5 text-[var(--cloak-danger-text)]" />}
              {p.screenEnabled && <MonitorUp className="w-3.5 h-3.5 text-[var(--cloak-success-text)]" />}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

