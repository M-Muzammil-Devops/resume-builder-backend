/**
 * Batch 3: Advanced ATS Checker — a transparent, deterministic 4-layer score (0–100):
 *   1. Parseability & Format      25 pts
 *   2. Keyword & Semantic Match   35 pts  (against a pasted job description, or a role benchmark)
 *   3. Impact & Actionability     25 pts
 *   4. Job-Board Compatibility    15 pts  (+ Indeed, LinkedIn, RemoteOK, Glassdoor, Monster badges)
 * plus an actionable issues list and the plain text an ATS parser extracts.
 * Layer scores are whole numbers and the overall score is exactly their sum.
 */
import { extractKeywords } from "../lib/keywords";
import {
  ROLE_BENCHMARKS,
  SKILL_TERMS,
  STRONG_VERBS,
  SYNONYMS,
  TOOL_TERMS,
  WEAK_PHRASES,
  canonical,
  neighbours,
  stem,
  variants,
} from "./keywordBank";

export type AtsLayerId = "parseability" | "keywords" | "impact" | "boards";
export type AtsSeverity = "high" | "medium" | "low";
export type AtsIssueSection = "header" | "summary" | "experience" | "education" | "skills" | "projects" | "general";
export type AtsBoardId = "indeed" | "linkedin" | "remoteok" | "glassdoor" | "monster";
export type AtsBoardStatus = "pass" | "warn" | "fail";

export type AtsCheck = { id: string; label: string; points: number; max: number; passed: boolean; detail: string };
export type AtsLayer = { id: AtsLayerId; label: string; score: number; max: number; checks: AtsCheck[] };
export type AtsIssue = {
  id: string;
  layer: AtsLayerId;
  severity: AtsSeverity;
  section: AtsIssueSection;
  title: string;
  detail: string;
  fixable: boolean;
  suggestedFix?: string;
  itemIndex?: number;
  /** Editor helpers: the section to jump to and the field a fix replaces. */
  sectionId?: string;
  fieldPath?: string;
  original?: string;
};
export type AtsBoard = { board: AtsBoardId; label: string; status: AtsBoardStatus; score: number; reason: string };
export type AtsKeywordMatch = { keyword: string; matchedAs: string; kind: "exact" | "synonym" | "semantic"; group: "required" | "niceToHave" };
export type AtsKeywords = {
  mode: "jd" | "role";
  role: string;
  benchmark: string;
  total: number;
  matched: string[];
  missing: string[];
  missingRequired: string[];
  missingNiceToHave: string[];
  semanticMatches: AtsKeywordMatch[];
  matches: AtsKeywordMatch[];
  skillCoverage: number;
  aiEnhanced: boolean;
};
export type AdvancedAtsResult = {
  version: 2;
  score: number;
  grade: "Excellent" | "Good" | "Fair" | "Needs work";
  layers: AtsLayer[];
  keywords: AtsKeywords;
  boards: AtsBoard[];
  issues: AtsIssue[];
  plainTextPreview: string;
  stats: { wordCount: number; bulletCount: number; quantifiedBullets: number; strongVerbBullets: number; weakBullets: number; sections: string[] };
  analyzedAt: string;
};
export type AtsOptions = { jobDescription?: string | null; targetRole?: string | null; aiKeywords?: string[] | null; now?: Date };

/* ------------------------------------------------------------------ text helpers */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** HTML / entities -> plain single-line text. */
export function txt(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
const words = (s: string) => s.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const norm = (s: string) => ` ${s.toLowerCase().replace(/[“”"’']/g, "").replace(/\s+/g, " ")} `;

/** Whole-term search in normalised text (C++, C#, .NET, Node.js and CI/CD stay intact). */
function hasTerm(normText: string, term: string): boolean {
  const t = term.toLowerCase();
  const re = new RegExp(`(?:^|[^a-z0-9+#])${escapeRe(t)}(?=$|[^a-z0-9+#])`, "i");
  return re.test(normText.replace(/[.,;:!?()]+(?=\s)/g, " "));
}
function countTerm(normText: string, term: string): number {
  const re = new RegExp(`(?:^|[^a-z0-9+#])${escapeRe(term.toLowerCase())}(?=$|[^a-z0-9+#])`, "gi");
  return (normText.replace(/[.,;:!?()]+(?=\s)/g, " ").match(re) || []).length;
}
/** Short or common-English spellings must appear as an acronym / proper noun in the job description. */
const AMBIGUOUS = new Set(["go", "ai", "ml", "pm", "ui", "ux", "qa", "bi", "hr", "ap", "ar", "ts", "js", "sem", "sap", "lean", "rest", "node", "spring", "express", "git", "sales", "training", "security", "mobile", "clinical", "presentation", "coaching", "leadership", "communication", "kpi", "crm", "c"]);
function jdHas(jdRaw: string, jdNorm: string, term: string): boolean {
  if (!hasTerm(jdNorm, term)) return false;
  if (!AMBIGUOUS.has(term)) return true;
  if (term.length <= 3) {
    // Must be written as an acronym / proper noun (Go, AI, UX…), not at the start of a sentence for "Go".
    const re = new RegExp(`(^|[^A-Za-z0-9+#])(${escapeRe(term.toUpperCase())}|${escapeRe(term[0].toUpperCase() + term.slice(1))})(?=$|[^A-Za-z0-9+#])`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(jdRaw))) {
      const before = jdRaw.slice(0, m.index + m[1].length).trimEnd();
      if (term === "go" && (before === "" || /[.!?:\n•\-]$/.test(before))) continue;
      if (term === "go" && /^Go[\s-]+(to|live|above|beyond)/.test(jdRaw.slice(m.index + m[1].length))) continue;
      return true;
    }
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ resume model */

type Bullet = { text: string; sectionId: string; section: AtsIssueSection; itemIndex: number; fieldPath: string; where: string };
type Model = {
  header: Rec | null;
  name: string;
  headline: string;
  contact: { email: string; phone: string; location: string; linkedin: string; website: string; github: string };
  sections: Rec[];
  ordered: Rec[];
  bullets: Bullet[];
  experience: Rec[];
  skills: string[];
  summary: string;
  twoColumn: boolean;
  photo: boolean;
  plain: string;
  normAll: string;
  normSkills: string;
};

const ISSUE_SECTION: Record<string, AtsIssueSection> = {
  header: "header", summary: "summary", experience: "experience", education: "education", skills: "skills", projects: "projects",
};
const sectionKind = (t: string): AtsIssueSection => ISSUE_SECTION[t] ?? "general";
const STD_TITLE: Record<string, { re: RegExp; label: string }> = {
  summary: { re: /summary|profile|about|objective|overview/i, label: "Summary" },
  experience: { re: /experience|employment|work history|career|professional background/i, label: "Experience" },
  education: { re: /education|academic|qualification|degree/i, label: "Education" },
  skills: { re: /skill|competenc|expertise|technolog|tools|tech stack/i, label: "Skills" },
  projects: { re: /project|portfolio/i, label: "Projects" },
};
const DEFAULT_TITLE: Record<string, string> = {
  summary: "SUMMARY", experience: "EXPERIENCE", education: "EDUCATION", skills: "SKILLS", projects: "PROJECTS",
  certifications: "CERTIFICATIONS", achievements: "ACHIEVEMENTS", languages: "LANGUAGES", strengths: "STRENGTHS",
  volunteering: "VOLUNTEERING", awards: "AWARDS", interests: "INTERESTS", references: "REFERENCES", custom: "ADDITIONAL",
};

function shown(settings: unknown, key: string): boolean {
  return !(isRec(settings) && settings[key] === false);
}

function sectionHeading(s: Rec): string {
  const t = String(s.type);
  return (txt(s.title) || DEFAULT_TITLE[t] || t).toUpperCase();
}

function dateRange(item: Rec): string {
  const a = txt(item.startDate);
  const b = txt(item.endDate);
  return a && b ? `${a} – ${b}` : a || b;
}

/** Plain-text lines of one section exactly as a linear parser reads it. */
function sectionLines(s: Rec, bullets: Bullet[]): string[] {
  const type = String(s.type);
  const set = s.settings;
  const out: string[] = [];
  const kind = sectionKind(type);
  const id = String(s.id ?? type);
  const items = arr(s.items).filter(isRec);
  const bullet = (text: string, itemIndex: number, fieldPath: string, where: string) => {
    const t = txt(text);
    if (!t) return;
    out.push(`• ${t}`);
    bullets.push({ text: t, sectionId: id, section: kind, itemIndex, fieldPath, where });
  };
  switch (type) {
    case "summary": {
      const t = txt(s.content);
      if (t) out.push(t);
      break;
    }
    case "experience":
      items.forEach((it, i) => {
        const head = [txt(it.title), txt(it.company)].filter(Boolean).join(" — ");
        const meta = [shown(set, "location") ? txt(it.location) : "", shown(set, "datePeriod") ? dateRange(it) : ""].filter(Boolean).join(" | ");
        if (head || meta) out.push([head, meta].filter(Boolean).join(" | "));
        const where = `${txt(it.title) || "Role"}${txt(it.company) ? ` at ${txt(it.company)}` : ""}`;
        const bl = arr(it.bullets).filter((b): b is string => typeof b === "string");
        const desc = txt(it.description);
        if (desc && shown(set, "description")) {
          if (bl.length) out.push(desc);
          else bullet(String(it.description), i, `items[${i}].description`, where);
        }
        if (shown(set, "bullets")) bl.forEach((b, bi) => bullet(b, i, `items[${i}].bullets[${bi}]`, where));
        arr(it.projects).filter(isRec).forEach((p) => {
          const line = [txt(p.name), txt(p.description)].filter(Boolean).join(": ");
          if (line) out.push(`• ${line}`);
        });
        out.push("");
      });
      break;
    case "education":
      items.forEach((it) => {
        const head = [txt(it.degree), txt(it.school)].filter(Boolean).join(" — ");
        const meta = [shown(set, "location") ? txt(it.location) : "", shown(set, "datePeriod") ? dateRange(it) : ""].filter(Boolean).join(" | ");
        if (head || meta) out.push([head, meta].filter(Boolean).join(" | "));
        if (txt(it.gpa) && shown(set, "gpa")) out.push(`GPA: ${txt(it.gpa)}`);
        arr(it.bullets).forEach((b) => txt(b) && out.push(`• ${txt(b)}`));
      });
      break;
    case "skills":
      arr(s.categories).filter(isRec).forEach((c) => {
        const list = arr(c.skills).map(txt).filter(Boolean);
        if (!list.length) return;
        const name = txt(c.name);
        out.push(name && shown(set, "groupName") ? `${name}: ${list.join(", ")}` : list.join(", "));
      });
      break;
    case "projects":
      items.forEach((it, i) => {
        const head = [txt(it.name), shown(set, "datePeriod") ? dateRange(it) : ""].filter(Boolean).join(" | ");
        if (head) out.push(head);
        if (txt(it.description)) bullet(String(it.description), i, `items[${i}].description`, txt(it.name) || "Project");
        const tech = arr(it.technologies).map(txt).filter(Boolean);
        if (tech.length) out.push(`Technologies: ${tech.join(", ")}`);
        if (txt(it.link)) out.push(txt(it.link));
        out.push("");
      });
      break;
    case "achievements":
    case "strengths":
      items.forEach((it, i) => {
        const t = [txt(it.title), txt(it.text) || txt(it.description)].filter(Boolean).join(": ");
        if (!t) return;
        if (type === "achievements") bullet(txt(it.text) ? String(it.text) : t, i, txt(it.text) ? `items[${i}].text` : `items[${i}].description`, "Achievements");
        else out.push(`• ${t}`);
      });
      break;
    case "certifications":
      items.forEach((it) => {
        const t = [txt(it.name), txt(it.issuer), txt(it.date)].filter(Boolean).join(" — ");
        if (t) out.push(`• ${t}`);
      });
      break;
    case "languages":
      items.forEach((it) => {
        const t = [txt(it.name), txt(it.level)].filter(Boolean).join(": ");
        if (t) out.push(`• ${t}`);
      });
      break;
    case "volunteering":
      items.forEach((it) => {
        const head = [txt(it.role), txt(it.organization), dateRange(it)].filter(Boolean).join(" | ");
        if (head) out.push(head);
        if (txt(it.description)) out.push(`• ${txt(it.description)}`);
      });
      break;
    default: {
      // Generic: every visible string field, in order.
      const pick = (v: unknown) => {
        if (typeof v === "string") {
          const t = txt(v);
          if (t && !/^data:|^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)$/i.test(t) && t.length > 1) out.push(t);
        } else if (Array.isArray(v)) v.forEach(pick);
        else if (isRec(v)) for (const [k, x] of Object.entries(v)) if (!/^(id|type|icon|logoUrl|photoUrl|settings|title)$/.test(k)) pick(x);
      };
      if (typeof s.content === "string") pick(s.content);
      pick(s.items);
      break;
    }
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

export function buildModel(content: unknown): Model {
  const c = isRec(content) ? content : {};
  const sections = arr(c.sections).filter(isRec).slice(0, 60);
  const header = sections.find((s) => s.type === "header") ?? null;
  const contactRaw = header && isRec(header.contact) ? header.contact : {};
  const hs = header?.settings;
  const contact = {
    email: shown(hs, "email") ? txt(contactRaw.email) : "",
    phone: shown(hs, "phone") ? txt(contactRaw.phone) : "",
    location: shown(hs, "location") ? txt(contactRaw.location) : "",
    linkedin: shown(hs, "link") ? txt(contactRaw.linkedinHref) || txt(contactRaw.linkedin) : "",
    website: txt(contactRaw.website) || (shown(hs, "extraLink") ? txt(contactRaw.extraLinkHref) || txt(contactRaw.extraLink) : ""),
    github: txt(contactRaw.github),
  };
  const byId = new Map(sections.map((s) => [String(s.id), s]));
  const left = arr(c.leftColumnIds).map((id) => byId.get(String(id))).filter((s): s is Rec => Boolean(s));
  const right = arr(c.rightColumnIds).map((id) => byId.get(String(id))).filter((s): s is Rec => Boolean(s));
  const seen = new Set<Rec>();
  const ordered: Rec[] = [];
  for (const s of [...left, ...right, ...sections]) {
    if (s.type === "header" || seen.has(s)) continue;
    seen.add(s);
    ordered.push(s);
  }
  const name = header ? txt(header.fullName) : "";
  const headline = header && shown(hs, "title") ? txt(header.title) : "";
  const bullets: Bullet[] = [];
  const lines: string[] = [];
  if (name) lines.push(name.toUpperCase());
  if (headline) lines.push(headline);
  const contactLine = [
    contact.email && `Email: ${contact.email}`,
    contact.phone && `Phone: ${contact.phone}`,
    contact.location && `Location: ${contact.location}`,
    contact.linkedin && `LinkedIn: ${contact.linkedin}`,
    contact.github && `GitHub: ${contact.github}`,
    contact.website && `Website: ${contact.website}`,
  ].filter(Boolean);
  if (contactLine.length) lines.push(contactLine.join(" | "));
  const skillTexts: string[] = [];
  for (const s of ordered) {
    const body = sectionLines(s, bullets);
    if (!body.length) continue;
    lines.push("", sectionHeading(s), ...body);
    if (s.type === "skills") skillTexts.push(...body);
  }
  const plain = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const skills = sections
    .filter((s) => s.type === "skills")
    .flatMap((s) => arr(s.categories).filter(isRec).flatMap((cat) => arr(cat.skills).map(txt)))
    .filter(Boolean);
  const summarySec = sections.find((s) => s.type === "summary");
  const photo = Boolean(header && typeof header.photoUrl === "string" && header.photoUrl && shown(hs, "photo"));
  return {
    header,
    name,
    headline,
    contact,
    sections,
    ordered,
    bullets,
    experience: sections.filter((s) => s.type === "experience").flatMap((s) => arr(s.items).filter(isRec)),
    skills,
    summary: summarySec ? txt(summarySec.content) : "",
    twoColumn: left.length > 0 && right.length > 0,
    photo,
    plain,
    normAll: norm(plain),
    normSkills: norm(skillTexts.join(" ") + " " + skills.join(" , ")),
  };
}

/* ------------------------------------------------------------------ keywords */

type JdTerm = { term: string; spelling: string; group: "required" | "niceToHave"; count: number; label?: string };

const DISPLAY: Record<string, string> = {
  aws: "AWS", gcp: "GCP", sql: "SQL", "ci/cd": "CI/CD", iam: "IAM", eks: "EKS", ec2: "EC2", s3: "S3", html: "HTML", css: "CSS",
  "c#": "C#", "c++": "C++", ".net": ".NET", "node.js": "Node.js", "next.js": "Next.js", graphql: "GraphQL", postgresql: "PostgreSQL",
  mysql: "MySQL", mongodb: "MongoDB", javascript: "JavaScript", typescript: "TypeScript", golang: "Go", php: "PHP", etl: "ETL",
  "a/b testing": "A/B testing", okrs: "OKRs", saas: "SaaS", b2b: "B2B", crm: "CRM", erp: "ERP", sap: "SAP", gaap: "GAAP", ifrs: "IFRS",
  hipaa: "HIPAA", bls: "BLS", cpr: "CPR", llm: "LLM", sem: "SEM", "rest api": "REST API", "github actions": "GitHub Actions",
  "gitlab ci": "GitLab CI", "argo cd": "Argo CD", "power bi": "Power BI", "microsoft excel": "Excel", devops: "DevOps", ios: "iOS",
  "key performance indicators": "KPIs", "search engine optimization": "SEO", "user experience": "UX", "user interface": "UI",
  "customer relationship management": "CRM", "site reliability engineering": "SRE", "infrastructure as code": "Infrastructure as Code",
  "machine learning": "Machine Learning", "artificial intelligence": "AI", "natural language processing": "NLP", hubspot: "HubSpot",
  quickbooks: "QuickBooks", bigquery: "BigQuery", "scikit-learn": "scikit-learn", "react native": "React Native", datadog: "Datadog",
};
/** Human label for a canonical term ("ci/cd" -> "CI/CD", "kubernetes" -> "Kubernetes"). */
export function prettyKeyword(term: string): string {
  const c = canonical(term);
  if (DISPLAY[c]) return DISPLAY[c];
  return c.replace(/(^|[\s-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase()).replace(/\b(And|Of|To|For|With)\b/g, (w) => w.toLowerCase());
}

const NICE_HEAD = /nice[\s-]to[\s-]have|preferred|bonus|desirable|good to have|ideally|a plus|pluses|optional/i;
const REQ_HEAD = /requirement|qualification|must|what you.?ll need|you have|you bring|responsibilit|what you.?ll do|about you|skills|experience with|we.?re looking for/i;

/** Skills / tools named in a job description, grouped Required/Core vs Nice-to-have/Tools. */
export function jdKeywords(jd: string, extra: string[] = []): JdTerm[] {
  const raw = jd.replace(/<[^>]*>/g, " ").slice(0, 20000);
  const jdNorm = norm(raw);
  const found = new Map<string, JdTerm>();
  const spellings = new Set<string>([...SKILL_TERMS, ...SYNONYMS.flat()]);
  for (const sp of spellings) {
    if (!jdHas(raw, jdNorm, sp)) continue;
    const term = canonical(sp);
    const prev = found.get(term);
    const count = countTerm(jdNorm, sp);
    if (prev) prev.count += count;
    else found.set(term, { term, spelling: sp, group: "required", count });
  }
  for (const k of [...extractKeywords(raw), ...extra]) {
    const term = canonical(k);
    if (!term || term.length < 2 || found.has(term)) continue;
    if (!jdHas(raw, jdNorm, k.toLowerCase())) continue;
    found.set(term, { term, spelling: k.toLowerCase(), group: "required", count: countTerm(jdNorm, k) });
  }
  // Drop a term that is only part of a longer found term ("sql" inside "postgresql" is a separate word, so it stays).
  for (const t of [...found.keys()]) {
    for (const other of found.keys()) {
      if (other !== t && other.includes(" ") && other.split(" ").includes(t) && found.get(t)!.count <= found.get(other)!.count) found.delete(t);
    }
  }
  // Context: lines after a "Nice to have / Preferred" heading (or with "a plus" inline) are nice-to-have.
  const lines = raw.split(/\n|(?<=[.;])\s+(?=[A-Z])/);
  let ctx: "required" | "niceToHave" | null = null;
  const seenReq = new Set<string>();
  const seenNice = new Set<string>();
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    const isHead = l.length < 70 && /:$|^#+|^[A-Z][A-Za-z\s/&'’-]+$/.test(l);
    if (NICE_HEAD.test(l) && (isHead || l.length < 90)) ctx = "niceToHave";
    else if (isHead && REQ_HEAD.test(l)) ctx = "required";
    const inlineNice = NICE_HEAD.test(l);
    const ln = norm(l);
    for (const t of found.values()) {
      if (!variants(t.term).some((v) => hasTerm(ln, v)) && !hasTerm(ln, t.spelling)) continue;
      if (inlineNice || ctx === "niceToHave") seenNice.add(t.term);
      else seenReq.add(t.term);
    }
  }
  for (const t of found.values()) {
    t.group = seenReq.has(t.term) || (!seenNice.has(t.term) && t.count >= 1) ? "required" : "niceToHave";
    if (seenNice.has(t.term) && !seenReq.has(t.term)) t.group = "niceToHave";
    if (t.group === "required" && !seenReq.has(t.term) && TOOL_TERMS.has(t.term) && t.count === 1 && seenNice.size) t.group = "niceToHave";
  }
  return [...found.values()]
    .sort((a, b) => (a.group === b.group ? b.count - a.count : a.group === "required" ? -1 : 1))
    .slice(0, 30);
}

function matchTerm(m: Model, term: string): { kind: AtsKeywordMatch["kind"]; matchedAs: string } | null {
  const c = canonical(term);
  const has = (v: string) => (AMBIGUOUS.has(v) ? jdHas(m.plain, m.normAll, v) : hasTerm(m.normAll, v));
  if (has(c) || has(term)) return { kind: "exact", matchedAs: c };
  for (const v of variants(c)) if (v !== c && has(v)) return { kind: "synonym", matchedAs: v };
  // Stemmed phrase match: "stakeholder management" ~ "managed stakeholders".
  const parts = c.split(/\s+/).filter((w) => w.length > 2);
  if (parts.length > 1) {
    const stems = new Set(words(m.normAll.replace(/[^a-z0-9+#\s]/g, " ")).map(stem));
    if (parts.every((p) => stems.has(stem(p)))) return { kind: "semantic", matchedAs: parts.join(" ") };
  } else if (c.length > 5) {
    const st = stem(c);
    const ws = words(m.normAll.replace(/[^a-z0-9+#\s]/g, " "));
    const hit = ws.find((w) => w.length > 4 && stem(w) === st);
    if (hit) return { kind: "semantic", matchedAs: hit };
  }
  // Related concepts (CI/CD ≈ DevOps, Observability ≈ Prometheus). Named tools need the real name or a synonym.
  if (!TOOL_TERMS.has(c)) for (const n of neighbours(c)) if (hasTerm(m.normAll, n)) return { kind: "semantic", matchedAs: n };
  return null;
}

/** The spelling as it appears in the resume ("reactjs" -> "ReactJS"). */
function asWritten(plain: string, term: string): string {
  const re = new RegExp(`(?:^|[^A-Za-z0-9+#])(${escapeRe(term)})(?=$|[^A-Za-z0-9+#])`, "i");
  const hit = re.exec(plain);
  return hit ? hit[1] : prettyKeyword(term);
}

function inferRole(m: Model, targetRole?: string | null): string {
  const first = m.experience[0];
  return txt(targetRole) || m.headline.split(/\s+[|•·–—]\s+/)[0] || (first ? txt(first.title) : "") || "";
}

function keywordLayer(m: Model, opts: AtsOptions, issues: AtsIssue[]): { layer: AtsLayer; kw: AtsKeywords; coverage: number } {
  const role = inferRole(m, opts.targetRole);
  const jd = txt(opts.jobDescription ?? "") ? String(opts.jobDescription) : "";
  let terms: JdTerm[] = jd ? jdKeywords(jd, opts.aiKeywords ?? []) : [];
  let mode: "jd" | "role" = "jd";
  let benchmark = "Job description";
  if (!terms.length) {
    mode = "role";
    const bench = ROLE_BENCHMARKS.find((b) => b.match.test(role || m.plain.slice(0, 400))) ?? ROLE_BENCHMARKS[ROLE_BENCHMARKS.length - 1];
    benchmark = bench.label;
    terms = bench.keywords.map((k, i) => ({ term: k, spelling: k, group: i < 8 ? "required" : "niceToHave", count: 1 }));
  }
  const matches: AtsKeywordMatch[] = [];
  const missing: JdTerm[] = [];
  let got = 0;
  let total = 0;
  const weight = { exact: 1, synonym: 0.9, semantic: 0.6 } as const;
  for (const t of terms) {
    const imp = t.group === "required" ? 2 : 1;
    total += imp;
    const hit = matchTerm(m, t.term);
    if (hit) {
      got += imp * weight[hit.kind];
      matches.push({ keyword: t.term, matchedAs: hit.matchedAs, kind: hit.kind, group: t.group });
    } else missing.push(t);
  }
  const coverage = total ? got / total : 0;
  const pts = Math.round(35 * Math.min(1, coverage / 0.85));
  const L = (term: string) => prettyKeyword(term);
  for (const x of matches) {
    x.keyword = L(x.keyword);
    x.matchedAs = x.kind === "exact" ? x.keyword : asWritten(m.plain, x.matchedAs);
  }
  const inSkills = matches.filter((x) => variants(x.keyword).some((v) => hasTerm(m.normSkills, v)) || hasTerm(m.normSkills, x.matchedAs)).length;
  const missingRequired = missing.filter((t) => t.group === "required").map((t) => L(t.term));
  const missingNice = missing.filter((t) => t.group === "niceToHave").map((t) => L(t.term));
  const semantic = matches.filter((x) => x.kind !== "exact");
  const checks: AtsCheck[] = [
    {
      id: "kw-coverage",
      label: mode === "jd" ? "Job description keyword coverage" : `${benchmark} benchmark coverage`,
      points: pts,
      max: 35,
      passed: coverage >= 0.7,
      detail: `${matches.length} of ${terms.length} keywords matched (${Math.round(coverage * 100)}% weighted coverage).`,
    },
    {
      id: "kw-skills",
      label: "Matched keywords listed in Skills",
      points: 0,
      max: 0,
      passed: !matches.length || inSkills / matches.length >= 0.5,
      detail: `${inSkills} of ${matches.length} matched keywords appear in the Skills section.`,
    },
    {
      id: "kw-semantic",
      label: "Synonym and related-term matches",
      points: 0,
      max: 0,
      passed: true,
      detail: semantic.length ? semantic.slice(0, 6).map((x) => `${x.keyword} ≈ ${x.matchedAs}`).join(", ") : "No synonym matches needed.",
    },
  ];
  const skillsSec = m.sections.find((s) => s.type === "skills");
  if (missingRequired.length) {
    issues.push({
      id: "kw-missing-required",
      layer: "keywords",
      severity: missingRequired.length >= 4 || coverage < 0.5 ? "high" : "medium",
      section: "skills",
      sectionId: skillsSec ? String(skillsSec.id) : undefined,
      title: `${missingRequired.length} ${mode === "jd" ? "required" : "core"} keyword${missingRequired.length > 1 ? "s" : ""} missing`,
      detail: `Add the ones you genuinely have to Skills or a bullet: ${missingRequired.slice(0, 8).join(", ")}.`,
      fixable: false,
    });
  }
  if (missingNice.length) {
    issues.push({
      id: "kw-missing-nice",
      layer: "keywords",
      severity: "low",
      section: "skills",
      sectionId: skillsSec ? String(skillsSec.id) : undefined,
      title: `${missingNice.length} nice-to-have keyword${missingNice.length > 1 ? "s" : ""} missing`,
      detail: `Optional, but they lift your rank: ${missingNice.slice(0, 8).join(", ")}.`,
      fixable: false,
    });
  }
  if (matches.length >= 3 && inSkills / matches.length < 0.5) {
    issues.push({
      id: "kw-skills-section",
      layer: "keywords",
      severity: "medium",
      section: "skills",
      sectionId: skillsSec ? String(skillsSec.id) : undefined,
      title: "Matched keywords are not in your Skills section",
      detail: "ATS filters often search the Skills list first. Repeat your key tools there.",
      fixable: false,
    });
  }
  return {
    coverage,
    layer: { id: "keywords", label: "Keyword & Semantic Match", score: pts, max: 35, checks },
    kw: {
      mode,
      role,
      benchmark,
      total: terms.length,
      matched: matches.map((x) => x.keyword),
      missing: missing.map((t) => L(t.term)),
      missingRequired,
      missingNiceToHave: missingNice,
      semanticMatches: semantic,
      matches,
      skillCoverage: Math.round(coverage * 100),
      aiEnhanced: Boolean(opts.aiKeywords?.length),
    },
  };
}

/* ------------------------------------------------------------------ dates */

export function dateFormat(value: string): string | null {
  const v = value.trim();
  if (!v || /^(present|current|now|today|ongoing)$/i.test(v)) return null;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}$/i.test(v)) return /^[a-z]{3,4}\.?\s/i.test(v) && v.split(/\s+/)[0].replace(".", "").length <= 4 ? "Mon YYYY" : "Month YYYY";
  if (/^\d{1,2}\/\d{4}$/.test(v)) return "MM/YYYY";
  if (/^\d{4}-\d{1,2}$/.test(v)) return "YYYY-MM";
  if (/^\d{4}$/.test(v)) return "YYYY";
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v)) return "DD/MM/YYYY";
  return "other";
}

/* ------------------------------------------------------------------ scoring */

const QUANT = /\d|%|\$|€|£|₨|\b(?:million|billion|thousand|dozens?|hundreds?|double[d]?|triple[d]?|half)\b/i;
const pct = (n: number, d: number) => (d ? n / d : 0);
const clampPts = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Deterministic stronger bullet: weak opener -> action verb, then a metric placeholder when there is no number. */
export function strengthenBullet(text: string, opts: { metric?: boolean } = {}): string {
  let t = txt(text).replace(/\s+/g, " ").trim();
  if (!t) return t;
  t = t.replace(/^[•\-*–]\s*/, "");
  for (const w of WEAK_PHRASES) {
    const m = w.re.exec(t);
    if (!m || m.index > 12) continue;
    const before = t.slice(0, m.index).replace(/^(?:i|we)\s+(?:was|were|am|have been)?\s*/i, "").trim();
    let rest = t.slice(m.index + m[0].length).trim();
    const first = rest.split(/\s+/)[0] ?? "";
    const past = first.toLowerCase().endsWith("ing") ? gerundPast(first) : null;
    let verb = w.fix;
    if (past) {
      verb = sentenceCase(past);
      rest = rest.slice(first.length).trim();
    } else if (/^the\s/i.test(rest) && w.fix === "Owned") verb = "Owned";
    t = `${before ? `${before} ` : ""}${verb} ${rest}`.trim();
    break;
  }
  // Opening gerund ("Managing a team…") -> past tense.
  const firstWord = t.split(/\s+/)[0] ?? "";
  if (/ing$/i.test(firstWord) && !STRONG_VERBS.has(firstWord.toLowerCase())) {
    const past = gerundPast(firstWord);
    if (past) t = `${sentenceCase(past)}${t.slice(firstWord.length)}`;
  }
  const lead = (t.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!STRONG_VERBS.has(lead) && !/ed$/.test(lead)) t = `Delivered ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  t = sentenceCase(t).replace(/[.;,\s]+$/, "");
  if (opts.metric !== false && !QUANT.test(t)) t = `${t}, improving [key metric] by [X]%`;
  return t.replace(/\s{2,}/g, " ");
}
function gerundPast(word: string): string | null {
  // keywordBank.gerundToPast without importing a cycle-prone default.
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  const map: Record<string, string> = { building: "built", leading: "led", running: "ran", writing: "wrote", overseeing: "oversaw", driving: "drove", making: "made", teaching: "taught", selling: "sold", growing: "grew", winning: "won", bringing: "brought", setting: "set", cutting: "cut", speaking: "spoke", holding: "held", keeping: "kept", taking: "took", giving: "gave", meeting: "met", spending: "spent", sending: "sent", getting: "got", doing: "did", finding: "found", handling: "handled", using: "used" };
  if (map[w]) return map[w];
  if (!w.endsWith("ing") || w.length < 5) return null;
  const st = w.slice(0, -3);
  if (/[^aeiou]y$/.test(st)) return `${st.slice(0, -1)}ied`;
  return `${st}ed`;
}

function firstVerb(b: string): string {
  return (b.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

export function analyzeAdvancedAts(content: unknown, opts: AtsOptions = {}): AdvancedAtsResult {
  const m = buildModel(content);
  const issues: AtsIssue[] = [];
  const add = (i: AtsIssue) => issues.push(i);
  const headerId = m.header ? String(m.header.id ?? "header") : undefined;
  const wc = words(m.plain).length;

  /* ---------- Layer 1: Parseability & Format (25) */
  const p: AtsCheck[] = [];
  const core = ["summary", "experience", "education", "skills"] as const;
  const corePts = { summary: 1.5, experience: 2, education: 1.5, skills: 1 };
  let headPts = 0;
  const nonStd: string[] = [];
  for (const k of core) {
    const sec = m.sections.find((s) => s.type === k && sectionLines(s, []).length);
    if (!sec) {
      add({
        id: `parse-missing-${k}`,
        layer: "parseability",
        severity: k === "experience" || k === "skills" ? "high" : "medium",
        section: k,
        title: `Add ${/^[AEIOU]/.test(STD_TITLE[k].label) ? "an" : "a"} ${STD_TITLE[k].label} section`,
        detail: `ATS parsers look for a "${STD_TITLE[k].label}" heading to file this information.`,
        fixable: false,
      });
      continue;
    }
    if (STD_TITLE[k].re.test(txt(sec.title) || k)) headPts += corePts[k];
    else {
      headPts += corePts[k] / 2;
      nonStd.push(txt(sec.title));
      add({
        id: `parse-heading-${k}`,
        layer: "parseability",
        severity: "medium",
        section: k,
        sectionId: String(sec.id),
        title: `Rename "${txt(sec.title)}" to "${STD_TITLE[k].label}"`,
        detail: "Creative headings can make parsers skip the whole section. Use the standard name.",
        fixable: false,
      });
    }
  }
  p.push({ id: "p-headings", label: "Standard section headings", points: headPts, max: 6, passed: headPts >= 5.5, detail: nonStd.length ? `Non-standard: ${nonStd.join(", ")}` : "Summary, Experience, Education and Skills found." });

  const c = m.contact;
  const emailOk = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(c.email);
  const phoneOk = (c.phone.match(/\d/g) || []).length >= 7;
  const contactParts = [Boolean(m.name), emailOk, phoneOk, Boolean(c.location || c.linkedin || c.website || c.github)];
  const contactPts = contactParts.filter(Boolean).length * 1.5;
  p.push({ id: "p-contact", label: "Complete contact block", points: contactPts, max: 6, passed: contactPts >= 6, detail: `Name ${m.name ? "✓" : "✗"} · Email ${emailOk ? "✓" : "✗"} · Phone ${phoneOk ? "✓" : "✗"} · Location/links ${contactParts[3] ? "✓" : "✗"}` });
  const missingContact = [!m.name && "full name", !emailOk && (c.email ? "a valid email" : "email"), !phoneOk && "phone number", !contactParts[3] && "location or LinkedIn"].filter(Boolean) as string[];
  if (missingContact.length) {
    add({ id: "parse-contact", layer: "parseability", severity: !emailOk || !m.name ? "high" : "medium", section: "header", sectionId: headerId, title: `Contact info incomplete: ${missingContact.join(", ")}`, detail: "Recruiters and job boards need a complete contact block to reach you.", fixable: false });
  }

  const dated = [...m.sections.filter((s) => s.type === "experience" || s.type === "education")].flatMap((s) => arr(s.items).filter(isRec).map((it, i) => ({ it, i, s })));
  const fmts = new Map<string, number>();
  let missingStart = 0;
  let badDates = 0;
  for (const { it, s } of dated) {
    const a = txt(it.startDate);
    const b = txt(it.endDate);
    if (!a && !b) missingStart += 1;
    for (const d of [a, b]) {
      const f = d ? dateFormat(d) : null;
      if (f === "other") badDates += 1;
      // Year-only education dates are standard; only experience dates must share one format.
      else if (f && s.type === "experience") fmts.set(f.replace("Month YYYY", "Mon YYYY"), (fmts.get(f.replace("Month YYYY", "Mon YYYY")) ?? 0) + 1);
    }
  }
  let datePts = 4;
  if (!dated.length) datePts = 2;
  if (fmts.size > 1) datePts -= 1.5;
  if (missingStart) datePts -= Math.min(2, missingStart);
  if (badDates) datePts -= Math.min(1.5, badDates * 0.5);
  datePts = Math.max(0, datePts);
  p.push({ id: "p-dates", label: "Consistent dates", points: datePts, max: 4, passed: datePts >= 3.5, detail: fmts.size ? `Formats used: ${[...fmts.keys()].join(", ")}` : "No dates found." });
  if (fmts.size > 1) add({ id: "parse-date-format", layer: "parseability", severity: "medium", section: "experience", title: "Use one date format everywhere", detail: `You mix ${[...fmts.keys()].join(" and ")}. Pick one, e.g. "Jan 2022 – Present".`, fixable: false });
  if (missingStart) add({ id: "parse-date-missing", layer: "parseability", severity: "high", section: "experience", title: `${missingStart} role${missingStart > 1 ? "s" : ""} or degree${missingStart > 1 ? "s" : ""} without dates`, detail: "ATS timelines need a start and end date for every entry.", fixable: false });

  const expItems = m.experience;
  const withBullets = expItems.filter((it) => arr(it.bullets).some((b) => txt(b)) || txt(it.description)).length;
  const longBullets = m.bullets.filter((b) => words(b.text).length > 45).length;
  let bulletPts = expItems.length ? 4 * pct(withBullets, expItems.length) : 1;
  if (longBullets) bulletPts -= Math.min(1.5, longBullets * 0.5);
  bulletPts = Math.max(0, bulletPts);
  p.push({ id: "p-bullets", label: "Clean bullet structure", points: bulletPts, max: 4, passed: bulletPts >= 3.5, detail: `${withBullets}/${expItems.length} roles have bullets; ${longBullets} bullet(s) read like paragraphs.` });
  expItems.forEach((it, i) => {
    if (arr(it.bullets).some((b) => txt(b)) || txt(it.description)) return;
    const sec = m.sections.find((s) => s.type === "experience");
    add({ id: `parse-no-bullets-${i}`, layer: "parseability", severity: "high", section: "experience", sectionId: sec ? String(sec.id) : undefined, itemIndex: i, title: `Add bullets to ${txt(it.title) || "this role"}`, detail: "Roles without bullets give the ATS nothing to match against.", fixable: false });
  });

  let lenPts = 3;
  if (wc < 150) lenPts = 0.5;
  else if (wc < 300) lenPts = 2;
  else if (wc > 1300) lenPts = 1;
  else if (wc > 1000) lenPts = 2;
  p.push({ id: "p-length", label: "Balanced length", points: lenPts, max: 3, passed: lenPts >= 3, detail: `${wc} words (ideal 300–1000).` });
  if (wc < 300) add({ id: "parse-short", layer: "parseability", severity: wc < 150 ? "high" : "medium", section: "general", title: "Resume is too short", detail: `${wc} words. Aim for 300–1000 so the ATS has enough to rank.`, fixable: false });
  if (wc > 1000) add({ id: "parse-long", layer: "parseability", severity: "low", section: "general", title: "Resume is long", detail: `${wc} words. Trim older roles to keep it to 1–2 pages.`, fixable: false });

  const empty = m.ordered.filter((s) => !sectionLines(s, []).length);
  const emptyPts = Math.max(0, 2 - empty.length);
  p.push({ id: "p-empty", label: "No empty sections", points: emptyPts, max: 2, passed: !empty.length, detail: empty.length ? `Empty: ${empty.map(sectionHeading).join(", ")}` : "Every section has content." });
  for (const s of empty) add({ id: `parse-empty-${String(s.id)}`, layer: "parseability", severity: "low", section: sectionKind(String(s.type)), sectionId: String(s.id), title: `"${sectionHeading(s)}" is empty`, detail: "Fill it in or remove it — empty headings look like parsing errors.", fixable: false });
  const parse = clampPts(p.reduce((a, x) => a + x.points, 0), 25);

  /* ---------- Layer 2: Keywords (35) */
  const kwRes = keywordLayer(m, opts, issues);

  /* ---------- Layer 3: Impact (25) */
  const bl = m.bullets;
  const quantified = bl.filter((b) => QUANT.test(b.text));
  const strong = bl.filter((b) => STRONG_VERBS.has(firstVerb(b.text)));
  const weak = bl.filter((b) => WEAK_PHRASES.some((w) => w.re.test(b.text)));
  const balanced = bl.filter((b) => {
    const n = words(b.text).length;
    return n >= 6 && n <= 32;
  });
  const verbs = new Map<string, number>();
  for (const b of bl) {
    const v = firstVerb(b.text);
    if (STRONG_VERBS.has(v)) verbs.set(v, (verbs.get(v) ?? 0) + 1);
  }
  const repeated = [...verbs.entries()].filter(([, n]) => n > 2);
  const i1 = bl.length ? 10 * Math.min(1, pct(quantified.length, bl.length) / 0.5) : 0;
  const i2 = bl.length ? Math.max(0, 8 * pct(strong.length, bl.length) - Math.min(3, weak.length)) : 0;
  const i3 = bl.length ? 4 * pct(balanced.length, bl.length) : 0;
  const i4 = bl.length ? Math.max(0, 3 - repeated.length) : 0;
  const impactChecks: AtsCheck[] = [
    { id: "i-quant", label: "Quantified achievements", points: i1, max: 10, passed: pct(quantified.length, bl.length) >= 0.5, detail: `${quantified.length}/${bl.length} bullets include a number, %, $ or scale.` },
    { id: "i-verbs", label: "Strong action verbs", points: i2, max: 8, passed: !weak.length && pct(strong.length, bl.length) >= 0.7, detail: `${strong.length}/${bl.length} start with an action verb; ${weak.length} use weak phrases.` },
    { id: "i-length", label: "Bullet length balance", points: i3, max: 4, passed: pct(balanced.length, bl.length) >= 0.8, detail: `${balanced.length}/${bl.length} bullets are 6–32 words.` },
    { id: "i-repeat", label: "Varied verbs", points: i4, max: 3, passed: !repeated.length, detail: repeated.length ? `Repeated: ${repeated.map(([v, n]) => `${v} ×${n}`).join(", ")}` : "No verb used more than twice." },
  ];
  const impact = clampPts(impactChecks.reduce((a, x) => a + x.points, 0), 25);
  if (!bl.length) add({ id: "impact-no-bullets", layer: "impact", severity: "high", section: "experience", title: "No achievement bullets found", detail: "Add 3–5 bullets per role that start with an action verb and include a result.", fixable: false });
  const issueFor = (b: Bullet, id: string, severity: AtsSeverity, title: string, detail: string) =>
    add({ id, layer: "impact", severity, section: b.section, sectionId: b.sectionId, itemIndex: b.itemIndex, fieldPath: b.fieldPath, original: b.text, title, detail, fixable: true, suggestedFix: strengthenBullet(b.text) });
  const flagged = new Set<Bullet>();
  weak.slice(0, 6).forEach((b, n) => {
    flagged.add(b);
    const phrase = WEAK_PHRASES.find((w) => w.re.test(b.text))!.label;
    issueFor(b, `impact-weak-${n}`, "high", `Weak phrase "${phrase}" — ${b.where}`, `“${b.text.slice(0, 90)}${b.text.length > 90 ? "…" : ""}” Lead with what you did and the result.`);
  });
  bl.filter((b) => !flagged.has(b) && !QUANT.test(b.text))
    .slice(0, 6)
    .forEach((b, n) => {
      flagged.add(b);
      issueFor(b, `impact-metric-${n}`, "medium", `No measurable result — ${b.where}`, `“${b.text.slice(0, 90)}${b.text.length > 90 ? "…" : ""}” Add a number: %, $, time saved, users, team size.`);
    });
  bl.filter((b) => !flagged.has(b) && !STRONG_VERBS.has(firstVerb(b.text)) && !/ed$/.test(firstVerb(b.text)))
    .slice(0, 4)
    .forEach((b, n) => {
      flagged.add(b);
      issueFor(b, `impact-verb-${n}`, "low", `Start with an action verb — ${b.where}`, `“${b.text.slice(0, 90)}${b.text.length > 90 ? "…" : ""}”`);
    });
  bl.filter((b) => !flagged.has(b) && words(b.text).length > 32)
    .slice(0, 3)
    .forEach((b, n) => {
      flagged.add(b);
      add({ id: `impact-long-${n}`, layer: "impact", severity: "low", section: b.section, sectionId: b.sectionId, itemIndex: b.itemIndex, fieldPath: b.fieldPath, original: b.text, title: `Bullet too long — ${b.where}`, detail: `${words(b.text).length} words. Keep bullets to one or two lines.`, fixable: true, suggestedFix: strengthenBullet(words(b.text).slice(0, 28).join(" ")) });
    });
  for (const [v, n] of repeated.slice(0, 2)) add({ id: `impact-repeat-${v}`, layer: "impact", severity: "low", section: "experience", title: `"${sentenceCase(v)}" starts ${n} bullets`, detail: "Vary your verbs (Led, Built, Reduced, Launched…) so each bullet stands out.", fixable: false });
  if (m.summary) {
    const sw = words(m.summary).length;
    const sec = m.sections.find((s) => s.type === "summary");
    const weakSummary = WEAK_PHRASES.some((w) => w.re.test(m.summary)) || /\b(hard[\s-]?working|team player|go-getter|detail[\s-]oriented|self[\s-]starter)\b/i.test(m.summary);
    if (sw > 120 || sw < 15 || weakSummary) {
      add({
        id: "impact-summary",
        layer: "impact",
        severity: "medium",
        section: "summary",
        sectionId: sec ? String(sec.id) : undefined,
        fieldPath: "content",
        original: m.summary,
        title: sw > 120 ? "Summary is too long" : sw < 15 ? "Summary is too thin" : "Summary uses clichés",
        detail: "Aim for 2–4 sentences: your title, years of experience, top skills and one measurable win.",
        fixable: true,
        suggestedFix: strengthenSummary(m.summary, { role: inferRole(m, opts.targetRole), keywords: kwRes.kw.missingRequired.slice(0, 3) }),
      });
    }
  }

  /* ---------- Layer 4: Job boards (15) */
  const headingsRatio = headPts / 6;
  const dateRatio = datePts / 4;
  const quantRatio = pct(quantified.length, bl.length);
  const tools = new Set([...TOOL_TERMS].map(canonical).filter((t) => variants(t).some((v) => (AMBIGUOUS.has(v) ? jdHas(m.plain, m.normAll, v) : hasTerm(m.normAll, v)))));
  const stuffed = [...new Set([...tools, ...kwRes.kw.matches.map((x) => canonical(x.keyword)), ...m.skills.map((s) => canonical(s))])]
    .map((k) => ({ k, n: countTerm(m.normAll, k) }))
    .filter((x) => x.k.length > 1 && (x.n > 8 || (wc > 0 && x.n / wc > 0.03 && x.n >= 6)));
  const pairs = expItems.length ? pct(expItems.filter((it) => txt(it.title) && txt(it.company) && (txt(it.startDate) || txt(it.endDate))).length, expItems.length) : 0;
  const sumWords = words(m.summary).length;
  const board = (id: AtsBoardId, label: string, parts: Array<[number, number, string]>, okText: string): AtsBoard => {
    const max = parts.reduce((a, [, w]) => a + w, 0);
    const got = parts.reduce((a, [r, w]) => a + Math.max(0, Math.min(1, r)) * w, 0);
    const score = Math.round((got / max) * 100);
    const weakest = [...parts].sort((a, b) => a[0] - b[0])[0];
    const status: AtsBoardStatus = score >= 80 ? "pass" : score >= 55 ? "warn" : "fail";
    return { board: id, label, score, status, reason: status === "pass" && weakest[0] >= 0.75 ? okText : weakest[2] };
  };
  const boards: AtsBoard[] = [
    board("indeed", "Indeed", [
      [headingsRatio, 30, "Use standard headings (Summary, Experience, Education, Skills)."],
      [dateRatio, 25, "Fix dates: every role needs consistent start/end dates."],
      [m.twoColumn ? 0.5 : 1, 25, "Two-column layout — Indeed reads it as one column; keep key info in the main column."],
      [m.photo ? 0.3 : 1, 10, "Remove the photo; Indeed's parser ignores images and some filters penalise them."],
      [lenPts / 3, 10, "Adjust length to 300–1000 words."],
    ], "Linear sections, clean dates and standard headings."),
    board("linkedin", "LinkedIn", [
      [m.headline ? 1 : 0, 25, "Add a clear headline / job title under your name."],
      [Math.min(1, m.skills.length / 8), 25, `List at least 8 skills (you have ${m.skills.length}).`],
      [sumWords >= 25 && sumWords <= 120 ? 1 : sumWords ? 0.5 : 0, 25, sumWords ? "Keep the summary concise: 25–120 words." : "Add a short summary for Easy Apply profiles."],
      [expItems.length ? pct(expItems.filter((it) => txt(it.title)).length, expItems.length) : 0, 25, "Give every role a clear job title."],
    ], "Clear headline, good skills density and a concise summary."),
    board("remoteok", "RemoteOK", [
      [Math.min(1, tools.size / 6), 35, `Name your tech stack/tools (found ${tools.size}; aim for 6+).`],
      [c.github || c.website ? 1 : c.linkedin ? 0.5 : 0, 25, "Add a GitHub, portfolio or website link — remote teams check them."],
      [Math.min(1, quantRatio / 0.4), 25, "Add measurable results to more bullets."],
      [wc <= 1000 ? 1 : 0.4, 15, "Keep it concise — under 1000 words."],
    ], "Tech stack, links and impact bullets look remote-ready."),
    board("glassdoor", "Glassdoor", [
      [pairs, 40, "Every role needs a title, company and dates."],
      [Math.min(1, quantRatio / 0.5), 30, "Add measurable results (%, $, time, scale)."],
      [bulletPts / 4, 30, "Use short bullets under each role."],
    ], "Complete role/company/date pairs with measurable results."),
    board("monster", "Monster", [
      [contactPts / 6, 35, "Complete your contact block (name, email, phone, location)."],
      [headingsRatio, 30, "Use standard section headings."],
      [stuffed.length ? 0.2 : 1, 20, `Keyword stuffing: "${stuffed[0]?.k ?? ""}" repeats too often.`],
      [Math.min(1, kwRes.coverage / 0.6), 15, "Mirror more keywords from the job / role."],
    ], "Complete contact block, standard headings, balanced keywords."),
  ];
  if (stuffed.length) add({ id: "board-stuffing", layer: "boards", severity: "medium", section: "general", title: `Keyword stuffing: "${stuffed[0].k}" appears ${stuffed[0].n} times`, detail: "Repeating a term this often can get you flagged. Keep each keyword to 2–4 natural mentions.", fixable: false });
  if (m.twoColumn) add({ id: "board-columns", layer: "boards", severity: "low", section: "general", title: "Two-column layout", detail: "Most parsers read left column first, then right. Check the Plain-Text Preview reads in a sensible order.", fixable: false });
  if (m.photo) add({ id: "board-photo", layer: "boards", severity: "low", section: "header", sectionId: headerId, title: "Photo on resume", detail: "US/UK job boards and ATS ignore photos; some filters penalise them.", fixable: false });
  if (!c.github && !c.website && tools.size >= 3) add({ id: "board-links", layer: "boards", severity: "low", section: "header", sectionId: headerId, title: "Add a GitHub or portfolio link", detail: "RemoteOK and tech recruiters look for proof of work.", fixable: false });
  const boardAvg = boards.reduce((a, b) => a + b.score, 0) / boards.length;
  const boardPts = clampPts((15 * boardAvg) / 100, 15);
  const boardChecks: AtsCheck[] = boards.map((b) => ({ id: `b-${b.board}`, label: b.label, points: Math.round((b.score / 100) * 3 * 10) / 10, max: 3, passed: b.status === "pass", detail: b.reason }));

  const layers: AtsLayer[] = [
    { id: "parseability", label: "Parseability & Format", score: parse, max: 25, checks: p.map((x) => ({ ...x, points: Math.round(x.points * 10) / 10, passed: x.passed })) },
    kwRes.layer,
    { id: "impact", label: "Impact & Actionability", score: impact, max: 25, checks: impactChecks.map((x) => ({ ...x, points: Math.round(x.points * 10) / 10 })) },
    { id: "boards", label: "Job-Board Compatibility", score: boardPts, max: 15, checks: boardChecks },
  ];
  const score = layers.reduce((a, l) => a + l.score, 0);
  const rank = { high: 0, medium: 1, low: 2 } as const;
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return {
    version: 2,
    score,
    grade: score >= 85 ? "Excellent" : score >= 70 ? "Good" : score >= 50 ? "Fair" : "Needs work",
    layers,
    keywords: kwRes.kw,
    boards,
    issues: issues.slice(0, 40),
    plainTextPreview: m.plain,
    stats: {
      wordCount: wc,
      bulletCount: bl.length,
      quantifiedBullets: quantified.length,
      strongVerbBullets: strong.length,
      weakBullets: weak.length,
      sections: m.ordered.map((s) => sectionHeading(s)),
    },
    analyzedAt: (opts.now ?? new Date()).toISOString(),
  };
}

/** Deterministic summary rewrite: drop clichés / first person, 2–4 sentences, mention missing keywords. */
export function strengthenSummary(text: string, ctx: { role?: string; keywords?: string[] } = {}): string {
  let t = txt(text)
    .replace(/\b(?:i am|i'm)\s+(?:a|an)\s+/gi, "")
    .replace(/\b(hard[\s-]?working|team player|go-getter|detail[\s-]oriented|self[\s-]starter|passionate|dynamic|motivated)\b,?\s*/gi, "")
    .replace(/\bresponsible for\b/gi, "owning")
    .replace(/\bhelped (?:with|to)?\b/gi, "supported")
    .replace(/\bworked on\b/gi, "delivered")
    .replace(/\bi\s+(?:have|bring)\b/gi, "Brings")
    .replace(/\s{2,}/g, " ")
    .trim();
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  t = sentences.slice(0, 4).join(" ");
  const ws = words(t);
  if (ws.length > 80) t = `${ws.slice(0, 78).join(" ").replace(/[,;:]$/, "")}.`;
  if (!t) t = ctx.role ? `${ctx.role} focused on measurable results.` : "Professional focused on measurable results.";
  t = sentenceCase(t);
  if (!/[.!?]$/.test(t)) t += ".";
  const kw = (ctx.keywords ?? []).filter((k) => !norm(t).includes(` ${k.toLowerCase()} `));
  if (kw.length) t += ` Skilled in ${kw.length > 1 ? `${kw.slice(0, -1).join(", ")} and ${kw[kw.length - 1]}` : kw[0]}.`;
  if (!QUANT.test(t)) t += " Track record of [measurable result, e.g. 30% growth].";
  return t.replace(/\.\./g, ".");
}
