import { cacheDel, cacheGet, cacheIncr, cacheSet, cacheTake, isRedisActive } from "./redis";

/**
 * Short-lived auth state (OAuth state/nonce, magic codes, one-time handoff codes, counters).
 * Lives in Redis so it survives a backend restart and works across processes; falls back to
 * process memory when Redis is off (single-process dev).
 */
type Entry = { value: string; expiresAt: number };
const memory = new Map<string, Entry>();

function memGet(key: string): string | null {
  const row = memory.get(key);
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    memory.delete(key);
    return null;
  }
  return row.value;
}

function sweep() {
  if (memory.size < 5000) return;
  const now = Date.now();
  for (const [key, row] of memory) if (row.expiresAt < now) memory.delete(key);
}

export async function ephSet(key: string, value: unknown, ttlSeconds: number) {
  if (isRedisActive()) return cacheSet(key, value, ttlSeconds);
  sweep();
  memory.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function ephGet<T>(key: string): Promise<T | null> {
  if (isRedisActive()) return cacheGet<T>(key);
  const raw = memGet(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

/** Read once: the value is gone after this call (replay-proof). */
export async function ephTake<T>(key: string): Promise<T | null> {
  if (isRedisActive()) return cacheTake<T>(key);
  const raw = memGet(key);
  memory.delete(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function ephDel(...keys: string[]) {
  if (isRedisActive()) return cacheDel(...keys);
  for (const key of keys) memory.delete(key);
}

/** Atomic counter; the window starts at the first hit. */
export async function ephIncr(key: string, ttlSeconds: number): Promise<number> {
  if (isRedisActive()) {
    const value = await cacheIncr(key, ttlSeconds);
    if (value !== null) return value;
  }
  const current = Number(memGet(key) || 0) + 1;
  const prev = memory.get(key);
  memory.set(key, {
    value: String(current),
    expiresAt: prev && prev.expiresAt > Date.now() ? prev.expiresAt : Date.now() + ttlSeconds * 1000,
  });
  return current;
}

/** Test hook. */
export function __clearEphemeralForTests() {
  memory.clear();
}
