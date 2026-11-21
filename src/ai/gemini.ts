import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AtsResult, ImproveSuggestion, ResumeDocument } from "../shared";
import { jobDescriptionRejection, keywordMatches } from "../ats/engine";
import { extractKeywords } from "../lib/keywords";
import { analyzeResume, filterValidSuggestions, rewriteFragment } from "./improveEngine";

function modelCandidates() {
  const preferred = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const extras = [
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-2.0-flash",
  ];
  return [...new Set([preferred, ...extras])];
}

function getGenAI() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  return new GoogleGenerativeAI(key);
}

async function generateJson<T>(prompt: string, fallback: T): Promise<T> {
  const genAI = getGenAI();
  if (!genAI) return fallback;

  const fullPrompt = `${prompt}\n\nRespond with valid JSON only. No markdown fences.`;
  let lastErr: unknown;

  for (const modelName of modelCandidates()) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(fullPrompt);
      const text = result.response.text().trim();
      const cleaned = text
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```$/i, "");
      return JSON.parse(cleaned) as T;
    } catch (err) {
      lastErr = err;
      console.warn(`Gemini model ${modelName} failed, trying next…`);
    }
  }

  console.warn("Gemini failed, using local fallback:", lastErr);
  return fallback;
}

function resumePlainText(doc: ResumeDocument): string {
  return JSON.stringify(doc.content, null, 2);
}

export async function rewriteShorter(
  text: string,
  mode: "shorter" | "longer" | "improve" | "grammar" = "shorter",
  variant = 0
): Promise<string> {
  const plain = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return text;

  const words = plain.split(/\s+/);
  const localFallback = () => rewriteFragment(plain, mode, variant);
  const filler = /\(e\.g\.\s*30%\s*faster recovery|\(e\.g\.\s*25%\s*improvement\)/i;

  const instruction =
    mode === "longer"
      ? "Make this one sentence longer without adding any number, percentage, or claim that is not in the original."
      : mode === "grammar"
        ? "Fix grammar and spelling only. Do not add new claims."
        : mode === "improve"
          ? "Rewrite as one resume bullet: start with a strong action verb and keep any numbers."
          : "Rewrite this shorter. One sentence, 12 words or fewer. Keep numbers.";

  const ai = await generateJson<{ text?: string }>(
    `${instruction}
Return JSON: {"text":"..."}

Original:
${plain}`,
    { text: localFallback() }
  );

  const next = (ai?.text || "").trim();
  if (!next || filler.test(next) || /with a measured/i.test(next)) return localFallback();
  if (mode === "longer") {
    const invented = next.match(/\d[\d,]*(?:\.\d+)?%?/g) || [];
    const known = new Set(plain.match(/\d[\d,]*(?:\.\d+)?%?/g) || []);
    if (invented.some((n) => !known.has(n))) return localFallback();
  }
  if (mode === "shorter" && next.split(/\s+/).length >= words.length) return localFallback();
  if ((mode === "grammar" || mode === "improve") && next === plain) return localFallback();
  return next;
}

export async function improveText(doc: ResumeDocument): Promise<ImproveSuggestion[]> {
  // Always start from local analysis tied to real resume text (never fake examples).
  const local = analyzeResume(doc);

  const ai = await generateJson<ImproveSuggestion[]>(
    `Improve this resume. Return a JSON array of suggestions. Each item MUST quote original text that appears verbatim in the resume.
Fields: id, category (spellcheck|wording|recommendation), severity (error|warning|info), original, suggestion, reason, sectionId (optional), locationLabel (optional).
Max 8 items. Prefer spelling fixes, stronger verbs, and quantified bullets.

Resume:
${resumePlainText(doc)}`,
    []
  );

  const validated = filterValidSuggestions(doc, Array.isArray(ai) ? ai : []);
  const seen = new Set(local.map((s) => `${s.category}:${s.original.toLowerCase()}`));
  const merged = [...local];
  for (const s of validated) {
    const key = `${s.category}:${s.original.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(s);
  }
  return merged.slice(0, 16);
}

export function jobDescriptionUsable(jd: string): boolean {
  return jobDescriptionRejection(jd) === null;
}

export async function atsCheck(doc: ResumeDocument, jobDescription: string): Promise<AtsResult> {
  const rejection = jobDescriptionRejection(jobDescription);
  if (rejection) {
    return {
      score: 0,
      matchedKeywords: [],
      missingKeywords: [],
      suggestions: [],
      summary: rejection,
      rejected: true,
    };
  }
  const text = resumePlainText(doc);
  const keywords = extractKeywords(jobDescription);
  const matched = keywords.filter((k) => keywordMatches(text, k));
  const missing = keywords.filter((k) => !keywordMatches(text, k));
  const score = keywords.length
    ? Math.round((matched.length / keywords.length) * 100)
    : 50;

  const fallback: AtsResult = {
    score,
    matchedKeywords: matched.slice(0, 20),
    missingKeywords: missing.slice(0, 20),
    suggestions: [
      {
        area: "Summary",
        advice: missing.slice(0, 5).length
          ? `Mention: ${missing.slice(0, 5).join(", ")}`
          : "Summary already covers key keywords.",
      },
      {
        area: "Experience",
        advice: "Mirror JD verbs (deploy, automate, scale) with metrics.",
      },
      {
        area: "Skills",
        advice: "Add missing tools from the JD into skill categories.",
      },
    ],
    summary: `Heuristic ATS score ${score}/100 based on keyword overlap.`,
  };

  const ai = await generateJson<AtsResult>(
    `ATS-check this resume against the job description. Return JSON: {score, matchedKeywords, missingKeywords, suggestions:[{area,advice}], summary}\n\nJD:\n${jobDescription}\n\nResume:\n${resumePlainText(doc)}`,
    fallback
  );
  return {
    ...fallback,
    summary: ai?.summary || fallback.summary,
  };
}

export async function coverLetter(
  doc: ResumeDocument,
  jobDescription?: string
): Promise<string> {
  const header = doc.content.sections.find((s) => s.type === "header");
  const name = header && header.type === "header" ? header.fullName : "Candidate";
  const fallback = `Dear Hiring Manager,\n\nI am writing to express my interest in the role. As ${name}, I bring hands-on experience with cloud platforms, CI/CD, and reliable production operations.\n\n${
    jobDescription
      ? "I have reviewed the job description and aligned my recent achievements with your requirements.\n\n"
      : ""
  }I would welcome the opportunity to discuss how I can contribute to your team.\n\nSincerely,\n${name}`;

  const result = await generateJson<{ body: string }>(
    `Write a concise professional cover letter. Return JSON {body}.\nResume:\n${resumePlainText(doc)}\nJD:\n${jobDescription || "general"}`,
    { body: fallback }
  );
  return result.body;
}

export async function tailorForJob(
  doc: ResumeDocument,
  jobDescription: string
): Promise<{ summary?: string; skillsAdvice?: string; experienceAdvice?: string }> {
  return generateJson(
    `Suggest tailored resume updates for this JD. Return JSON {summary, skillsAdvice, experienceAdvice}.\nJD:\n${jobDescription}\nResume:\n${resumePlainText(doc)}`,
    {
      summary:
        "Lead with cloud + CI/CD outcomes that match the JD, then list relevant stacks.",
      skillsAdvice: "Promote JD tools into the first skill category.",
      experienceAdvice: "Rewrite top bullets to mirror JD responsibilities with metrics.",
    }
  );
}
