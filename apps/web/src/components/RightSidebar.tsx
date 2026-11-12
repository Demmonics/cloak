import React, { useEffect, useState } from 'react';
import { useDexieLiveQuery as useLiveQuery } from '../lib/useLiveQuery.js';
import {
  Ban,
  Bookmark,
  CheckCircle2,
  FileText,
  Info,
  KeyRound,
  Pin,
  Search,
  Trash2,
  UserMinus,
  Users,
  X,
} from 'lucide-react';
import { Avatar, Button, ConfirmDialog } from '@cloak/ui';
import type { RoomMemberSummary } from '@cloak/protocol';
import { api, type RoomDetailResponse } from '../lib/api.js';
import { clientSearch, type SearchResultHit } from '../lib/search.js';
import { db, type LocalDecryptedMessage } from '../lib/storage.js';
import {
  approvePendingMember,
  clearChannelAndPurge,
  removeMemberAndRotateEpoch,
  rotateRoomKeyManually,
} from '../lib/workspaceClient.js';
import { useAppStore } from '../store/useAppStore.js';

export interface RightSidebarProps {
  roomDetail: RoomDetailResponse;
  activeChannelId: string | null;
  onRefreshRoom: () => Promise<void>;
  onSendThreadReply: (root: LocalDecryptedMessage, text: string) => Promise<void>;
}

export function RightSidebar({
  roomDetail,
  activeChannelId,
  onRefreshRoom,
  onSendThreadReply,
}: RightSidebarProps) {
  const rightDrawer = useAppStore((s) => s.rightDrawer);
  const setRightDrawer = useAppStore((s) => s.setRightDrawer);
  const threadRootMessage = useAppStore((s) => s.threadRootMessage);
  const setThreadRootMessage = useAppStore((s) => s.setThreadRootMessage);
  const selectChannel = useAppStore((s) => s.selectChannel);
  const presenceByDevice = useAppStore((s) => s.presenceByDevice);
  const profile = useAppStore((s) => s.profile);
  const pushToast = useAppStore((s) => s.pushToast);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultHit[]>([]);
  const [threadText, setThreadText] = useState('');
  const [memberConfirm, setMemberConfirm] = useState<{ member: RoomMemberSummary; action: 'kick' | 'ban' } | null>(null);
  const [busyAction, setBusyAction] = useState(false);

  const room = roomDetail.room;
  const members = roomDetail.members;
  const myMember = members.find((m) => m.deviceId === profile?.id);
  const isOwner = myMember?.roleName === 'owner';
  const isModerator = isOwner || myMember?.roleName === 'admin';

  const pinnedMessages = useLiveQuery(
    () =>
      db.messages
        .where('roomId')
        .equals(room.id)
        .filter((m) => m.isPinned === 1 && m.deletedForMe === 0 && !m.deletedForEveryoneAt)
        .toArray(),
    [room.id],
    [],
  );

  const bookmarkedEntries = useLiveQuery(async () => {
    const marks = await db.bookmarks.where('roomId').equals(room.id).toArray();
    if (marks.length === 0) return [];
    const msgs = await db.messages.bulkGet(marks.map((m) => m.messageId));
    return msgs.filter((m): m is LocalDecryptedMessage => Boolean(m && m.deletedForMe === 0));
  }, [room.id], []);

  const roomMessagesWithFiles = useLiveQuery(
    () =>
      db.messages
        .where('roomId')
        .equals(room.id)
        .filter((m) => m.attachments.length > 0 && m.deletedForMe === 0 && !m.deletedForEveryoneAt)
        .toArray(),
    [room.id],
    [],
  );

  const threadReplies = useLiveQuery(
    () =>
      threadRootMessage
        ? db.messages
            .where('roomId')
            .equals(room.id)
            .filter((m) => m.threadRootId === threadRootMessage.id && m.deletedForMe === 0)
            .sortBy('createdAt')
        : Promise.resolve([]),
    [room.id, threadRootMessage?.id],
    [],
  );

  useEffect(() => {
    if (rightDrawer !== 'search') return;
    setSearchResults(clientSearch.searchRoom(room.id, searchQuery));
  }, [rightDrawer, room.id, searchQuery]);

  if (!rightDrawer && !threadRootMessage) return null;

  const activeMembers = members.filter((m) => m.status === 'active');
  const pendingMembers = members.filter((m) => m.status === 'pending_approval');

  const handleApprove = async (m: RoomMemberSummary) => {
    setBusyAction(true);
    try {
      await approvePendingMember({
        roomId: room.id,
        member: m,
        currentEpoch: room.currentEpoch,
      });
      await onRefreshRoom();
      pushToast({ tone: 'success', title: `Approved ${m.displayName}` });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Approval failed',
        detail: err instanceof Error ? err.message : 'Unable to wrap epoch key',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleConfirmRemoveMember = async () => {
    if (!memberConfirm) return;
    setBusyAction(true);
    try {
      await removeMemberAndRotateEpoch({
        roomId: room.id,
        targetDeviceId: memberConfirm.member.deviceId,
        action: memberConfirm.action,
        activeMembers,
        currentEpoch: room.currentEpoch,
      });
      setMemberConfirm(null);
      await onRefreshRoom();
      pushToast({
        tone: 'success',
        title: memberConfirm.action === 'ban' ? 'Member banned & key rotated' : 'Member removed & key rotated',
      });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Member removal failed',
        detail: err instanceof Error ? err.message : 'Operation failed',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleRotateKey = async () => {
    setBusyAction(true);
    try {
      const next = await rotateRoomKeyManually({
        roomId: room.id,
        activeMembers,
        currentEpoch: room.currentEpoch,
      });
      await onRefreshRoom();
      pushToast({
        tone: 'success',
        title: `Rotated to Encryption Epoch ${next}`,
        detail: 'New messages use a fresh XChaCha20 room epoch key.',
      });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Epoch rotation failed',
        detail: err instanceof Error ? err.message : 'Operation failed',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleThreadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!threadRootMessage || !threadText.trim()) return;
    setBusyAction(true);
    try {
      await onSendThreadReply(threadRootMessage, threadText.trim());
      setThreadText('');
    } finally {
      setBusyAction(false);
    }
  };

  const quotaPct = Math.min(100, Math.round((room.usedBytes / Math.max(1, room.quotaBytes)) * 100));

  return (
    <aside
      aria-label="Room details and utilities"
      className="w-80 shrink-0 bg-[#12151f] border-l border-[#1f2435] flex flex-col min-h-0"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#1f2435] flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-[#cbd5e1] flex items-center gap-1.5">
          {threadRootMessage ? (
            <>Thread</>
          ) : rightDrawer === 'members' ? (
            <><Users className="w-3.5 h-3.5 text-[#a5b4fc]" /> Members ({activeMembers.length})</>
          ) : rightDrawer === 'pins' ? (
            <><Pin className="w-3.5 h-3.5 text-[#a5b4fc]" /> Pinned Messages</>
          ) : rightDrawer === 'files' ? (
            <><FileText className="w-3.5 h-3.5 text-[#38bdf8]" /> Shared Files</>
          ) : rightDrawer === 'search' ? (
            <><Search className="w-3.5 h-3.5 text-[#a5b4fc]" /> Local Encrypted Search</>
          ) : rightDrawer === 'bookmarks' ? (
            <><Bookmark className="w-3.5 h-3.5 text-[#fbbf24]" /> Local Bookmarks</>
          ) : (
            <><Info className="w-3.5 h-3.5 text-[#a5b4fc]" /> Room Security & Info</>
          )}
        </span>
        <button
          type="button"
          aria-label="Close panel"
          onClick={() => {
            setThreadRootMessage(null);
            setRightDrawer(null);
          }}
          className="p-1 text-[#8d96ad] hover:text-white rounded cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Thread View takes precedence if opened */}
        {threadRootMessage && (
          <div className="space-y-3">
            <div className="rounded-xl border border-[#262c3f] bg-[#171b28] p-3 text-xs">
              <div className="text-[#8d96ad] mb-1">Root Message</div>
              <div className="text-[#f1f3f9]">{threadRootMessage.text}</div>
            </div>

            <div className="space-y-2">
              {threadReplies.map((rep: LocalDecryptedMessage) => {
                const sender = members.find((m) => m.deviceId === rep.senderDeviceId);
                return (
                  <div key={rep.id} className="rounded-lg bg-[#161a26] border border-[#23293c] p-2.5 text-xs">
                    <div className="font-semibold text-[#c4b5fd] mb-0.5">
                      {sender?.displayName || rep.senderDeviceId.slice(0, 8)}
                    </div>
                    <div className="text-[#e2e8f0]">{rep.text}</div>
                  </div>
                );
              })}
            </div>

            <form onSubmit={handleThreadSubmit} className="space-y-2">
              <label htmlFor="thread-reply-input" className="sr-only">Reply in thread</label>
              <input
                id="thread-reply-input"
                type="text"
                value={threadText}
                onChange={(e) => setThreadText(e.target.value)}
                placeholder="Reply in encrypted thread..."
                className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-xs text-white focus:border-[#7c6cff] focus:outline-none"
              />
              <Button type="submit" size="sm" variant="primary" disabled={busyAction} className="w-full">
                Send Thread Reply
              </Button>
            </form>
          </div>
        )}

        {/* Members View */}
        {!threadRootMessage && rightDrawer === 'members' && (
          <div className="space-y-4">
            {isModerator && pendingMembers.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#fbbf24]">
                  Pending Approval ({pendingMembers.length})
                </div>
                {pendingMembers.map((m) => (
                  <div
                    key={m.deviceId}
                    className="rounded-lg border border-[#f59e0b]/40 bg-[#1a1820] p-2.5 flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar name={m.displayName} color={m.avatarColor} emoji={m.avatarEmoji} size="sm" />
                      <span className="text-xs text-white truncate">{m.displayName}</span>
                    </div>
                    <Button size="sm" variant="primary" disabled={busyAction} onClick={() => void handleApprove(m)}>
                      <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              {activeMembers.map((m) => {
                const canManageTarget =
                  isModerator && m.deviceId !== profile?.id && m.roleName !== 'owner';
                return (
                  <div
                    key={m.deviceId}
                    className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-[#181c29]"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar
                        name={m.displayName}
                        color={m.avatarColor}
                        emoji={m.avatarEmoji}
                        status={presenceByDevice[m.deviceId] ?? (m.deviceId === profile?.id ? 'online' : 'offline')}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[#f1f3f9] truncate">
                          {m.displayName}
                        </div>
                        <div className="text-[10px] text-[#8d96ad] capitalize">{m.roleName}</div>
                      </div>
                    </div>

                    {canManageTarget && (
                      <div className="flex items-center gap-1 shrink-0">
                        {isOwner && (
                          <button
                            type="button"
                            title="Toggle Admin Role"
                            aria-label={`Toggle admin role for ${m.displayName}`}
                            onClick={async () => {
                              await api.updateMemberRole(
                                room.id,
                                m.deviceId,
                                m.roleName === 'admin' ? 'member' : 'admin',
                              );
                              await onRefreshRoom();
                            }}
                            className="px-1.5 py-0.5 rounded bg-[#1f2536] text-[10px] text-[#cbd5e1] hover:text-white cursor-pointer"
                          >
                            {m.roleName === 'admin' ? 'Demote' : 'Admin'}
                          </button>
                        )}
                        <button
                          type="button"
                          title="Kick & Rotate Key"
                          aria-label={`Kick ${m.displayName}`}
                          onClick={() => setMemberConfirm({ member: m, action: 'kick' })}
                          className="p-1 text-[#9aa3b8] hover:text-[#fbbf24] cursor-pointer"
                        >
                          <UserMinus className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Ban & Rotate Key"
                          aria-label={`Ban ${m.displayName}`}
                          onClick={() => setMemberConfirm({ member: m, action: 'ban' })}
                          className="p-1 text-[#f87171] hover:text-red-300 cursor-pointer"
                        >
                          <Ban className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Pins View */}
        {!threadRootMessage && rightDrawer === 'pins' && (
          <div className="space-y-2">
            {pinnedMessages.length === 0 ? (
              <p className="text-xs text-[#8d96ad]">No pinned messages cached in this room.</p>
            ) : (
              pinnedMessages.map((pm: LocalDecryptedMessage) => (
                <div key={pm.id} className="rounded-xl border border-[#262c3f] bg-[#161a26] p-3 space-y-1.5">
                  <div className="text-xs text-[#e2e8f0] break-words">{pm.text}</div>
                  <div className="flex items-center justify-between text-[10px] text-[#8d96ad]">
                    <span>{new Date(pm.createdAt).toLocaleString()}</span>
                    {isModerator && (
                      <button
                        type="button"
                        onClick={async () => {
                          await api.unpinMessage(room.id, pm.id);
                          await db.messages.update(pm.id, { isPinned: 0 });
                        }}
                        className="text-[#fca5a5] hover:underline cursor-pointer"
                      >
                        Unpin
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Shared Files View */}
        {!threadRootMessage && rightDrawer === 'files' && (
          <div className="space-y-2">
            {roomMessagesWithFiles.flatMap((m: LocalDecryptedMessage) =>
              m.attachments.map((att) => (
                <div
                  key={`${m.id}:${att.attachmentId}`}
                  className="rounded-xl border border-[#262c3f] bg-[#161a26] p-2.5 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#f1f3f9] truncate">{att.encryptedFilename}</div>
                    <div className="text-[10px] text-[#8d96ad]">
                      {(att.plaintextSizeBytes / 1024).toFixed(1)} KiB · {att.mimeType}
                    </div>
                  </div>
                  {(isModerator || m.senderDeviceId === profile?.id) && (
                    <button
                      type="button"
                      title="Delete attachment from server"
                      aria-label={`Delete ${att.encryptedFilename}`}
                      onClick={async () => {
                        await api.deleteAttachment(att.attachmentId);
                        await db.attachmentsCache.delete(att.attachmentId);
                        await onRefreshRoom();
                        pushToast({ tone: 'success', title: 'Attachment deleted from object store' });
                      }}
                      className="p-1.5 text-[#f87171] hover:bg-[#3a1a21] rounded cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )),
            )}
            {roomMessagesWithFiles.length === 0 && (
              <p className="text-xs text-[#8d96ad]">No encrypted attachments indexed in this room yet.</p>
            )}
          </div>
        )}

        {/* Client-Side Search View */}
        {!threadRootMessage && rightDrawer === 'search' && (
          <div className="space-y-3">
            <div className="rounded-lg bg-[#10131d] border border-[#23293c] p-2 text-[11px] text-[#9aa3b8]">
              Search runs 100% locally in memory. Queries and plaintext never touch the server.
            </div>
            <div>
              <label htmlFor="local-search-input" className="sr-only">Search decrypted messages</label>
              <input
                id="local-search-input"
                type="search"
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search decrypted messages & filenames..."
                className="w-full rounded-lg bg-[#0d1017] border border-[#2a3146] px-3 py-2 text-xs text-white focus:border-[#7c6cff] focus:outline-none"
              />
            </div>

            <div className="space-y-2">
              {searchResults.map((hit) => (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => selectChannel(hit.channelId)}
                  className="w-full text-left rounded-xl border border-[#262c3f] bg-[#161a26] hover:border-[#7c6cff] p-2.5 space-y-1 cursor-pointer cloak-transition"
                >
                  <div className="text-xs text-[#f1f3f9] line-clamp-3">{hit.text}</div>
                  <div className="text-[10px] text-[#8d96ad]">
                    {new Date(hit.createdAt).toLocaleString()}
                  </div>
                </button>
              ))}
              {searchQuery.trim() && searchResults.length === 0 && (
                <p className="text-xs text-[#8d96ad]">No matching decrypted messages found locally.</p>
              )}
            </div>
          </div>
        )}

        {/* Bookmarks View */}
        {!threadRootMessage && rightDrawer === 'bookmarks' && (
          <div className="space-y-2">
            {bookmarkedEntries.length === 0 ? (
              <p className="text-xs text-[#8d96ad]">No saved local bookmarks in this room.</p>
            ) : (
              bookmarkedEntries.map((bm: LocalDecryptedMessage) => (
                <div key={bm.id} className="rounded-xl border border-[#262c3f] bg-[#161a26] p-3 space-y-1.5">
                  <div className="text-xs text-[#f1f3f9] line-clamp-3">{bm.text}</div>
                  <div className="flex items-center justify-between text-[10px] text-[#8d96ad]">
                    <button
                      type="button"
                      onClick={() => selectChannel(bm.channelId)}
                      className="text-[#a5b4fc] hover:underline cursor-pointer"
                    >
                      Jump to channel
                    </button>
                    <button
                      type="button"
                      onClick={() => void db.bookmarks.delete(bm.id)}
                      className="text-[#fca5a5] hover:underline cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Room Security & Info View */}
        {!threadRootMessage && rightDrawer === 'info' && (
          <div className="space-y-3 text-xs">
            <div className="rounded-xl border border-[#262c3f] bg-[#161a26] p-3 space-y-2">
              <div className="flex justify-between">
                <span className="text-[#8d96ad]">Room Kind</span>
                <span className="text-white uppercase font-mono">{room.roomKind}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8d96ad]">Encryption Epoch</span>
                <span className="text-[#c4b5fd] font-mono">Epoch #{room.currentEpoch}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8d96ad]">Object Storage</span>
                <span className="text-white">
                  {(room.usedBytes / (1024 * 1024)).toFixed(2)} / {(room.quotaBytes / (1024 * 1024)).toFixed(0)} MiB
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-[#0d1017] overflow-hidden">
                <div className="h-full bg-[#7c6cff]" style={{ width: `${quotaPct}%` }} />
              </div>
            </div>

            {isModerator && (
              <div className="space-y-2">
                <Button variant="secondary" size="sm" onClick={handleRotateKey} disabled={busyAction} className="w-full">
                  <KeyRound className="w-3.5 h-3.5" />
                  Rotate Room Encryption Epoch
                </Button>
                {activeChannelId && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyAction}
                    onClick={async () => {
                      await clearChannelAndPurge(room.id, activeChannelId);
                      await onRefreshRoom();
                      pushToast({ tone: 'success', title: 'Channel cleared cleanly' });
                    }}
                    className="w-full text-[#fca5a5]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Clear Active Channel History
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(memberConfirm)}
        onCancel={() => setMemberConfirm(null)}
        onConfirm={handleConfirmRemoveMember}
        title={
          memberConfirm?.action === 'ban'
            ? `Ban ${memberConfirm.member.displayName}?`
            : `Remove ${memberConfirm?.member.displayName}?`
        }
        description="Removes member access immediately and rotates the room's XChaCha20 encryption key to a new epoch so the removed device cannot decrypt future messages."
        confirmLabel={memberConfirm?.action === 'ban' ? 'Ban & Rotate Key' : 'Kick & Rotate Key'}
        destructive
        busy={busyAction}
      />
    </aside>
  );
}
