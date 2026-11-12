import { marked } from 'marked';

const SAFE_ELEMENTS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  's',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'a',
  'span',
] as const;

const SAFE_TAGS_SET = new Set<string>(SAFE_ELEMENTS);

function escapeHtmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isSafeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') {
      return u.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function renderMarkdownToUnsafeHtml(rawMarkdown: string): string {
  const renderer = new marked.Renderer();
  renderer.html = (token) => escapeHtmlText(token.raw ?? token.text);
  renderer.image = (token) => escapeHtmlText(token.text || token.href || '[image]');
  renderer.text = (token) => {
    if ('tokens' in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
      return renderer.parser.parseInline(token.tokens);
    }
    return escapeHtmlText(token.text);
  };
  renderer.link = (token) => {
    const safeUrl = isSafeHref(token.href);
    const label = escapeHtmlText(token.text || token.href);
    if (!safeUrl) {
      return `<span class="text-[#9aa3b8]">${label}</span>`;
    }
    return `<a href="${escapeHtmlText(safeUrl)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
  };

  const out = marked.parse(rawMarkdown, {
    async: false,
    gfm: true,
    breaks: true,
    renderer,
  });
  return typeof out === 'string' ? out : escapeHtmlText(rawMarkdown);
}

let cachedPurify: typeof import('dompurify').default | null = null;

/**
 * Sanitizes rendered HTML following Modern Web Guidance:
 * Uses native Sanitizer / Element#setHTML when supported, and dynamically imports
 * DOMPurify only when native support is absent with ALLOW_ARIA_ATTR=false,
 * ALLOW_DATA_ATTR=false, KEEP_CONTENT=false, and '#text' allowlisted.
 */
export async function sanitizeUntrustedHtml(html: string): Promise<string> {
  if (typeof document === 'undefined') {
    return html;
  }

  const hasNativeSanitizer =
    'setHTML' in Element.prototype && typeof (globalThis as { Sanitizer?: unknown }).Sanitizer === 'function';

  if (hasNativeSanitizer) {
    try {
      const container = document.createElement('div') as HTMLDivElement & {
        setHTML: (input: string, opts?: unknown) => void;
      };
      const SanitizerCtor = (globalThis as unknown as { Sanitizer: new (cfg: unknown) => unknown }).Sanitizer;
      const sanitizer = new SanitizerCtor({
        elements: [...SAFE_ELEMENTS],
        attributes: [
          { name: 'href', elements: ['a'] },
          { name: 'rel', elements: ['a'] },
          { name: 'target', elements: ['a'] },
          { name: 'class', elements: ['span', 'code'] },
        ],
      });
      container.setHTML(html, { sanitizer });
      container.querySelectorAll('a').forEach((anchor) => {
        const href = anchor.getAttribute('href') || '';
        const safe = isSafeHref(href);
        if (!safe) {
          anchor.removeAttribute('href');
        } else {
          anchor.setAttribute('href', safe);
          anchor.setAttribute('rel', 'noopener noreferrer nofollow');
          anchor.setAttribute('target', '_blank');
        }
      });
      return container.innerHTML;
    } catch {
      // Fallback cleanly to DOMPurify if native Sanitizer signature differs
    }
  }

  if (!cachedPurify) {
    const mod = await import('dompurify');
    cachedPurify = mod.default;
  }

  const clean = cachedPurify.sanitize(html, {
    ALLOWED_TAGS: [...SAFE_TAGS_SET, '#text'],
    ALLOWED_ATTR: ['href', 'rel', 'target', 'class'],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: false,
  });
  return clean;
}

