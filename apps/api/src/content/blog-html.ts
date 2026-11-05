import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "article", "section", "h1", "h2", "h3", "h4", "p", "br", "strong", "b", "em", "i", "u", "s", "blockquote",
  "ul", "ol", "li", "a", "img", "figure", "figcaption", "hr", "table", "thead",
  "tbody", "tr", "th", "td", "span", "div"
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ["href", "title", "target", "rel", "class"],
    img: ["src", "alt", "title", "width", "height", "loading", "style", "class"],
    "*": ["class", "style"]
  },
  allowedStyles: {
    "*": {
      "display": [/^(block|inline-block|flex|grid|none)$/],
      "width": [/^\d{1,4}(px|%|em|rem|vw|vh)$/],
      "height": [/^(auto|\d{1,4}(px|%|em|rem|vw|vh))$/],
      "max-width": [/^\d{1,4}(px|%|em|rem|vw|vh)$/],
      "max-height": [/^\d{1,4}(px|%|em|rem|vw|vh)$/],
      "object-fit": [/^(cover|contain|fill|none|scale-down)$/],
      "border-radius": [/^\d{1,3}(px|%|em|rem)$/],
      "margin": [/^(\d{1,3}(px|%|em|rem)\s*){1,4}$|^auto$/],
      "margin-top": [/^(\d{1,3}(px|%|em|rem)\s*){1,4}$|^auto$/],
      "margin-right": [/^(\d{1,3}(px|%|em|rem)\s*){1,4}$|^auto$/],
      "margin-bottom": [/^(\d{1,3}(px|%|em|rem)\s*){1,4}$|^auto$/],
      "margin-left": [/^(\d{1,3}(px|%|em|rem)\s*){1,4}$|^auto$/],
      "padding": [/^(\d{1,3}(px|%|em|rem)\s*){1,4}$/],
      "padding-top": [/^(\d{1,3}(px|%|em|rem)\s*){1,4}$/],
      "padding-right": [/^(\d{1,3}(px|%|em|rem)\s*){1,4}$/],
      "padding-bottom": [/^(\d{1,3}(px|%|em|rem)\s*){1,4}$/],
      "padding-left": [/^(\d{1,3}(px|%|em|rem)\s*){1,4}$/],
      "text-align": [/^(left|right|center|justify)$/]
    }
  },
  allowedSchemes: ["https", "http", "mailto"],
  allowedSchemesByTag: { img: ["https"] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: "noopener noreferrer", ...(attribs.target ? { target: attribs.target } : {}) }
    })
  }
};

/** Server-side allowlist; pasted web HTML never reaches storage with scripts or inline handlers. */
export function sanitizeBlogHtml(value: unknown): string {
  const source = typeof value === "string" ? value : "";
  if (!source.trim()) return "";
  return sanitizeHtml(source, SANITIZE_OPTIONS).trim();
}

const BLOCK_BOUNDARY = /<\/?(?:article|section|p|div|h[1-4]|li|ul|ol|blockquote|figure|figcaption|table|thead|tbody|tr|th|td)\b[^>]*>|<br\s*\/?>/gi;

/** Plain text used for search, validation and older clients; HTML entities are decoded by the sanitizer. */
export function blogPlainText(html: string): string {
  const safe = sanitizeBlogHtml(html);
  if (!safe) return "";
  return sanitizeHtml(safe.replace(BLOCK_BOUNDARY, " "), { allowedTags: [], allowedAttributes: {} })
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
