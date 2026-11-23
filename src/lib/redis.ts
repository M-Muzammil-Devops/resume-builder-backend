import { env } from "../config/env";

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan?(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  incr?(key: string): Promise<number>;
  expire?(key: string, seconds: number): Promise<unknown>;
  getdel?(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
};

let client: RedisLike | null = null;
let disabledReason = "REDIS_ENABLED=false";

export function isRedisActive() {
  return Boolean(client);
}

export async function initRedis(log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void }) {
  if (!env.redisEnabled) {
    disabledReason = "REDIS_ENABLED=false — running without cache";
    log?.info({ redis: false }, disabledReason);
    return null;
  }

  try {
    const Redis = (await import("ioredis")).default;
    const redis = new Redis(env.redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 3000,
    });
    await redis.connect();
    client = redis as unknown as RedisLike;
    log?.info({ redis: true, url: env.redisUrl.replace(/\/\/.*@/, "//***@") }, "Redis connected");
    return client;
  } catch (err) {
    client = null;
    disabledReason = err instanceof Error ? err.message : "Redis connect failed";
    log?.warn({ err: disabledReason }, "Redis unavailable — continuing without cache");
    return null;
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!client) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttl = env.redisTtlSeconds) {
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), "EX", ttl);
  } catch {
    /* ignore cache write errors */
  }
}

export async function cacheDel(...keys: string[]) {
  if (!client || keys.length === 0) return;
  try {
    await client.del(...keys);
  } catch {
    /* ignore */
  }
}

/** Delete every key that starts with `prefix` (SCAN based, never KEYS). */
export async function cacheDelPrefix(prefix: string) {
  if (!client?.scan) return;
  try {
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
      cursor = next;
      if (keys.length) await client.del(...keys);
    } while (cursor !== "0");
  } catch {
    /* ignore */
  }
}

/** Every key that starts with `prefix` (SCAN based, never KEYS). Empty when Redis is off. */
export async function cacheKeys(prefix: string, max = 5000): Promise<string[]> {
  if (!client?.scan) return [];
  const out: string[] = [];
  try {
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
      cursor = next;
      out.push(...keys);
    } while (cursor !== "0" && out.length < max);
  } catch {
    /* ignore */
  }
  return [...new Set(out)];
}

/** Atomic counter with a TTL set on first use. null when Redis is off or fails (caller falls back). */
export async function cacheIncr(key: string, ttl: number): Promise<number | null> {
  if (!client?.incr) return null;
  try {
    const value = await client.incr(key);
    if (value === 1 && client.expire) await client.expire(key, ttl);
    return value;
  } catch {
    return null;
  }
}

/** Read a JSON value and delete it in one step (GETDEL; GET + DEL on old servers). One-time tokens. */
export async function cacheTake<T>(key: string): Promise<T | null> {
  if (!client) return null;
  try {
    let raw: string | null;
    if (client.getdel) {
      raw = await client.getdel(key);
    } else {
      raw = await client.get(key);
      if (raw) await client.del(key);
    }
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Test hook: inject a fake client. */
export function __setRedisClientForTests(fake: unknown) {
  client = fake as RedisLike | null;
}

export function redisStatus() {
  return { enabled: env.redisEnabled, active: isRedisActive(), reason: client ? "ok" : disabledReason };
}
