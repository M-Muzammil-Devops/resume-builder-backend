import test from "node:test";
import assert from "node:assert/strict";
import { JobFeedService } from "./feed";
import { arbeitnow, cleanText, dedupeJobs, dedupeKey, remoteOk, remotive, safeHttpsUrl, PROVIDERS, jsearch, jooble } from "./providers";
import { ARBEITNOW_PAYLOAD, LIVE_ROUTES, REMOTEOK_PAYLOAD, REMOTIVE_PAYLOAD, memoryStore, mockFetch } from "./feed.fixture";
import { buildModel, jobKeywordTerms, matchJobTerms } from "../ats/advanced";
import { STRONG_RESUME, WEAK_RESUME } from "../ats/advanced.fixture";

const env = {} as NodeJS.ProcessEnv;
const signal = new AbortController().signal;

test("RemoteOK adapter: skips the legal row and non-https links, normalizes salary/tags/dates", async () => {
  const { impl } = mockFetch({ "https://remoteok.com/api": { body: REMOTEOK_PAYLOAD } });
  const jobs = await remoteOk.fetchJobs(impl, signal, env);
  assert.equal(jobs.filter((j) => j.externalId === "1003").length, 0, "http:// apply link dropped");
  const j = jobs.find((x) => x.externalId === "1001" && x.company === "Acme Cloud")!;
  assert.equal(j.source, "remoteok");
  assert.equal(j.title, "Senior DevOps Engineer");
  assert.equal(j.remote, true);
  assert.equal(j.salary, "$120k – $160k");
  assert.deepEqual(j.tags, ["devops", "aws", "kubernetes", "terraform"]);
  assert.equal(j.postedAt?.toISOString(), "2026-11-26T15:40:28.000Z");
  assert.ok(j.applyUrl.startsWith("https://"));
  assert.ok(!/[<>]/.test(j.description), "HTML stripped");
  assert.match(j.description, /• Terraform & Helm/);
  const sales = jobs.find((x) => x.externalId === "1002")!;
  assert.equal(sales.location, "Remote");
  assert.equal(sales.salary, null);
});

test("Arbeitnow + Remotive adapters: double-encoded HTML, remote flag, zone-less dates", async () => {
  const a = await arbeitnow.fetchJobs(mockFetch({ "https://www.arbeitnow.com": { body: ARBEITNOW_PAYLOAD } }).impl, signal, env);
  assert.equal(a.length, 2);
  assert.equal(a[0].source, "arbeitnow");
  assert.equal(a[0].externalId, "platform-engineer-berlin-319876");
  assert.equal(a[0].remote, false);
  assert.equal(a[0].postedAt?.toISOString(), new Date(1795805730 * 1000).toISOString());
  assert.ok(!/&lt;|<strong>/.test(a[0].description), a[0].description);
  assert.match(a[0].description, /Linux, AWS, Docker/);
  assert.deepEqual(a[0].tags, ["Technology", "Full Time"]);
  const r = await remotive.fetchJobs(mockFetch({ "https://remotive.com": { body: REMOTIVE_PAYLOAD } }).impl, signal, env);
  assert.equal(r.length, 1);
  assert.equal(r[0].company, "Creative Force");
  assert.equal(r[0].postedAt?.toISOString(), "2026-11-25T11:26:35.000Z");
  assert.equal(r[0].salary, "$70k - $90k");
  assert.ok(r[0].tags.includes("Software Development"));
});

test("helpers: https-only URLs, safe text, dedupe keys", () => {
  assert.equal(safeHttpsUrl("http://x.com/a"), null);
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpsUrl("https://user:pw@x.com"), null);
  assert.equal(safeHttpsUrl("https://jobs.example.com/a?b=1"), "https://jobs.example.com/a?b=1");
  assert.equal(cleanText("<script>alert(1)</script><p>Hi&nbsp;there â\u0080\u00a6</p>"), "Hi there …");
  assert.equal(dedupeKey("Acme Cloud Inc", "Senior DevOps Engineer (m/w/d)"), dedupeKey("Acme Cloud", "Senior DevOps Engineer"));
  const base = { location: "", remote: true, salary: null, tags: [], description: "", applyUrl: "https://a.b/c", postedAt: null };
  const out = dedupeJobs([
    { ...base, source: "remoteok", externalId: "1", title: "Dev", company: "A" },
    { ...base, source: "remoteok", externalId: "1", title: "Other", company: "B" },
    { ...base, source: "arbeitnow", externalId: "9", title: "Dev", company: "A GmbH" },
    { ...base, source: "arbeitnow", externalId: "10", title: "QA", company: "A" },
  ]);
  assert.deepEqual(out.map((j) => j.externalId), ["1", "10"]);
  assert.equal(jsearch.enabled({} as NodeJS.ProcessEnv), false);
  assert.equal(jooble.enabled({ JOOBLE_API_KEY: "k" } as NodeJS.ProcessEnv), true);
});

test("feed: all providers in parallel, cross-source dedupe, keywords extracted, TTL cache", async () => {
  let now = new Date("2026-11-28T00:00:00Z");
  const { impl, calls } = mockFetch(LIVE_ROUTES);
  const { store } = memoryStore();
  const feed = new JobFeedService({ store, fetch: impl, env, now: () => now });
  const list = await feed.list();
  assert.equal(calls.length, 3, "RemoteOK + Arbeitnow + Remotive fetched (JSearch / Jooble have no key)");
  // 2 RemoteOK + 2 Arbeitnow + 1 Remotive, minus the Acme duplicate.
  assert.equal(list.length, 4);
  assert.equal(list.filter((j) => j.title === "Senior DevOps Engineer").length, 1);
  assert.ok(list.every((j) => j.applyUrl.startsWith("https://")));
  const devops = list.find((j) => j.title === "Senior DevOps Engineer")!;
  assert.equal(devops.source, "remoteok", "newest copy wins");
  for (const k of ["kubernetes", "terraform", "aws"]) assert.ok([...devops.keywords, ...devops.niceKeywords].includes(k), k);
  const sales = list.find((j) => j.company === "Snowflake")!;
  assert.ok(![...sales.keywords, ...sales.niceKeywords].includes("snowflake"), "employer name is not a skill");
  assert.ok(![...sales.keywords, ...sales.niceKeywords].includes("golang"), "Go-To-Market is not Go");
  const st = feed.status();
  assert.equal(st.total, 4);
  assert.ok(st.lastRefreshedAt);
  assert.deepEqual(st.providers.map((p) => p.status), ["fetched", "fetched", "fetched", "disabled", "disabled"]);

  now = new Date(now.getTime() + 10 * 60_000);
  await feed.list();
  assert.equal(calls.length, 3, "inside the 30 min TTL nothing is fetched");
  now = new Date(now.getTime() + 25 * 60_000);
  await feed.list();
  await feed.refresh(); // join the background refresh
  assert.equal(calls.length, 5, "after the TTL RemoteOK + Arbeitnow refresh; Remotive waits 6h");
});

test("feed: a failing / slow provider does not block the others, and last good jobs stay", async () => {
  const now = new Date("2026-11-28T00:00:00Z");
  const { impl } = mockFetch({
    "https://remoteok.com/api": { status: 503 },
    "https://www.arbeitnow.com/api/job-board-api": { body: ARBEITNOW_PAYLOAD, delayMs: 500 },
    "https://remotive.com/api/remote-jobs": { body: REMOTIVE_PAYLOAD },
  });
  const { store } = memoryStore();
  const feed = new JobFeedService({ store, fetch: impl, env, now: () => now, timeoutMs: 50 });
  const t0 = Date.now();
  const reports = await feed.refresh();
  assert.ok(Date.now() - t0 < 400, "timeout cut the slow provider");
  const by = Object.fromEntries(reports.map((r) => [r.source, r]));
  assert.equal(by.remoteok.status, "failed");
  assert.match(by.remoteok.error!, /503/);
  assert.equal(by.arbeitnow.status, "failed");
  assert.match(by.arbeitnow.error!, /timed out/);
  assert.equal(by.remotive.status, "fetched");
  assert.equal((await feed.list()).length, 1);

  // A later failure of Remotive keeps its cached jobs listed.
  const { store: s2 } = memoryStore();
  let t = new Date("2026-11-28T00:00:00Z");
  const ok = mockFetch(LIVE_ROUTES);
  const f2 = new JobFeedService({ store: s2, fetch: ok.impl, env, now: () => t });
  assert.equal((await f2.list()).length, 4);
  const broken = new JobFeedService({ store: s2, fetch: mockFetch({ "https://": { throws: "ECONNRESET" } }).impl, env, now: () => t });
  t = new Date(t.getTime() + 7 * 60 * 60_000);
  await broken.refresh({ force: true });
  assert.equal((await broken.list()).length, 4, "failed refresh keeps the last good jobs");
});

test("feed: forced refresh is throttled per provider; jobs that left a feed are hidden", async () => {
  let now = new Date("2026-11-28T00:00:00Z");
  const routes = { ...LIVE_ROUTES };
  const { impl, calls } = mockFetch(routes);
  const { store } = memoryStore();
  const feed = new JobFeedService({ store, fetch: impl, env, now: () => now });
  await feed.refresh({ force: true });
  assert.equal(calls.length, 3);
  await feed.refresh({ force: true });
  assert.equal(calls.length, 3, "a second forced refresh right away fetches nothing");
  assert.ok(feed.nextRefreshInSec() > 0);
  now = new Date(now.getTime() + 3 * 60_000);
  routes["https://remoteok.com/api"] = { body: [REMOTEOK_PAYLOAD[0], REMOTEOK_PAYLOAD[1]] };
  await feed.refresh({ force: true });
  assert.equal(calls.length, 5, "RemoteOK + Arbeitnow after 2 min; Remotive keeps its 6h limit");
  const list = await feed.list();
  assert.equal(list.some((j) => j.company === "Snowflake"), false, "job removed from RemoteOK is no longer listed");
  assert.equal(PROVIDERS.find((p) => p.source === "remotive")!.minIntervalMs, 6 * 60 * 60_000);
});

test("ATS match %: strong DevOps resume beats weak one; matched / missing skills", () => {
  const kw = jobKeywordTerms("Senior DevOps Engineer", cleanText(REMOTEOK_PAYLOAD[1].description as string), ["devops", "aws", "kubernetes", "terraform"], "Acme Cloud");
  const strong = matchJobTerms(buildModel(STRONG_RESUME), kw.required, kw.nice, "Senior DevOps Engineer");
  const weak = matchJobTerms(buildModel(WEAK_RESUME), kw.required, kw.nice, "Senior DevOps Engineer");
  assert.equal(strong.basis, "keywords");
  assert.ok(strong.score >= 70 && strong.score <= 100, `strong ${strong.score}`);
  assert.ok(weak.score < strong.score - 30, `weak ${weak.score} vs ${strong.score}`);
  assert.ok(strong.matched.includes("Kubernetes") && strong.matched.includes("Terraform"), strong.matched.join());
  assert.ok(weak.missing.includes("Kubernetes"));
  for (const r of [strong, weak]) assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100);
  // Few skills in the post -> title relevance, capped at 60.
  const t = matchJobTerms(buildModel(STRONG_RESUME), [], [], "DevOps Engineer");
  assert.equal(t.basis, "title");
  assert.ok(t.score > 0 && t.score <= 60);
});
