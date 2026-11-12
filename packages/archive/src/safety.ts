import { marked } from 'marked';
import { ArchiveError } from './types.js';

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sanitizeZipFilenameComponent(name: string): string {
  const cleaned = name
    .replaceAll('\u0000', '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = cleaned.replace(/^\.+/, '');
  return (safe || 'file').slice(0, 140);
}

export function validateArchiveEntryPath(entryPath: string): string {
  if (!entryPath || entryPath.length > 512) {
    throw new ArchiveError('UNSAFE_ARCHIVE_ENTRY', `Invalid archive path length: "${entryPath}"`);
  }
  if (entryPath.includes('\u0000') || entryPath.includes('\\')) {
    throw new ArchiveError('UNSAFE_ARCHIVE_ENTRY', `Forbidden separator or NUL byte in "${entryPath}"`);
  }
  if (entryPath.startsWith('/') || /^[a-zA-Z]:/.test(entryPath)) {
    throw new ArchiveError('UNSAFE_ARCHIVE_ENTRY', `Absolute path rejected: "${entryPath}"`);
  }
  const segments = entryPath.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new ArchiveError('UNSAFE_ARCHIVE_ENTRY', `Path traversal segment rejected in "${entryPath}"`);
    }
    for (let i = 0; i < seg.length; i += 1) {
      const code = seg.charCodeAt(i);
      if (code <= 0x1f || code === 0x7f) {
        throw new ArchiveError('UNSAFE_ARCHIVE_ENTRY', `Control character rejected in "${entryPath}"`);
      }
    }
  }
  return entryPath;
}

const SAFE_PREVIEW_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const SAFE_PREVIEW_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  'audio/mp4',
]);

const SAFE_PREVIEW_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
]);

export function classifySafeAttachmentRenderMode(
  mimeType: string,
  filename: string,
): 'image' | 'audio' | 'video' | 'download_only' {
  const normalizedMime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const lowerName = filename.toLowerCase();
  if (
    normalizedMime.includes('svg') ||
    normalizedMime.includes('html') ||
    normalizedMime.includes('javascript') ||
    lowerName.endsWith('.svg') ||
    lowerName.endsWith('.html') ||
    lowerName.endsWith('.htm') ||
    lowerName.endsWith('.xhtml')
  ) {
    return 'download_only';
  }
  if (SAFE_PREVIEW_IMAGE_MIMES.has(normalizedMime)) return 'image';
  if (SAFE_PREVIEW_AUDIO_MIMES.has(normalizedMime)) return 'audio';
  if (SAFE_PREVIEW_VIDEO_MIMES.has(normalizedMime)) return 'video';
  return 'download_only';
}

export function sanitizeLinkHref(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#')) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Renders markdown to offline-safe HTML cleanly without double-escaping code spans
 * or breaking blockquotes (`>`). Raw HTML blocks/inline tags are escaped as visible literal text
 * so `<script>` or `<img onerror=...>` can never execute, images inside markdown become plain text
 * (attachments are rendered strictly through Cloak's typed attachment cards), and links allow ONLY
 * http:, https:, mailto:, or same-document # anchors.
 */
export function renderSafeOfflineMarkdown(rawMarkdown: string): string {
  const renderer = new marked.Renderer();

  renderer.html = (token) => escapeHtml(token.raw ?? token.text);
  renderer.image = (token) => escapeHtml(token.text || token.href || '[image]');
  renderer.text = (token) => {
    if ('tokens' in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
      return renderer.parser.parseInline(token.tokens);
    }
    return escapeHtml(token.text);
  };
  renderer.link = (token) => {
    const safeUrl = sanitizeLinkHref(token.href);
    const label = escapeHtml(token.text || token.href);
    if (!safeUrl) {
      return `<span class="blocked-link">${label}</span>`;
    }
    return `<a href="${escapeHtml(safeUrl)}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>`;
  };

  const rendered = marked.parse(rawMarkdown, {
    async: false,
    gfm: true,
    breaks: true,
    renderer,
  });

  return typeof rendered === 'string' ? rendered : escapeHtml(rawMarkdown);
}
