/**
 * Batch 3: 1-click "Fix with AI" for ATS issues. Gemini when configured; otherwise (or when Gemini fails /
 * returns junk) a deterministic rewrite: weak phrase -> action verb, gerund -> past tense, metric
 * placeholder when there is no number, summary clichés removed. Never returns an empty string.
 */
import { WEAK_PHRASES } from "./keywordBank";
import { jdKeywords, prettyKeyword, strengthenBullet, strengthenSummary, txt } from "./advanced";

export type RewriteSection = "header" | "summary" | "experience" | "education" | "skills" | "projects" | "general";
export type RewriteInput = { section: RewriteSection; text: string; jobDescription?: string | null; issueTitle?: string | null; role?: string | null };
export type RewriteAi = ((prompt: string) => Promise<string | null>) | null;
export type RewriteResult = { text: string; source: "ai" | "rule"; changes: string[] };

const HAS_NUMBER = /\d|%|\$|€|£/;

export function rewritePrompt(input: RewriteInput): string {
  const kind = input.section === "summary" ? "professional summary (2–4 sentences, under 80 words)" : "resume bullet (one line, under 30 words)";
  return [
    `Rewrite this ${kind} so it passes Applicant Tracking Systems and impresses recruiters.`,
    "Rules: start with a strong past-tense action verb; remove weak phrases (responsible for, helped with, worked on, duties included);",
    "keep every fact, name and number from the original; never invent employers, tools or numbers.",
    "If there is no number, add a placeholder in square brackets like [X%] or [N users] for the user to fill in.",
    "Plain text only, no bullet symbol, no quotes, no explanation.",
    input.issueTitle ? `Issue to fix: ${txt(input.issueTitle).slice(0, 160)}` : "",
    input.role ? `Target role: ${txt(input.role).slice(0, 120)}` : "",
    input.jobDescription ? `Job description (use its wording where it is truthful):\n${String(input.jobDescription).slice(0, 3000)}` : "",
    `Original:\n${txt(input.text).slice(0, 2000)}`,
    'Return JSON {"text": "..."}',
  ]
    .filter(Boolean)
    .join("\n");
}

/** Accept the model's text only when it is clean, non-empty and a sensible length. */
export function usableRewrite(original: string, out: string | null | undefined): string | null {
  if (typeof out !== "string") return null;
  const t = out.replace(/^["'“”\s•\-*]+|["'“”\s]+$/g, "").replace(/\s+\n/g, "\n").trim();
  if (t.length < 8) return null;
  if (t.length > Math.max(400, original.length * 3 + 200)) return null;
  if (/\b(as an ai|i cannot|i can't|language model|here is|here's)\b/i.test(t)) return null;
  return t;
}

export function ruleRewrite(input: RewriteInput): RewriteResult {
  const original = txt(input.text);
  const changes: string[] = [];
  const weak = WEAK_PHRASES.filter((w) => w.re.test(original)).map((w) => w.label);
  let out: string;
  if (input.section === "summary") {
    const kws = input.jobDescription
      ? jdKeywords(String(input.jobDescription))
          .filter((k) => k.group === "required")
          .map((k) => prettyKeyword(k.term))
          .filter((k) => !original.toLowerCase().includes(k.toLowerCase()))
          .slice(0, 3)
      : [];
    out = strengthenSummary(original, { role: input.role ?? undefined, keywords: kws });
    if (kws.length) changes.push(`Added job keywords: ${kws.join(", ")}`);
    changes.push("Tightened to 2–4 sentences without clichés");
  } else {
    const lines = String(input.text ?? "")
      .split(/\n+/)
      .map((l) => txt(l))
      .filter(Boolean);
    const long = /too long/i.test(input.issueTitle ?? "");
    out = (lines.length ? lines : [original])
      .map((l) => strengthenBullet(long ? l.split(/\s+/).slice(0, 28).join(" ") : l))
      .join("\n");
    if (long) changes.push("Shortened to one line");
  }
  if (weak.length) changes.push(`Replaced weak phrase${weak.length > 1 ? "s" : ""}: ${weak.join(", ")}`);
  if (!HAS_NUMBER.test(original) && /\[[^\]]+\]/.test(out)) changes.push("Added a metric placeholder — replace [X] with your real number");
  if (!out.trim()) out = original || "Delivered [result], improving [key metric] by [X]%";
  if (out === original) changes.push("Already strong — kept your wording");
  return { text: out, source: "rule", changes };
}

export async function rewriteForAts(input: RewriteInput, ai: RewriteAi): Promise<RewriteResult> {
  const original = txt(input.text);
  if (ai && original) {
    try {
      const got = usableRewrite(original, await ai(rewritePrompt(input)));
      if (got) {
        const changes = ["Rewritten with AI for ATS keywords and impact"];
        if (!HAS_NUMBER.test(original) && /\[[^\]]+\]/.test(got)) changes.push("Added a metric placeholder — replace [X] with your real number");
        return { text: got, source: "ai", changes };
      }
    } catch {
      /* fall through to the deterministic rewrite */
    }
  }
  return ruleRewrite(input);
}
