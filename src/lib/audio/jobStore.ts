import { cacheDel, cacheGet, cacheKeys, cacheSet, isRedisActive } from "../redis";
import type { AudioJob } from "./service";

/** What is written to Redis: the job minus its AbortController. */
export type StoredJob = Omit<AudioJob, "abort">;

/** Where audio job state lives between restarts. */
export interface JobStore {
  readonly persistent: boolean;
  save(job: StoredJob): Promise<void>;
  remove(id: string): Promise<void>;
  loadAll(): Promise<StoredJob[]>;
}

export const JOB_KEY_PREFIX = "audio:job:v1:";
/** Job state lives 1 hour after its last update (matches the 1-hour file retention). */
export const JOB_TTL_SECONDS = 3600;

export function toStored(job: AudioJob): StoredJob {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { abort, ...rest } = job;
  return rest;
}

/** Redis-backed store (uses the app's shared client; a no-op when REDIS_ENABLED=false or Redis is down). */
export class RedisJobStore implements JobStore {
  constructor(private ttlSeconds = JOB_TTL_SECONDS) {}
  get persistent() {
    return isRedisActive();
  }
  async save(job: StoredJob) {
    await cacheSet(JOB_KEY_PREFIX + job.id, job, this.ttlSeconds);
  }
  async remove(id: string) {
    await cacheDel(JOB_KEY_PREFIX + id);
  }
  async loadAll() {
    const keys = await cacheKeys(JOB_KEY_PREFIX);
    const jobs: StoredJob[] = [];
    for (const k of keys) {
      const j = await cacheGet<StoredJob>(k);
      if (j && typeof j.id === "string" && typeof j.userId === "string" && typeof j.dir === "string") jobs.push(j);
    }
    return jobs;
  }
}

/** In-memory store: used in tests (shared between two AudioService instances to simulate a restart). */
export class MemoryJobStore implements JobStore {
  readonly persistent = true;
  readonly data = new Map<string, string>();
  async save(job: StoredJob) {
    this.data.set(job.id, JSON.stringify(job));
  }
  async remove(id: string) {
    this.data.delete(id);
  }
  async loadAll() {
    return [...this.data.values()].map((v) => JSON.parse(v) as StoredJob);
  }
}
