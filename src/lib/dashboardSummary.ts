/**
 * User Dashboard v2: honest, deterministic numbers computed from the user's own data.
 * Pure functions only (no DB), so they are unit-tested in dashboardSummary.test.ts.
 */
import { scrubSampleText } from "./sampleText";
import { isEmptySection } from "../shared/sampleMarks";
import { LANDING_PRESETS, buildTemplateContent } from "../shared/templateStarter";

const CORE = new Set(["header", "summary", "experience", "education", "skills"]);

type Any = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === "string" ? v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "");
const list = (v: unknown): Any[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Any[]) : []);

function sectionsOf(content: unknown): Any[] {
  if (!content || typeof content !== "object") return [];
  return list((content as { sections?: unknown }).sections);
}

const starterCache = new Map<string, Set<string>>();

/**
 * Starter text of a landing template ("tmpl-landing-<id>"): those templates open with role-specific
 * example text that is not sample-marked, so text still equal to it is treated as not written yet.
 */
export function starterTexts(templateId: string | null | undefined): Set<string> | undefined {
  const id = (templateId || "").replace(/^tmpl-landing-/, "");
  if (!id || !LANDING_PRESETS[id]) return undefined;
  let set = starterCache.get(id);
  if (!set) {
    set = new Set<string>();
    const walk = (v: unknown, scope: string) => {
      if (typeof v === "string") {
        const t = text(v);
        if (t.length >= 2) set!.add(`${scope}\u0000${t}`);
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, scope));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, scopeOf(scope, k));
    };
    try {
      for (const section of buildTemplateContent(id).sections as unknown as Any[]) walk(section, String(section.type));
    } catch {
      /* unknown preset: nothing to compare against */
    }
    starterCache.set(id, set);
  }
  return set;
}

/** A text is compared only with starter text of the same section type and field (header title ≠ job title). */
function scopeOf(scope: string, key: string): string {
  return scope.includes("/") ? `${scope.split("/")[0]}/${key}` : `${scope}/${key}`;
}

function blankStarter(v: unknown, starter: Set<string>, scope: string): unknown {
  if (typeof v === "string") return starter.has(`${scope}\u0000${text(v)}`) ? "" : v;
  if (Array.isArray(v)) return v.map((x) => blankStarter(x, starter, scope));
  if (v && typeof v === "object") {
    const out: Any = {};
    for (const [k, x] of Object.entries(v as Any)) out[k] = k === "id" || k === "type" ? x : blankStarter(x, starter, scopeOf(scope, k));
    return out;
  }
  return v;
}

function blankStarterContent(content: unknown, starter: Set<string>): unknown {
  if (!content || typeof content !== "object") return content;
  return { ...(content as Any), sections: sectionsOf(content).map((s) => blankStarter(s, starter, String(s.type))) };
}

export type ReadinessCheck = { key: string; label: string; done: boolean; points: number };

/**
 * Resume readiness score (0–100). Only text the user wrote counts: untouched sample text is removed
 * first (same scrub as exports) and, when given, landing-template starter text too, so a fresh
 * template scores low.
 */
export function resumeReadiness(content: unknown, starter?: Set<string>): { score: number; checks: ReadinessCheck[] } {
  const scrubbed = scrubSampleText(content);
  const sections = sectionsOf(starter && starter.size ? blankStarterContent(scrubbed, starter) : scrubbed);
  const byType = (t: string) => sections.filter((s) => s.type === t);
  const header = byType("header")[0] ?? {};
  const contact = (header.contact && typeof header.contact === "object" ? header.contact : {}) as Any;

  const summary = byType("summary").map((s) => text(s.content)).join(" ");
  const jobs = byType("experience").flatMap((s) => list(s.items));
  const realJobs = jobs.filter((j) => text(j.title) || text(j.company));
  const bullets = jobs.flatMap((j) => (Array.isArray(j.bullets) ? j.bullets.map(text) : [])).filter(Boolean).length
    + jobs.filter((j) => text(j.description).length >= 40).length;
  const schools = byType("education").flatMap((s) => list(s.items)).filter((e) => text(e.degree) || text(e.school));
  const skills = byType("skills")
    .flatMap((s) => list(s.categories))
    .flatMap((c) => (Array.isArray(c.skills) ? c.skills.map(text) : []))
    .filter(Boolean).length;
  // scrubSampleText already dropped sections with no text of their own.
  const extras = sections.filter((s) => !CORE.has(String(s.type)) && !isEmptySection(s)).length;

  const checks: ReadinessCheck[] = [
    { key: "name", label: "Name and job title", done: Boolean(text(header.fullName) && text(header.title)), points: 15 },
    { key: "contact", label: "Email and phone", done: Boolean(text(contact.email) && text(contact.phone)), points: 10 },
    { key: "summary", label: "Summary", done: summary.length >= 40, points: 15 },
    { key: "experience", label: "Experience", done: realJobs.length >= 1, points: 15 },
    { key: "bullets", label: "Achievements in experience", done: bullets >= 3, points: 10 },
    { key: "education", label: "Education", done: schools.length >= 1, points: 10 },
    { key: "skills", label: "Skills (5+)", done: skills >= 5, points: 15 },
    { key: "extra", label: "Extra section (projects, languages…)", done: extras >= 1, points: 10 },
  ];
  const score = checks.reduce((sum, c) => sum + (c.done ? c.points : 0), 0);
  return { score, checks };
}

export type ProfileStep = { key: string; label: string; done: boolean };

/** Account profile checklist shown in the welcome card (percentage = done / total). */
export function profileSteps(input: {
  name: string | null;
  location: string | null;
  emailVerified: boolean;
  resumeCount: number;
  bestScore: number;
  pdfExportsEver: number;
}): { pct: number; steps: ProfileStep[] } {
  const steps: ProfileStep[] = [
    { key: "account", label: "Account created", done: true },
    { key: "profile", label: "Profile basics", done: Boolean(input.name?.trim()) && Boolean(input.location?.trim()) },
    { key: "verified", label: "Email verified", done: input.emailVerified },
    { key: "resume", label: "First resume", done: input.resumeCount > 0 },
    { key: "strong", label: "Resume 80%+ ready", done: input.bestScore >= 80 },
    { key: "pdf", label: "First PDF export", done: input.pdfExportsEver > 0 },
  ];
  const pct = Math.round((steps.filter((s) => s.done).length / steps.length) * 100);
  return { pct, steps };
}

export function startOfNextUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
