import test from "node:test";
import assert from "node:assert/strict";
import { profileSteps, resumeReadiness, starterTexts, startOfNextUtcMonth } from "./dashboardSummary";
import { buildTemplateContent } from "../shared/templateStarter";
import { markSampleContent } from "../shared/sampleMarks";
import { exportLimitFor, exportPlanOf, normalizeExportSettings } from "./exportSettings";

const full = {
  sections: [
    { id: "h", type: "header", fullName: "Ayesha Khan", title: "Product Designer", contact: { email: "a@example.com", phone: "+92 300 0000000" } },
    { id: "s", type: "summary", title: "Summary", content: "Designer with eight years of experience shipping B2B products end to end." },
    {
      id: "e",
      type: "experience",
      title: "Experience",
      items: [{ id: "e1", title: "Lead Designer", company: "Acme", startDate: "", endDate: "", location: "", bullets: ["Shipped A", "Grew B by 20%", "Led C"] }],
    },
    { id: "ed", type: "education", title: "Education", items: [{ id: "d1", degree: "BS Design", school: "NCA", startDate: "", endDate: "", location: "" }] },
    { id: "sk", type: "skills", title: "Skills", categories: [{ id: "c", name: "Core", skills: ["Figma", "UX", "UI", "Research", "Prototyping"] }] },
    { id: "l", type: "languages", title: "Languages", items: [{ id: "l1", name: "English", level: "Fluent", proficiency: 5 }] },
  ],
  leftColumnIds: [],
  rightColumnIds: [],
};

test("dashboard: a fully written resume scores 100", () => {
  const r = resumeReadiness(full);
  assert.equal(r.score, 100);
  assert.ok(r.checks.every((c) => c.done));
});

test("dashboard: score is deterministic and drops with missing sections", () => {
  const partial = { ...full, sections: full.sections.filter((s) => s.type !== "skills" && s.type !== "summary") };
  assert.equal(resumeReadiness(partial).score, 70);
  assert.equal(resumeReadiness(partial).score, resumeReadiness(partial).score);
  assert.equal(resumeReadiness(null).score, 0);
  assert.equal(resumeReadiness({ sections: "x" }).score, 0);
});

test("dashboard: untouched template sample text never counts", () => {
  // A fresh template: every text field still carries its sample mark.
  const sample = markSampleContent(structuredClone(full) as never);
  assert.equal(resumeReadiness(sample).score, 0);
});

test("dashboard: profile checklist percentage", () => {
  const p = profileSteps({ name: "A", location: "Karachi", emailVerified: true, resumeCount: 1, bestScore: 90, pdfExportsEver: 2 });
  assert.equal(p.pct, 100);
  const q = profileSteps({ name: null, location: null, emailVerified: false, resumeCount: 0, bestScore: 0, pdfExportsEver: 0 });
  assert.equal(q.pct, 17);
  assert.equal(q.steps[0].done, true);
});

test("dashboard: billing plan PRO uses the Pro export limit", () => {
  const s = normalizeExportSettings({ maxExports: { free: 5, pro: 0 } });
  assert.equal(exportLimitFor(s, "user", "FREE"), 5);
  assert.equal(exportLimitFor(s, "user", "PRO"), 0);
  assert.equal(exportPlanOf("admin", "FREE"), "admin");
  assert.equal(startOfNextUtcMonth(new Date("2026-12-15T10:00:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("dashboard: untouched landing-template starter text never counts", () => {
  const starter = starterTexts("tmpl-landing-executive-navy");
  assert.ok(starter && starter.size > 10);
  const fresh = buildTemplateContent("executive-navy");
  assert.equal(resumeReadiness(fresh, starter).score, 0);
  // The user types their own name and title: only that part counts.
  const edited = structuredClone(fresh) as unknown as { sections: Array<Record<string, unknown>> };
  const header = edited.sections.find((s) => s.type === "header")!;
  header.fullName = "Muhammad Ali";
  header.title = "Operations Lead";
  assert.equal(resumeReadiness(edited, starter).score, 15);
  assert.equal(starterTexts("tmpl-unknown"), undefined);
});
