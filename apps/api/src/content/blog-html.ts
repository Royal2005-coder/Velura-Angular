import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "p", "br", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "blockquote",
  "ul", "ol", "li", "a", "img", "figure", "figcaption", "hr", "table", "thead",
  "tbody", "tr", "th", "td", "span", "div"
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    "*": ["class"]
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

const BLOCK_BOUNDARY = /<\/?(?:p|div|h[2-4]|li|ul|ol|blockquote|figure|figcaption|table|thead|tbody|tr|th|td)\b[^>]*>|<br\s*\/?>/gi;

/** Plain text used for search, validation and older clients; HTML entities are decoded by the sanitizer. */
export function blogPlainText(html: string): string {
  const safe = sanitizeBlogHtml(html);
  if (!safe) return "";
  return sanitizeHtml(safe.replace(BLOCK_BOUNDARY, " "), { allowedTags: [], allowedAttributes: {} })
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
