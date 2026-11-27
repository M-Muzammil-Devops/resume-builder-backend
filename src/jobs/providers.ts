/**
 * Batch 4: live job feeds from free public APIs (RemoteOK, Arbeitnow, Remotive) plus optional
 * key-gated JSearch / Jooble adapters. Every adapter returns normalized jobs; nothing here is fake.
 */

export type JobSource = "remoteok" | "arbeitnow" | "remotive" | "jsearch" | "jooble";
export const LIVE_SOURCES: JobSource[] = ["remoteok", "arbeitnow", "remotive", "jsearch", "jooble"];
export const SOURCE_LABEL: Record<JobSource, string> = {
  remoteok: "RemoteOK",
  arbeitnow: "Arbeitnow",
  remotive: "Remotive",
  jsearch: "JSearch",
  jooble: "Jooble",
};

export type NormalizedJob = {
  externalId: string;
  source: JobSource;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  salary: string | null;
  tags: string[];
  description: string;
  applyUrl: string;
  postedAt: Date | null;
};

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type Provider = {
  source: JobSource;
  /** Minimum time between two real fetches (provider terms / politeness). */
  minIntervalMs: number;
  enabled(env: NodeJS.ProcessEnv): boolean;
  fetchJobs(fetchImpl: FetchLike, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<NormalizedJob[]>;
};

const UA = "ResumeBuilder-JobFeed/1.0 (+https://devops.elevatesofts.com)";
const MIN = 60_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", euro: "€", pound: "£" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** "â\u0080\u00a6" (UTF-8 bytes read as Latin-1) -> "…". Leaves text without such runs untouched. */
export function fixMojibake(s: string): string {
  if (!/[\u00c2-\u00f4][\u0080-\u00bf]/.test(s)) return s;
  return s.replace(/[\u00c2-\u00f4][\u0080-\u00bf]{1,3}/g, (run) => {
    const out = Buffer.from(run, "latin1").toString("utf8");
    return out.includes("\ufffd") || out.length !== 1 ? run : out;
  });
}

/** HTML (sometimes entity-encoded twice) -> safe plain text with paragraph breaks. */
export function cleanText(input: unknown, max = 8000): string {
  let s = fixMojibake(str(input));
  if (!s) return "";
  // Arbeitnow sends &lt;p&gt;… : decode once so the tags become real tags, then strip them.
  if (/&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<\s*(script|style|noscript|iframe|svg)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|li|section|article|tr)\s*>/gi, "\n")
    .replace(/<\s*(p|div|h[1-6]|ul|ol|section|article|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  s = decodeEntities(s)
    // RemoteOK double-encodes non-breaking spaces as "Â ".
    .replace(/Â(?=[\s\u00a0]|$)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, "")}…`;
  return s;
}

const oneLine = (v: unknown, max = 200) => cleanText(v, max * 2).replace(/\s+/g, " ").trim().slice(0, max);

/** Only real absolute https links are allowed as apply URLs. */
export function safeHttpsUrl(v: unknown): string | null {
  const s = str(v).trim();
  if (!s || s.length > 2000) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || !u.hostname.includes(".") || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function toDate(v: unknown): Date | null {
  if (typeof v === "number" || (typeof v === "string" && /^\d{9,13}$/.test(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = str(v).trim();
  if (!s) return null;
  // Remotive sends "2026-11-25T11:26:35" without a zone: treat it as UTC.
  const d = new Date(/T\d\d:\d\d(:\d\d)?$/.test(s) ? `${s}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tagList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out: string[] = [];
  for (const t of raw) {
    const s = oneLine(t, 40);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= 12) break;
  }
  return out;
}

const money = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);

function finish(job: Partial<NormalizedJob> & { source: JobSource }): NormalizedJob | null {
  const applyUrl = safeHttpsUrl(job.applyUrl);
  const title = oneLine(job.title, 160);
  const company = oneLine(job.company, 120);
  const externalId = oneLine(job.externalId, 190);
  if (!applyUrl || !title || !company || !externalId) return null;
  return {
    externalId,
    source: job.source,
    title,
    company,
    location: /^\s*(remote|remote job|remote work|anywhere|worldwide remote|poste à distance|werken op afstand|home ?office|fernarbeit|trabajo remoto)\s*$/i.test(oneLine(job.location, 120)) ? "Remote" : oneLine(job.location, 120) || (job.remote ? "Remote" : ""),
    remote: Boolean(job.remote),
    salary: job.salary ? oneLine(job.salary, 80) || null : null,
    tags: job.tags ?? [],
    description: cleanText(job.description),
    applyUrl,
    postedAt: job.postedAt ?? null,
  };
}

async function getJson(fetchImpl: FetchLike, url: string, signal: AbortSignal, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const res = await fetchImpl(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers ?? {}) }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const remoteOk: Provider = {
  source: "remoteok",
  minIntervalMs: 2 * MIN,
  enabled: (env) => env.JOBS_REMOTEOK_ENABLED !== "false",
  async fetchJobs(fetchImpl, signal) {
    const data = await getJson(fetchImpl, "https://remoteok.com/api", signal);
    if (!Array.isArray(data)) throw new Error("Unexpected RemoteOK response");
    const out: NormalizedJob[] = [];
    for (const r of data) {
      if (!isRec(r) || !r.id || !r.position) continue; // first element is the legal notice
      const lo = Number(r.salary_min) || 0;
      const hi = Number(r.salary_max) || 0;
      const salary = lo && hi ? `${money(lo)} – ${money(hi)}` : hi ? `Up to ${money(hi)}` : lo ? `From ${money(lo)}` : null;
      const job = finish({
        source: "remoteok",
        externalId: str(r.id),
        title: r.position as string,
        company: r.company as string,
        location: str(r.location) || "Remote",
        remote: true,
        salary,
        tags: tagList(r.tags),
        description: r.description as string,
        applyUrl: str(r.url) || str(r.apply_url),
        postedAt: toDate(r.date) ?? toDate(r.epoch),
      });
      if (job) out.push(job);
    }
    return out;
  },
};

export const arbeitnow: Provider = {
  source: "arbeitnow",
  minIntervalMs: 2 * MIN,
  enabled: (env) => env.JOBS_ARBEITNOW_ENABLED !== "false",
  async fetchJobs(fetchImpl, signal) {
    const data = await getJson(fetchImpl, "https://www.arbeitnow.com/api/job-board-api", signal);
    const rows = isRec(data) && Array.isArray(data.data) ? data.data : null;
    if (!rows) throw new Error("Unexpected Arbeitnow response");
    const out: NormalizedJob[] = [];
    for (const r of rows) {
      if (!isRec(r)) continue;
      const types = Array.isArray(r.job_types) ? r.job_types.map(str).filter(Boolean) : [];
      const job = finish({
        source: "arbeitnow",
        externalId: str(r.slug),
        title: r.title as string,
        company: r.company_name as string,
        location: str(r.location),
        remote: r.remote === true,
        salary: null,
        tags: tagList([...(Array.isArray(r.tags) ? r.tags : []), ...types]),
        description: r.description as string,
        applyUrl: str(r.url),
        postedAt: toDate(r.created_at),
      });
      if (job) out.push(job);
    }
    return out;
  },
};

export const remotive: Provider = {
  source: "remotive",
  // Remotive asks for at most ~4 requests a day.
  minIntervalMs: 6 * 60 * MIN,
  enabled: (env) => env.JOBS_REMOTIVE_ENABLED !== "false",
  async fetchJobs(fetchImpl, signal) {
    const data = await getJson(fetchImpl, "https://remotive.com/api/remote-jobs", signal);
    const rows = isRec(data) && Array.isArray(data.jobs) ? data.jobs : null;
    if (!rows) throw new Error("Unexpected Remotive response");
    const out: NormalizedJob[] = [];
    for (const r of rows) {
      if (!isRec(r)) continue;
      const job = finish({
        source: "remotive",
        externalId: str(r.id),
        title: r.title as string,
        company: r.company_name as string,
        location: str(r.candidate_required_location) || "Remote",
        remote: true,
        salary: str(r.salary) || null,
        tags: tagList([...(Array.isArray(r.tags) ? r.tags : []), str(r.category)].filter(Boolean)),
        description: r.description as string,
        applyUrl: str(r.url),
        postedAt: toDate(r.publication_date),
      });
      if (job) out.push(job);
    }
    return out;
  },
};

/** Optional: JSearch (RapidAPI) when JSEARCH_API_KEY is set. */
export const jsearch: Provider = {
  source: "jsearch",
  minIntervalMs: 60 * MIN,
  enabled: (env) => Boolean(env.JSEARCH_API_KEY),
  async fetchJobs(fetchImpl, signal, env) {
    const query = encodeURIComponent(env.JSEARCH_QUERY || "software engineer");
    const data = await getJson(fetchImpl, `https://jsearch.p.rapidapi.com/search?query=${query}&page=1&num_pages=1`, signal, {
      headers: { "X-RapidAPI-Key": String(env.JSEARCH_API_KEY), "X-RapidAPI-Host": "jsearch.p.rapidapi.com" },
    });
    const rows = isRec(data) && Array.isArray(data.data) ? data.data : null;
    if (!rows) throw new Error("Unexpected JSearch response");
    const out: NormalizedJob[] = [];
    for (const r of rows) {
      if (!isRec(r)) continue;
      const lo = Number(r.job_min_salary) || 0;
      const hi = Number(r.job_max_salary) || 0;
      const job = finish({
        source: "jsearch",
        externalId: str(r.job_id),
        title: r.job_title as string,
        company: r.employer_name as string,
        location: [str(r.job_city), str(r.job_state), str(r.job_country)].filter(Boolean).join(", "),
        remote: r.job_is_remote === true,
        salary: lo && hi ? `${money(lo)} – ${money(hi)}` : null,
        tags: tagList(Array.isArray(r.job_required_skills) ? r.job_required_skills : []),
        description: r.job_description as string,
        applyUrl: str(r.job_apply_link),
        postedAt: toDate(r.job_posted_at_datetime_utc) ?? toDate(r.job_posted_at_timestamp),
      });
      if (job) out.push(job);
    }
    return out;
  },
};

/** Optional: Jooble when JOOBLE_API_KEY is set. */
export const jooble: Provider = {
  source: "jooble",
  minIntervalMs: 60 * MIN,
  enabled: (env) => Boolean(env.JOOBLE_API_KEY),
  async fetchJobs(fetchImpl, signal, env) {
    const key = encodeURIComponent(String(env.JOOBLE_API_KEY));
    const data = await getJson(fetchImpl, `https://jooble.org/api/${key}`, signal, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords: env.JOOBLE_QUERY || "software engineer", location: env.JOOBLE_LOCATION || "" }),
    });
    const rows = isRec(data) && Array.isArray(data.jobs) ? data.jobs : null;
    if (!rows) throw new Error("Unexpected Jooble response");
    const out: NormalizedJob[] = [];
    for (const r of rows) {
      if (!isRec(r)) continue;
      const job = finish({
        source: "jooble",
        externalId: str(r.id),
        title: r.title as string,
        company: r.company as string,
        location: str(r.location),
        remote: /remote/i.test(`${str(r.location)} ${str(r.type)}`),
        salary: str(r.salary) || null,
        tags: tagList(str(r.type) ? [str(r.type)] : []),
        description: r.snippet as string,
        applyUrl: str(r.link),
        postedAt: toDate(r.updated),
      });
      if (job) out.push(job);
    }
    return out;
  },
};

export const PROVIDERS: Provider[] = [remoteOk, arbeitnow, remotive, jsearch, jooble];

/** "Senior React Engineer (m/w/d)" @ "Acme GmbH" -> "acme|senior react engineer". */
export function dedupeKey(company: string, title: string): string {
  const c = company
    .toLowerCase()
    .replace(/\b(gmbh|inc|llc|ltd|limited|corp|corporation|co|ag|se|bv|s\.?a\.?|plc|group)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const t = title
    .toLowerCase()
    .replace(/\((?:m|w|f|d|x|gn|all genders?|f\/m\/d|m\/w\/d|m\/f\/d)[^)]*\)/g, " ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
  return `${c}|${t}`;
}

/** Drop repeats by (source, externalId) and by normalized (company, title). First one wins. */
export function dedupeJobs(jobs: NormalizedJob[]): NormalizedJob[] {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const out: NormalizedJob[] = [];
  for (const j of jobs) {
    const id = `${j.source}:${j.externalId}`;
    const key = dedupeKey(j.company, j.title);
    if (ids.has(id) || keys.has(key)) continue;
    ids.add(id);
    keys.add(key);
    out.push(j);
  }
  return out;
}
