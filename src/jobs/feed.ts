/**
 * Batch 4: cached live job feed. Providers are fetched in parallel (Promise.allSettled, strict
 * per-provider timeout), normalized, de-duplicated and stored in the Job table with a TTL, so
 * user requests read the cache and never hammer the external APIs.
 */
import { jobKeywordTerms } from "../ats/advanced";
import {
  LIVE_SOURCES,
  PROVIDERS,
  SOURCE_LABEL,
  dedupeJobs,
  dedupeKey,
  type FetchLike,
  type JobSource,
  type NormalizedJob,
  type Provider,
} from "./providers";

export type FeedJob = NormalizedJob & {
  id: string;
  keywords: string[];
  niceKeywords: string[];
  dedupeKey: string;
  fetchedAt: Date | null;
};

export type FeedState = { source: string; fetchedAt: Date; ok: boolean; count: number; error: string | null };

export interface FeedStore {
  states(): Promise<FeedState[]>;
  saveState(state: FeedState): Promise<void>;
  /** Insert or update by (source, externalId); returns nothing. */
  upsertJobs(jobs: Array<NormalizedJob & { keywords: string[]; niceKeywords: string[]; dedupeKey: string }>, at: Date): Promise<void>;
  /** Jobs of `source` not seen in the run that started at `before` are no longer listed. */
  deactivateMissing(source: JobSource, before: Date): Promise<void>;
  loadActive(): Promise<FeedJob[]>;
}

export type ProviderReport = { source: JobSource; label: string; status: "fetched" | "cached" | "failed" | "disabled"; count: number; error?: string; fetchedAt: string | null };
export type FeedStatus = { lastRefreshedAt: string | null; total: number; providers: ProviderReport[]; refreshing: boolean };

export type FeedOptions = {
  store: FeedStore;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  providers?: Provider[];
  /** Cache lifetime before a background refresh (default 30 min). */
  ttlMs?: number;
  /** Per-provider request timeout (default 9 s). */
  timeoutMs?: number;
  /** A forced refresh still waits at least this long between real fetches of one provider (default 2 min). */
  minForceMs?: number;
  /** Retry delay after a provider failed (default 5 min). */
  retryMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
};

const MIN = 60_000;

export class JobFeedService {
  private store: FeedStore;
  private fetchImpl: FetchLike;
  private env: NodeJS.ProcessEnv;
  private providers: Provider[];
  private ttlMs: number;
  private timeoutMs: number;
  private minForceMs: number;
  private retryMs: number;
  private now: () => Date;
  private log: (msg: string) => void;
  private cache: FeedJob[] | null = null;
  private states = new Map<string, FeedState>();
  private statesLoaded = false;
  private inflight: Promise<ProviderReport[]> | null = null;
  private lastReport = new Map<JobSource, ProviderReport>();
  /** Bumped whenever the cached job list changes (lets callers cache per-resume matches). */
  version = 0;

  constructor(opts: FeedOptions) {
    this.store = opts.store;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
    this.env = opts.env ?? process.env;
    this.providers = opts.providers ?? PROVIDERS;
    this.ttlMs = opts.ttlMs ?? 30 * MIN;
    this.timeoutMs = opts.timeoutMs ?? 9000;
    this.minForceMs = opts.minForceMs ?? 2 * MIN;
    this.retryMs = opts.retryMs ?? 5 * MIN;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
  }

  private enabled(): Provider[] {
    return this.providers.filter((p) => p.enabled(this.env));
  }

  private async loadStates() {
    if (this.statesLoaded) return;
    for (const s of await this.store.states()) this.states.set(s.source, s);
    this.statesLoaded = true;
  }

  private due(p: Provider, force: boolean): boolean {
    const st = this.states.get(p.source);
    if (!st) return true;
    const age = this.now().getTime() - st.fetchedAt.getTime();
    if (!st.ok) return age >= this.failWait(p, force);
    if (age < Math.max(p.minIntervalMs, force ? this.minForceMs : 0)) return false;
    return force || age >= this.ttlMs;
  }

  /** After a failure: retry soon, but never faster than a quarter of the provider's own interval. */
  private failWait(p: Provider, force: boolean): number {
    return Math.max(force ? this.minForceMs : this.retryMs, p.minIntervalMs / 4);
  }

  private async fetchOne(p: Provider): Promise<NormalizedJob[]> {
    const ctrl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error(`timed out after ${Math.round(this.timeoutMs / 1000)}s`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([p.fetchJobs(this.fetchImpl, ctrl.signal, this.env), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch every provider that is due. Single-flight: concurrent callers share one run. */
  refresh(opts: { force?: boolean } = {}): Promise<ProviderReport[]> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run(Boolean(opts.force)).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(force: boolean): Promise<ProviderReport[]> {
    await this.loadStates();
    const started = this.now();
    const enabled = this.enabled();
    const due = enabled.filter((p) => this.due(p, force));
    const results = await Promise.allSettled(due.map((p) => this.fetchOne(p)));
    let changed = false;
    for (let i = 0; i < due.length; i += 1) {
      const p = due[i];
      const r = results[i];
      const at = this.now();
      if (r.status === "fulfilled" && r.value.length) {
        try {
          const jobs = dedupeJobs(r.value).map((j) => {
            const kw = jobKeywordTerms(j.title, j.description, j.tags, j.company);
            return { ...j, keywords: kw.required, niceKeywords: kw.nice, dedupeKey: dedupeKey(j.company, j.title) };
          });
          await this.store.upsertJobs(jobs, at);
          await this.store.deactivateMissing(p.source, started);
          const st = { source: p.source, fetchedAt: at, ok: true, count: jobs.length, error: null };
          await this.store.saveState(st);
          this.states.set(p.source, st);
          this.lastReport.set(p.source, { source: p.source, label: SOURCE_LABEL[p.source], status: "fetched", count: jobs.length, fetchedAt: at.toISOString() });
          changed = true;
          continue;
        } catch (err) {
          this.log(`job feed ${p.source}: store failed: ${(err as Error).message}`);
          const st = { source: p.source, fetchedAt: at, ok: false, count: 0, error: "Could not save jobs" };
          this.states.set(p.source, st);
          await this.store.saveState(st).catch(() => {});
          this.lastReport.set(p.source, { source: p.source, label: SOURCE_LABEL[p.source], status: "failed", count: 0, error: st.error, fetchedAt: at.toISOString() });
          continue;
        }
      }
      const error = r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason).slice(0, 160) : "No jobs returned";
      this.log(`job feed ${p.source}: ${error}`);
      const prev = this.states.get(p.source);
      // Keep the last good jobs listed; only remember the failure for the retry timer.
      const st = { source: p.source, fetchedAt: at, ok: false, count: prev?.count ?? 0, error };
      this.states.set(p.source, st);
      await this.store.saveState(st).catch(() => {});
      this.lastReport.set(p.source, { source: p.source, label: SOURCE_LABEL[p.source], status: "failed", count: 0, error, fetchedAt: at.toISOString() });
    }
    if (changed || !this.cache) await this.reload();
    return this.reports();
  }

  private async reload() {
    const rows = await this.store.loadActive();
    // Cross-source de-duplication: the same company + title on two boards is listed once (newest wins).
    rows.sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0));
    const seen = new Set<string>();
    const out: FeedJob[] = [];
    for (const r of rows) {
      const key = r.dedupeKey || dedupeKey(r.company, r.title);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    this.cache = out;
    this.version += 1;
  }

  private reports(): ProviderReport[] {
    return this.providers.map((p) => {
      if (!p.enabled(this.env)) return { source: p.source, label: SOURCE_LABEL[p.source], status: "disabled" as const, count: 0, fetchedAt: null };
      const st = this.states.get(p.source);
      const last = this.lastReport.get(p.source);
      const count = (this.cache ?? []).filter((j) => j.source === p.source).length;
      if (last && last.status === "failed") return { ...last, count };
      return { source: p.source, label: SOURCE_LABEL[p.source], status: last?.status === "fetched" ? "fetched" : "cached", count, fetchedAt: st ? st.fetchedAt.toISOString() : null, ...(st && !st.ok && st.error ? { error: st.error } : {}) };
    });
  }

  /** Cached jobs; fetches synchronously only when nothing is cached yet, otherwise refreshes in the background. */
  async list(): Promise<FeedJob[]> {
    await this.loadStates();
    if (!this.cache) await this.reload();
    const stale = this.enabled().some((p) => this.due(p, false));
    if (stale) {
      if (!this.cache || this.cache.length === 0) await this.refresh().catch(() => []);
      else void this.refresh().catch((err) => this.log(`job feed background refresh failed: ${(err as Error).message}`));
    }
    return this.cache ?? [];
  }

  status(): FeedStatus {
    const ok = [...this.states.values()].filter((s) => s.ok && LIVE_SOURCES.includes(s.source as JobSource));
    const last = ok.reduce<Date | null>((m, s) => (!m || s.fetchedAt > m ? s.fetchedAt : m), null);
    return { lastRefreshedAt: last ? last.toISOString() : null, total: this.cache?.length ?? 0, providers: this.reports(), refreshing: Boolean(this.inflight) };
  }

  /** Seconds until a forced refresh can fetch again (0 when something is due). */
  nextRefreshInSec(): number {
    const now = this.now().getTime();
    let best = Infinity;
    for (const p of this.enabled()) {
      if (this.due(p, true)) return 0;
      const st = this.states.get(p.source);
      if (!st) return 0;
      const wait = st.ok ? Math.max(p.minIntervalMs, this.minForceMs) : this.failWait(p, true);
      best = Math.min(best, st.fetchedAt.getTime() + wait - now);
    }
    return Number.isFinite(best) ? Math.max(0, Math.ceil(best / 1000)) : 0;
  }
}

type PrismaLike = {
  jobFeedState: {
    findMany(args?: unknown): Promise<FeedState[]>;
    upsert(args: unknown): Promise<unknown>;
  };
  job: {
    upsert(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
  };
  $transaction(ops: Promise<unknown>[]): Promise<unknown>;
};

/** Prisma-backed cache: Job rows (source != catalog/custom) + JobFeedState. */
export function prismaFeedStore(db: PrismaLike): FeedStore {
  return {
    states: () => db.jobFeedState.findMany(),
    async saveState(s) {
      await db.jobFeedState.upsert({ where: { source: s.source }, create: s, update: s });
    },
    async upsertJobs(jobs, at) {
      for (let i = 0; i < jobs.length; i += 40) {
        const chunk = jobs.slice(i, i + 40);
        await db.$transaction(
          chunk.map((j) => {
            const data = {
              title: j.title,
              company: j.company,
              location: j.location,
              remote: j.remote,
              department: j.tags[0] ?? SOURCE_LABEL[j.source],
              description: j.description,
              applyUrl: j.applyUrl,
              keywords: j.keywords,
              niceKeywords: j.niceKeywords,
              salary: j.salary,
              tags: j.tags,
              postedAt: j.postedAt,
              fetchedAt: at,
              active: true,
              dedupeKey: j.dedupeKey,
            };
            return db.job.upsert({
              where: { source_externalId: { source: j.source, externalId: j.externalId } },
              create: { ...data, source: j.source, externalId: j.externalId },
              update: data,
            }) as Promise<unknown>;
          })
        );
      }
    },
    async deactivateMissing(source, before) {
      await db.job.updateMany({ where: { source, active: true, fetchedAt: { lt: before } }, data: { active: false } });
      // Old listings nobody tracks are deleted after a week; tracked ones stay for the tracker.
      await db.job.deleteMany({
        where: { source, active: false, fetchedAt: { lt: new Date(before.getTime() - 7 * 24 * 60 * MIN) }, applications: { none: {} } },
      });
    },
    async loadActive() {
      const rows = await db.job.findMany({
        where: { source: { in: LIVE_SOURCES }, active: true },
        select: {
          id: true, source: true, externalId: true, title: true, company: true, location: true, remote: true, salary: true,
          tags: true, description: true, applyUrl: true, postedAt: true, keywords: true, niceKeywords: true, dedupeKey: true, fetchedAt: true,
        },
      });
      return rows.map((r) => ({
        id: String(r.id),
        source: r.source as JobSource,
        externalId: String(r.externalId ?? ""),
        title: String(r.title),
        company: String(r.company),
        location: String(r.location ?? ""),
        remote: Boolean(r.remote),
        salary: (r.salary as string | null) ?? null,
        tags: (r.tags as string[]) ?? [],
        description: String(r.description ?? ""),
        applyUrl: String(r.applyUrl),
        postedAt: (r.postedAt as Date | null) ?? null,
        keywords: (r.keywords as string[]) ?? [],
        niceKeywords: (r.niceKeywords as string[]) ?? [],
        dedupeKey: String(r.dedupeKey ?? ""),
        fetchedAt: (r.fetchedAt as Date | null) ?? null,
      }));
    },
  };
}
