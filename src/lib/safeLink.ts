/**
 * BUG-1102 / BUG-1100: link values stored in a resume may only use http(s), mailto or tel.
 * Any other scheme (javascript:, data:, vbscript:, file:, ...) is dropped on write.
 */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

function normalise(raw: string): string {
  return String(raw ?? "")
    .replace(/&colon;|&#0*58;|&#x0*3a;/gi, ":")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f\s]+/g, "")
    .trim();
}

/** Value for an href field (linkedinHref, extraLinkHref, ...). Returns "" when it is not a safe URL. */
export function safeHrefValue(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = normalise(raw);
  if (!value) return "";
  if (/^https?:\/\/[^"'<>`\\]+$/i.test(value)) return value;
  if (/^mailto:[^"'<>`\\]+@[^"'<>`\\]+$/i.test(value)) return value;
  if (/^tel:\+?[\d().-]{3,}$/i.test(value)) return value;
  // A bare domain ("linkedin.com/in/x") becomes an https link; anything with another scheme is dropped.
  if (!SCHEME.test(value) && /^[\w-]+(\.[\w-]+)+(\/[^\s"'<>`\\]*)?$/i.test(value)) return `https://${value}`;
  return "";
}

/** Value for a link label that the UI may turn into a link (linkedin, website, url, ...). */
export function safeLinkLabel(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const value = normalise(raw);
  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return raw;
  if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") return raw;
  // "localhost:3000/x" or "example.com:8080" are host:port, not a scheme.
  if (/^[\w-]+(\.[\w-]+)*:\d+(\/|$)/.test(value)) return raw;
  return "";
}

export const HREF_KEY = /href$/i;
export const LINK_LABEL_KEYS = new Set(["url", "link", "website", "github", "linkedin", "extraLink", "credentialUrl"]);

/** Looks like a URL the user typed as the visible link text. */
export function looksLikeUrl(raw: string): boolean {
  const text = normalise(raw);
  return /^https?:\/\//i.test(text) || /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(\/|$)/i.test(text);
}
