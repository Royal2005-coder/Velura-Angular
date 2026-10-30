import type { AdminBlogRow } from './admin-erp-api.service';

/**
 * Allowlist mirrored from `apps/api/src/content/blog-html.ts`.
 *
 * The API sanitizes again before storage; this browser-side copy exists so pasted web pages
 * cannot execute scripts inside the admin workspace or the live preview before a save.
 */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote',
  'ul', 'ol', 'li', 'a', 'img', 'figure', 'figcaption', 'hr', 'table', 'thead',
  'tbody', 'tr', 'th', 'td', 'span', 'div',
]);

const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math',
  'video', 'audio', 'canvas', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta',
]);

const BLOCK_SELECTOR = 'p,div,h2,h3,h4,li,ul,ol,blockquote,figure,figcaption,table,thead,tbody,tr,th,td,br';

function safeUrl(value: string, kind: 'link' | 'image'): string | null {
  const url = value.trim();
  if (!url) return null;
  if (kind === 'image') return /^https:\/\//i.test(url) ? url : null;
  if (url.startsWith('#')) return url;
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

function cleanNode(node: Element): void {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag) || tag === 'body' || tag === 'html') {
      child.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      cleanNode(child);
      child.replaceWith(...Array.from(child.childNodes));
      continue;
    }
    for (const attribute of Array.from(child.attributes)) {
      const name = attribute.name.toLowerCase();
      const allowed =
        (tag === 'a' && ['href', 'title', 'target'].includes(name)) ||
        (tag === 'img' && ['src', 'alt', 'title', 'width', 'height', 'loading'].includes(name));
      if (!allowed) {
        child.removeAttribute(attribute.name);
        continue;
      }
      if ((tag === 'a' && name === 'href') || (tag === 'img' && name === 'src')) {
        const safe = safeUrl(attribute.value, tag === 'img' ? 'image' : 'link');
        if (!safe) child.removeAttribute(attribute.name);
        else child.setAttribute(name, safe);
      }
      if (tag === 'img' && (name === 'width' || name === 'height') && !/^\d{1,4}$/.test(attribute.value.trim())) {
        child.removeAttribute(attribute.name);
      }
    }
    if (tag === 'a' && child.getAttribute('href')) {
      child.setAttribute('rel', 'noopener noreferrer');
    }
    if (tag === 'img') {
      child.setAttribute('loading', 'lazy');
      if (child.getAttribute('src') && !child.hasAttribute('alt')) child.setAttribute('alt', '');
    }
    cleanNode(child);
  }
}

/**
 * Sanitizes pasted/editor HTML for the admin preview and for the payload sent to the API.
 * Returns an empty string for falsy input and never keeps an event handler or script node.
 */
export function sanitizeEditorHtml(value: string | null | undefined): string {
  const source = String(value ?? '');
  if (!source.trim()) return '';
  if (typeof DOMParser === 'undefined') {
    return source.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const doc = new DOMParser().parseFromString(source, 'text/html');
  cleanNode(doc.body);
  return doc.body.innerHTML.trim();
}

/**
 * Plain text used for the minimum-length rule and word count. Block boundaries become spaces so
 * `<h2>A</h2><p>B</p>` never turns into the single token `AB`.
 */
export function blogEditorText(value: string | null | undefined): string {
  const source = String(value ?? '');
  if (!source.trim()) return '';
  if (typeof DOMParser === 'undefined') {
    return source.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const doc = new DOMParser().parseFromString(sanitizeEditorHtml(source), 'text/html');
  for (const block of Array.from(doc.body.querySelectorAll(BLOCK_SELECTOR))) {
    block.after(doc.createTextNode(' '));
  }
  return (doc.body.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Escapes legacy plain-text content into paragraphs the rich editor can open and edit. */
export function htmlFromPlainText(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const escape = (part: string): string =>
    part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Rich HTML for an existing row, converting posts written before the editor existed. */
export function blogRowHtml(row: Pick<AdminBlogRow, 'content_html' | 'content'>): string {
  return sanitizeEditorHtml(row.content_html) || htmlFromPlainText(row.content);
}

/** Inserts clipboard text into the contenteditable selection, escaping when no HTML was copied. */
export function pasteHtmlFromClipboard(html: string, text: string): string {
  const safe = sanitizeEditorHtml(html);
  if (safe) return safe;
  const escape = (part: string): string =>
    part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escape(text).split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`).join('');
}
