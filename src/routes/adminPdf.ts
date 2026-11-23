import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { adminGuard } from "../lib/adminAuth";
import { auditAdmin } from "../lib/adminAudit";
import { cacheDelPrefix, cacheGet, cacheSet } from "../lib/redis";
import { parseDateBound } from "../lib/activity";
import { exportSettingsSchema, getExportSettings, saveExportSettings } from "../lib/exportSettings";
import { BUILTIN_TEMPLATES, BUILTIN_TEMPLATE_IDS, builtinIdOfTemplateId } from "../shared/builtinTemplates";

const TEMPLATE_SETTINGS_CACHE = "template:settings:v1";

async function builtinCatalog() {
  const settings = await prisma.templateSetting.findMany();
  const byId = new Map(settings.map((s) => [s.id, s]));
  return BUILTIN_TEMPLATES.map((t, index) => {
    const s = byId.get(t.id);
    return {
      id: t.id,
      templateId: `tmpl-landing-${t.id}`,
      defaultName: t.name,
      name: s?.name || t.name,
      category: s?.category || t.category,
      description: s?.description || t.description,
      layoutKey: t.layoutKey,
      isActive: s?.isActive ?? true,
      featured: s?.featured ?? false,
      sortOrder: s?.sortOrder ?? index,
      customized: Boolean(s),
      thumb: `/templates/thumbs/${t.id}-280.webp`,
      image: `/templates/${t.id}.webp`,
      previewUrl: `/template-preview/${t.id}`,
    };
  }).sort((a, b) => a.sortOrder - b.sortOrder);
}

const resumeListSchema = z.object({
  search: z.string().max(200).optional(),
  template: z.string().max(80).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  status: z.enum(["all", "complete", "draft", "exported"]).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  skip: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/** Admin PDF / template / resume control, mounted under /admin (adminGuard on every route). */
export async function adminPdfRoutes(app: FastifyInstance) {
  app.addHook("onRequest", adminGuard(app));

  // ---- Built-in templates -------------------------------------------------
  app.get("/builtin-templates", async () => {
    const [catalog, resumeCounts, exportCounts] = await Promise.all([
      builtinCatalog(),
      prisma.resume.groupBy({ by: ["templateId"], _count: { _all: true } }),
      prisma.exportEvent.groupBy({ by: ["templateId"], _count: { _all: true } }),
    ]);
    const uses = new Map<string, number>();
    for (const r of resumeCounts) {
      const id = builtinIdOfTemplateId(r.templateId);
      if (id) uses.set(id, (uses.get(id) || 0) + r._count._all);
    }
    const exports = new Map<string, number>();
    for (const r of exportCounts) {
      const id = builtinIdOfTemplateId(r.templateId);
      if (id) exports.set(id, (exports.get(id) || 0) + r._count._all);
    }
    return {
      templates: catalog.map((t) => ({ ...t, resumes: uses.get(t.id) || 0, exports: exports.get(t.id) || 0 })),
    };
  });

  app.patch("/builtin-templates/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().max(80) }).parse(request.params);
    if (!BUILTIN_TEMPLATE_IDS.has(id)) return reply.code(404).send({ error: "Template not found" });
    const parsed = z
      .object({
        name: z.string().trim().max(80).optional(),
        category: z.string().trim().max(40).optional(),
        description: z.string().trim().max(200).optional(),
        isActive: z.boolean().optional(),
        featured: z.boolean().optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid template settings" });
    const body = parsed.data;
    // An empty text field means "back to the default".
    const data = {
      ...(body.name !== undefined ? { name: body.name || null } : {}),
      ...(body.category !== undefined ? { category: body.category || null } : {}),
      ...(body.description !== undefined ? { description: body.description || null } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      ...(body.featured !== undefined ? { featured: body.featured } : {}),
    };
    const index = BUILTIN_TEMPLATES.findIndex((t) => t.id === id);
    await prisma.templateSetting.upsert({ where: { id }, create: { id, sortOrder: index, ...data }, update: data });
    await cacheDelPrefix(TEMPLATE_SETTINGS_CACHE);
    await auditAdmin(request, "template.update", "builtin-template", id, body);
    return { template: (await builtinCatalog()).find((t) => t.id === id) };
  });

  app.put("/builtin-templates/order", async (request, reply) => {
    const parsed = z.object({ ids: z.array(z.string().max(80)).min(1).max(50) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid order" });
    const ids = parsed.data.ids.filter((id, i, all) => BUILTIN_TEMPLATE_IDS.has(id) && all.indexOf(id) === i);
    // Templates missing from the list keep their relative order after the listed ones.
    const rest = (await builtinCatalog()).map((t) => t.id).filter((id) => !ids.includes(id));
    const order = [...ids, ...rest];
    await prisma.$transaction(
      order.map((id, sortOrder) =>
        prisma.templateSetting.upsert({ where: { id }, create: { id, sortOrder }, update: { sortOrder } })
      )
    );
    await cacheDelPrefix(TEMPLATE_SETTINGS_CACHE);
    await auditAdmin(request, "template.reorder", "builtin-template", null, { order });
    return { templates: await builtinCatalog() };
  });

  // ---- User resumes / generated PDFs -------------------------------------
  app.get("/resumes", async (request) => {
    const q = resumeListSchema.parse(request.query);
    const from = parseDateBound(q.from, false);
    const to = parseDateBound(q.to, true);
    const search = q.search?.trim();
    const where = {
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" as const } },
              { user: { email: { contains: search, mode: "insensitive" as const } } },
              { user: { name: { contains: search, mode: "insensitive" as const } } },
            ],
          }
        : {}),
      ...(q.template ? { templateId: { in: [q.template, `tmpl-landing-${q.template}`] } } : {}),
      ...(from || to ? { updatedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(q.status === "complete" ? { isComplete: true } : q.status === "draft" ? { isComplete: false } : {}),
    };
    let exportedIds: string[] | null = null;
    if (q.status === "exported") {
      const rows = await prisma.exportEvent.findMany({ where: { resumeId: { not: null } }, distinct: ["resumeId"], select: { resumeId: true }, take: 50_000 });
      exportedIds = rows.map((r) => r.resumeId as string);
    }
    const fullWhere = exportedIds ? { ...where, id: { in: exportedIds } } : where;
    const take = q.take ?? 25;
    const skip = q.skip ?? 0;
    const [rows, total] = await Promise.all([
      prisma.resume.findMany({
        where: fullWhere,
        orderBy: { updatedAt: "desc" },
        take,
        skip,
        select: {
          id: true,
          title: true,
          templateId: true,
          layoutKey: true,
          isComplete: true,
          shareEnabled: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { id: true, email: true, name: true } },
        },
      }),
      prisma.resume.count({ where: fullWhere }),
    ]);
    const ids = rows.map((r) => r.id);
    const exportStats = ids.length
      ? await prisma.exportEvent.groupBy({ by: ["resumeId"], where: { resumeId: { in: ids } }, _count: { _all: true }, _max: { createdAt: true } })
      : [];
    const statsById = new Map(exportStats.map((s) => [s.resumeId, s]));
    const catalog = new Map((await builtinCatalog()).map((t) => [t.id, t.name]));
    return {
      total,
      take,
      skip,
      resumes: rows.map((r) => {
        const builtin = builtinIdOfTemplateId(r.templateId);
        const s = statsById.get(r.id);
        return {
          ...r,
          templateName: builtin ? catalog.get(builtin) || builtin : r.templateId,
          exports: s?._count._all || 0,
          lastExportAt: s?._max.createdAt || null,
        };
      }),
    };
  });

  app.get("/resumes/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const row = await prisma.resume.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        templateId: true,
        layoutKey: true,
        isComplete: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, email: true, name: true } },
      },
    });
    if (!row) return reply.code(404).send({ error: "Resume not found" });
    const sections = Array.isArray((row.content as { sections?: unknown[] } | null)?.sections)
      ? ((row.content as { sections: Array<{ type?: string; title?: string }> }).sections).map((s) => ({ type: s.type || "custom", title: s.title || null }))
      : [];
    const exports = await prisma.exportEvent.findMany({
      where: { resumeId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, format: true, pageSize: true, createdAt: true },
    });
    const { content: _content, ...rest } = row;
    void _content;
    return { resume: { ...rest, sections }, exports };
  });

  app.delete("/resumes/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const row = await prisma.resume.findUnique({ where: { id }, select: { id: true, title: true, userId: true } });
    if (!row) return reply.code(404).send({ error: "Resume not found" });
    await prisma.resume.delete({ where: { id } });
    await auditAdmin(request, "resume.delete", "resume", id, { ownerId: row.userId, title: row.title });
    return { ok: true };
  });

  app.get("/exports", async (request) => {
    const q = z
      .object({
        format: z.enum(["pdf", "docx", "txt"]).optional(),
        take: z.coerce.number().int().min(1).max(200).optional(),
        skip: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query);
    const where = q.format ? { format: q.format } : {};
    const [events, total] = await Promise.all([
      prisma.exportEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.take ?? 50,
        skip: q.skip ?? 0,
        select: { id: true, format: true, pageSize: true, templateId: true, resumeId: true, createdAt: true, user: { select: { id: true, email: true } } },
      }),
      prisma.exportEvent.count({ where }),
    ]);
    return { events, total };
  });

  // ---- PDF export settings -----------------------------------------------
  app.get("/settings/export", async () => ({ settings: await getExportSettings() }));

  app.put("/settings/export", async (request, reply) => {
    const parsed = exportSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid export settings" });
    const before = await getExportSettings();
    const settings = await saveExportSettings(parsed.data);
    await auditAdmin(request, "settings.export.update", "setting", "export", { before, after: settings });
    return { settings };
  });

  // ---- Audit log ------------------------------------------------------------
  app.get("/audit", async (request) => {
    const q = z
      .object({
        action: z.string().max(60).optional(),
        take: z.coerce.number().int().min(1).max(200).optional(),
        skip: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query);
    const where = q.action ? { action: { startsWith: q.action } } : {};
    const [entries, total] = await Promise.all([
      prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: q.take ?? 50, skip: q.skip ?? 0 }),
      prisma.adminAuditLog.count({ where }),
    ]);
    return { entries, total };
  });
}

/** Public: admin overrides for the built-in templates (landing gallery) and export defaults. */
export async function publicTemplateSettingsRoutes(app: FastifyInstance) {
  app.get("/template-settings", async () => {
    const cached = await cacheGet<unknown>(TEMPLATE_SETTINGS_CACHE);
    if (cached) return cached;
    let templates: Awaited<ReturnType<typeof builtinCatalog>> = [];
    try {
      templates = await builtinCatalog();
    } catch {
      // Before the migration is applied the landing page keeps its static order.
    }
    const payload = {
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        description: t.description,
        isActive: t.isActive,
        featured: t.featured,
        sortOrder: t.sortOrder,
      })),
    };
    await cacheSet(TEMPLATE_SETTINGS_CACHE, payload, 120);
    return payload;
  });

  app.get("/export-settings", async () => {
    const s = await getExportSettings();
    return { defaultPageSize: s.defaultPageSize };
  });
}
