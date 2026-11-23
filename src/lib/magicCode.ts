import { createHmac, randomInt, timingSafeEqual } from "crypto";

/** Email magic code: 6 digits, 10 minutes, stored only as an HMAC, 5 tries. */
export const MAGIC_CODE_TTL_SECONDS = 10 * 60;
export const MAGIC_CODE_MAX_ATTEMPTS = 5;
/** Codes per email per window, and requests per IP per window. */
export const MAGIC_CODES_PER_EMAIL = 3;
export const MAGIC_REQUESTS_PER_IP = 10;
export const MAGIC_WINDOW_SECONDS = 15 * 60;

export function generateMagicCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function normalizeMagicCode(input: unknown): string {
  return String(input ?? "").replace(/\D/g, "").slice(0, 6);
}

export function hashMagicCode(secret: string, email: string, code: string): string {
  return createHmac("sha256", secret).update(`magic:${email.toLowerCase()}:${code}`).digest("hex");
}

export function magicCodeMatches(secret: string, email: string, code: string, storedHash: string): boolean {
  if (!/^\d{6}$/.test(code) || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashMagicCode(secret, email, code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
