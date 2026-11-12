// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../lib/storage.js', () => ({
  db: {
    drafts: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    messages: {
      where: vi.fn(),
    },
  },
}));

const mockBuildRoomExportInput = vi.fn();
const mockUploadEncryptedAttachment = vi.fn();
vi.mock('../lib/workspaceClient.js', () => ({
  buildRoomExportInput: (...args: unknown[]) => mockBuildRoomExportInput(...args),
  uploadEncryptedAttachment: (...args: unknown[]) => mockUploadEncryptedAttachment(...args),
}));

const mockRunExportInWorker = vi.fn();
const mockOpenArchiveInWorker = vi.fn();
vi.mock('../lib/exportWorkerClient.js', () => ({
  runExportInWorker: (...args: unknown[]) => mockRunExportInWorker(...args),
  openArchiveInWorker: (...args: unknown[]) => mockOpenArchiveInWorker(...args),
}));

import { MessageComposer } from './MessageComposer.js';
import { ExportChatModal } from './modals/ExportChatModal.js';
import { ArchiveViewerPage } from '../pages/ArchiveViewerPage.js';
import type { RoomDetailResponse } from '../lib/api.js';

beforeAll(() => {
  if (typeof HTMLDialogElement !== 'undefined') {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
  }
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MessageComposer IME and Enter submission', () => {
  it('blocks Enter submission during IME composition (isComposing / keyCode 229) and submits on normal Enter', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onSaveEdit = vi.fn().mockResolvedValue(undefined);
    const onTypingChange = vi.fn();

    render(
      <MessageComposer
        roomId="room-1"
        channelId="chan-1"
        channelName="general"
        currentEpoch={1}
        canSend={true}
        onSend={onSend}
        onSaveEdit={onSaveEdit}
        onTypingChange={onTypingChange}
      />,
    );

    const textarea = screen.getByLabelText('Message #general') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello world' } });

    // IME composition active -> Enter must NOT submit
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();

    // Chromium legacy IME keyCode 229 -> Enter must NOT submit
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();

    // Shift+Enter newline -> must NOT submit
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    // Normal Enter -> submits via requestSubmit
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false, isComposing: false });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello world',
        attachments: [],
      }),
    );
  });
});

describe('ExportChatModal mandatory password validation', () => {
  const roomDetail: RoomDetailResponse = {
    room: {
      id: 'room-1',
      roomKind: 'group',
      name: 'Alpha Vault',
      description: 'Test encrypted room',
      ownerDeviceId: 'dev-1',
      currentEpoch: 1,
      defaultDisappearSeconds: null,
      quotaBytes: 512 * 1024 * 1024,
      usedBytes: 0,
      nextEventSeq: 1,
      myRole: 'owner',
      myStatus: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      channels: [
        {
          id: 'chan-1',
          roomId: 'room-1',
          categoryName: null,
          name: 'general',
          topic: '',
          channelType: 'text',
          position: 0,
          isPrivate: false,
          slowModeSeconds: 0,
          disappearSeconds: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    },
    members: [],
    myEpochEnvelopes: [],
  };

  it('requires a >= 8 char matching password before encrypting & exporting', async () => {
    mockBuildRoomExportInput.mockResolvedValue({
      roomId: 'room-1',
      roomDisplayName: 'Alpha Vault',
      currentEpoch: 1,
      exporterDeviceId: 'dev-1',
      exporterDisplayName: 'Alice',
      channels: [],
      messages: [],
      members: [],
      attachments: [],
      options: {
        format: 'complete',
        scope: 'all',
        includeAttachments: true,
        containerMode: 'cloakexport',
        password: 'StrongPassword!42',
      },
    });
    mockRunExportInWorker.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'alpha.cloakexport',
      mimeType: 'application/octet-stream',
      manifest: { includedMessageCount: 0, includedAttachmentCount: 0 },
    });

    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => 'blob:test');
      URL.revokeObjectURL = vi.fn();
    }

    render(
      <ExportChatModal
        open={true}
        onClose={vi.fn()}
        roomDetail={roomDetail}
        activeChannelId="chan-1"
      />,
    );

    const exportBtn = screen.getByRole('button', { name: /Encrypt & Export Archive/i });
    expect(exportBtn).toBeDisabled();

    const pw1 = screen.getByLabelText(/^Archive Password/i);
    const pw2 = screen.getByLabelText(/^Confirm Archive Password/i);

    // Mismatched passwords stay disabled
    fireEvent.change(pw1, { target: { value: 'StrongPassword!42' } });
    fireEvent.change(pw2, { target: { value: 'DifferentPass!99' } });
    expect(exportBtn).toBeDisabled();

    // Matching valid passwords enable export
    fireEvent.change(pw2, { target: { value: 'StrongPassword!42' } });
    expect(exportBtn).not.toBeDisabled();

    fireEvent.click(exportBtn);
    await waitFor(() => {
      expect(mockBuildRoomExportInput).toHaveBeenCalledTimes(1);
      expect(mockRunExportInWorker).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ArchiveViewerPage offline decryption and integrity display', () => {
  it('shows error on wrong/tampered archive and renders verified metadata on valid unlock', async () => {
    render(
      <MemoryRouter>
        <ArchiveViewerPage />
      </MemoryRouter>,
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const mockFile = new File([new Uint8Array([67, 76, 75, 49])], 'chat.cloakexport', {
      type: 'application/octet-stream',
    });
    Object.defineProperty(mockFile, 'arrayBuffer', {
      value: async () => new Uint8Array([67, 76, 75, 49]).buffer,
    });

    fireEvent.change(fileInput, { target: { files: [mockFile] } });

    const unlockBtn = await screen.findByRole('button', { name: /Unlock Archive/i });
    await waitFor(() => expect(unlockBtn).not.toBeDisabled());

    const pwInput = screen.getByLabelText(/Archive Password/i);
    fireEvent.change(pwInput, { target: { value: 'wrong-password' } });

    mockOpenArchiveInWorker.mockRejectedValueOnce(new Error('WRONG_PASSWORD_OR_CORRUPT'));
    fireEvent.click(unlockBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('WRONG_PASSWORD_OR_CORRUPT');

    mockOpenArchiveInWorker.mockResolvedValueOnce({
      containerMode: 'cloakexport',
      integritySha256: {
        'manifest.json': '0123456789abcdef',
        'messages.json': 'fedcba9876543210',
      },
      manifest: {
        formatVersion: 1,
        containerMode: 'cloakexport',
        exportFormat: 'complete',
        exportScope: 'all',
        roomId: 'room-1',
        roomDisplayName: 'Private Lounge',
        exporterDeviceId: 'dev-1',
        exporterDisplayName: 'Alice',
        createdAtUtc: '2026-01-01T12:00:00Z',
        timezone: 'UTC',
        syncCursorSeq: 42,
        encryptionEpoch: 1,
        isHistoricalOfflineSnapshot: true,
        warnings: [],
        participants: [{ deviceId: 'dev-1', displayName: 'Alice', roleName: 'owner' }],
        includedMessageCount: 1,
        includedAttachmentCount: 0,
        attachmentManifest: [],
      },
      messagesDoc: {
        room: { id: 'room-1', displayName: 'Private Lounge', currentEpoch: 1 },
        channels: [{ id: 'c1', name: 'general', kind: 'text' }],
        members: [],
        messages: [
          {
            id: 'm1',
            channelId: 'c1',
            channelName: 'general',
            senderDeviceId: 'dev-1',
            senderDisplayName: 'Alice',
            createdAtUtc: '2026-01-01T12:00:00Z',
            editedAtUtc: null,
            text: 'Top secret offline archive check',
            encryptionEpoch: 1,
            replyToMessageId: null,
            replyPreviewText: null,
            signatureVerified: true,
            reactions: [],
            attachments: [],
          },
        ],
      },
      htmlContent: '<!doctype html><html><body>offline</body></html>',
      attachments: new Map(),
      integrityVerified: true,
      integrityErrors: [],
    });

    fireEvent.change(pwInput, { target: { value: 'correct-password' } });
    fireEvent.click(unlockBtn);

    expect(await screen.findByText('Private Lounge')).toBeInTheDocument();
    expect(screen.getByText('Integrity SHA-256 Verified')).toBeInTheDocument();
    expect(screen.getByText('Top secret offline archive check')).toBeInTheDocument();
    expect(screen.getByText('Historical Offline Snapshot')).toBeInTheDocument();
  });
});
