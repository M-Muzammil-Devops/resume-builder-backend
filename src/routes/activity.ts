import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { adminGuard } from "../lib/adminAuth";
import { activityWhere, enrichPendingLoginEvents, parseDateBound, toCsv } from "../lib/activity";
import { geoDbAvailable } from "../lib/geoip";
import { parseUserAgent } from "../lib/userAgent";
import { CONSENT_VERSION, consentAction, consentFromCookieHeader, isAnonId } from "../lib/consent";

const filterSchema = z.object({
  search: z.string().max(200).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  country: z.string().max(80).optional(),
  device: z.enum(["desktop", "mobile", "tablet", "bot", "unknown"]).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  skip: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

function filtersOf(query: unknown) {
  const q = filterSchema.parse(query);
  return {
    q,
    where: activityWhere({
      search: q.search,
      from: parseDateBound(q.from, false),
      to: parseDateBound(q.to, true),
      country: q.country || undefined,
      device: q.device,
    }),
  };
}

const eventSelect = {
  id: true,
  createdAt: true,
  ip: true,
  city: true,
  region: true,
  country: true,
  countryCode: true,
  browser: true,
  os: true,
  device: true,
  user: { select: { id: true, email: true, name: true, role: true } },
} as const;

/** Admin "Users & Activity" API, mounted under /admin (adminGuard on every route). */
export async function adminActivityRoutes(app: FastifyInstance) {
  app.addHook("onRequest", adminGuard(app));

  app.get("/activity", async (request) => {
    await enrichPendingLoginEvents();
    const { q, where } = filtersOf(request.query);
    const take = q.take ?? 50;
    const skip = q.skip ?? 0;
    const [events, total] = await Promise.all([
      prisma.loginEvent.findMany({ where, orderBy: { createdAt: "desc" }, take, skip, select: eventSelect }),
      prisma.loginEvent.count({ where }),
    ]);
    return { events, total, take, skip, geoDb: geoDbAvailable() };
  });

  app.get("/activity/facets", async () => {
    await enrichPendingLoginEvents();
    const [countries, devices] = await Promise.all([
      prisma.loginEvent.groupBy({ by: ["country"], _count: { _all: true }, orderBy: { _count: { country: "desc" } }, take: 100 }),
      prisma.loginEvent.groupBy({ by: ["device"], _count: { _all: true } }),
    ]);
    return {
      countries: countries.map((c) => ({ country: c.country || "Unknown", count: c._count._all })),
      devices: devices.map((d) => ({ device: d.device || "unknown", count: d._count._all })),
      geoDb: geoDbAvailable(),
    };
  });

  app.get("/activity/export.csv", async (request, reply) => {
    await enrichPendingLoginEvents(2000);
    const { where } = filtersOf(request.query);
    const rows = await prisma.loginEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: 20_000, select: eventSelect });
    const csv = toCsv(
      ["date_time_utc", "email", "name", "ip", "city", "region", "country", "device", "browser", "os"],
      rows.map((r) => [r.createdAt, r.user.email, r.user.name, r.ip, r.city, r.region, r.country, r.device, r.browser, r.os])
    );
    const stamp = new Date().toISOString().slice(0, 10);
    request.log.info({ rows: rows.length }, "admin activity csv exported");
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="user-activity-${stamp}.csv"`)
      .header("Cache-Control", "no-store")
      .send(csv);
  });

  app.get("/activity/users/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    await enrichPendingLoginEvents();
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        lastLoginAt: true,
        emailVerifiedAt: true,
        _count: { select: { resumes: true, loginEvents: true, exportEvents: true } },
      },
    });
    if (!user) return reply.code(404).send({ error: "User not found" });
    const [logins, pageViews] = await Promise.all([
      prisma.loginEvent.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 200, select: eventSelect }),
      prisma.pageView.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, path: true, device: true, createdAt: true },
      }),
    ]);
    return { user, logins, pageViews };
  });

  /** Consented page-view analytics + consent choices, last N days. */
  app.get("/analytics/summary", async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).parse(request.query);
    const since = new Date(Date.now() - (days ?? 30) * 86_400_000);
    const [views, visitors, topPaths, consents] = await Promise.all([
      prisma.pageView.count({ where: { createdAt: { gte: since } } }),
      prisma.pageView.findMany({ where: { createdAt: { gte: since } }, distinct: ["anonId"], select: { anonId: true }, take: 100_000 }),
      prisma.pageView.groupBy({
        by: ["path"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { path: "desc" } },
        take: 10,
      }),
      prisma.consentLog.groupBy({ by: ["action"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    return {
      days: days ?? 30,
      pageViews: views,
      visitors: visitors.length,
      topPaths: topPaths.map((p) => ({ path: p.path, views: p._count._all })),
      consent: Object.fromEntries(consents.map((c) => [c.action, c._count._all])),
    };
  });
}

// Small per-IP window so the public endpoints cannot be used to flood the tables.
const hits = new Map<string, { n: number; reset: number }>();
function limited(request: FastifyRequest, max: number): boolean {
  const now = Date.now();
  const key = request.ip || "?";
  const slot = hits.get(key);
  if (!slot || slot.reset < now) {
    hits.set(key, { n: 1, reset: now + 60_000 });
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return false;
  }
  slot.n += 1;
  return slot.n > max;
}

async function optionalUserId(request: FastifyRequest): Promise<string | null> {
  if (!request.headers.authorization) return null;
  try {
    await request.jwtVerify();
    return request.user?.userId ?? null;
  } catch {
    return null;
  }
}

function cleanPath(raw: string): string | null {
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // Query strings can carry tokens (reset links etc.), so only the path is kept.
  const path = raw.split(/[?#]/)[0].slice(0, 200);
  return /^[\w\-./~%@]*$/.test(path) ? path : null;
}

function referrerHost(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host.slice(0, 120) || null;
  } catch {
    return null;
  }
}

/** Public: consent audit log and consented page views. */
export async function trackingRoutes(app: FastifyInstance) {
  app.post("/consent", async (request, reply) => {
    if (limited(request, 30)) return reply.code(429).send({ error: "Too many requests" });
    const body = z
      .object({
        anonId: z.string().max(64),
        version: z.number().int().min(1).max(999),
        choices: z.object({ preferences: z.boolean(), analytics: z.boolean(), marketing: z.boolean() }),
      })
      .safeParse(request.body);
    if (!body.success || !isAnonId(body.data.anonId)) return reply.code(400).send({ error: "Invalid consent" });
    const userId = await optionalUserId(request);
    await prisma.consentLog.create({
      data: {
        anonId: body.data.anonId,
        userId,
        version: body.data.version,
        ...body.data.choices,
        action: consentAction(body.data.choices),
      },
    });
    return { ok: true, version: CONSENT_VERSION };
  });

  app.post("/analytics/pageview", async (request, reply) => {
    // Server-side check: nothing is stored unless the visitor's own consent cookie allows analytics.
    const consent = consentFromCookieHeader(request.headers.cookie);
    if (!consent?.analytics) return reply.code(204).send();
    if (limited(request, 120)) return reply.code(429).send({ error: "Too many requests" });
    const body = z.object({ path: z.string().max(400), referrer: z.string().max(500).optional() }).safeParse(request.body);
    const path = body.success ? cleanPath(body.data.path) : null;
    if (!path) return reply.code(400).send({ error: "Invalid path" });
    const userId = await optionalUserId(request);
    await prisma.pageView.create({
      data: {
        anonId: consent.anonId,
        userId,
        path,
        referrer: body.success ? referrerHost(body.data.referrer) : null,
        device: parseUserAgent(String(request.headers["user-agent"] || "")).device,
      },
    });
    return reply.code(204).send();
  });
}
