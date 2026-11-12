import React, { useEffect, useState } from 'react';
import { Flame, Forward, Volume2 } from 'lucide-react';
import type { RoomSummary } from '@cloak/protocol';
import { Button, ModalDialog } from '@cloak/ui';
import { api, type RoomDetailResponse } from '../../lib/api.js';
import type { CloakLiveKitController } from '../../lib/livekitCall.js';
import type { LocalDecryptedMessage } from '../../lib/storage.js';
import { burnRoomAndRotateEpoch, sendEncryptedMessage } from '../../lib/workspaceClient.js';
import { useAppStore } from '../../store/useAppStore.js';

export function BurnRoomModal({
  open,
  onClose,
  roomDetail,
  onBurned,
}: {
  open: boolean;
  onClose: () => void;
  roomDetail: RoomDetailResponse;
  onBurned: () => Promise<void>;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  const handleBurn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (confirmText.trim() !== 'BURN') return;
    setBusy(true);
    try {
      const nextEpoch = await burnRoomAndRotateEpoch({
        roomId: roomDetail.room.id,
        activeMembers: roomDetail.members,
        currentEpoch: roomDetail.room.currentEpoch,
      });
      await onBurned();
      setConfirmText('');
      onClose();
      pushToast({
        tone: 'warning',
        title: 'Room history burned & key rotated',
        detail: `Server history wiped cleanly; room continues under Epoch ${nextEpoch}.`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={`Burn All History in "${roomDetail.room.name}"`}
      description="Permanently wipes all encrypted messages, attachments, and tombstones while preserving room membership and channels under a fresh encryption epoch."
    >
      <form onSubmit={handleBurn} className="space-y-4">
        <div className="rounded-xl border border-[#ef4444]/40 bg-[#ef4444]/10 p-3 text-xs text-[#fca5a5] flex gap-2">
          <Flame className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Previously exported archives created before this action remain offline snapshots, while all server and live synced devices will purge this history.
          </span>
        </div>

        <div>
          <label htmlFor="burn-confirm-input" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
            Type <strong>BURN</strong> to confirm irreversible wipe
          </label>
          <input
            id="burn-confirm-input"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="BURN"
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" autoFocus onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={busy || confirmText.trim() !== 'BURN'}>
            {busy ? 'Burning...' : 'Burn History & Rotate Epoch'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function ForwardModal({
  open,
  onClose,
  msg,
  rooms,
}: {
  open: boolean;
  onClose: () => void;
  msg: LocalDecryptedMessage | null;
  rooms: RoomSummary[];
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [targetRoomId, setTargetRoomId] = useState(rooms[0]?.id ?? '');
  const [targetChannelId, setTargetChannelId] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedRoom = rooms.find((r) => r.id === targetRoomId);
  const textChannels = React.useMemo(
    () => selectedRoom?.channels.filter((c) => c.channelType !== 'voice') ?? [],
    [selectedRoom],
  );

  useEffect(() => {
    if (!targetRoomId && rooms[0]) setTargetRoomId(rooms[0].id);
  }, [rooms, targetRoomId]);

  useEffect(() => {
    setTargetChannelId((prev) => (textChannels.some((c) => c.id === prev) ? prev : textChannels[0]?.id ?? ''));
  }, [textChannels]);

  if (!msg) return null;

  const handleForward = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetRoomId || !targetChannelId) return;
    setBusy(true);
    try {
      const detail = await api.getRoom(targetRoomId);
      await sendEncryptedMessage({
        roomId: targetRoomId,
        channelId: targetChannelId,
        epoch: detail.room.currentEpoch,
        text: `[Forwarded]\n${msg.text}`,
        attachments: [],
        members: detail.members,
      });
      onClose();
      pushToast({ tone: 'success', title: `Forwarded to #${textChannels.find((c) => c.id === targetChannelId)?.name ?? 'channel'}` });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Forward failed',
        detail: err instanceof Error ? err.message : 'Unable to forward message',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog open={open} onClose={onClose} title="Forward Encrypted Message">
      <form onSubmit={handleForward} className="space-y-4">
        <div className="rounded-xl bg-[#10131d] border border-[#262c3f] p-3 text-xs text-[#cbd5e1] line-clamp-3">
          {msg.text}
        </div>
        <div>
          <label htmlFor="fwd-room" className="block text-xs font-medium text-[#cbd5e1] mb-1">Destination Room</label>
          <select
            id="fwd-room"
            value={targetRoomId}
            onChange={(e) => setTargetRoomId(e.target.value)}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
          >
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="fwd-channel" className="block text-xs font-medium text-[#cbd5e1] mb-1">Destination Channel</label>
          <select
            id="fwd-channel"
            value={targetChannelId}
            onChange={(e) => setTargetChannelId(e.target.value)}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
          >
            {textChannels.map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !targetChannelId}>
            <Forward className="w-3.5 h-3.5" /> Forward
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function DeviceSettingsModal({
  open,
  onClose,
  controller,
}: {
  open: boolean;
  onClose: () => void;
  controller: CloakLiveKitController | null;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    if (!open || !navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => setDevices([]));
  }, [open]);

  const mics = devices.filter((d) => d.kind === 'audioinput');
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const speakers = devices.filter((d) => d.kind === 'audiooutput');

  const switchDev = async (kind: 'audioinput' | 'audiooutput' | 'videoinput', deviceId: string) => {
    if (!controller || !deviceId) return;
    await controller.switchActiveDevice(kind, deviceId);
    pushToast({ tone: 'info', title: 'Updated media device' });
  };

  return (
    <ModalDialog open={open} onClose={onClose} title="Audio & Video Devices">
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-xs text-[#9aa3b8]">
          <Volume2 className="w-4 h-4 text-[#a5b4fc]" />
          <span>Select hardware devices for LiveKit WebRTC calls.</span>
        </div>

        <div>
          <label htmlFor="dev-mic" className="block text-xs font-medium text-[#cbd5e1] mb-1">Microphone</label>
          <select
            id="dev-mic"
            onChange={(e) => void switchDev('audioinput', e.target.value)}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-xs text-white"
          >
            {mics.length === 0 ? <option>Default Microphone</option> : null}
            {mics.map((m, i) => (
              <option key={m.deviceId || i} value={m.deviceId}>{m.label || `Microphone ${i + 1}`}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="dev-cam" className="block text-xs font-medium text-[#cbd5e1] mb-1">Camera</label>
          <select
            id="dev-cam"
            onChange={(e) => void switchDev('videoinput', e.target.value)}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-xs text-white"
          >
            {cams.length === 0 ? <option>Default Camera</option> : null}
            {cams.map((c, i) => (
              <option key={c.deviceId || i} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="dev-spk" className="block text-xs font-medium text-[#cbd5e1] mb-1">Speaker Output</label>
          <select
            id="dev-spk"
            onChange={(e) => void switchDev('audiooutput', e.target.value)}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-xs text-white"
          >
            {speakers.length === 0 ? <option>Default System Output</option> : null}
            {speakers.map((s, i) => (
              <option key={s.deviceId || i} value={s.deviceId}>{s.label || `Speaker ${i + 1}`}</option>
            ))}
          </select>
        </div>

        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </ModalDialog>
  );
}
