import type { FetchLike } from "./providers";
import type { FeedJob, FeedState, FeedStore } from "./feed";

/** Trimmed copies of the real provider payload shapes (Nov 2026). */
export const REMOTEOK_PAYLOAD = [
  { last_updated: 1795786372, legal: "API Terms of Service: Please link back to Remote OK." },
  {
    slug: "remote-senior-devops-engineer-acme-1001", id: "1001", epoch: 1795707628, date: "2026-11-26T15:40:28+00:00",
    company: "Acme Cloud", position: "Senior DevOps Engineer", tags: ["devops", "aws", "kubernetes", "terraform"],
    description: "<p>We run <b>Kubernetes</b> on AWS.</p><ul><li>Terraform &amp; Helm</li><li>CI/CD with GitHub Actions</li><li>Prometheus and Grafana</li></ul><p>Nice to have: Go</p>",
    location: "Worldwide", apply_url: "https://remoteOK.com/remote-jobs/remote-senior-devops-engineer-acme-1001",
    salary_min: 120000, salary_max: 160000, url: "https://remoteOK.com/remote-jobs/remote-senior-devops-engineer-acme-1001",
  },
  {
    slug: "remote-sales-lead-1002", id: "1002", epoch: 1795600000, date: "2026-11-25T10:00:00+00:00",
    company: "Snowflake", position: "Partner Sales Manager", tags: ["sales"], description: "<p>Sell Snowflake. Go-To-Market plans.</p>",
    location: "", url: "https://remoteOK.com/remote-jobs/remote-sales-lead-1002", salary_min: 0, salary_max: 0,
  },
  // Not https -> dropped.
  { id: "1003", position: "Bad Link Job", company: "Nope", description: "x", url: "http://example.com/job", date: "2026-11-25T10:00:00+00:00" },
  // Duplicate id inside one payload -> dropped.
  { id: "1001", position: "Senior DevOps Engineer", company: "Acme Cloud", description: "dup", url: "https://remoteok.com/remote-jobs/x", date: "2026-11-26T15:40:28+00:00" },
];

export const ARBEITNOW_PAYLOAD = {
  data: [
    {
      slug: "platform-engineer-berlin-319876", company_name: "Fiskaly GmbH", title: "Platform Engineer (m/w/d)",
      description: "&lt;h2&gt;&lt;strong&gt;Job Details&lt;/strong&gt;&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Linux, AWS, Docker&lt;/li&gt;&lt;li&gt;Terraform&lt;/li&gt;&lt;/ul&gt;",
      remote: false, url: "https://www.arbeitnow.com/jobs/companies/fiskaly/platform-engineer-berlin-319876",
      tags: ["Technology"], job_types: ["Full Time"], location: "Berlin", created_at: 1795805730,
    },
    // Same company + title as the RemoteOK job -> cross-source duplicate.
    {
      slug: "senior-devops-engineer-acme-777", company_name: "Acme Cloud Inc", title: "Senior DevOps Engineer",
      description: "<p>Same role.</p>", remote: true, url: "https://www.arbeitnow.com/jobs/companies/acme/senior-devops-777",
      tags: [], job_types: [], location: "Remote", created_at: 1795500000,
    },
  ],
  links: {},
  meta: {},
};

export const REMOTIVE_PAYLOAD = {
  "job-count": 1,
  jobs: [
    {
      id: 2091212, url: "https://remotive.com/remote-jobs/software-dev/frontend-engineer-2091212", title: "Frontend Engineer",
      company_name: "Creative Force ", category: "Software Development", tags: ["react", "typescript", "css"],
      job_type: "full_time", publication_date: "2026-11-25T11:26:35", candidate_required_location: "Europe",
      salary: "$70k - $90k", description: "<p>React, TypeScript and CSS. Nice to have: GraphQL.</p>",
    },
  ],
};

export type MockRoute = { status?: number; body?: unknown; delayMs?: number; throws?: string };

/** fetch stand-in keyed by URL prefix; records every call. */
export function mockFetch(routes: Record<string, MockRoute>) {
  const calls: string[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const r = routes[key];
    if (r.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, r.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    }
    if (r.throws) throw new Error(r.throws);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body };
  };
  return { impl, calls };
}

export const LIVE_ROUTES: Record<string, MockRoute> = {
  "https://remoteok.com/api": { body: REMOTEOK_PAYLOAD },
  "https://www.arbeitnow.com/api/job-board-api": { body: ARBEITNOW_PAYLOAD },
  "https://remotive.com/api/remote-jobs": { body: REMOTIVE_PAYLOAD },
};

/** In-memory FeedStore with the same semantics as the Prisma one. */
export function memoryStore() {
  const jobs = new Map<string, FeedJob & { active: boolean }>();
  const states = new Map<string, FeedState>();
  let n = 0;
  const store: FeedStore = {
    states: async () => [...states.values()],
    saveState: async (s) => {
      states.set(s.source, { ...s });
    },
    upsertJobs: async (list, at) => {
      for (const j of list) {
        const key = `${j.source}:${j.externalId}`;
        const prev = jobs.get(key);
        jobs.set(key, { ...j, id: prev?.id ?? `job${++n}`, fetchedAt: at, active: true });
      }
    },
    deactivateMissing: async (source, before) => {
      for (const j of jobs.values()) if (j.source === source && j.fetchedAt && j.fetchedAt < before) j.active = false;
    },
    loadActive: async () => [...jobs.values()].filter((j) => j.active).map((j) => ({ ...j })),
  };
  return { store, jobs, states };
}
