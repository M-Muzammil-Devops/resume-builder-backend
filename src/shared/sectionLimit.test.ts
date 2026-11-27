import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_FREE_PDF_SECTION_LIMIT,
  countResumeSections,
  effectiveSectionLimit,
  sectionLimitBlocked,
  sectionLimitMessage,
} from "./sectionLimit";
import { SAMPLE_DEVOPS_CONTENT } from "./defaults";

const header = { type: "header", id: "header", fullName: "A", title: "", contact: {} };
const resume = (...types: string[]) => ({
  sections: [header, ...types.map((type, i) => ({ type, id: `${type}_${i}`, title: type.toUpperCase(), items: [] }))],
  leftColumnIds: [],
  rightColumnIds: [],
});

test("section count: Header / Personal Info is never counted", () => {
  assert.equal(countResumeSections({ sections: [header] }), 0);
  assert.equal(countResumeSections(resume("summary")), 1);
});

test("section count: filled and empty sections both count", () => {
  const r = resume("summary", "experience", "education", "skills");
  (r.sections[1] as Record<string, unknown>).content = "Filled summary";
  assert.equal(countResumeSections(r), 4);
  const withEmpty = resume("summary", "experience", "education", "skills", "projects");
  assert.equal(countResumeSections(withEmpty), 5);
});

test("section count: custom sections count, repeated ids count once, junk is ignored", () => {
  const r = resume("summary", "custom", "custom");
  assert.equal(countResumeSections(r), 3);
  assert.equal(countResumeSections({ sections: [header, { type: "summary", id: "s" }, { type: "summary", id: "s" }] }), 1);
  assert.equal(countResumeSections({ sections: [null, 3, {}, { type: "" }, { id: "x" }] }), 0);
  assert.equal(countResumeSections(null), 0);
  assert.equal(countResumeSections({}), 0);
  assert.equal(countResumeSections({ sections: "nope" }), 0);
});

test("section count: the starter sample has 7 sections (Summary onwards)", () => {
  assert.equal(countResumeSections(SAMPLE_DEVOPS_CONTENT), SAMPLE_DEVOPS_CONTENT.sections.filter((s) => s.type !== "header").length);
});

test("section limit: 0-4 allowed, 5+ blocked for Free with the default limit 4", () => {
  const limit = effectiveSectionLimit("free", { enabled: true, max: DEFAULT_FREE_PDF_SECTION_LIMIT });
  assert.equal(limit, 4);
  for (const n of [0, 1, 2, 3, 4]) assert.equal(sectionLimitBlocked(n, limit), false, `${n} sections`);
  for (const n of [5, 6, 12]) assert.equal(sectionLimitBlocked(n, limit), true, `${n} sections`);
});

test("section limit: Pro and Admin are never limited; off or 0 means unlimited", () => {
  assert.equal(effectiveSectionLimit("pro", { enabled: true, max: 4 }), 0);
  assert.equal(effectiveSectionLimit("admin", { enabled: true, max: 4 }), 0);
  assert.equal(effectiveSectionLimit("free", { enabled: false, max: 4 }), 0);
  assert.equal(effectiveSectionLimit("free", { enabled: true, max: 0 }), 0);
  assert.equal(sectionLimitBlocked(50, 0), false);
});

test("section limit: message names the limit and the count", () => {
  assert.equal(
    sectionLimitMessage(4, 6),
    "Your Free plan allows up to 4 sections for PDF download. This resume has 6 sections. Upgrade your plan to download."
  );
  assert.match(sectionLimitMessage(1, 1), /up to 1 section for .* has 1 section\./);
});

test("section limit: backend and frontend copies are identical", () => {
  const fe = path.resolve(__dirname, "../../../resume-builder-frontend/src/shared/sectionLimit.ts");
  if (!existsSync(fe)) return;
  assert.equal(readFileSync(fe, "utf8").replace(/\r\n/g, "\n"), readFileSync(path.join(__dirname, "sectionLimit.ts"), "utf8").replace(/\r\n/g, "\n"));
});
