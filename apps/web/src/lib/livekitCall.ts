import {
  ConnectionQuality,
  ExternalE2EEKeyProvider,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  isE2EESupported,
  type LocalParticipant,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from 'livekit-client';
import { ensureCryptoReady, utf8Encode } from '@cloak/crypto';
import type { ScreenSharePreset } from '@cloak/config';

export interface CallParticipantView {
  identity: string;
  name: string;
  isLocal: boolean;
  isSpeaking: boolean;
  micEnabled: boolean;
  camEnabled: boolean;
  screenEnabled: boolean;
  connectionQuality: ConnectionQuality;
  videoTrack?: Track;
  screenTrack?: Track;
}

export interface LiveKitControllerCallbacks {
  onParticipantsChanged: (participants: CallParticipantView[]) => void;
  onAudioLevelChanged: (levels: Record<string, boolean>) => void;
  onDisconnected: (reason?: string) => void;
  onE2EEState: (enabled: boolean, note: string) => void;
}

export async function deriveLiveKitMediaKey(epochKey: Uint8Array, roomId: string, epoch: number): Promise<ArrayBuffer> {
  const s = await ensureCryptoReady();
  const context = utf8Encode(`cloak-lk-media-v1:${roomId}:${epoch}`);
  const derived = s.crypto_generichash(32, context, epochKey);
  const out = new ArrayBuffer(derived.byteLength);
  new Uint8Array(out).set(derived);
  return out;
}

export class CloakLiveKitController {
  private room: Room | null = null;
  private keyProvider: ExternalE2EEKeyProvider | null = null;
  private worker: Worker | null = null;
  private deafened = false;
  private readonly callbacks: LiveKitControllerCallbacks;

  constructor(callbacks: LiveKitControllerCallbacks) {
    this.callbacks = callbacks;
  }

  async connect(params: {
    livekitUrl: string;
    token: string;
    epochKey: Uint8Array;
    roomId: string;
    epoch: number;
  }): Promise<void> {
    await this.disconnect();

    let e2eeActive = false;
    let e2eeNote = 'Standard WebRTC DTLS-SRTP';

    if (typeof Worker !== 'undefined' && isE2EESupported()) {
      try {
        this.keyProvider = new ExternalE2EEKeyProvider();
        this.worker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), {
          type: 'module',
        });
        const mediaKey = await deriveLiveKitMediaKey(params.epochKey, params.roomId, params.epoch);
        await this.keyProvider.setKey(mediaKey);
        e2eeActive = true;
        e2eeNote = 'LiveKit E2EE (frame-level Insertable Streams / ScriptTransform)';
      } catch (err) {
        e2eeNote = `E2EE worker unavailable (${err instanceof Error ? err.message : 'fallback DTLS-SRTP'})`;
        this.keyProvider = null;
        this.worker?.terminate();
        this.worker = null;
      }
    } else {
      e2eeNote = 'Browser lacks Encoded Streams / Worker E2EE — falling back to SFU DTLS-SRTP';
    }

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: VideoPresets.h720.resolution,
      },
      publishDefaults: {
        simulcast: true,
      },
      encryption:
        e2eeActive && this.keyProvider && this.worker
          ? { keyProvider: this.keyProvider, worker: this.worker }
          : undefined,
    });

    this.room = room;
    this.callbacks.onE2EEState(e2eeActive, e2eeNote);

    const sync = () => this.emitSnapshot();
    room.on(RoomEvent.ParticipantConnected, sync);
    room.on(RoomEvent.ParticipantDisconnected, sync);
    room.on(RoomEvent.TrackSubscribed, (_t, pub: RemoteTrackPublication) => {
      if (pub.kind === Track.Kind.Audio && pub.audioTrack && this.deafened) {
        pub.setSubscribed(true);
        if (pub.audioTrack instanceof RemoteAudioTrack) {
          pub.audioTrack.setVolume(0);
        }
      }
      sync();
    });
    room.on(RoomEvent.TrackUnsubscribed, sync);
    room.on(RoomEvent.TrackMuted, sync);
    room.on(RoomEvent.TrackUnmuted, sync);
    room.on(RoomEvent.LocalTrackPublished, sync);
    room.on(RoomEvent.LocalTrackUnpublished, sync);
    room.on(RoomEvent.ConnectionQualityChanged, sync);
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const map: Record<string, boolean> = {};
      for (const sp of speakers) map[sp.identity] = true;
      this.callbacks.onAudioLevelChanged(map);
      sync();
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      this.callbacks.onDisconnected(reason ? String(reason) : undefined);
    });

    await room.connect(params.livekitUrl, params.token);
    if (e2eeActive) {
      try {
        await room.setE2EEEnabled(true);
      } catch {
        this.callbacks.onE2EEState(false, 'SFU connected; E2EE frame activation unsupported on this browser');
      }
    }
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch {
      // Allow listen-only join if user denies or lacks microphone device
    }
    sync();
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(enabled);
    this.emitSnapshot();
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    await this.room?.localParticipant.setCameraEnabled(enabled);
    this.emitSnapshot();
  }

  async setScreenShareEnabled(enabled: boolean, preset?: ScreenSharePreset): Promise<void> {
    if (!this.room) return;
    if (enabled && preset) {
      await this.room.localParticipant.setScreenShareEnabled(true, {
        audio: true,
        resolution: { width: preset.width, height: preset.height, frameRate: preset.frameRate },
      });
    } else {
      await this.room.localParticipant.setScreenShareEnabled(enabled);
    }
    this.emitSnapshot();
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    if (!this.room) return;
    for (const p of this.room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) {
        if (pub.audioTrack && pub.audioTrack instanceof RemoteAudioTrack) {
          pub.audioTrack.setVolume(deafened ? 0 : 1);
        }
      }
    }
  }

  async switchActiveDevice(kind: 'audioinput' | 'audiooutput' | 'videoinput', deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice(kind, deviceId);
  }

  async disconnect(): Promise<void> {
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }
    this.worker?.terminate();
    this.worker = null;
    this.keyProvider = null;
    this.callbacks.onParticipantsChanged([]);
  }

  getRemoteAudioTracks(): Array<{ sid: string; track: Track }> {
    if (!this.room) return [];
    const list: Array<{ sid: string; track: Track }> = [];
    for (const p of this.room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) {
        if (pub.track) {
          list.push({ sid: `${p.identity}-${pub.trackSid}`, track: pub.track });
        }
      }
    }
    return list;
  }

  private emitSnapshot(): void {
    if (!this.room) {
      this.callbacks.onParticipantsChanged([]);
      return;
    }
    const items: CallParticipantView[] = [
      this.toView(this.room.localParticipant, true),
      ...Array.from(this.room.remoteParticipants.values()).map((p) => this.toView(p, false)),
    ];
    this.callbacks.onParticipantsChanged(items);
  }

  private toView(p: LocalParticipant | RemoteParticipant, isLocal: boolean): CallParticipantView {
    const camPub = p.getTrackPublication(Track.Source.Camera);
    const scrPub = p.getTrackPublication(Track.Source.ScreenShare);
    const micPub = p.getTrackPublication(Track.Source.Microphone);
    return {
      identity: p.identity,
      name: p.name || p.identity.slice(0, 8),
      isLocal,
      isSpeaking: p.isSpeaking,
      micEnabled: Boolean(micPub && !micPub.isMuted),
      camEnabled: Boolean(camPub && !camPub.isMuted && camPub.track),
      screenEnabled: Boolean(scrPub && !scrPub.isMuted && scrPub.track),
      connectionQuality: p.connectionQuality,
      videoTrack: camPub?.track,
      screenTrack: scrPub?.track,
    };
  }
}
