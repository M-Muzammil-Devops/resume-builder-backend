import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

/** Admin-controlled PDF export settings (AppSetting key "export"). */
export const exportSettingsSchema = z.object({
  /** Used when a resume has no page size of its own. */
  defaultPageSize: z.enum(["A4", "US Letter"]),
  /** Extra outer PDF margin in millimetres (0 = the resume's own margins only). */
  marginMm: z.number().int().min(0).max(30),
  /** "Made with ResumeBuilder" footer on PDFs of free (non-admin) accounts. */
  watermarkFree: z.boolean(),
  watermarkText: z.string().trim().min(1).max(80),
  /** PDF exports per calendar month (UTC); 0 = unlimited. */
  maxExports: z.object({
    free: z.number().int().min(0).max(100000),
    pro: z.number().int().min(0).max(100000),
  }),
});

export type ExportSettings = z.infer<typeof exportSettingsSchema>;

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  defaultPageSize: "A4",
  marginMm: 0,
  watermarkFree: false,
  watermarkText: "Made with ResumeBuilder",
  maxExports: { free: 0, pro: 0 },
};

const KEY = "export";
let cache: { at: number; value: ExportSettings } | null = null;
const TTL_MS = 30_000;

/** Merges a stored value over the defaults; anything invalid falls back to the default. */
export function normalizeExportSettings(raw: unknown): ExportSettings {
  const base = { ...DEFAULT_EXPORT_SETTINGS, maxExports: { ...DEFAULT_EXPORT_SETTINGS.maxExports } };
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  const merged = {
    ...base,
    ...obj,
    maxExports: { ...base.maxExports, ...((obj.maxExports as object) || {}) },
  };
  const parsed = exportSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : base;
}

export async function getExportSettings(): Promise<ExportSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value = DEFAULT_EXPORT_SETTINGS;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    value = normalizeExportSettings(row?.value);
  } catch {
    // Table missing before the migration is applied: defaults keep exports working.
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function saveExportSettings(value: ExportSettings): Promise<ExportSettings> {
  const clean = exportSettingsSchema.parse(value);
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: clean as Prisma.InputJsonValue },
    update: { value: clean as Prisma.InputJsonValue },
  });
  cache = { at: Date.now(), value: clean };
  return clean;
}

/** Plan of an account for export limits. Admins are unlimited; there is no paid plan yet. */
export function exportPlanOf(role: string | null | undefined): "admin" | "pro" | "free" {
  if (role === "admin") return "admin";
  if (role === "pro") return "pro";
  return "free";
}

export function exportLimitFor(settings: ExportSettings, role: string | null | undefined): number {
  const plan = exportPlanOf(role);
  if (plan === "admin") return 0;
  return settings.maxExports[plan];
}

export function startOfUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
