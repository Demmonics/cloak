import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Maximize2,
  Minimize2,
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Button, ModalDialog } from '@cloak/ui';
import { p2pApi, type P2pCaptureSourceInfo } from '../../lib/p2pClient.js';

export type ScreenQualityPreset = '720p30' | '1080p30' | '1080p60';

export const SCREEN_PRESETS: Record<
  ScreenQualityPreset,
  { width: number; height: number; fps: number; maxBitrate: number; label: string }
> = {
  '720p30': { width: 1280, height: 720, fps: 30, maxBitrate: 2_500_000, label: '720p · 30 fps' },
  '1080p30': { width: 1920, height: 1080, fps: 30, maxBitrate: 4_500_000, label: '1080p · 30 fps' },
  '1080p60': { width: 1920, height: 1080, fps: 60, maxBitrate: 7_500_000, label: '1080p · 60 fps' },
};

export interface MediaRtpStats {
  bytesReceived: number;
  bytesSent: number;
  frameWidth: number;
  frameHeight: number;
  framesPerSecond: number;
  packetsLost: number;
}

interface MediaDockProps {
  callState: 'idle' | 'calling' | 'connected';
  iceStatus: string;
  videoOn: boolean;
  screenSharing: boolean;
  screenLabel: string | null;
  micMuted: boolean;
  deafened: boolean;
  screenQuality: ScreenQualityPreset;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  rtpStats: MediaRtpStats;
  devices: MediaDeviceInfo[];
  selectedMicId: string;
  selectedCamId: string;
  selectedSpeakerId: string;
  onSelectMic: (id: string) => void;
  onSelectCam: (id: string) => void;
  onSelectSpeaker: (id: string) => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onChangeScreenQuality: (preset: ScreenQualityPreset) => void;
  onStartNativeCapture: (source: P2pCaptureSourceInfo, preset: ScreenQualityPreset) => Promise<void>;
  onStartBrowserDisplayCapture: (preset: ScreenQualityPreset) => Promise<void>;
  onStopScreenShare: () => Promise<void>;
  onRestartIce: () => Promise<void>;
  onHangup: () => Promise<void>;
  onModalStateChange?: (open: boolean) => void;
}

export function P2pMediaDock({
  callState,
  iceStatus,
  videoOn,
  screenSharing,
  screenLabel,
  micMuted,
  deafened,
  screenQuality,
  localStream,
  remoteStream,
  rtpStats,
  devices,
  selectedMicId,
  selectedCamId,
  selectedSpeakerId,
  onSelectMic,
  onSelectCam,
  onSelectSpeaker,
  onToggleMute,
  onToggleDeafen,
  onChangeScreenQuality,
  onStartNativeCapture,
  onStartBrowserDisplayCapture,
  onStopScreenShare,
  onRestartIce,
  onHangup,
  onModalStateChange,
}: MediaDockProps) {
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localPreviewRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const [theater, setTheater] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sources, setSources] = useState<P2pCaptureSourceInfo[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pickerErr, setPickerErr] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);

  const mics = devices.filter((d) => d.kind === 'audioinput');
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const speakers = devices.filter((d) => d.kind === 'audiooutput');

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
      if (remoteStream) {
        void remoteVideoRef.current.play().catch(() => undefined);
      }
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.muted = deafened;
      if (remoteStream) {
        void remoteAudioRef.current.play().catch(() => undefined);
      }
    }
  }, [remoteStream, deafened, callState]);

  useEffect(() => {
    if (localPreviewRef.current) {
      localPreviewRef.current.srcObject = localStream;
      if (localStream) {
        void localPreviewRef.current.play().catch(() => undefined);
      }
    }
  }, [localStream, callState]);

  useEffect(() => {
    const audioEl = remoteAudioRef.current as (HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    }) | null;
    if (audioEl && selectedSpeakerId && typeof audioEl.setSinkId === 'function') {
      void audioEl.setSinkId(selectedSpeakerId).catch(() => {
        // Ignore unsupported browser sink errors
      });
    }
  }, [selectedSpeakerId, remoteStream]);

  const setPickerOpenWithGuard = useCallback(
    (next: boolean) => {
      setPickerOpen(next);
      onModalStateChange?.(next);
    },
    [onModalStateChange],
  );

  const loadCaptureSources = useCallback(async () => {
    setLoadingSources(true);
    setPickerErr(null);
    try {
      const list = await p2pApi.listCaptureSources();
      setSources(list);
      const first = list[0];
      if (first) {
        setSelectedSourceId((prev) => (list.some((s) => s.id === prev) ? prev : first.id));
      }
    } catch (err) {
      setPickerErr(err instanceof Error ? err.message : 'Unable to enumerate displays/windows');
    } finally {
      setLoadingSources(false);
    }
  }, []);

  useEffect(() => {
    if (!pickerOpen || !selectedSourceId) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    const refreshPreview = async () => {
      try {
        const blob = await p2pApi.getCaptureFrameBlob(selectedSourceId, 640);
        if (cancelled) return;
        const nextUrl = URL.createObjectURL(blob);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = nextUrl;
        setPreviewUrl(nextUrl);
      } catch {
        // Keep last preview frame
      }
    };

    void refreshPreview();
    const timer = window.setInterval(() => void refreshPreview(), 800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pickerOpen, selectedSourceId]);

  const toggleFullscreen = async () => {
    if (!stageRef.current) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    } else {
      await stageRef.current.requestFullscreen().catch(() => undefined);
    }
  };

  if (callState === 'idle') return null;

  const hasRemoteVideo = Boolean(remoteStream && remoteStream.getVideoTracks().length > 0);
  const selectedSource = sources.find((s) => s.id === selectedSourceId) ?? null;

  return (
    <section
      ref={stageRef}
      aria-label="Direct WebRTC Media Stage"
      className={`mx-4 mt-3 rounded-xl border border-[#2a3146] bg-[#0c0e14] p-3 space-y-3 ${
        theater ? 'min-h-[380px]' : ''
      }`}
    >
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              iceStatus === 'connected' || iceStatus === 'completed'
                ? 'bg-[#22c55e]'
                : iceStatus === 'failed' || iceStatus === 'disconnected'
                  ? 'bg-[#f59e0b]'
                  : 'bg-[#38bdf8]'
            }`}
          />
          <span className="font-semibold text-white">
            Direct WebRTC {screenSharing ? `· Screen (${screenLabel ?? screenQuality})` : videoOn ? '· Video + Audio' : '· Voice'}
          </span>
          <span className="text-[#9aa3b8]">ICE: {iceStatus}</span>
          {rtpStats.bytesReceived > 0 && (
            <span className="text-[#34d399] font-mono text-[11px]" data-testid="rtp-stats">
              RX {(rtpStats.bytesReceived / 1024).toFixed(1)} KiB
              {rtpStats.frameWidth > 0 ? ` · ${rtpStats.frameWidth}x${rtpStats.frameHeight}@${rtpStats.framesPerSecond.toFixed(0)}fps` : ''}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {!screenSharing ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setPickerOpenWithGuard(true);
                void loadCaptureSources();
              }}
            >
              <MonitorUp className="w-3.5 h-3.5" /> Share Screen
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void onStopScreenShare()}>
              <MonitorOff className="w-3.5 h-3.5" /> Stop Share
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onToggleMute} aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}>
            {micMuted ? <MicOff className="w-3.5 h-3.5 text-[#fca5a5]" /> : <Mic className="w-3.5 h-3.5" />}
          </Button>
          <Button size="sm" variant="secondary" onClick={onToggleDeafen} aria-label={deafened ? 'Undeafen audio' : 'Deafen audio'}>
            {deafened ? <VolumeX className="w-3.5 h-3.5 text-[#fca5a5]" /> : <Volume2 className="w-3.5 h-3.5" />}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setTheater((t) => !t)} title="Toggle Theater View">
            {theater ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void toggleFullscreen()} title="Fullscreen Stage">
            Full
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void onRestartIce()} title="Reconnect ICE">
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          <Button size="sm" variant="danger" onClick={() => void onHangup()}>
            <PhoneOff className="w-3.5 h-3.5" /> End
          </Button>
        </div>
      </div>

      <div className={`grid gap-3 ${theater ? 'grid-cols-1 lg:grid-cols-[1fr_220px]' : 'grid-cols-1 sm:grid-cols-[minmax(0,1fr)_190px]'}`}>
        <div className={`relative rounded-xl bg-black border border-[#1f2435] overflow-hidden flex items-center justify-center ${theater ? 'h-80' : 'h-48'}`}>
          <video
            ref={remoteVideoRef}
            data-testid="remote-video"
            autoPlay
            playsInline
            muted={deafened}
            className="w-full h-full object-contain"
          />
          {!hasRemoteVideo && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-[#9aa3b8]">
              Waiting for remote video/screen track (direct P2P audio active)...
            </div>
          )}
        </div>

        <div className="flex flex-col justify-between gap-2 text-[11px]">
          <div className="relative h-28 rounded-lg bg-[#141722] border border-[#262c3f] overflow-hidden">
            <video
              ref={localPreviewRef}
              data-testid="local-preview"
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            <span className="absolute bottom-1 left-1.5 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-white">
              Self Preview
            </span>
          </div>

          <div className="space-y-1">
            <select
              aria-label="Microphone device"
              value={selectedMicId}
              onChange={(e) => onSelectMic(e.target.value)}
              className="w-full rounded bg-[#141722] border border-[#262c3f] px-1.5 py-1 text-[11px] text-[#e2e8f0]"
            >
              <option value="">Default Mic ({mics.length})</option>
              {mics.map((d, idx) => (
                <option key={d.deviceId || idx} value={d.deviceId}>
                  {d.label || `Mic ${idx + 1}`}
                </option>
              ))}
            </select>
            <select
              aria-label="Camera device"
              value={selectedCamId}
              onChange={(e) => onSelectCam(e.target.value)}
              className="w-full rounded bg-[#141722] border border-[#262c3f] px-1.5 py-1 text-[11px] text-[#e2e8f0]"
            >
              <option value="">Default Camera ({cams.length})</option>
              {cams.map((d, idx) => (
                <option key={d.deviceId || idx} value={d.deviceId}>
                  {d.label || `Camera ${idx + 1}`}
                </option>
              ))}
            </select>
            {speakers.length > 0 && (
              <select
                aria-label="Speaker output device"
                value={selectedSpeakerId}
                onChange={(e) => onSelectSpeaker(e.target.value)}
                className="w-full rounded bg-[#141722] border border-[#262c3f] px-1.5 py-1 text-[11px] text-[#e2e8f0]"
              >
                <option value="">Default Speaker ({speakers.length})</option>
                {speakers.map((d, idx) => (
                  <option key={d.deviceId || idx} value={d.deviceId}>
                    {d.label || `Speaker ${idx + 1}`}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Screen & Window Share Pre-Live Preview Picker */}
      <ModalDialog
        open={pickerOpen}
        onClose={() => setPickerOpenWithGuard(false)}
        title="Share Screen or Application Window"
        wide
      >
        <div className="space-y-3 text-xs text-[#e2e8f0]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <label htmlFor="screen-preset-select" className="text-[#9aa3b8]">
                Stream Quality:
              </label>
              <select
                id="screen-preset-select"
                value={screenQuality}
                onChange={(e) => onChangeScreenQuality(e.target.value as ScreenQualityPreset)}
                className="rounded-lg bg-[#0d1017] border border-[#2a3146] px-2 py-1 text-white"
              >
                {Object.entries(SCREEN_PRESETS).map(([key, spec]) => (
                  <option key={key} value={key}>
                    {spec.label}
                  </option>
                ))}
              </select>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void loadCaptureSources()} disabled={loadingSources}>
              <RefreshCw className="w-3.5 h-3.5" /> Refresh Sources
            </Button>
          </div>

          {pickerErr && <div className="text-[#fca5a5]">{pickerErr}</div>}

          <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-3">
            <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
              {sources.map((src) => (
                <button
                  key={src.id}
                  type="button"
                  onClick={() => setSelectedSourceId(src.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border cursor-pointer ${
                    src.id === selectedSourceId
                      ? 'border-[#7c6cff] bg-[#7c6cff]/15 text-white'
                      : 'border-[#262c3f] bg-[#121623] text-[#cbd5e1] hover:border-[#37405b]'
                  }`}
                >
                  <div className="font-medium truncate">{src.title}</div>
                  <div className="text-[10px] text-[#9aa3b8] uppercase">
                    {src.kind} · {src.width}x{src.height}
                  </div>
                </button>
              ))}
              {sources.length === 0 && !loadingSources && (
                <div className="text-[#9aa3b8] p-2">No native desktop capture sources enumerated.</div>
              )}
            </div>

            <div className="rounded-xl border border-[#262c3f] bg-black p-2 flex flex-col items-center justify-center min-h-[200px]">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt={selectedSource?.title ?? 'Pre-live screen share preview'}
                  className="max-h-56 w-full object-contain rounded"
                />
              ) : (
                <div className="text-[#9aa3b8]">Select a display or window to preview before going live...</div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap justify-between gap-2 pt-2 border-t border-[#262c3f]">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setPickerOpenWithGuard(false);
                void onStartBrowserDisplayCapture(screenQuality);
              }}
            >
              Use Browser Tab/Screen Picker
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setPickerOpenWithGuard(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={!selectedSource}
                onClick={() => {
                  if (!selectedSource) return;
                  setPickerOpenWithGuard(false);
                  void onStartNativeCapture(selectedSource, screenQuality);
                }}
              >
                Go Live with Selected Source
              </Button>
            </div>
          </div>
        </div>
      </ModalDialog>
    </section>
  );
}
