import { sanitizeValue } from "./sanitizeHtml";
import { HREF_KEY, LINK_LABEL_KEYS, looksLikeUrl, safeHrefValue, safeLinkLabel } from "./safeLink";
import { IMAGE_KEYS, pruneResumeContent, pruneResumeDesign, safeImageUrl } from "./resumeSchema";

const SAMPLE = new Set([
  "your name",
  "role title",
  "senior role title",
  "junior role title",
  "previous company",
  "industry certificate",
  "award name",
  "describe your custom entry",
  "describe your custom entry.",
  "your skill",
  "company name",
  "your role | specialty | focus area",
  "company description",
  // BUG-027: sample contact/education/cert copy is not data.
  "hello@email.com",
  "+1-(234)-555-1234",
  "city, country",
  "university name",
  "issuing organization",
]);

function plain(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim()
    .toLowerCase();
}

function limitFor(key: string | null): number {
  if (key === "content" || key === "description" || key === "quote") return 2000;
  if (key === "fullName" || key === "title" || key === "email" || key === "name") return 200;
  return 1000;
}

/** Drop stored sample text and cap field length. Sample copy stays a placeholder, not data. */
export function cleanResumeValue(value: unknown, key: string | null = null): unknown {
  if (typeof value === "string") {
    if (key && IMAGE_KEYS.has(key)) return safeImageUrl(value);
    // BUG-1240: no save-time blanking by value; sample copy is dropped only at export time.
    if (key && HREF_KEY.test(key)) return safeHrefValue(value);
    const text = key && LINK_LABEL_KEYS.has(key) ? String(safeLinkLabel(value)) : value;
    const limit = limitFor(key);
    return text.length > limit ? text.slice(0, limit) : text;
  }
  if (Array.isArray(value)) return value.map((item) => cleanResumeValue(item, null));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = cleanResumeValue(child, childKey);
    }
    return out;
  }
  return value;
}

/**
 * BUG-400: the header link target follows the link text the user typed. When the visible
 * text is a URL ("linkedin.com/in/x"), the stored href is that URL, never a stale default.
 */
function syncHeaderLinks(content: unknown): unknown {
  const sections = (content as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections)) return content;
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const s = section as { type?: unknown; contact?: Record<string, unknown> };
    if (s.type !== "header" || !s.contact || typeof s.contact !== "object") continue;
    for (const [labelKey, hrefKey] of [
      ["linkedin", "linkedinHref"],
      ["extraLink", "extraLinkHref"],
    ] as const) {
      const raw = s.contact[labelKey];
      const label = typeof raw === "string" ? raw.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim() : "";
      if (label && looksLikeUrl(label)) {
        const href = safeHrefValue(label);
        if (href) s.contact[hrefKey] = href;
      } else if (!label && hrefKey in s.contact) {
        s.contact[hrefKey] = "";
      }
    }
  }
  return content;
}

/**
 * BUG-1240b: sample-provenance marks (path -> sample value). Each value is cleaned exactly like the
 * field it describes, so an untouched field still equals its mark after saving.
 */
function storedSampleMarks(value: unknown): Record<string, string> | null {
  const raw = value && typeof value === "object" ? (value as { sampleFields?: unknown }).sampleFields : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [path, mark] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof mark !== "string" || path.length > 300 || count >= 2000) continue;
    const key = path.split("/").pop() || null;
    out[path] = String(cleanResumeValue(sanitizeValue(mark), key));
    count++;
  }
  return out;
}

/** BUG-402: every write path (PUT/POST resume, POST export) stores content through this. */
export function storedResumeContent(value: unknown): object {
  const marks = storedSampleMarks(value);
  const content = syncHeaderLinks(cleanResumeValue(sanitizeValue(pruneResumeContent(value)))) as Record<string, unknown>;
  if (marks && content && typeof content === "object") content.sampleFields = marks;
  return content as object;
}

/** Design holds colours/font names only; strip any markup so it can never break out of CSS/HTML. */
export function storedResumeDesign(value: unknown): object {
  return sanitizeValue(pruneResumeDesign(value)) as object;
}
