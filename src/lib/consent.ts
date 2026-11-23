/**
 * First-party cookie-consent record shared with the frontend (src/lib/consent.ts there).
 * Cookie `rb_consent` = "<version>.<p><a><m>.<anonId>.<unixSeconds>", e.g. "1.010.Ab3_x9.1764000000".
 * Essential cookies are always on and are not part of the record.
 */
export const CONSENT_COOKIE = "rb_consent";
export const CONSENT_VERSION = 1;

export type ConsentChoices = { preferences: boolean; analytics: boolean; marketing: boolean };
export type ConsentRecord = ConsentChoices & { version: number; anonId: string; at: number };

const ANON_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function isAnonId(value: unknown): value is string {
  return typeof value === "string" && ANON_ID.test(value);
}

export function parseConsentValue(raw: string | null | undefined): ConsentRecord | null {
  if (!raw) return null;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const m = /^(\d{1,3})\.([01])([01])([01])\.([A-Za-z0-9_-]{8,64})\.(\d{1,12})$/.exec(value.trim());
  if (!m) return null;
  return {
    version: Number(m[1]),
    preferences: m[2] === "1",
    analytics: m[3] === "1",
    marketing: m[4] === "1",
    anonId: m[5],
    at: Number(m[6]),
  };
}

/** Reads rb_consent from a Cookie header. Records of an older version count as "no consent". */
export function consentFromCookieHeader(header: string | string[] | undefined): ConsentRecord | null {
  const text = Array.isArray(header) ? header.join("; ") : String(header || "");
  for (const part of text.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== CONSENT_COOKIE) continue;
    const rec = parseConsentValue(part.slice(idx + 1).trim());
    return rec && rec.version === CONSENT_VERSION ? rec : null;
  }
  return null;
}

export function consentAction(choices: ConsentChoices): "accept_all" | "reject_all" | "custom" {
  if (choices.preferences && choices.analytics && choices.marketing) return "accept_all";
  if (!choices.preferences && !choices.analytics && !choices.marketing) return "reject_all";
  return "custom";
}
