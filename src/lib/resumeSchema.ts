import { fileKind } from "./uploads";

/**
 * BUG-1401 / BUG-1402: server-side shape and size rules for stored resume data.
 * Keys follow shared/types.ts (and what the editor actually stores); anything else is dropped.
 */

const CONTENT_KEYS = new Set(["sections", "leftColumnIds", "rightColumnIds"]);
const COMMON_SECTION_KEYS = ["id", "type", "title", "settings"];
const SECTION_KEYS: Record<string, string[]> = {
  header: ["fullName", "contact", "photoUrl"],
  summary: ["content"],
  philosophy: ["quote", "author"],
  skills: ["categories"],
};
const ITEM_KEYS: Record<string, string[]> = {
  experience: ["id", "title", "company", "startDate", "endDate", "location", "bullets", "link", "description", "logoUrl", "projects"],
  projects: ["id", "name", "description", "technologies", "link", "startDate", "endDate", "location"],
  achievements: ["id", "text", "title", "description", "icon"],
  strengths: ["id", "text", "title", "description", "icon"],
  certifications: ["id", "name", "issuer", "date", "url"],
  education: ["id", "degree", "school", "startDate", "endDate", "location", "gpa", "logoUrl", "bullets"],
  languages: ["id", "name", "level", "proficiency"],
  volunteering: ["id", "role", "organization", "startDate", "endDate", "location", "description"],
  interests: ["id", "title", "description"],
  awards: ["id", "name", "issuer", "date", "icon"],
  references: ["id", "name", "email", "phone"],
  custom: ["id", "title", "subtitle", "date", "startDate", "endDate", "location", "description", "link"],
  online: ["id", "platform", "username", "url", "icon"],
  industryExpertise: ["id", "name", "level"],
  myTime: ["id", "label", "percent"],
};
const CATEGORY_KEYS = ["id", "name", "skills"];
const PROJECT_ROW_KEYS = ["id", "name", "description"];
const CONTACT_KEYS = [
  "phone", "email", "linkedin", "location", "website", "github", "extraLink", "extraField",
  "dateOfBirth", "nationality", "linkedinHref", "extraLinkHref",
];
const HEADER_SETTINGS_KEYS = [
  "title", "phone", "link", "email", "location", "extraLink", "extraField", "dateOfBirth",
  "nationality", "uppercaseName", "photo", "photoStyle", "photoAccent",
];
const SECTION_SETTINGS_KEYS = [
  "title", "subtitle", "location", "datePeriod", "bullets", "description", "gpa", "link", "logo",
  "institution", "groupName", "icons", "username", "uppercaseTitles", "skillsLayout", "skillBorder",
  "languageSliderStyle",
];
const DESIGN_KEYS = [
  "accentColor", "inkColor", "fontFamily", "fontSize", "lineHeight", "pageMargins", "sectionSpacing",
  "columnLayout", "background", "showBranding", "pageSize", "headerStyle", "photoPosition",
  "titlePlacement", "sectionHeadingStyle", "contactLayout", "entryLayout",
];

/** Keys whose value is an image source, validated by safeImageUrl instead of the text rules. */
export const IMAGE_KEYS = new Set(["photoUrl", "logoUrl"]);

/** Longest accepted text field, in characters (BUG-1402). Image data URLs have their own cap. */
export const MAX_FIELD_CHARS = 10_000;
/** Largest accepted inline image (decoded bytes). */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> | unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in value) out[key] = value[key];
  return out;
}

function pickItems(items: unknown, keys: readonly string[] | undefined, child?: (item: Record<string, unknown>) => void) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!isRecord(item) || !keys) return item;
    const out = pick(item, keys) as Record<string, unknown>;
    child?.(out);
    return out;
  });
}

function pruneSection(section: unknown): unknown {
  if (!isRecord(section)) return section;
  const type = typeof section.type === "string" ? section.type : "";
  const extra = SECTION_KEYS[type] ?? (type in ITEM_KEYS ? ["items"] : ["items", "content"]);
  const out = pick(section, [...COMMON_SECTION_KEYS, ...extra]) as Record<string, unknown>;
  if ("settings" in out) out.settings = pick(out.settings, type === "header" ? HEADER_SETTINGS_KEYS : SECTION_SETTINGS_KEYS);
  if (type === "header" && "contact" in out) out.contact = pick(out.contact, CONTACT_KEYS);
  if (type === "skills" && "categories" in out) out.categories = pickItems(out.categories, CATEGORY_KEYS);
  if ("items" in out) {
    out.items = pickItems(out.items, ITEM_KEYS[type], (item) => {
      if (type === "experience" && "projects" in item) item.projects = pickItems(item.projects, PROJECT_ROW_KEYS);
    });
  }
  return out;
}

/** Drop keys the app does not know about (BUG-1401: photo/image/avatar extras and the like). */
export function pruneResumeContent(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of CONTENT_KEYS) if (key in value) out[key] = value[key];
  if (Array.isArray(out.sections)) out.sections = out.sections.map(pruneSection);
  return out;
}

export function pruneResumeDesign(value: unknown): unknown {
  return pick(value ?? {}, DESIGN_KEYS);
}

/** Hosts an image URL may never point at: loopback, private, link-local, local names. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || !host.includes(".") && !host.includes(":")) return true;
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(":")) {
    return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  }
  return false;
}

const DATA_IMAGE = /^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/=\s]+)$/i;

/**
 * BUG-1401: an image source is kept only when it is
 *  - an inline PNG/JPEG/WebP data URL whose bytes really are that format (no SVG, no HTML), or
 *  - the app's own upload path (/uploads/...), or
 *  - an https URL to a public host that is not an SVG.
 * Anything else (javascript:, data:text/html, SVG, http, loopback/private hosts) becomes "".
 */
export function safeImageUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (!value) return "";

  const data = DATA_IMAGE.exec(value);
  if (data) {
    const b64 = data[2].replace(/\s+/g, "");
    if (Math.floor((b64.length * 3) / 4) > MAX_IMAGE_BYTES) return "";
    const declared = data[1].toLowerCase() === "jpg" ? "jpeg" : data[1].toLowerCase();
    const kind = fileKind(Buffer.from(b64.slice(0, 64), "base64"));
    return kind === declared ? `data:image/${data[1].toLowerCase()};base64,${b64}` : "";
  }
  if (/^data:/i.test(value)) return "";

  if (value.startsWith("/")) {
    if (/^\/uploads\/[\w\-/.]+$/.test(value) && !value.includes("..") && !/\.svgz?$/i.test(value)) return value;
    return "";
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  if (isPrivateHost(url.hostname)) return "";
  if (/\.svgz?$/i.test(url.pathname)) return "";
  return url.toString();
}

/** BUG-1402: header limits (the editor enforces the same maxLength). */
export const HEADER_LIMITS: Record<string, number> = {
  fullName: 200, title: 200, email: 200, phone: 50, location: 200, linkedin: 200, extraLink: 200, extraField: 200,
};

/** First over-long header field as { path, max }, or null. Over-long is a 400, never truncated. */
export function oversizedHeaderField(content: unknown): { path: string; max: number } | null {
  if (!isRecord(content) || !Array.isArray(content.sections)) return null;
  const sections = content.sections as unknown[];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!isRecord(s) || s.type !== "header") continue;
    const base = `content.sections[${i}]`;
    for (const key of ["fullName", "title"]) {
      const v = s[key];
      if (typeof v === "string" && v.length > HEADER_LIMITS[key]) return { path: `${base}.${key}`, max: HEADER_LIMITS[key] };
    }
    if (isRecord(s.contact)) {
      for (const [key, v] of Object.entries(s.contact)) {
        const max = HEADER_LIMITS[key];
        if (max && typeof v === "string" && v.length > max) return { path: `${base}.contact.${key}`, max };
      }
    }
  }
  return null;
}

/** First text field longer than the limit, as a readable path, or null (BUG-1402). */
export function oversizedField(value: unknown, limit = MAX_FIELD_CHARS, path = "content"): string | null {
  if (typeof value === "string") return value.length > limit ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = oversizedField(value[i], limit, `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (IMAGE_KEYS.has(key)) continue;
      const hit = oversizedField(child, limit, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}