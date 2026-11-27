import fs from "fs/promises";
import os from "os";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma";
import { adminGuard, adminOf } from "../lib/adminAuth";
import { auditAdmin } from "../lib/adminAudit";
import { TEAM_ROLES, isTeamRole, roleDefaults, type TeamRole } from "../lib/adminAccess";
import { cacheDel, cacheGet, cacheSet, redisPing, redisStatus } from "../lib/redis";
import { verifyMail, sendMail, mailConfigured } from "../lib/mailer";
import { pendingSince } from "../lib/requestStats";
import { ALL_SITE_PAGES } from "../lib/sitePages";
import { buildPdf } from "../lib/simplePdf";
import { env } from "../config/env";
import { adminSettingsSchema, getAdminSettings, integrationStatus, saveAdminSettings } from "../lib/appSettings";

/** The owner's time zone (Asia/Karachi, UTC+5, no DST). Days and hours in the dashboard are PKT. */
export const PKT_OFFSET_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;

export const RANGES = { today: 1, "7d": 7, "30d": 30, "90d": 90 } as const;
export type Range = keyof typeof RANGES;

/** UTC instant of 00:00 PKT on the day `now` falls in. */
export function pktDayStart(now: number): number {
  return Math.floor((now + PKT_OFFSET_MS) / DAY_MS) * DAY_MS - PKT_OFFSET_MS;
}

/** First instant of the range: today = since 00:00 PKT, Nd = the last N PKT days including today. */
export function rangeStart(range: Range, now = Date.now()): Date {
  return new Date(pktDayStart(now) - (RANGES[range] - 1) * DAY_MS);
}

export function pktDayKey(ms: number): string {
  return new Date(ms + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function hourLabel(h: number): string {
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
}

/** Busiest and quietest 2-hour windows of a 24-slot series. */
export function peakWindows(hours: number[]) {
  let best = 0;
  let worst = 0;
  let bestSum = -1;
  let worstSum = Number.POSITIVE_INFINITY;
  for (let h = 0; h < 24; h += 1) {
    const sum = hours[h] + hours[(h + 1) % 24];
    if (sum > bestSum) {
      bestSum = sum;
      best = h;
    }
    if (sum < worstSum) {
      worstSum = sum;
      worst = h;
    }
  }
  const total = hours.reduce((a, b) => a + b, 0) || 1;
  return {
    peak: { from: best, to: (best + 2) % 24, label: `${hourLabel(best)} – ${hourLabel((best + 2) % 24)}`, share: bestSum / total },
    quiet: { from: worst, to: (worst + 2) % 24, label: `${hourLabel(worst)} – ${hourLabel((worst + 2) % 24)}`, share: worstSum / total },
  };
}

type DeviceKey = "desktop" | "mobile" | "tablet" | "other";
function deviceKey(raw: string | null): DeviceKey {
  if (raw === "desktop" || raw === "mobile" || raw === "tablet") return raw;
  return "other";
}

const int = (v: unknown) => Number(v ?? 0) || 0;

async function overview(range: Range) {
  const now = Date.now();
  const since = rangeStart(range, now);
  const today = new Date(pktDayStart(now));
  const day30 = new Date(now - 30 * DAY_MS);
  const userWhere = { role: "user", status: { not: "DELETED" } };

  const [
    totalUsers,
    newToday,
    newPeriod,
    planGroups,
    resumesTotal,
    resumesPeriod,
    pdfPeriod,
    pdfTotal,
    audioPeriod,
    contactPeriod,
    viewsPeriod,
    pathsTracked,
    reqStats,
    dauRows,
    mauRows,
    periodActiveRows,
    returningRows,
  ] = await Promise.all([
    prisma.user.count({ where: userWhere }),
    prisma.user.count({ where: { ...userWhere, createdAt: { gte: today } } }),
    prisma.user.count({ where: { ...userWhere, createdAt: { gte: since } } }),
    prisma.user.groupBy({ by: ["plan"], where: userWhere, _count: { _all: true } }),
    prisma.resume.count(),
    prisma.resume.count({ where: { createdAt: { gte: since } } }),
    prisma.exportEvent.count({ where: { format: "pdf", createdAt: { gte: since } } }),
    prisma.exportEvent.count({ where: { format: "pdf" } }),
    prisma.usageEvent.count({ where: { kind: "audio_job", createdAt: { gte: since } } }),
    prisma.contactMessage.count({ where: { createdAt: { gte: since } } }),
    prisma.pageView.count({ where: { createdAt: { gte: since } } }),
    prisma.pageView.groupBy({ by: ["path"], where: { createdAt: { gte: since } }, _count: { _all: true }, orderBy: { _count: { path: "desc" } }, take: 200 }),
    prisma.requestStat.aggregate({ where: { bucket: { gte: new Date(since.getTime() - 3_600_000) } }, _sum: { total: true, errors: true } }),
    activeUsersSince(today),
    activeUsersSince(day30),
    activeUsersSince(since),
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(DISTINCT e."userId")::int AS n FROM "LoginEvent" e JOIN "User" u ON u.id = e."userId"
      WHERE e."createdAt" >= ${since} AND u.role = 'user' AND u."createdAt" < ${since}`,
  ]);

  const [dailySignups, dailyViews, dailyLogins, hourRows, deviceViews, deviceLogins, geoRows, latestContacts, latestSignups] =
    await Promise.all([
      prisma.$queryRaw<{ d: string; n: number }[]>`
        SELECT to_char(("createdAt" + interval '5 hours')::date, 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
        FROM "User" WHERE role = 'user' AND "createdAt" >= ${since} GROUP BY 1`,
      prisma.$queryRaw<{ d: string; n: number }[]>`
        SELECT to_char(("createdAt" + interval '5 hours')::date, 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
        FROM "PageView" WHERE "createdAt" >= ${since} GROUP BY 1`,
      prisma.$queryRaw<{ d: string; n: number }[]>`
        SELECT to_char(("createdAt" + interval '5 hours')::date, 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
        FROM "LoginEvent" WHERE "createdAt" >= ${since} GROUP BY 1`,
      prisma.$queryRaw<{ h: number; dow: number; n: number }[]>`
        SELECT EXTRACT(HOUR FROM t."createdAt" + interval '5 hours')::int AS h,
               EXTRACT(ISODOW FROM t."createdAt" + interval '5 hours')::int AS dow,
               COUNT(*)::int AS n
        FROM (
          SELECT "createdAt" FROM "PageView" WHERE "createdAt" >= ${since}
          UNION ALL
          SELECT "createdAt" FROM "LoginEvent" WHERE "createdAt" >= ${since}
        ) t GROUP BY 1, 2`,
      prisma.pageView.groupBy({ by: ["device"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.loginEvent.groupBy({ by: ["device"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.$queryRaw<{ code: string | null; country: string | null; visits: number; users: number }[]>`
        SELECT "countryCode" AS code, MAX(country) AS country, COUNT(*)::int AS visits, COUNT(DISTINCT "userId")::int AS users
        FROM "LoginEvent" WHERE "createdAt" >= ${since} AND (country IS NOT NULL OR "countryCode" IS NOT NULL)
        GROUP BY "countryCode" ORDER BY visits DESC LIMIT 120`,
      prisma.contactMessage.findMany({ orderBy: { createdAt: "desc" }, take: 8, select: { id: true, name: true, email: true, message: true, createdAt: true } }),
      prisma.user.findMany({
        where: { ...userWhere, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, name: true, email: true, createdAt: true, country: true },
      }),
    ]);

  // Line chart: one point per PKT day.
  const days = RANGES[range];
  const map = (rows: { d: string; n: number }[]) => new Map(rows.map((r) => [r.d, int(r.n)]));
  const sMap = map(dailySignups);
  const vMap = map(dailyViews);
  const lMap = map(dailyLogins);
  const dailyTrend = Array.from({ length: days }, (_, i) => {
    const key = pktDayKey(since.getTime() + i * DAY_MS);
    return { date: key, signups: sMap.get(key) || 0, visits: (vMap.get(key) || 0) + (lMap.get(key) || 0), pageViews: vMap.get(key) || 0, logins: lMap.get(key) || 0 };
  });

  // Bar chart: 24 PKT hours + Mon..Sun.
  const hours = Array.from({ length: 24 }, () => 0);
  const weekdays = Array.from({ length: 7 }, () => 0);
  for (const r of hourRows) {
    hours[int(r.h)] += int(r.n);
    weekdays[(int(r.dow) + 6) % 7] += int(r.n);
  }
  const windows = peakWindows(hours);
  const busiest = weekdays.indexOf(Math.max(...weekdays));

  const devices: Record<DeviceKey, number> = { desktop: 0, mobile: 0, tablet: 0, other: 0 };
  for (const r of [...deviceViews, ...deviceLogins]) devices[deviceKey(r.device)] += r._count._all;

  const plans = { free: 0, pro: 0 };
  for (const g of planGroups) {
    if (g.plan === "PRO") plans.pro += g._count._all;
    else plans.free += g._count._all;
  }

  const reqTotal = int(reqStats._sum.total) + pendingSince(since).total;
  const reqErrors = int(reqStats._sum.errors) + pendingSince(since).errors;

  const leads = [
    ...latestContacts.map((c) => ({ id: `c-${c.id}`, type: "contact" as const, name: c.name, email: c.email, note: c.message.slice(0, 120), createdAt: c.createdAt })),
    ...latestSignups.map((u) => ({ id: `s-${u.id}`, type: "signup" as const, name: u.name || u.email.split("@")[0], email: u.email, note: u.country ? `Signed up · ${u.country}` : "Signed up", createdAt: u.createdAt })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 8);

  const trackedPaths = new Set(pathsTracked.map((p) => p.path));
  return {
    range,
    since: since.toISOString(),
    timezone: "Asia/Karachi",
    generatedAt: new Date(now).toISOString(),
    kpis: {
      totalUsers,
      newUsers: { today: newToday, period: newPeriod },
      activeUsers: { dau: int(dauRows[0]?.n), mau: int(mauRows[0]?.n), period: int(periodActiveRows[0]?.n), returning: int(returningRows[0]?.n) },
      totalWebsitePages: { total: ALL_SITE_PAGES.length, tracked: trackedPaths.size, views: viewsPeriod },
      leadsCount: { total: contactPeriod + newPeriod, contact: contactPeriod, signups: newPeriod },
      billingPlanSplit: plans,
      resumesCount: { total: resumesTotal, period: resumesPeriod },
      pdfExportsCount: { total: pdfTotal, period: pdfPeriod },
      audioJobsCount: { period: audioPeriod },
      errorRate: { rate: reqTotal ? reqErrors / reqTotal : 0, errors: reqErrors, requests: reqTotal },
    },
    dailyTrend,
    peakHours: {
      hours: hours.map((count, hour) => ({ hour, label: hourLabel(hour), count })),
      weekdays: weekdays.map((count, i) => ({ day: DAY_NAMES[i], count })),
      peak: windows.peak,
      quiet: windows.quiet,
      busiestDay: weekdays[busiest] > 0 ? DAY_NAMES[busiest] : null,
      total: hours.reduce((a, b) => a + b, 0),
    },
    devices: (Object.keys(devices) as DeviceKey[]).map((k) => ({ device: k, count: devices[k] })),
    geography: geoRows.map((g) => ({
      code: g.code ? g.code.toUpperCase() : null,
      country: g.country || g.code || "Unknown",
      visits: int(g.visits),
      users: int(g.users),
    })),
    topPages: pathsTracked.slice(0, 8).map((p) => ({ path: p.path, views: p._count._all })),
    latestLeads: leads,
  };
}

function activeUsersSince(since: Date) {
  return prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(DISTINCT t.uid)::int AS n FROM (
      SELECT "userId" AS uid FROM "LoginEvent" WHERE "createdAt" >= ${since}
      UNION
      SELECT "userId" AS uid FROM "PageView" WHERE "userId" IS NOT NULL AND "createdAt" >= ${since}
    ) t JOIN "User" u ON u.id = t.uid WHERE u.role = 'user'`;
}

async function memInfo() {
  try {
    const raw = await fs.readFile("/proc/meminfo", "utf8");
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(raw)?.[1] || 0);
    const total = kb("MemTotal") * 1024;
    const avail = kb("MemAvailable") * 1024;
    if (total > 0) return { total, used: total - avail };
  } catch {
    /* not Linux */
  }
  return { total: os.totalmem(), used: os.totalmem() - os.freemem() };
}

async function health() {
  const started = Date.now();
  let dbOk = false;
  let dbMs: number | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    dbMs = Date.now() - started;
  } catch {
    dbOk = false;
  }
  const redisMs = await redisPing();
  const redis = redisStatus();
  let disk: { total: number; used: number; pct: number } | null = null;
  try {
    const st = await fs.statfs("/");
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    disk = { total, used: total - free, pct: total ? (total - free) / total : 0 };
  } catch {
    disk = null;
  }
  const mem = await memInfo();
  const smtp = await verifyMail();
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const level = (pct: number) => (pct >= 0.9 ? "down" : pct >= 0.75 ? "warn" : "ok");
  return {
    checkedAt: new Date().toISOString(),
    backend: { status: "ok", uptimeSeconds: Math.round(process.uptime()), node: process.version, rssMb: Math.round(process.memoryUsage().rss / MB), load: os.loadavg()[0], cpus: os.cpus().length },
    postgres: { status: dbOk ? "ok" : "down", latencyMs: dbMs },
    redis: { status: redisMs !== null ? "ok" : redis.enabled ? "down" : "off", latencyMs: redisMs, enabled: redis.enabled, reason: redisMs !== null ? null : redis.reason },
    disk: disk
      ? { status: level(disk.pct), usedGb: +(disk.used / GB).toFixed(1), totalGb: +(disk.total / GB).toFixed(1), pct: disk.pct }
      : { status: "unknown", usedGb: null, totalGb: null, pct: null },
    ram: { status: level(mem.used / mem.total), usedMb: Math.round(mem.used / MB), totalMb: Math.round(mem.total / MB), pct: mem.used / mem.total },
    smtp: { status: !smtp.configured ? "off" : smtp.ok ? "ok" : "warn", configured: smtp.configured, host: smtp.host, error: smtp.error, checkedAt: smtp.checkedAt },
  };
}

const invoiceListSchema = z.object({
  search: z.string().max(200).optional(),
  status: z.enum(["all", "PAID", "PENDING", "FAILED", "REFUNDED"]).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  skip: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/** Payouts settle 7 days after payment: newer paid invoices count as pending payout, older ones as available. */
const SETTLE_MS = 7 * DAY_MS;

function money(cents: number, currency: string) {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function invoicePdf(inv: {
  invoiceNumber: string;
  userEmail: string;
  plan: string;
  amountCents: number;
  currency: string;
  status: string;
  issuedAt: Date;
  paidAt: Date | null;
  provider: string | null;
}) {
  const d = (x: Date | null) => (x ? new Date(x.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") + " PKT" : "-");
  const violet: [number, number, number] = [109, 76, 246];
  return buildPdf({
    boxes: [{ x: 0, y: 772, w: 595, h: 70, color: [17, 22, 51] }],
    rules: [
      { x1: 50, y1: 560, x2: 545, y2: 560 },
      { x1: 50, y1: 520, x2: 545, y2: 520 },
      { x1: 50, y1: 470, x2: 545, y2: 470 },
    ],
    lines: [
      { x: 50, y: 800, text: "ResumeBuilder", size: 20, bold: true, color: [255, 255, 255] },
      { x: 420, y: 800, text: "INVOICE", size: 16, bold: true, color: [196, 181, 253] },
      { x: 50, y: 730, text: `Invoice ${inv.invoiceNumber}`, size: 14, bold: true },
      { x: 50, y: 710, text: `Status: ${inv.status}`, size: 10, color: inv.status === "PAID" ? [22, 163, 74] : inv.status === "FAILED" ? [225, 29, 72] : [217, 119, 6] },
      { x: 50, y: 680, text: "Billed to", size: 9, bold: true, color: [100, 110, 140] },
      { x: 50, y: 665, text: inv.userEmail, size: 11 },
      { x: 330, y: 680, text: "Issued", size: 9, bold: true, color: [100, 110, 140] },
      { x: 330, y: 665, text: d(inv.issuedAt), size: 11 },
      { x: 330, y: 645, text: "Paid", size: 9, bold: true, color: [100, 110, 140] },
      { x: 330, y: 630, text: d(inv.paidAt), size: 11 },
      { x: 50, y: 570, text: "Description", size: 9, bold: true, color: [100, 110, 140] },
      { x: 430, y: 570, text: "Amount", size: 9, bold: true, color: [100, 110, 140] },
      { x: 50, y: 535, text: `ResumeBuilder ${inv.plan === "PRO" ? "Pro" : inv.plan} plan`, size: 11 },
      { x: 430, y: 535, text: money(inv.amountCents, inv.currency), size: 11 },
      { x: 330, y: 485, text: "Total", size: 12, bold: true },
      { x: 430, y: 485, text: money(inv.amountCents, inv.currency), size: 12, bold: true, color: violet },
      { x: 50, y: 430, text: inv.provider ? `Payment provider: ${inv.provider}` : "Payment provider: -", size: 9, color: [100, 110, 140] },
      { x: 50, y: 60, text: "ResumeBuilder by ElevateSofts - devops.elevatesofts.com", size: 8, color: [130, 140, 170] },
    ],
  });
}

const permissionsSchema = z
  .object({
    canRead: z.boolean().optional(),
    canWrite: z.boolean().optional(),
    canDelete: z.boolean().optional(),
    canBilling: z.boolean().optional(),
    canSystem: z.boolean().optional(),
  })
  .optional();

function resolvePerms(role: TeamRole, overrides?: z.infer<typeof permissionsSchema>) {
  const base = roleDefaults(role);
  if (role === "SUPER_ADMIN") return base;
  return {
    canRead: true,
    canWrite: overrides?.canWrite ?? base.canWrite,
    canDelete: overrides?.canDelete ?? base.canDelete,
    canBilling: overrides?.canBilling ?? base.canBilling,
    canSystem: overrides?.canSystem ?? base.canSystem,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Admin Dashboard v2 API, mounted under /admin (adminGuard + RBAC on every route). */
export async function adminV2Routes(app: FastifyInstance) {
  app.addHook("onRequest", adminGuard(app));

  app.get("/overview", async (request) => {
    const { range } = z.object({ range: z.enum(["today", "7d", "30d", "90d"]).optional() }).parse(request.query);
    const r: Range = range ?? "7d";
    const key = `admin:overview:v2:${r}`;
    let payload = await cacheGet<Awaited<ReturnType<typeof overview>>>(key);
    if (!payload) {
      payload = await overview(r);
      await cacheSet(key, payload, 60);
    }
    // Total users is all-time and must match on every range: read it fresh (cheap indexed count),
    // never from a range's 60 s cache.
    const totalUsers = await prisma.user.count({ where: { role: "user", status: { not: "DELETED" } } }).catch(() => null);
    if (totalUsers != null) payload = { ...payload, kpis: { ...payload.kpis, totalUsers } };
    return payload;
  });

  app.get("/health", async () => health());

  /** Website Pages: every public page with its consented views in the range (plus any other tracked path). */
  app.get("/pages", async (request) => {
    const { range } = z.object({ range: z.enum(["today", "7d", "30d", "90d"]).optional() }).parse(request.query);
    const r: Range = range ?? "30d";
    const since = rangeStart(r);
    const [rows, visitors] = await Promise.all([
      prisma.pageView.groupBy({ by: ["path"], where: { createdAt: { gte: since } }, _count: { _all: true }, orderBy: { _count: { path: "desc" } }, take: 500 }),
      prisma.$queryRaw<{ path: string; n: number }[]>`
        SELECT path, COUNT(DISTINCT "anonId")::int AS n FROM "PageView" WHERE "createdAt" >= ${since} GROUP BY path`,
    ]);
    const views = new Map(rows.map((x) => [x.path, x._count._all]));
    const uniq = new Map(visitors.map((x) => [x.path, int(x.n)]));
    const known = new Set(ALL_SITE_PAGES);
    const pages = [
      ...ALL_SITE_PAGES.map((path) => ({ path, views: views.get(path) || 0, visitors: uniq.get(path) || 0, public: true })),
      ...rows.filter((x) => !known.has(x.path)).map((x) => ({ path: x.path, views: x._count._all, visitors: uniq.get(x.path) || 0, public: false })),
    ].sort((a, b) => b.views - a.views || a.path.localeCompare(b.path));
    return { range: r, since: since.toISOString(), publicPages: ALL_SITE_PAGES.length, totalViews: rows.reduce((a, x) => a + x._count._all, 0), pages };
  });

  /** Leads: contact-form messages and new sign-ups in the range, newest first. */
  app.get("/leads", async (request) => {
    const q = z
      .object({
        range: z.enum(["today", "7d", "30d", "90d"]).optional(),
        type: z.enum(["all", "contact", "signup"]).optional(),
        search: z.string().max(200).optional(),
      })
      .parse(request.query);
    const since = rangeStart(q.range ?? "30d");
    const term = (q.search || "").trim();
    const contains = term ? { contains: term, mode: "insensitive" as const } : undefined;
    const [contacts, signups] = await Promise.all([
      q.type === "signup"
        ? Promise.resolve([])
        : prisma.contactMessage.findMany({
            where: { createdAt: { gte: since }, ...(contains ? { OR: [{ email: contains }, { name: contains }] } : {}) },
            orderBy: { createdAt: "desc" },
            take: 200,
          }),
      q.type === "contact"
        ? Promise.resolve([])
        : prisma.user.findMany({
            where: { role: "user", createdAt: { gte: since }, ...(contains ? { OR: [{ email: contains }, { name: contains }] } : {}) },
            orderBy: { createdAt: "desc" },
            take: 200,
            select: { id: true, name: true, email: true, createdAt: true, country: true, plan: true, status: true },
          }),
    ]);
    const leads = [
      ...contacts.map((c) => ({ id: `c-${c.id}`, type: "contact" as const, name: c.name, email: c.email, note: c.message, delivered: c.delivered, createdAt: c.createdAt, country: null as string | null, plan: null as string | null })),
      ...signups.map((u) => ({ id: `s-${u.id}`, type: "signup" as const, name: u.name || u.email.split("@")[0], email: u.email, note: "", delivered: null as boolean | null, createdAt: u.createdAt, country: u.country, plan: u.plan })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { since: since.toISOString(), contact: contacts.length, signups: signups.length, leads };
  });

  /** Cookie Consents: latest banner choices + totals per action. */
  app.get("/consents", async (request) => {
    const q = z
      .object({ take: z.coerce.number().int().min(1).max(200).optional(), skip: z.coerce.number().int().min(0).optional(), action: z.enum(["all", "accept_all", "reject_all", "custom"]).optional() })
      .parse(request.query);
    const where = q.action && q.action !== "all" ? { action: q.action } : {};
    const [entries, total, groups] = await Promise.all([
      prisma.consentLog.findMany({ where, orderBy: { createdAt: "desc" }, take: q.take ?? 50, skip: q.skip ?? 0 }),
      prisma.consentLog.count({ where }),
      prisma.consentLog.groupBy({ by: ["action"], _count: { _all: true } }),
    ]);
    return {
      entries: entries.map((e) => ({ ...e, anonId: `${e.anonId.slice(0, 6)}…` })),
      total,
      totals: Object.fromEntries(groups.map((g) => [g.action, g._count._all])),
    };
  });

  // ---- Billing, invoices & balances ----------------------------------------
  app.get("/billing", async (request) => {
    const q = invoiceListSchema.parse(request.query);
    const term = (q.search || "").trim();
    const where: Prisma.InvoiceWhereInput = {
      ...(q.status && q.status !== "all" ? { status: q.status } : {}),
      ...(term
        ? { OR: [{ invoiceNumber: { contains: term, mode: "insensitive" } }, { userEmail: { contains: term, mode: "insensitive" } }] }
        : {}),
    };
    const settledBefore = new Date(Date.now() - SETTLE_MS);
    const [invoices, total, paidAll, paidSettled, pending, failed, activePro, currencyRow] = await Promise.all([
      prisma.invoice.findMany({ where, orderBy: { issuedAt: "desc" }, take: q.take ?? 25, skip: q.skip ?? 0 }),
      prisma.invoice.count({ where }),
      prisma.invoice.aggregate({ where: { status: "PAID" }, _sum: { amountCents: true }, _count: { _all: true } }),
      prisma.invoice.aggregate({ where: { status: "PAID", paidAt: { lt: settledBefore } }, _sum: { amountCents: true } }),
      prisma.invoice.aggregate({ where: { status: "PENDING" }, _sum: { amountCents: true }, _count: { _all: true } }),
      prisma.invoice.count({ where: { status: "FAILED" } }),
      prisma.user.count({ where: { role: "user", plan: "PRO", status: "ACTIVE" } }),
      prisma.invoice.findFirst({ orderBy: { issuedAt: "desc" }, select: { currency: true } }),
    ]);
    const revenue = int(paidAll._sum.amountCents);
    const settled = int(paidSettled._sum.amountCents);
    return {
      summary: {
        currency: currencyRow?.currency || "USD",
        totalRevenueCents: revenue,
        availableBalanceCents: settled,
        pendingPayoutCents: revenue - settled,
        pendingInvoicesCents: int(pending._sum.amountCents),
        pendingInvoices: pending._count._all,
        paidInvoices: paidAll._count._all,
        failedInvoices: failed,
        activeProSubs: activePro,
        providerConnected: false,
      },
      invoices,
      total,
    };
  });

  app.get("/billing/invoices/:id/pdf", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const inv = await prisma.invoice.findFirst({ where: { OR: [{ id }, { invoiceNumber: id }] } });
    if (!inv) return reply.code(404).send({ error: "Invoice not found" });
    const pdf = invoicePdf(inv);
    const safe = inv.invoiceNumber.replace(/[^\w.-]+/g, "_");
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="invoice-${safe}.pdf"`)
      .header("Cache-Control", "no-store")
      .send(pdf);
  });

  // ---- Manage team (RBAC) ---------------------------------------------------
  app.get("/team", async () => {
    const [owners, members] = await Promise.all([
      prisma.user.findMany({ where: { role: "admin" }, orderBy: { createdAt: "asc" }, select: { id: true, email: true, name: true, lastLoginAt: true, createdAt: true } }),
      prisma.adminTeamMember.findMany({ orderBy: { createdAt: "asc" } }),
    ]);
    return {
      owners: owners.map((o) => ({
        id: `owner-${o.id}`,
        email: o.email,
        name: o.name,
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        owner: true,
        ...roleDefaults("SUPER_ADMIN"),
        lastActiveAt: o.lastLoginAt,
        createdAt: o.createdAt,
      })),
      members: members.map((m) => ({ ...m, owner: false })),
      roles: TEAM_ROLES.map((role) => ({ role, ...roleDefaults(role) })),
    };
  });

  app.post("/team/invite", async (request, reply) => {
    const admin = adminOf(request);
    const body = z
      .object({
        email: z.string().max(254),
        name: z.string().max(100).optional(),
        role: z.string().max(20),
        permissions: permissionsSchema,
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid invite" });
    const email = body.data.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: "Enter a valid email address", field: "email" });
    if (!isTeamRole(body.data.role)) return reply.code(400).send({ error: "Unknown role", field: "role" });
    const owner = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" }, role: "admin" }, select: { id: true } });
    if (owner) return reply.code(409).send({ error: "This email is already the account owner (Super Admin)" });
    const exists = await prisma.adminTeamMember.findUnique({ where: { email }, select: { id: true } });
    if (exists) return reply.code(409).send({ error: "This email is already on the team" });
    const role = body.data.role;
    const member = await prisma.adminTeamMember.create({
      data: {
        email,
        name: body.data.name?.trim() || null,
        role,
        ...resolvePerms(role, body.data.permissions),
        status: "INVITED",
        invitedBy: admin.email,
      },
    });
    await auditAdmin(request, "team.invite", "team", member.id, { email, role });

    // Best-effort invite email; the invite works without it (sign in at /admin/login with this email).
    let emailed = false;
    if (mailConfigured()) {
      const url = `${(env.frontendUrl || env.appUrl || "").split(",")[0].replace(/\/+$/, "")}/admin/login`;
      try {
        const res = await sendMail({
          to: email,
          subject: "You're invited to the ResumeBuilder admin console",
          text: `Hi${member.name ? ` ${member.name}` : ""},\n\n${admin.email} added you to the ResumeBuilder admin team as ${role.replace("_", " ")}.\nSign in with this email at ${url}\n(Create an account first at /register if you don't have one.)\n`,
        });
        emailed = res.delivered;
      } catch (err) {
        request.log.warn({ err: err instanceof Error ? err.message : String(err) }, "team invite email failed");
      }
    }
    return reply.code(201).send({ member, emailed });
  });

  app.patch("/team/:id", async (request, reply) => {
    const admin = adminOf(request);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const body = z
      .object({
        name: z.string().max(100).nullable().optional(),
        role: z.string().max(20).optional(),
        status: z.enum(["ACTIVE", "INVITED", "DISABLED"]).optional(),
        permissions: permissionsSchema,
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid update" });
    if (id.startsWith("owner-")) return reply.code(403).send({ error: "The owner account always keeps full access" });
    const member = await prisma.adminTeamMember.findUnique({ where: { id } });
    if (!member) return reply.code(404).send({ error: "Team member not found" });
    if (body.data.role !== undefined && !isTeamRole(body.data.role)) return reply.code(400).send({ error: "Unknown role" });
    const role: TeamRole = (body.data.role as TeamRole | undefined) ?? (isTeamRole(member.role) ? member.role : "CUSTOM");
    const self = member.email === admin.email.toLowerCase();
    if (self && ((body.data.role && role !== "SUPER_ADMIN") || body.data.status === "DISABLED")) {
      return reply.code(400).send({ error: "You cannot remove your own Super Admin access" });
    }
    const current = { canWrite: member.canWrite, canDelete: member.canDelete, canBilling: member.canBilling, canSystem: member.canSystem };
    const perms = body.data.role && body.data.role !== member.role && !body.data.permissions
      ? resolvePerms(role)
      : resolvePerms(role, { ...current, ...body.data.permissions });
    const updated = await prisma.adminTeamMember.update({
      where: { id },
      data: {
        ...(body.data.name !== undefined ? { name: body.data.name?.trim() || null } : {}),
        role,
        ...perms,
        ...(body.data.status ? { status: body.data.status } : {}),
      },
    });
    await auditAdmin(request, "team.update", "team", id, {
      email: member.email,
      from: { role: member.role, status: member.status, ...current },
      to: { role: updated.role, status: updated.status, canWrite: updated.canWrite, canDelete: updated.canDelete, canBilling: updated.canBilling, canSystem: updated.canSystem },
    });
    return { member: updated };
  });

  app.delete("/team/:id", async (request, reply) => {
    const admin = adminOf(request);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    if (id.startsWith("owner-")) return reply.code(403).send({ error: "The owner account cannot be removed" });
    const member = await prisma.adminTeamMember.findUnique({ where: { id } });
    if (!member) return reply.code(404).send({ error: "Team member not found" });
    if (member.email === admin.email.toLowerCase()) return reply.code(400).send({ error: "You cannot remove yourself" });
    await prisma.adminTeamMember.delete({ where: { id } });
    await auditAdmin(request, "team.remove", "team", id, { email: member.email, role: member.role });
    return { ok: true };
  });

  // ---- Audio jobs (noise remover) -----------------------------------------
  app.get("/audio-jobs", async (request) => {
    const q = z
      .object({
        range: z.enum(["today", "7d", "30d", "90d", "all"]).optional(),
        status: z.enum(["all", "queued", "processing", "done", "failed", "canceled"]).optional(),
        search: z.string().max(200).optional(),
        take: z.coerce.number().int().min(1).max(100).optional(),
        skip: z.coerce.number().int().min(0).max(100000).optional(),
      })
      .parse(request.query);
    const range = q.range ?? "30d";
    const take = q.take ?? 25;
    const skip = q.skip ?? 0;
    const since = range === "all" ? null : rangeStart(range);
    const term = (q.search ?? "").trim();
    const where: Prisma.AudioJobWhereInput = {
      ...(since ? { createdAt: { gte: since } } : {}),
      ...(q.status && q.status !== "all" ? { status: q.status } : {}),
      ...(term
        ? {
            OR: [
              { userEmail: { contains: term, mode: "insensitive" } },
              { id: { startsWith: term.toLowerCase() } },
              { mode: { contains: term, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [rows, filtered, total, byStatus, minutes, inRange, first] = await Promise.all([
      prisma.audioJob.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.audioJob.count({ where }),
      prisma.audioJob.count(),
      prisma.audioJob.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.audioJob.aggregate({ where: { status: "done" }, _sum: { durationSec: true } }),
      since ? prisma.audioJob.count({ where: { createdAt: { gte: since } } }) : prisma.audioJob.count(),
      prisma.audioJob.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    ]);
    // Jobs from before the job log existed (only counted, no details).
    const untracked = await prisma.usageEvent
      .count({ where: { kind: "audio_job", ...(first ? { createdAt: { lt: first.createdAt } } : {}) } })
      .catch(() => 0);
    const count = (st: string) => byStatus.find((b) => b.status === st)?._count._all ?? 0;
    return {
      range,
      summary: {
        total,
        completed: count("done"),
        failed: count("failed"),
        canceled: count("canceled"),
        active: count("queued") + count("processing"),
        minutesProcessed: Math.round(((minutes._sum.durationSec ?? 0) / 60) * 10) / 10,
        inRange,
        untracked,
      },
      jobs: rows.map((j) => ({
        id: j.id,
        userId: j.userId,
        user: j.userEmail || null,
        mode: j.mode,
        strength: j.strength,
        outputFormat: j.outputFormat,
        inputExt: j.inputExt,
        sizeBytes: j.sizeBytes,
        durationSec: j.durationSec,
        status: j.status,
        errorCode: j.errorCode,
        engine: j.engine,
        processingMs: j.processingMs,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
      })),
      total: filtered,
      take,
      skip,
    };
  });

  // ---- Settings -------------------------------------------------------------
  app.get("/settings", async () => ({ settings: await getAdminSettings(true), integrations: integrationStatus() }));

  app.patch("/settings", async (request, reply) => {
    const parsed = adminSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({ error: `${issue?.path.join(".") || "settings"}: ${issue?.message || "invalid value"}` });
    }
    const before = await getAdminSettings(true);
    const settings = await saveAdminSettings(parsed.data);
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    const flat = (o: Record<string, unknown>, pre = ""): Record<string, unknown> =>
      Object.entries(o).reduce<Record<string, unknown>>((acc, [k, v]) => {
        if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(acc, flat(v as Record<string, unknown>, `${pre}${k}.`));
        else acc[`${pre}${k}`] = v;
        return acc;
      }, {});
    const a = flat(before as unknown as Record<string, unknown>);
    const b = flat(settings as unknown as Record<string, unknown>);
    for (const k of Object.keys(b)) if (a[k] !== b[k]) changed[k] = { from: a[k], to: b[k] };
    await auditAdmin(request, "settings.update", "settings", "admin", { changed });
    await cacheDel("admin:stats:v1").catch(() => undefined);
    return { settings, integrations: integrationStatus() };
  });
}
