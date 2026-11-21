/** Strip trailing slashes so `${base}/path` never produces "//". */
export function stripTrailingSlash(value: string | undefined | null): string {
  return (value || "").trim().replace(/\/+$/, "");
}

/** Join a base URL and path segments with exactly one slash between each part. */
export function joinUrl(base: string, ...parts: string[]): string {
  let out = stripTrailingSlash(base);
  for (const part of parts) {
    const clean = (part || "").replace(/^\/+|\/+$/g, "");
    if (!clean) continue;
    out = out ? `${out}/${clean}` : clean;
  }
  return out;
}

/** scheme://host[:port] of a URL, or "" when it cannot be parsed. */
export function originOf(value: string | undefined | null): string {
  const raw = stripTrailingSlash(value);
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

export function isLoopbackUrl(value: string | undefined | null): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test((value || "").trim());
}

export const SECRET_PLACEHOLDERS = [
  "change-me-to-a-long-random-string",
  "dev-secret-change-me",
  "changeme",
  "secret",
  "your-secret",
  "your_jwt_secret",
];

/** Why a secret is unsafe for production, or null when it is fine. Never includes the value. */
export function weakSecretReason(value: string | undefined | null): string | null {
  const v = (value || "").trim();
  if (!v) return "is missing";
  const lower = v.toLowerCase();
  if (SECRET_PLACEHOLDERS.includes(lower) || /change[-_ ]?me|placeholder|^your[-_]/i.test(lower)) {
    return "is a placeholder value";
  }
  if (v.length < 32) return "is shorter than 32 characters";
  return null;
}
