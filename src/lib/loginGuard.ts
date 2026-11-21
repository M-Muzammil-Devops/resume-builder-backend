const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function key(ip: string, email: string) {
  return `${ip}|${email}`;
}

function current(ip: string, email: string) {
  const id = key(ip, email);
  const row = buckets.get(id);
  if (!row || row.resetAt < Date.now()) {
    const fresh = { count: 0, resetAt: Date.now() + WINDOW_MS };
    buckets.set(id, fresh);
    return fresh;
  }
  return row;
}

/** Lockout is per account. A spoofed X-Forwarded-For must not open a new bucket. */
export function loginBlocked(email: string) {
  return current("account", email).count >= MAX_FAILS;
}

export function recordLoginFailure(email: string) {
  const row = current("account", email);
  row.count += 1;
}

export function clearLoginFailures(email: string) {
  buckets.delete(key("account", email));
}

const hits = new Map<string, number[]>();

export function hitLimit(bucket: string, limit: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    hits.set(bucket, recent);
    return true;
  }
  recent.push(now);
  hits.set(bucket, recent);
  return false;
}
