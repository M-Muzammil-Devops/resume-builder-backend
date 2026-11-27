import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { env } from "../config/env";
import { mailConfigured } from "./mailer";
import { getExportSettings, saveExportSettings } from "./exportSettings";

/**
 * Admin Settings (AppSetting key "admin"). The free-plan PDF export limit and the free watermark are the
 * same live values as the PDF control settings (AppSetting key "export"), so there is one source of truth.
 */
export const adminSettingsSchema = z.object({
  siteName: z.string().trim().min(1).max(60),
  supportEmail: z.union([z.literal(""), z.string().trim().email().max(160)]),
  freeLimits: z.object({
    /** PDF exports per month for Free accounts (0 = unlimited). Live: export settings. */
    pdfExportsPerMonth: z.number().int().min(0).max(100000),
    /** Audio minutes per month for Free accounts (0 = unlimited). */
    audioMinutesPerMonth: z.number().int().min(0).max(100000),
    /** Resumes a Free account can keep (0 = unlimited). */
    maxResumes: z.number().int().min(0).max(1000),
    /** "Made with ResumeBuilder" footer on Free PDFs. Live: export settings. */
    watermark: z.boolean(),
  }),
  registrationOpen: z.boolean(),
  maintenance: z.object({
    enabled: z.boolean(),
    message: z.string().trim().max(300),
  }),
});

export type AdminSettings = z.infer<typeof adminSettingsSchema>;
type StoredSettings = Omit<AdminSettings, "freeLimits"> & { freeLimits: { audioMinutesPerMonth: number; maxResumes: number } };

export const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  siteName: "ResumeBuilder",
  supportEmail: "",
  freeLimits: { pdfExportsPerMonth: 5, audioMinutesPerMonth: 20, maxResumes: 5, watermark: true },
  registrationOpen: true,
  maintenance: { enabled: false, message: "We are doing a short update. Please check back in a few minutes." },
};

const KEY = "admin";
const TTL_MS = 30_000;
let cache: { at: number; value: AdminSettings } | null = null;

/** Merges a stored value over the defaults; any invalid field falls back to its default. */
export function normalizeAdminSettings(raw: unknown, live?: { pdfExportsPerMonth: number; watermark: boolean }): AdminSettings {
  const d = DEFAULT_ADMIN_SETTINGS;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fl = o.freeLimits && typeof o.freeLimits === "object" ? (o.freeLimits as Record<string, unknown>) : {};
  const mt = o.maintenance && typeof o.maintenance === "object" ? (o.maintenance as Record<string, unknown>) : {};
  const pick = <T>(schema: z.ZodType<T>, v: unknown, fallback: T): T => {
    const r = schema.safeParse(v);
    return r.success ? r.data : fallback;
  };
  const s = adminSettingsSchema.shape;
  const f = s.freeLimits.shape;
  return {
    siteName: pick(s.siteName, o.siteName, d.siteName),
    supportEmail: pick(s.supportEmail, o.supportEmail, d.supportEmail),
    freeLimits: {
      pdfExportsPerMonth: live ? live.pdfExportsPerMonth : pick(f.pdfExportsPerMonth, fl.pdfExportsPerMonth, d.freeLimits.pdfExportsPerMonth),
      audioMinutesPerMonth: pick(f.audioMinutesPerMonth, fl.audioMinutesPerMonth, d.freeLimits.audioMinutesPerMonth),
      maxResumes: pick(f.maxResumes, fl.maxResumes, d.freeLimits.maxResumes),
      watermark: live ? live.watermark : pick(f.watermark, fl.watermark, d.freeLimits.watermark),
    },
    registrationOpen: pick(s.registrationOpen, o.registrationOpen, d.registrationOpen),
    maintenance: {
      enabled: pick(s.maintenance.shape.enabled, mt.enabled, d.maintenance.enabled),
      message: pick(s.maintenance.shape.message, mt.message, d.maintenance.message) || d.maintenance.message,
    },
  };
}

export async function getAdminSettings(fresh = false): Promise<AdminSettings> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let raw: unknown = null;
  try {
    raw = (await prisma.appSetting.findUnique({ where: { key: KEY } }))?.value ?? null;
  } catch {
    // Table not reachable: defaults keep sign-ups and the site working.
  }
  const exp = await getExportSettings();
  const value = normalizeAdminSettings(raw, { pdfExportsPerMonth: exp.maxExports.free, watermark: exp.watermarkFree });
  cache = { at: Date.now(), value };
  return value;
}

export async function saveAdminSettings(input: AdminSettings): Promise<AdminSettings> {
  const clean = adminSettingsSchema.parse(input);
  const stored: StoredSettings = {
    siteName: clean.siteName,
    supportEmail: clean.supportEmail,
    freeLimits: { audioMinutesPerMonth: clean.freeLimits.audioMinutesPerMonth, maxResumes: clean.freeLimits.maxResumes },
    registrationOpen: clean.registrationOpen,
    maintenance: clean.maintenance,
  };
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: stored as unknown as Prisma.InputJsonValue },
    update: { value: stored as unknown as Prisma.InputJsonValue },
  });
  const exp = await getExportSettings();
  if (exp.maxExports.free !== clean.freeLimits.pdfExportsPerMonth || exp.watermarkFree !== clean.freeLimits.watermark) {
    await saveExportSettings({ ...exp, watermarkFree: clean.freeLimits.watermark, maxExports: { ...exp.maxExports, free: clean.freeLimits.pdfExportsPerMonth } });
  }
  cache = null;
  return getAdminSettings(true);
}

/** False when an admin turned new sign-ups off. Fails open (a settings read error never blocks sign-ups). */
export async function registrationOpen(): Promise<boolean> {
  try {
    return (await getAdminSettings()).registrationOpen;
  } catch {
    return true;
  }
}

/** "Configured" / "Not configured" from env presence only. Never returns a secret value. */
export function integrationStatus() {
  const has = (...v: (string | undefined)[]) => v.some((x) => typeof x === "string" && x.trim().length > 0);
  return [
    { key: "smtp", label: "SMTP email", configured: mailConfigured() },
    { key: "google", label: "Google sign-in", configured: Boolean(env.googleClientId && env.googleClientSecret) },
    { key: "facebook", label: "Facebook sign-in", configured: Boolean(env.facebookAppId && env.facebookAppSecret) },
    {
      key: "analytics",
      label: "Google Analytics",
      configured: has(process.env.NEXT_PUBLIC_GA_ID, process.env.GA_MEASUREMENT_ID, process.env.GA_ID),
    },
  ];
}
