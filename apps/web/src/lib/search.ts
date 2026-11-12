import MiniSearch from 'minisearch';
import type { LocalDecryptedMessage } from './storage.js';

export interface SearchDocument {
  id: string;
  roomId: string;
  channelId: string;
  senderDeviceId: string;
  text: string;
  attachmentNames: string;
  createdAt: string;
}

export type SearchResultHit = SearchDocument & { score: number };

/**
 * Strictly client-side MiniSearch inverted index over decrypted room messages.
 * Zero plaintext search queries or decrypted message contents are ever transmitted.
 */
class ClientSearchIndex {
  private readonly engine: MiniSearch<SearchDocument>;
  private readonly indexedIds = new Set<string>();
  private readonly docsById = new Map<string, SearchDocument>();

  constructor() {
    this.engine = new MiniSearch<SearchDocument>({
      fields: ['text', 'attachmentNames'],
      storeFields: ['roomId', 'channelId', 'senderDeviceId', 'text', 'createdAt'],
      searchOptions: {
        prefix: true,
        fuzzy: 0.15,
        boost: { text: 2, attachmentNames: 1 },
      },
    });
  }

  upsertMessage(msg: LocalDecryptedMessage): void {
    if (msg.deletedForMe === 1 || msg.deletedForEveryoneAt) {
      this.removeMessage(msg.id);
      return;
    }
    if (msg.expiresAt && Date.parse(msg.expiresAt) <= Date.now()) {
      this.removeMessage(msg.id);
      return;
    }

    const doc: SearchDocument = {
      id: msg.id,
      roomId: msg.roomId,
      channelId: msg.channelId,
      senderDeviceId: msg.senderDeviceId,
      text: msg.text,
      attachmentNames: msg.attachments.map((a) => a.encryptedFilename).join(' '),
      createdAt: msg.createdAt,
    };

    if (this.indexedIds.has(msg.id)) {
      this.engine.discard(msg.id);
    }
    this.engine.add(doc);
    this.indexedIds.add(msg.id);
    this.docsById.set(msg.id, doc);
  }

  upsertBatch(msgs: readonly LocalDecryptedMessage[]): void {
    for (const msg of msgs) {
      this.upsertMessage(msg);
    }
  }

  removeMessage(messageId: string): void {
    if (!this.indexedIds.has(messageId)) return;
    this.engine.discard(messageId);
    this.indexedIds.delete(messageId);
    this.docsById.delete(messageId);
  }

  removeMany(messageIds: readonly string[]): void {
    for (const id of messageIds) {
      this.removeMessage(id);
    }
  }

  removeRoom(roomId: string): void {
    const toRemove: string[] = [];
    for (const [id, doc] of this.docsById.entries()) {
      if (doc.roomId === roomId) {
        toRemove.push(id);
      }
    }
    this.removeMany(toRemove);
  }

  clearAll(): void {
    this.engine.removeAll();
    this.indexedIds.clear();
    this.docsById.clear();
  }

  searchRoom(
    roomId: string,
    query: string,
    filters?: { channelId?: string; senderDeviceId?: string },
  ): Array<SearchDocument & { score: number }> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const results = this.engine.search(trimmed, {
      filter: (result) => {
        if (result.roomId !== roomId) return false;
        if (filters?.channelId && result.channelId !== filters.channelId) return false;
        if (filters?.senderDeviceId && result.senderDeviceId !== filters.senderDeviceId) return false;
        return true;
      },
    });
    return results.map((r) => {
      const doc = this.docsById.get(String(r.id));
      return {
        id: String(r.id),
        roomId: String(r.roomId),
        channelId: String(r.channelId),
        senderDeviceId: doc?.senderDeviceId ?? String(r.senderDeviceId),
        text: doc?.text ?? String(r.text),
        attachmentNames: doc?.attachmentNames ?? '',
        createdAt: String(r.createdAt),
        score: r.score,
      };
    });
  }
}

export const clientSearch = new ClientSearchIndex();
