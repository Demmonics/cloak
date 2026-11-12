import React, { useState } from 'react';
import { DISAPPEARING_MESSAGE_OPTIONS } from '@cloak/config';
import { Button, ModalDialog } from '@cloak/ui';
import type { RoomDetailResponse } from '../../lib/api.js';
import { createEncryptedRoom } from '../../lib/workspaceClient.js';
import { useAppStore } from '../../store/useAppStore.js';

export function CreateRoomModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (detail: RoomDetailResponse) => Promise<void>;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [name, setName] = useState('');
  const [roomKind, setRoomKind] = useState<'dm' | 'group' | 'community'>('group');
  const [description, setDescription] = useState('');
  const [disappearSeconds, setDisappearSeconds] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Room name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const detail = await createEncryptedRoom({
        name: name.trim(),
        roomKind,
        description: description.trim(),
        defaultDisappearSeconds: disappearSeconds ? Number(disappearSeconds) : null,
      });
      await onCreated(detail);
      setName('');
      setDescription('');
      setDisappearSeconds('');
      onClose();
      pushToast({
        tone: 'success',
        title: `Created "${detail.room.name}"`,
        detail: 'Epoch 1 XChaCha20 key generated locally.',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="Create Private Encrypted Room"
      description="Generates a local room encryption key (Epoch 1) wrapped exclusively for authorized devices."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div role="alert" className="rounded-lg border border-[#ef4444]/50 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#fca5a5]">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="create-room-kind" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
            Workspace Type
          </label>
          <select
            id="create-room-kind"
            value={roomKind}
            onChange={(e) => setRoomKind(e.target.value as 'dm' | 'group' | 'community')}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white focus:border-[#7c6cff] focus:outline-none"
          >
            <option value="dm">1:1 Direct Message</option>
            <option value="group">Private Group</option>
            <option value="community">Multi-Channel Community</option>
          </select>
        </div>

        <div>
          <label htmlFor="create-room-name" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
            Room Name
          </label>
          <input
            id="create-room-name"
            type="text"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Zero-Trust Lounge"
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white focus:border-[#7c6cff] focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="create-room-desc" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
            Description (optional)
          </label>
          <input
            id="create-room-desc"
            type="text"
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white focus:border-[#7c6cff] focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="create-room-disappear" className="block text-xs font-medium text-[#cbd5e1] mb-1.5">
            Default Disappearing Message Timer
          </label>
          <select
            id="create-room-disappear"
            value={disappearSeconds}
            onChange={(e) => setDisappearSeconds(e.target.value)}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white focus:border-[#7c6cff] focus:outline-none"
          >
            {DISAPPEARING_MESSAGE_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.seconds === null ? '' : String(opt.seconds)}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Creating...' : 'Create Encrypted Room'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

