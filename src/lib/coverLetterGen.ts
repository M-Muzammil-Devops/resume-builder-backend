import { extractKeywords } from "./keywords";
import { scrubSampleText } from "./sampleText";

/**
 * Batch 2: auto cover letter from a finalized resume.
 * Facts are read from the structured resume JSON; the deterministic template below is used when
 * Gemini is not configured, fails, or returns something unusable, so generation never comes back empty.
 */

export const LETTER_TONES = ["professional", "concise", "enthusiastic"] as const;
export type LetterTone = (typeof LETTER_TONES)[number];

export function parseTone(raw: unknown): LetterTone {
  const v = String(raw ?? "").toLowerCase();
  return (LETTER_TONES as readonly string[]).includes(v) ? (v as LetterTone) : "professional";
}

export type LetterRole = { title: string; company: string; start: string; end: string };

export type LetterFacts = {
  name: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  links: string[];
  summary: string;
  roles: LetterRole[];
  achievements: string[];
  skills: string[];
};

export type LetterOptions = {
  tone: LetterTone;
  targetRole?: string | null;
  targetCompany?: string | null;
  jobDescription?: string | null;
};

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** Rich-text fields can hold HTML: keep the words only. */
export function plain(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<\s*(br|\/p|\/li|\/div)\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** A single value (name, job title, company, skill): no trailing dots or separators. */
export function field(value: unknown): string {
  return plain(value).replace(/[\s.,;:|•·-]+$/, "").trim();
}

function sentence(text: string): string {
  const t = text.trim().replace(/^[-•*\s]+/, "");
  if (!t) return "";
  const first = t.charAt(0).toLowerCase() + t.slice(1);
  return first.replace(/[.;,\s]+$/, "");
}

type AnySection = { type?: string; [k: string]: unknown };

export function letterFacts(content: unknown, fallbackName?: string | null, fallbackEmail?: string | null): LetterFacts {
  const scrubbed = (scrubSampleText(content) ?? content) as { sections?: AnySection[] } | null;
  const sections: AnySection[] = Array.isArray(scrubbed?.sections) ? scrubbed!.sections! : [];
  const header = sections.find((s) => s.type === "header") as
    | { fullName?: string; title?: string; contact?: Record<string, string | undefined> }
    | undefined;
  const contact = header?.contact ?? {};
  const facts: LetterFacts = {
    name: field(header?.fullName) || field(fallbackName) || "",
    headline: field(header?.title),
    email: field(contact.email) || field(fallbackEmail) || "",
    phone: field(contact.phone),
    location: field(contact.location),
    links: [contact.linkedin, contact.website, contact.github].map(field).filter(Boolean).slice(0, 3),
    summary: "",
    roles: [],
    achievements: [],
    skills: [],
  };
  const numbered: string[] = [];
  const otherBullets: string[] = [];
  for (const s of sections) {
    if (s.type === "summary") facts.summary = facts.summary || plain(s.content);
    if (s.type === "experience" && Array.isArray(s.items)) {
      for (const it of s.items as Array<Record<string, unknown>>) {
        const title = field(it.title);
        const company = field(it.company);
        if (title || company) facts.roles.push({ title, company, start: plain(it.startDate), end: plain(it.endDate) });
        for (const b of Array.isArray(it.bullets) ? it.bullets : []) {
          const t = plain(b);
          if (t.length < 12) continue;
          (/\d/.test(t) ? numbered : otherBullets).push(t);
        }
      }
    }
    if (s.type === "achievements" && Array.isArray(s.items)) {
      for (const it of s.items as Array<Record<string, unknown>>) {
        const t = plain(it.text) || [plain(it.title), plain(it.description)].filter(Boolean).join(": ");
        if (t.length >= 12) (/\d/.test(t) ? numbered : otherBullets).push(t);
      }
    }
    if (s.type === "skills" && Array.isArray(s.categories)) {
      for (const c of s.categories as Array<{ skills?: unknown[] }>) {
        for (const sk of Array.isArray(c.skills) ? c.skills : []) {
          const t = field(sk);
          if (t && t.length <= 40 && !facts.skills.some((x) => x.toLowerCase() === t.toLowerCase())) facts.skills.push(t);
        }
      }
    }
  }
  facts.achievements = [...numbered, ...otherBullets].map((t) => t.slice(0, 240)).slice(0, 3);
  facts.skills = facts.skills.slice(0, 12);
  facts.roles = facts.roles.slice(0, 3);
  return facts;
}

/** Skills from the resume that the job description asks for, resume skills first. */
export function matchedSkills(facts: LetterFacts, jobDescription?: string | null): string[] {
  if (!jobDescription) return facts.skills.slice(0, 5);
  const jd = jobDescription.toLowerCase();
  const kws = new Set(extractKeywords(jobDescription));
  const hits = facts.skills.filter((s) => jd.includes(s.toLowerCase()) || kws.has(s.toLowerCase()));
  const rest = facts.skills.filter((s) => !hits.includes(s));
  return [...hits, ...rest].slice(0, 5);
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "Senior PM | Strategy | B2B SaaS" -> "Senior PM". */
function mainTitle(headline: string): string {
  return field(headline.split(/\s+[|•·]\s+|\s+[-–—]\s+/)[0] ?? "");
}

export function inferRole(facts: LetterFacts, opts: LetterOptions): string {
  return field(opts.targetRole) || mainTitle(facts.headline) || mainTitle(facts.roles[0]?.title ?? "") || "";
}

/** Deterministic letter built only from the real resume facts. Never empty. */
export function templateLetter(facts: LetterFacts, opts: LetterOptions): string {
  const role = inferRole(facts, opts);
  const company = plain(opts.targetCompany);
  const roleText = role ? `the ${role} role` : "this role";
  const at = company ? ` at ${company}` : "";
  const greet = company ? `Dear ${company} Hiring Team,` : "Dear Hiring Manager,";
  const skills = matchedSkills(facts, opts.jobDescription);
  const recent = facts.roles[0];
  const years = facts.roles.length;
  const achievements = facts.achievements;
  const sign = facts.name || "";
  const closing = opts.tone === "enthusiastic" ? "With enthusiasm," : opts.tone === "concise" ? "Best regards," : "Sincerely,";

  const recentText = recent
    ? `${recent.title ? `as ${recent.title}` : "in my most recent role"}${recent.company ? ` at ${recent.company}` : ""}`
    : "";
  const paragraphs: string[] = [];
  // Thin resume (e.g. still the template sample): no invented facts, but still a complete, useful letter.
  const thin = !recentText && !achievements.length && !skills.length;
  const jdFocus = opts.jobDescription ? extractKeywords(opts.jobDescription).slice(0, 3).map((k) => (k.length <= 3 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))) : [];
  const focusText = jdFocus.length ? `The focus on ${listJoin(jdFocus)} in your posting is exactly the kind of work I want to do. ` : "";
  const approach = `${focusText}I bring a practical, results-focused approach: I learn a team's goals quickly, communicate clearly, and take ownership of my work from first draft to final delivery.`;

  if (opts.tone === "concise") {
    paragraphs.push(
      [
        `I am applying for ${roleText}${at}.`,
        recentText ? `I currently work ${recentText}.` : "",
        skills.length ? `My core skills include ${listJoin(skills.slice(0, 4))}.` : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (achievements.length) paragraphs.push(`Highlights: ${achievements.slice(0, 2).map(sentence).join("; ")}.`);
    if (thin) paragraphs.push(approach);
    paragraphs.push(`I would welcome a short conversation about how I can help${company ? ` ${company}` : " your team"}. Thank you for your time.`);
  } else {
    const opener =
      opts.tone === "enthusiastic"
        ? `I am excited to apply for ${roleText}${at}!`
        : `I am writing to apply for ${roleText}${at}.`;
    const intro = [opener];
    if (facts.summary) {
      const s = facts.summary.length > 320 ? `${facts.summary.slice(0, 317).replace(/\s+\S*$/, "")}…` : facts.summary;
      intro.push(s.endsWith(".") || s.endsWith("…") ? s : `${s}.`);
    } else if (facts.headline) {
      intro.push(`As ${/^[aeiou]/i.test(facts.headline) ? "an" : "a"} ${mainTitle(facts.headline)}, I focus on delivering reliable, measurable results.`);
    }
    paragraphs.push(intro.join(" "));

    const exp: string[] = [];
    if (recentText) {
      exp.push(
        `${opts.tone === "enthusiastic" ? "I love the work I do" : "I currently work"} ${recentText}${
          years > 1 ? `, after ${years - 1} earlier role${years > 2 ? "s" : ""}${facts.roles[1]?.company ? ` including ${facts.roles[1].company}` : ""}` : ""
        }.`
      );
    }
    if (achievements.length) {
      exp.push(
        achievements.length === 1
          ? `A result I am proud of: ${sentence(achievements[0])}.`
          : `Recent results include: ${achievements.map(sentence).join("; ")}.`
      );
    }
    if (exp.length) paragraphs.push(exp.join(" "));
    if (thin) {
      paragraphs.push(approach);
      paragraphs.push(
        `I am keen to bring that same care to ${company || "your team"}${role ? ` as ${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}` : ""}, and my resume gives more detail on my background and qualifications.`
      );
    }

    if (skills.length) {
      paragraphs.push(
        `${opts.jobDescription ? "Your requirements match my day-to-day strengths in" : "My core strengths include"} ${listJoin(skills)}${
          company ? `, and I am confident I can apply them to the goals of ${company}` : ", which I would bring to your team from day one"
        }.`
      );
    }
    paragraphs.push(
      opts.tone === "enthusiastic"
        ? `I would love the chance to discuss how I can contribute${company ? ` to ${company}` : ""}. Thank you so much for your time and consideration!`
        : `I would welcome the opportunity to discuss how my experience can contribute${company ? ` to ${company}` : " to your team"}. Thank you for your time and consideration.`
    );
  }
  return [greet, ...paragraphs, sign ? `${closing}\n${sign}` : closing]
    .join("\n\n")
    .replace(/([^.])\.{2}(?!\.)/g, "$1.")
    .replace(/[ \t]+([.,;])/g, "$1")
    .trim();
}

/** Prompt for Gemini: facts only (no raw JSON with photos / data URLs). */
export function letterPrompt(facts: LetterFacts, opts: LetterOptions): string {
  const role = inferRole(facts, opts);
  return [
    `Write a ${opts.tone} cover letter (${opts.tone === "concise" ? "120-170" : "220-320"} words) in plain text.`,
    "Use only facts given below; never invent employers, numbers or degrees. Start with a greeting line and end with a sign-off and the candidate's name.",
    `Target role: ${role || "not specified"}`,
    `Target company: ${plain(opts.targetCompany) || "not specified"}`,
    `Candidate: ${facts.name || "the candidate"}${facts.headline ? `, ${facts.headline}` : ""}`,
    facts.summary ? `Summary: ${facts.summary}` : "",
    facts.roles.length ? `Roles: ${facts.roles.map((r) => `${r.title} at ${r.company} (${r.start}–${r.end})`).join("; ")}` : "",
    facts.achievements.length ? `Achievements: ${facts.achievements.join(" | ")}` : "",
    facts.skills.length ? `Skills: ${facts.skills.join(", ")}` : "",
    opts.jobDescription ? `Job description:\n${String(opts.jobDescription).slice(0, 4000)}` : "",
    'Return JSON {"body": "<letter>"} with \\n between paragraphs.',
  ]
    .filter(Boolean)
    .join("\n");
}

/** An AI body is used only when it looks like a real letter. */
export function usableAiBody(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const t = body.replace(/\r\n/g, "\n").replace(/<[^>]*>/g, "").trim();
  if (t.length < 200 || t.length > 6000) return null;
  return t;
}

export type GenerateResult = { body: string; source: "ai" | "template" };

export async function generateLetterBody(
  facts: LetterFacts,
  opts: LetterOptions,
  ai?: (prompt: string) => Promise<string | null>
): Promise<GenerateResult> {
  if (ai) {
    try {
      const body = usableAiBody(await ai(letterPrompt(facts, opts)));
      if (body) return { body, source: "ai" };
    } catch {
      /* fall through to the template */
    }
  }
  return { body: templateLetter(facts, opts), source: "template" };
}

export function letterTitle(facts: LetterFacts, opts: LetterOptions, resumeTitle: string): string {
  const role = inferRole(facts, opts);
  const company = plain(opts.targetCompany);
  const base = role ? `${role}${company ? ` at ${company}` : ""}` : resumeTitle || "Resume";
  return `Cover Letter — ${base}`.slice(0, 120);
}

/* ---------- business-letter rendering (PDF via HTML, DOCX) ---------- */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export type LetterDoc = {
  title: string;
  body: string;
  facts: LetterFacts;
  targetCompany?: string | null;
  targetRole?: string | null;
  date?: Date;
  pageSize?: "A4" | "US Letter";
};

export function letterDate(d = new Date()): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function contactLine(f: LetterFacts): string[] {
  return [f.email, f.phone, f.location, ...f.links].filter(Boolean);
}

export function letterParagraphs(body: string): string[] {
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function letterHtml(doc: LetterDoc): string {
  const f = doc.facts;
  const letter = doc.pageSize === "US Letter";
  const paras = letterParagraphs(doc.body)
    .map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("\n");
  const recipient = [plain(doc.targetCompany) ? `${escapeHtml(plain(doc.targetCompany))} Hiring Team` : "Hiring Manager"]
    .map((l) => `<div>${l}</div>`)
    .join("");
  const re = plain(doc.targetRole) ? `<div class="re">Re: Application for ${escapeHtml(plain(doc.targetRole))}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title><style>
@page { size: ${letter ? "8.5in 11in" : "210mm 297mm"}; margin: 22mm 22mm 20mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #1f2937; font: 10.8pt/1.6 "Helvetica Neue", Arial, "Liberation Sans", sans-serif; }
.head { border-bottom: 2px solid #1e3a8a; padding-bottom: 10pt; margin-bottom: 18pt; }
.name { font-size: 21pt; font-weight: 700; letter-spacing: .01em; color: #0f172a; line-height: 1.15; }
.headline { font-size: 11pt; color: #1e3a8a; font-weight: 600; margin-top: 2pt; }
.contact { margin-top: 6pt; font-size: 9.2pt; color: #475569; word-break: break-word; }
.contact span + span::before { content: "  •  "; color: #94a3b8; }
.date { margin-bottom: 12pt; color: #334155; }
.to { margin-bottom: 12pt; color: #334155; }
.re { font-weight: 700; margin-bottom: 12pt; color: #0f172a; }
p { margin: 0 0 10pt; text-align: left; orphans: 3; widows: 3; }
</style></head><body>
<div class="head">${f.name ? `<div class="name">${escapeHtml(f.name)}</div>` : ""}${
    f.headline ? `<div class="headline">${escapeHtml(f.headline)}</div>` : ""
  }${contactLine(f).length ? `<div class="contact">${contactLine(f).map((c) => `<span>${escapeHtml(c)}</span>`).join("")}</div>` : ""}</div>
<div class="date">${escapeHtml(letterDate(doc.date))}</div>
<div class="to">${recipient}</div>
${re}
${paras}
</body></html>`;
}

export async function letterDocx(doc: LetterDoc): Promise<Buffer> {
  const { AlignmentType, BorderStyle, Document, Packer, Paragraph, TextRun } = await import("docx");
  const f = doc.facts;
  const font = "Calibri";
  const letter = doc.pageSize === "US Letter";
  const run = (text: string, o: { bold?: boolean; size?: number; color?: string } = {}) =>
    new TextRun({ text, font, size: o.size ?? 22, bold: o.bold, color: o.color });
  const children = [];
  if (f.name) children.push(new Paragraph({ spacing: { after: 40 }, children: [run(f.name, { bold: true, size: 40, color: "0F172A" })] }));
  if (f.headline) children.push(new Paragraph({ spacing: { after: 40 }, children: [run(f.headline, { bold: true, size: 22, color: "1E3A8A" })] }));
  const contacts = contactLine(f);
  children.push(
    new Paragraph({
      spacing: { after: 320 },
      border: { bottom: { color: "1E3A8A", space: 8, style: BorderStyle.SINGLE, size: 12 } },
      children: [run(contacts.join("  •  ") || " ", { size: 18, color: "475569" })],
    })
  );
  children.push(new Paragraph({ spacing: { after: 220 }, children: [run(letterDate(doc.date), { color: "334155" })] }));
  children.push(
    new Paragraph({
      spacing: { after: 220 },
      children: [run(plain(doc.targetCompany) ? `${plain(doc.targetCompany)} Hiring Team` : "Hiring Manager", { color: "334155" })],
    })
  );
  if (plain(doc.targetRole)) {
    children.push(new Paragraph({ spacing: { after: 220 }, children: [run(`Re: Application for ${plain(doc.targetRole)}`, { bold: true })] }));
  }
  for (const p of letterParagraphs(doc.body)) {
    const lines = p.split("\n");
    children.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 200, line: 300 },
        children: lines.map((l, i) => new TextRun({ text: l, font, size: 22, break: i > 0 ? 1 : undefined })),
      })
    );
  }
  const file = new Document({
    creator: f.name || "ResumeBuilder",
    title: doc.title,
    sections: [
      {
        properties: {
          page: {
            size: { width: letter ? 12240 : 11906, height: letter ? 15840 : 16838 },
            margin: { top: 1247, right: 1247, bottom: 1134, left: 1247 },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(file);
}

export function letterText(doc: LetterDoc): string {
  const f = doc.facts;
  const head = [f.name, f.headline, contactLine(f).join(" | ")].filter(Boolean).join("\n");
  return [head, letterDate(doc.date), doc.body].filter(Boolean).join("\n\n").trim();
}

/** Stable JSON (sorted keys) so a Postgres JSONB round-trip does not look like an edit. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
