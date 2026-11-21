import { dropEmptySections, hasSampleMarks, stripSampleFields, type ResumeContent } from "../shared";

/**
 * BUG-027/409/1240: sample copy shipped in the default/template resumes (defaults.ts,
 * templateStarter.ts). Used ONLY at export time (PDF/print, TXT, DOCX), never on save, so a
 * value the user really typed is always stored. Short real-world values (degrees, single skills)
 * are not listed; a skills group is dropped only when it is exactly an untouched sample group.
 */
export const SAMPLE_TEXT: readonly string[] = [
  // BUG-1250: sample role titles.
  "role title",
  "senior role title",
  "junior role title",
  "+1-(234)-555-1234",
  "analyzed performance data and recommended changes that raised conversion.",
  "automated recurring tasks and reduced manual work for the team.",
  "built and improved core workflows used by customers and internal teams.",
  "city, country",
  "collaborated with design and engineering to ship reliable releases.",
  "company name",
  "drove a cross-team initiative that lifted the primary kpi within two quarters.",
  "end-to-end initiative with clear goals, measurable outcomes, and documented learnings.",
  "exploring new tools, books, and communities that sharpen craft.",
  "first company",
  "flagship project",
  "grew key metric by 40%",
  "hello@email.com",
  "helping teammates grow through feedback and shared practice.",
  "improved team delivery",
  "industry certificate",
  "issuing organization",
  "launched major product",
  "led initiatives that improved delivery speed and quality across the team.",
  "mentored teammates and documented processes for clearer handoffs.",
  "partnered with stakeholders to define goals, roadmaps, and success metrics.",
  "personal or open-source project showcasing craft and problem-solving.",
  "previous company",
  "professional certification",
  "reduced cycle time by standardizing rituals and clarifying ownership.",
  "results-driven professional with experience delivering impact across teams and products. skilled at turning goals into clear plans, collaborating cross-functionally, and improving outcomes with measurable results.",
  "shipped a new offering from discovery to release with clear stakeholder alignment.",
  "side project",
  "supported day-to-day operations and prepared reports for leadership.",
  "training provider",
  "university name",
  "your name",
  "your role | specialty | focus area"
];

/** Untouched sample skill groups (sorted, lower-case). */
export const SAMPLE_SKILL_SETS: readonly string[] = [
  // BUG-1250: sample project technology tags.
  "analytics|delivery|research",
  "build|design",
  "analysis|communication|leadership|strategy",
  "excel|figma|jira|notion|sql"
];

export function isSampleSkillGroup(skills: unknown): boolean {
  if (!Array.isArray(skills) || skills.length === 0) return false;
  const key = skills
    .map((s) => String(s ?? "").replace(/<[^>]+>/g, "").trim().toLowerCase())
    .sort()
    .join("|");
  return SAMPLE_SKILL_SETS.includes(key);
}

const SAMPLE_SET = new Set(SAMPLE_TEXT);
const SKIP = new Set(["type", "id", "settings", "layoutKey", "variant", "icon", "level", "style"]);

function norm(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim().toLowerCase();
}

export function isSampleText(value: unknown): boolean {
  return typeof value === "string" && SAMPLE_SET.has(norm(value));
}

/** Export-only copy of resume content with template sample text blanked (TXT/DOCX/HTML). */
function legacyScrub(content: unknown, key: string | null = null): unknown {
  if (typeof content === "string") {
    if (key && (SKIP.has(key) || /href|url|link$/i.test(key))) return content;
    return isSampleText(content) ? "" : content;
  }
  if (Array.isArray(content)) return content.map((item) => legacyScrub(item, key));
  if (content && typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (isSampleSkillGroup(rec.skills)) return { ...rec, name: "", skills: [] };
    if (isSampleSkillGroup(rec.technologies)) return legacyScrub({ ...rec, technologies: [] }, key);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(content as Record<string, unknown>)) out[k] = SKIP.has(k) ? v : legacyScrub(v, k);
    return out;
  }
  return content;
}

/**
 * Export-only copy of resume content (TXT/DOCX/HTML).
 * BUG-1240b: a resume with sample marks loses only the fields the user never touched, so a typed
 * value equal to a sample string is kept. Older resumes without marks keep the value-based scrub.
 * Either way, sections left with no text are dropped, so no heading prints on its own.
 */
export function scrubSampleText(content: unknown): unknown {
  if (hasSampleMarks(content)) return dropEmptySections(stripSampleFields(content));
  const legacy = legacyScrub(content, null) as ResumeContent;
  return legacy && typeof legacy === "object" && Array.isArray(legacy.sections) ? dropEmptySections(legacy) : legacy;
}
