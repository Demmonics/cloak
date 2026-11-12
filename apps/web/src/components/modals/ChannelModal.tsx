import React, { useState } from 'react';
import { DISAPPEARING_MESSAGE_OPTIONS } from '@cloak/config';
import { Button, ModalDialog } from '@cloak/ui';
import { api } from '../../lib/api.js';
import { useAppStore } from '../../store/useAppStore.js';

export function CreateChannelModal({
  open,
  onClose,
  roomId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  roomId: string;
  onCreated: () => Promise<void>;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [name, setName] = useState('');
  const [channelType, setChannelType] = useState<'text' | 'voice' | 'announcement'>('text');
  const [topic, setTopic] = useState('');
  const [disappearSeconds, setDisappearSeconds] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Channel name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createChannel(roomId, {
        name: name.trim(),
        channelType,
        topic: topic.trim(),
        disappearSeconds: disappearSeconds ? Number(disappearSeconds) : null,
      });
      await onCreated();
      setName('');
      setTopic('');
      setDisappearSeconds('');
      onClose();
      pushToast({ tone: 'success', title: `Created #${name.trim()}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create channel');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog open={open} onClose={onClose} title="Create Encrypted Channel">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div role="alert" className="rounded-lg border border-[#ef4444]/50 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#fca5a5]">
            {error}
          </div>
        )}
        <div>
          <label htmlFor="ch-type" className="block text-xs font-medium text-[#cbd5e1] mb-1">Channel Type</label>
          <select
            id="ch-type"
            value={channelType}
            onChange={(e) => setChannelType(e.target.value as 'text' | 'voice' | 'announcement')}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
          >
            <option value="text">Text Channel</option>
            <option value="voice">Voice & Video Channel</option>
            <option value="announcement">Announcement Channel</option>
          </select>
        </div>

        <div>
          <label htmlFor="ch-name" className="block text-xs font-medium text-[#cbd5e1] mb-1">Name</label>
          <input
            id="ch-name"
            type="text"
            required
            maxLength={64}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. ops-review"
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
          />
        </div>

        <div>
          <label htmlFor="ch-topic" className="block text-xs font-medium text-[#cbd5e1] mb-1">Topic (optional)</label>
          <input
            id="ch-topic"
            type="text"
            maxLength={256}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
          />
        </div>

        <div>
          <label htmlFor="ch-disappear" className="block text-xs font-medium text-[#cbd5e1] mb-1">
            Channel Disappearing Policy
          </label>
          <select
            id="ch-disappear"
            value={disappearSeconds}
            onChange={(e) => setDisappearSeconds(e.target.value)}
            className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-sm text-white"
          >
            {DISAPPEARING_MESSAGE_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.seconds === null ? '' : String(opt.seconds)}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Creating...' : 'Create Channel'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

