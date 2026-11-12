import type { ExportManifest } from '@cloak/protocol';
import {
  classifySafeAttachmentRenderMode,
  escapeHtml,
  renderSafeOfflineMarkdown,
  sanitizeZipFilenameComponent,
} from './safety.js';
import type {
  ArchiveMessagesDocument,
  ExportBuildInput,
  ExportMessageRecord,
} from './types.js';

export function formatTimestampLocal(isoUtc: string, timezone: string): string {
  try {
    const dt = new Date(isoUtc);
    if (Number.isNaN(dt.getTime())) return isoUtc;
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(dt);
  } catch {
    return isoUtc;
  }
}

export function isMessageActiveForExport(msg: ExportMessageRecord, nowMs: number): boolean {
  if (msg.deletedForMe) return false;
  if (msg.deletedForEveryoneAtUtc) return false;
  if (msg.expiresAtUtc) {
    const exp = Date.parse(msg.expiresAtUtc);
    if (!Number.isNaN(exp) && exp <= nowMs) return false;
  }
  return true;
}

export function filterMessagesForExport(
  input: ExportBuildInput,
  nowMs = Date.now(),
): ExportMessageRecord[] {
  const selectedChannelSet = input.options.selectedChannelIds?.length
    ? new Set(input.options.selectedChannelIds)
    : null;
  const selectedMessageSet = input.options.selectedMessageIds?.length
    ? new Set(input.options.selectedMessageIds)
    : null;

  const startMs = input.options.dateRangeStartUtc ? Date.parse(input.options.dateRangeStartUtc) : null;
  const endMs = input.options.dateRangeEndUtc ? Date.parse(input.options.dateRangeEndUtc) : null;

  return input.messages
    .filter((msg) => {
      if (!isMessageActiveForExport(msg, nowMs)) return false;
      if (input.options.scope === 'selected') {
        const matchChannel = selectedChannelSet?.has(msg.channelId) ?? false;
        const matchMessage = selectedMessageSet?.has(msg.id) ?? false;
        if (!matchChannel && !matchMessage) return false;
      }
      if (input.options.scope === 'date_range') {
        const ts = Date.parse(msg.createdAtUtc);
        if (startMs !== null && !Number.isNaN(startMs) && ts < startMs) return false;
        if (endMs !== null && !Number.isNaN(endMs) && ts > endMs) return false;
      }
      return true;
    })
    .sort((a, b) => Date.parse(a.createdAtUtc) - Date.parse(b.createdAtUtc));
}

export interface PackagedAttachmentPlan {
  archivePath: string | null;
  filename: string;
  mimeType: string;
  plaintextSizeBytes: number;
  plaintextSha256Hex: string;
  bytes?: Uint8Array;
  unavailableReason: string | null;
}

export function buildAttachmentArchivePlans(
  messages: readonly ExportMessageRecord[],
  includeAttachments: boolean,
): {
  plansByMessageAndId: Map<string, PackagedAttachmentPlan[]>;
  uniqueFiles: Array<{ archivePath: string; bytes: Uint8Array; mimeType: string; sha256Hex: string }>;
  totalBytes: number;
} {
  const usedPaths = new Set<string>();
  const dedupeByAttId = new Map<string, { archivePath: string; bytes: Uint8Array; mimeType: string; sha256Hex: string }>();
  const plansByMessageAndId = new Map<string, PackagedAttachmentPlan[]>();
  let totalBytes = 0;

  for (const msg of messages) {
    const plans: PackagedAttachmentPlan[] = [];
    for (const att of msg.attachments) {
      if (!includeAttachments) {
        plans.push({
          archivePath: null,
          filename: att.filename,
          mimeType: att.mimeType,
          plaintextSizeBytes: att.plaintextSizeBytes,
          plaintextSha256Hex: att.plaintextSha256Hex,
          unavailableReason: 'Excluded by export options',
        });
        continue;
      }

      const existing = dedupeByAttId.get(att.attachmentId);
      if (existing) {
        plans.push({
          archivePath: existing.archivePath,
          filename: att.filename,
          mimeType: att.mimeType,
          plaintextSizeBytes: att.plaintextSizeBytes,
          plaintextSha256Hex: att.plaintextSha256Hex,
          bytes: existing.bytes,
          unavailableReason: null,
        });
        continue;
      }

      if (!att.bytes) {
        plans.push({
          archivePath: null,
          filename: att.filename,
          mimeType: att.mimeType,
          plaintextSizeBytes: att.plaintextSizeBytes,
          plaintextSha256Hex: att.plaintextSha256Hex,
          unavailableReason: att.unavailableReason ?? 'Attachment unavailable locally or on server',
        });
        continue;
      }

      const safeBase = sanitizeZipFilenameComponent(att.filename);
      let candidate = `attachments/${att.attachmentId.slice(0, 8)}-${safeBase}`;
      let suffix = 1;
      while (usedPaths.has(candidate)) {
        candidate = `attachments/${att.attachmentId.slice(0, 8)}-${suffix}-${safeBase}`;
        suffix++;
      }
      usedPaths.add(candidate);
      totalBytes += att.bytes.byteLength;
      dedupeByAttId.set(att.attachmentId, {
        archivePath: candidate,
        bytes: att.bytes,
        mimeType: att.mimeType,
        sha256Hex: att.plaintextSha256Hex,
      });

      plans.push({
        archivePath: candidate,
        filename: att.filename,
        mimeType: att.mimeType,
        plaintextSizeBytes: att.plaintextSizeBytes,
        plaintextSha256Hex: att.plaintextSha256Hex,
        bytes: att.bytes,
        unavailableReason: null,
      });
    }
    plansByMessageAndId.set(msg.id, plans);
  }

  return {
    plansByMessageAndId,
    uniqueFiles: Array.from(dedupeByAttId.values()),
    totalBytes,
  };
}

export function buildMessagesDocument(
  manifest: ExportManifest,
  input: ExportBuildInput,
  filteredMessages: readonly ExportMessageRecord[],
  plansByMessage: ReadonlyMap<string, PackagedAttachmentPlan[]>,
): ArchiveMessagesDocument {
  return {
    manifest,
    channels: input.channels,
    messages: filteredMessages.map((msg) => {
      const plans = plansByMessage.get(msg.id) ?? [];
      return {
        id: msg.id,
        channelId: msg.channelId,
        channelName: msg.channelName,
        senderDeviceId: msg.senderDeviceId,
        senderDisplayName: msg.senderDisplayName,
        createdAtUtc: msg.createdAtUtc,
        editedAtUtc: msg.editedAtUtc,
        text: msg.text,
        replyToMessageId: msg.replyToMessageId ?? null,
        replyPreviewText: msg.replyPreviewText ?? null,
        threadRootId: msg.threadRootId ?? null,
        isPinned: Boolean(msg.isPinned),
        reactions: msg.reactions,
        signatureVerified: msg.signatureVerified,
        attachments: plans.map((p, idx) => ({
          attachmentId: msg.attachments[idx]?.attachmentId ?? `att-${idx}`,
          filename: p.filename,
          archivePath: p.archivePath,
          mimeType: p.mimeType,
          plaintextSizeBytes: p.plaintextSizeBytes,
          plaintextSha256Hex: p.plaintextSha256Hex,
          unavailableReason: p.unavailableReason,
        })),
      };
    }),
  };
}

export function buildPlainTextTranscript(
  doc: ArchiveMessagesDocument,
  timezone: string,
): string {
  const lines: string[] = [];
  lines.push('====================================================================');
  lines.push(`CLOAK CHAT TRANSCRIPT — ${doc.manifest.roomDisplayName}`);
  lines.push(`Room ID: ${doc.manifest.roomId}`);
  lines.push(`Exported (UTC): ${doc.manifest.createdAtUtc}`);
  lines.push(`Display Timezone: ${timezone}`);
  lines.push(`Messages: ${doc.manifest.includedMessageCount} | Attachments: ${doc.manifest.includedAttachmentCount}`);
  if (doc.manifest.isHistoricalOfflineSnapshot) {
    lines.push(
      `[WARNING] HISTORICAL OFFLINE SNAPSHOT: Synced up to seq ${doc.manifest.syncCursorSeq} (${doc.manifest.lastSuccessfulSyncAtUtc ?? 'unknown'}). Server deletions made while offline may not be reflected.`,
    );
  }
  lines.push('====================================================================');
  lines.push('');

  const sortedByChannelThenTime = [...doc.messages].sort((a, b) => {
    if (a.channelId === b.channelId) {
      return Date.parse(a.createdAtUtc) - Date.parse(b.createdAtUtc);
    }
    return a.channelId.localeCompare(b.channelId);
  });

  let lastChannel = '';
  for (const msg of sortedByChannelThenTime) {
    if (msg.channelId !== lastChannel) {
      lastChannel = msg.channelId;
      lines.push(`--- #${msg.channelName} ---`);
    }
    const ts = formatTimestampLocal(msg.createdAtUtc, timezone);
    const edited = msg.editedAtUtc ? ' (edited)' : '';
    const pinned = msg.isPinned ? ' [PINNED]' : '';
    const sig = msg.signatureVerified ? '' : ' [UNVERIFIED SIG]';
    lines.push(`[${ts}] ${msg.senderDisplayName}${edited}${pinned}${sig}`);
    if (msg.replyToMessageId) {
      lines.push(`  ↳ Replying to ${msg.replyToMessageId}${msg.replyPreviewText ? `: "${msg.replyPreviewText}"` : ''}`);
    }
    if (msg.text) {
      for (const tLine of msg.text.split('\n')) {
        lines.push(`  ${tLine}`);
      }
    }
    for (const att of msg.attachments) {
      lines.push(
        `  [Attachment: ${att.filename} (${att.mimeType}, ${att.plaintextSizeBytes} B) -> ${att.archivePath ?? att.unavailableReason ?? 'unavailable'}]`,
      );
    }
    if (msg.reactions.length > 0) {
      lines.push(`  Reactions: ${msg.reactions.map((r) => `${r.emoji} (${r.count})`).join(' ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function buildOfflineSafeHtml(
  doc: ArchiveMessagesDocument,
  timezone: string,
): string {
  const sortedByChannelThenTime = [...doc.messages].sort((a, b) => {
    if (a.channelId === b.channelId) {
      return Date.parse(a.createdAtUtc) - Date.parse(b.createdAtUtc);
    }
    return a.channelId.localeCompare(b.channelId);
  });

  const channelCounts = new Map<string, { name: string; count: number }>();
  for (const msg of sortedByChannelThenTime) {
    const existing = channelCounts.get(msg.channelId);
    if (existing) existing.count++;
    else channelCounts.set(msg.channelId, { name: msg.channelName, count: 1 });
  }

  const channelLinksHtml = Array.from(channelCounts.entries())
    .map(
      ([cid, info]) =>
        `<li><a href="#channel-${escapeHtml(cid)}"># ${escapeHtml(info.name)} <span>(${info.count})</span></a></li>`,
    )
    .join('\n');

  const messagesByChannelHtml: string[] = [];
  let currentChannelId = '';
  for (const msg of sortedByChannelThenTime) {
    if (msg.channelId !== currentChannelId) {
      if (currentChannelId) messagesByChannelHtml.push('</section>');
      currentChannelId = msg.channelId;
      messagesByChannelHtml.push(
        `<section id="channel-${escapeHtml(msg.channelId)}" class="channel-group"><h2># ${escapeHtml(msg.channelName)}</h2>`,
      );
    }

    const replyBlock = msg.replyToMessageId
      ? `<div class="reply">Replying to <a href="#msg-${escapeHtml(msg.replyToMessageId)}">${escapeHtml(msg.replyPreviewText || msg.replyToMessageId)}</a></div>`
      : '';

    const attachmentsHtml = msg.attachments
      .map((att) => {
        if (!att.archivePath) {
          return `<div class="att unavailable">[Attachment unavailable: ${escapeHtml(att.filename)} — ${escapeHtml(att.unavailableReason || 'not stored')}]</div>`;
        }
        const mode = classifySafeAttachmentRenderMode(att.mimeType, att.filename);
        const relPath = `./${escapeHtml(att.archivePath)}`;
        const nameEsc = escapeHtml(att.filename);
        if (mode === 'image') {
          return `<figure class="att"><img src="${relPath}" alt="${nameEsc}" loading="lazy" /><figcaption><a href="${relPath}" download="${nameEsc}">${nameEsc}</a> (${att.plaintextSizeBytes} B)</figcaption></figure>`;
        }
        if (mode === 'audio') {
          return `<div class="att"><audio controls src="${relPath}"></audio><div><a href="${relPath}" download="${nameEsc}">${nameEsc}</a></div></div>`;
        }
        if (mode === 'video') {
          return `<div class="att"><video controls src="${relPath}"></video><div><a href="${relPath}" download="${nameEsc}">${nameEsc}</a></div></div>`;
        }
        return `<div class="att"><a href="${relPath}" download="${nameEsc}">Download ${nameEsc}</a> <span>(${escapeHtml(att.mimeType)}, ${att.plaintextSizeBytes} B)</span></div>`;
      })
      .join('');

    const reactionsHtml =
      msg.reactions.length > 0
        ? `<div class="reactions">${msg.reactions
            .map((r) => `<span class="chip">${escapeHtml(r.emoji)} ${r.count}</span>`)
            .join('')}</div>`
        : '';

    const badges = [
      msg.editedAtUtc ? '<span class="badge">edited</span>' : '',
      msg.isPinned ? '<span class="badge">pinned</span>' : '',
      msg.signatureVerified ? '' : '<span class="badge warn">unverified signature</span>',
    ].join('');

    messagesByChannelHtml.push(`
      <article id="msg-${escapeHtml(msg.id)}" class="message">
        <header class="msg-head">
          <strong>${escapeHtml(msg.senderDisplayName)}</strong>
          <time datetime="${escapeHtml(msg.createdAtUtc)}">${escapeHtml(formatTimestampLocal(msg.createdAtUtc, timezone))}</time>
          ${badges}
        </header>
        ${replyBlock}
        <div class="msg-body">${renderSafeOfflineMarkdown(msg.text)}</div>
        ${attachmentsHtml}
        ${reactionsHtml}
      </article>
    `);
  }
  if (currentChannelId) messagesByChannelHtml.push('</section>');

  const snapshotBanner = doc.manifest.isHistoricalOfflineSnapshot
    ? `<div class="banner warn"><strong>Historical Offline Snapshot:</strong> Exported without server sync (${escapeHtml(doc.manifest.lastSuccessfulSyncAtUtc ?? 'no sync timestamp')}). Messages deleted elsewhere while offline may still appear in this snapshot.</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';" />
  <title>Cloak Archive — ${escapeHtml(doc.manifest.roomDisplayName)}</title>
  <style>
    :root { color-scheme: dark; --bg: #0f1116; --panel: #161922; --border: #262b38; --text: #ebedf2; --muted: #98a2b3; --accent: #7c6cff; --warn: #f59e0b; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.55; }
    .layout { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }
    aside { background: var(--panel); border-right: 1px solid var(--border); padding: 1.25rem; position: sticky; top: 0; max-height: 100vh; overflow-y: auto; }
    aside h1 { font-size: 1.1rem; margin: 0 0 .35rem; }
    aside .meta { color: var(--muted); font-size: .82rem; margin-bottom: 1rem; }
    aside ul { list-style: none; padding: 0; margin: 0; display: grid; gap: .35rem; }
    aside a { color: var(--text); text-decoration: none; display: flex; justify-content: space-between; padding: .4rem .6rem; border-radius: .45rem; }
    aside a:hover { background: rgba(124, 108, 255, .14); }
    main { padding: 1.5rem 2rem; max-width: 960px; }
    .banner { padding: .8rem 1rem; border-radius: .6rem; border: 1px solid var(--border); margin-bottom: 1.25rem; background: var(--panel); }
    .banner.warn { border-color: var(--warn); }
    .channel-group h2 { font-size: 1rem; border-bottom: 1px solid var(--border); padding-bottom: .4rem; margin: 1.75rem 0 1rem; color: #c4b5fd; }
    .message { padding: .75rem 1rem; margin-bottom: .7rem; border: 1px solid var(--border); border-radius: .65rem; background: var(--panel); }
    .msg-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .55rem; margin-bottom: .35rem; }
    .msg-head time { color: var(--muted); font-size: .78rem; }
    .badge { font-size: .72rem; background: rgba(124,108,255,.18); color: #d8d0ff; padding: .1rem .4rem; border-radius: .35rem; }
    .badge.warn { background: rgba(245,158,11,.2); color: #fcd34d; }
    .reply { font-size: .82rem; color: var(--muted); border-left: 2px solid var(--accent); padding-left: .55rem; margin-bottom: .35rem; }
    .reply a { color: #c4b5fd; }
    .msg-body pre { background: #0a0c10; padding: .75rem; border-radius: .45rem; overflow-x: auto; }
    .msg-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; }
    .msg-body a { color: #93c5fd; }
    .att { margin-top: .55rem; padding: .5rem; border: 1px solid var(--border); border-radius: .45rem; background: #10131b; }
    .att img, .att video { max-width: 100%; max-height: 420px; border-radius: .35rem; display: block; }
    .att figcaption { font-size: .8rem; color: var(--muted); margin-top: .3rem; }
    .reactions { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .45rem; }
    .chip { font-size: .8rem; background: #1e2330; border: 1px solid var(--border); padding: .15rem .45rem; border-radius: 999px; }
    @media (max-width: 780px) { .layout { grid-template-columns: 1fr; } aside { position: static; max-height: none; border-right: 0; border-bottom: 1px solid var(--border); } main { padding: 1rem; } }
    @media print { aside { display: none; } body { background: #fff; color: #111; } .message { break-inside: avoid; background: #fff; border-color: #ccc; } }
  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <h1>${escapeHtml(doc.manifest.roomDisplayName)}</h1>
      <div class="meta">
        <div>Exported: ${escapeHtml(formatTimestampLocal(doc.manifest.createdAtUtc, timezone))}</div>
        <div>Messages: ${doc.manifest.includedMessageCount}</div>
        <div>Attachments: ${doc.manifest.includedAttachmentCount}</div>
      </div>
      <nav aria-label="Archived channels">
        <ul>${channelLinksHtml}</ul>
      </nav>
    </aside>
    <main>
      ${snapshotBanner}
      ${messagesByChannelHtml.join('\n') || '<p>No active messages matched this export scope.</p>'}
    </main>
  </div>
</body>
</html>`;
}
