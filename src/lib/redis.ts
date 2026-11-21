import { env } from "../config/env";

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
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

export function redisStatus() {
  return { enabled: env.redisEnabled, active: isRedisActive(), reason: client ? "ok" : disabledReason };
}
