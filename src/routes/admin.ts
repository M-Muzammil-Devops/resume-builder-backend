import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { adminGuard, adminOf } from "../lib/adminAuth";
import { cacheDel, cacheDelPrefix, cacheGet, cacheSet, redisStatus } from "../lib/redis";
import { publicUploadUrl, rejectUpload, saveUpload, writePlaceholderPreview } from "../lib/uploads";
import { env } from "../config/env";
import { adminUserWhere } from "../lib/adminSearch";
import { auditAdmin } from "../lib/adminAudit";

const DEPARTMENTS = [
  "DevOps",
  "Cloud",
  "SRE",
  "Platform",
  "Software Engineering",
  "Data",
  "Design",
  "Marketing",
  "Finance",
  "Healthcare",
  "Product",
  "Security",
  "QA",
  "Support",
  "Sales",
  "General",
] as const;

function mapLanding(t: {
  id: string;
  name: string;
  blurb: string;
  department: string;
  layoutKey: string;
  accentColor: string;
  fontFamily: string;
  hasPhoto: boolean;
  columns: string;
  pdfPath: string;
  previewPath: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...t,
    image: publicUploadUrl(t.previewPath),
    pdfUrl: publicUploadUrl(t.pdfPath),
    templateId: `tmpl-landing-${t.id}`,
  };
}

/**
 * Admin API. Registered with prefix "/admin" (see index.ts); every route in this
 * plugin is behind adminGuard (auth + admin role), applied once at router level.
 */
/** Cache key prefix for the public landing templates list; invalidated on admin create/update/delete. */
export const LANDING_TEMPLATES_CACHE_PREFIX = "landing:templates:v1";

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", adminGuard(app));

  app.get("/me", async (request) => {
    const access = request.adminAccess;
    return {
      user: adminOf(request),
      access: access
        ? {
            role: access.role,
            source: access.source,
            superAdmin: access.superAdmin,
            canRead: access.canRead,
            canWrite: access.canWrite,
            canDelete: access.canDelete,
            canBilling: access.canBilling,
            canSystem: access.canSystem,
          }
        : null,
    };
  });

  app.get("/stats", async (request) => {

    const cacheKey = "admin:stats:v1";
    const cached = await cacheGet<unknown>(cacheKey);
    if (cached) {
      request.log.debug({ cache: "hit", key: cacheKey }, "admin stats cache");
      return cached;
    }

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      newToday,
      newMonth,
      activeToday,
      activeMonth,
      oldUsers,
      byCountry,
      templates,
      resumes,
      loginsToday,
    ] = await Promise.all([
      prisma.user.count({ where: { role: "user", status: { not: "DELETED" } } }),
      prisma.user.count({ where: { role: "user", createdAt: { gte: startOfDay } } }),
      prisma.user.count({ where: { role: "user", createdAt: { gte: startOfMonth } } }),
      prisma.user.count({ where: { role: "user", lastLoginAt: { gte: startOfDay } } }),
      prisma.user.count({ where: { role: "user", lastLoginAt: { gte: startOfMonth } } }),
      prisma.user.count({ where: { role: "user", createdAt: { lt: thirtyDaysAgo } } }),
      prisma.user.groupBy({
        by: ["country"],
        where: { role: "user" },
        _count: { _all: true },
        orderBy: { _count: { country: "desc" } },
        take: 12,
      }),
      prisma.landingTemplate.count({ where: { isActive: true } }),
      prisma.resume.count(),
      prisma.loginEvent.count({ where: { createdAt: { gte: startOfDay } } }),
    ]);

    const recentUsers = await prisma.user.findMany({
      where: { role: "user" },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        email: true,
        name: true,
        location: true,
        country: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });

    const payload = {
      totals: {
        users: totalUsers,
        newUsersToday: newToday,
        newUsersMonth: newMonth,
        oldUsers,
        dailyActive: activeToday,
        monthlyActive: activeMonth,
        loginsToday,
        templates,
        resumes,
      },
      locations: byCountry.map((r) => ({
        country: r.country || "Unknown",
        count: r._count._all,
      })),
      recentUsers,
      redis: redisStatus(),
      generatedAt: now.toISOString(),
    };

    await cacheSet(cacheKey, payload, 60);
    request.log.info({ totalUsers, newToday, templates }, "admin stats generated");
    return payload;
  });

  /** Users list: search (email / name), plan + status filters, pagination. Soft-deleted users only with status=DELETED. */
  app.get("/users", async (request) => {
    const q = z
      .object({
        take: z.coerce.number().min(1).max(200).optional(),
        skip: z.coerce.number().min(0).optional(),
        search: z.string().max(200).optional(),
        q: z.string().max(200).optional(),
        plan: z.enum(["all", "FREE", "PRO"]).optional(),
        status: z.enum(["all", "ACTIVE", "SUSPENDED", "DELETED"]).optional(),
      })
      .parse(request.query);

    const take = q.take ?? 50;
    const skip = q.skip ?? 0;
    const where = {
      ...adminUserWhere(q.search ?? q.q),
      ...(q.plan && q.plan !== "all" ? { plan: q.plan } : {}),
      status: q.status && q.status !== "all" ? q.status : { not: "DELETED" },
    };
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          location: true,
          country: true,
          city: true,
          plan: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          emailVerifiedAt: true,
          _count: { select: { resumes: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    // Location fallback: the latest enriched sign-in (GeoIP) when the profile has no city / country.
    const ids = users.filter((u) => !u.city || !u.country).map((u) => u.id);
    const geo = new Map<string, { city: string | null; country: string | null; countryCode: string | null }>();
    if (ids.length) {
      const events = await prisma.loginEvent.findMany({
        where: { userId: { in: ids }, OR: [{ country: { not: null } }, { city: { not: null } }] },
        orderBy: { createdAt: "desc" },
        select: { userId: true, city: true, country: true, countryCode: true },
        take: 2000,
      });
      for (const e of events) if (!geo.has(e.userId)) geo.set(e.userId, e);
    }
    const rows = users.map((u) => {
      const g = geo.get(u.id);
      return {
        ...u,
        city: u.city || g?.city || null,
        country: u.country || g?.country || null,
        countryCode: g?.countryCode || null,
        lastActiveAt: u.lastLoginAt,
        resumes: u._count.resumes,
      };
    });

    return { users: rows, total, take, skip };
  });

  /** Suspend / re-activate a user. Suspending also signs them out everywhere (session epoch bump). */
  app.patch("/users/:id/status", async (request, reply) => {
    const admin = adminOf(request);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const body = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Status must be ACTIVE or SUSPENDED" });
    if (id === admin.id) return reply.code(400).send({ error: "You cannot change your own account here" });
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, status: true, email: true } });
    if (!target) return reply.code(404).send({ error: "User not found" });
    if (target.role === "admin") return reply.code(403).send({ error: "Admin accounts cannot be suspended" });
    if (target.status === "DELETED") return reply.code(409).send({ error: "This account was deleted" });
    const next = body.data.status;
    const user = await prisma.user.update({
      where: { id },
      data:
        next === "SUSPENDED"
          ? { status: "SUSPENDED", suspendedAt: new Date(), sessionEpoch: { increment: 1 } }
          : { status: "ACTIVE", suspendedAt: null },
      select: { id: true, status: true, suspendedAt: true },
    });
    await cacheDel("admin:stats:v1");
    await auditAdmin(request, next === "SUSPENDED" ? "user.suspend" : "user.activate", "user", id, { email: target.email, from: target.status });
    return { user };
  });

  /** Change a user's billing plan (FREE / PRO), e.g. a manual upgrade before payments are live. */
  app.patch("/users/:id/plan", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const body = z.object({ plan: z.enum(["FREE", "PRO"]) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Plan must be FREE or PRO" });
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, plan: true, email: true, status: true } });
    if (!target) return reply.code(404).send({ error: "User not found" });
    if (target.status === "DELETED") return reply.code(409).send({ error: "This account was deleted" });
    const user = await prisma.user.update({ where: { id }, data: { plan: body.data.plan }, select: { id: true, plan: true } });
    await cacheDel("admin:stats:v1");
    await auditAdmin(request, "user.plan", "user", id, { email: target.email, from: target.plan, to: body.data.plan });
    return { user };
  });

  /**
   * BUG-801 / v2: remove a user account. Default is a soft delete (status DELETED, signed out, hidden from lists,
   * restorable by support). ?permanent=true removes the account and its data for good. Admin accounts are protected.
   */
  app.delete("/users/:id", async (request, reply) => {
    const admin = adminOf(request);
    const parsed = z.object({ id: z.string().min(1).max(64) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid user id" });
    const { permanent } = z.object({ permanent: z.enum(["true", "false"]).optional() }).parse(request.query);
    const { id } = parsed.data;
    if (id === admin.id) return reply.code(400).send({ error: "You cannot delete your own account here" });
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, email: true, status: true } });
    if (!target) return reply.code(404).send({ error: "User not found" });
    if (target.role === "admin") return reply.code(403).send({ error: "Admin accounts cannot be deleted" });
    if (permanent === "true") {
      await prisma.user.delete({ where: { id } });
    } else {
      await prisma.user.update({
        where: { id },
        data: { status: "DELETED", deletedAt: new Date(), sessionEpoch: { increment: 1 } },
      });
    }
    await cacheDel("admin:stats:v1");
    await auditAdmin(request, permanent === "true" ? "user.delete.permanent" : "user.delete", "user", id, { email: target.email, from: target.status });
    request.log.info({ deletedUserId: id, admin: admin.email, permanent: permanent === "true" }, "user deleted by admin");
    return { ok: true, permanent: permanent === "true" };
  });
  app.get("/templates", async () => {
    const rows = await prisma.landingTemplate.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] });
    return { templates: rows.map(mapLanding), departments: DEPARTMENTS };
  });

  app.post("/templates", async (request, reply) => {
    const admin = adminOf(request);

    const parts = request.parts();
    const fields: Record<string, string> = {};
    let pdfBuf: Buffer | null = null;
    let pdfName = "template.pdf";
    let previewBuf: Buffer | null = null;
    let previewName = "preview.png";

    for await (const part of parts) {
      if (part.type === "file") {
        const buf = await part.toBuffer();
        if (part.fieldname === "pdf") {
          pdfBuf = buf;
          pdfName = part.filename || pdfName;
        } else if (part.fieldname === "preview") {
          previewBuf = buf;
          previewName = part.filename || previewName;
        }
      } else {
        fields[part.fieldname] = String(part.value ?? "");
      }
    }

    if (!pdfBuf || pdfBuf.length === 0) {
      return reply.code(400).send({ error: "PDF file is required" });
    }
    const pdfError = rejectUpload("pdf", pdfBuf);
    if (pdfError) return reply.code(400).send({ error: pdfError });
    if (previewBuf && previewBuf.length > 0) {
      const previewError = rejectUpload("preview", previewBuf);
      if (previewError) return reply.code(400).send({ error: previewError });
    }

    const meta = z
      .object({
        name: z.string().min(1),
        blurb: z.string().optional(),
        department: z.string().min(1),
        layoutKey: z.string().optional(),
        accentColor: z.string().optional(),
        fontFamily: z.string().optional(),
        hasPhoto: z.enum(["true", "false"]).optional(),
        columns: z.enum(["single", "double"]).optional(),
        sortOrder: z.string().optional(),
      })
      .parse(fields);

    const pdfPath = saveUpload("pdfs", pdfName.endsWith(".pdf") ? pdfName : `${pdfName}.pdf`, pdfBuf);
    let previewPath: string;
    if (previewBuf && previewBuf.length > 0) {
      previewPath = saveUpload("previews", previewName, previewBuf);
    } else {
      previewPath = writePlaceholderPreview({
        name: meta.name,
        department: meta.department,
        accent: meta.accentColor || "#1c2b42",
        hasPhoto: meta.hasPhoto !== "false",
        columns: meta.columns || "double",
      });
    }

    const row = await prisma.landingTemplate.create({
      data: {
        name: meta.name,
        blurb: meta.blurb || `${meta.department} template`,
        department: meta.department,
        layoutKey: meta.layoutKey || "high-performer",
        accentColor: meta.accentColor || "#1c2b42",
        fontFamily: meta.fontFamily || "Lato",
        hasPhoto: meta.hasPhoto !== "false",
        columns: meta.columns || "double",
        pdfPath,
        previewPath,
        sortOrder: Number(meta.sortOrder || 0) || 0,
        isActive: true,
      },
    });

    await cacheDel("admin:stats:v1");
    await cacheDelPrefix(LANDING_TEMPLATES_CACHE_PREFIX);
    request.log.info(
      { templateId: row.id, department: row.department, admin: admin.email },
      "landing template uploaded"
    );
    await auditAdmin(request, "template.upload", "landing-template", row.id, { name: row.name, department: row.department });
    return { template: mapLanding(row) };
  });

  app.patch("/templates/:id", async (request, reply) => {
    const admin = adminOf(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        name: z.string().optional(),
        blurb: z.string().optional(),
        department: z.string().optional(),
        layoutKey: z.string().optional(),
        accentColor: z.string().optional(),
        fontFamily: z.string().optional(),
        hasPhoto: z.boolean().optional(),
        columns: z.enum(["single", "double"]).optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().optional(),
      })
      .parse(request.body);

    // BUG-802: an unknown id is a 404, not a Prisma P2025 500 with a source path.
    const existing = await prisma.landingTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "Template not found" });
    const row = await prisma.landingTemplate.update({ where: { id }, data: body });
    await cacheDel("admin:stats:v1");
    await cacheDelPrefix(LANDING_TEMPLATES_CACHE_PREFIX);
    request.log.info({ templateId: id, admin: admin.email }, "landing template updated");
    await auditAdmin(request, "template.landing.update", "landing-template", id, body);
    return { template: mapLanding(row) };
  });

  app.delete("/templates/:id", async (request, reply) => {
    const admin = adminOf(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const existing = await prisma.landingTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "Template not found" });
    await prisma.landingTemplate.delete({ where: { id } });
    await cacheDel("admin:stats:v1");
    await cacheDelPrefix(LANDING_TEMPLATES_CACHE_PREFIX);
    request.log.info({ templateId: id, admin: admin.email }, "landing template deleted");
    await auditAdmin(request, "template.landing.delete", "landing-template", id);
    return { ok: true };
  });
}

/** Public landing templates (cached) */
export async function landingTemplateRoutes(app: FastifyInstance) {
  app.get("/landing-templates", async (request) => {
    const q = z
      .object({
        photo: z.enum(["all", "photo", "none"]).optional(),
        columns: z.enum(["all", "single", "double"]).optional(),
        department: z.string().optional(),
      })
      .parse(request.query);

    const cacheKey = `${LANDING_TEMPLATES_CACHE_PREFIX}:${q.photo || "all"}:${q.columns || "all"}:${q.department || "all"}`;
    const cached = await cacheGet<{ templates: unknown[] }>(cacheKey);
    if (cached) return cached;

    const where: {
      isActive: boolean;
      hasPhoto?: boolean;
      columns?: string;
      department?: string;
    } = { isActive: true };
    if (q.photo === "photo") where.hasPhoto = true;
    if (q.photo === "none") where.hasPhoto = false;
    if (q.columns === "single" || q.columns === "double") where.columns = q.columns;
    if (q.department) where.department = q.department;

    const rows = await prisma.landingTemplate.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    });

    const templates = rows.map((t) => ({
      id: t.id,
      name: t.name,
      blurb: t.blurb || t.department,
      image: publicUploadUrl(t.previewPath),
      pdfUrl: publicUploadUrl(t.pdfPath),
      layoutKey: t.layoutKey,
      accentColor: t.accentColor,
      fontFamily: t.fontFamily,
      templateId: `tmpl-landing-${t.id}`,
      department: t.department,
      hasPhoto: t.hasPhoto,
      columns: t.columns,
    }));

    // Fallback to empty — frontend merges static catalog if needed
    const payload = { templates };
    await cacheSet(cacheKey, payload, env.redisTtlSeconds);
    request.log.debug({ count: templates.length, filters: q }, "landing templates listed");
    return payload;
  });
}
