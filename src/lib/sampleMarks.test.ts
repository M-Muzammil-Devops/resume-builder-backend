import assert from "node:assert/strict";
import test from "node:test";
import { createSampleDevopsResume, markNewEntries, pruneSampleMarks, touchSampleValue, type ResumeContent } from "../shared";
import { scrubSampleText } from "./sampleText";
import { storedResumeContent } from "./resumeContent";
import { htmlToPlain, resumeToHtml } from "../routes/export";

type AnyRec = Record<string, any>;
const sec = (c: ResumeContent, type: string) => c.sections.find((s) => s.type === type) as AnyRec;

function freshStored(): ResumeContent {
  return storedResumeContent(createSampleDevopsResume().content) as ResumeContent;
}

test("BUG-1240b new resumes carry sample marks that survive the save sanitiser", () => {
  const c = freshStored();
  assert.ok(c.sampleFields && Object.keys(c.sampleFields).length > 10);
  assert.equal(c.sampleFields!["education/items/ed1/school"], "University Name");
});

test("BUG-1240b untouched sample fields, sample dates and Remote never reach the export", () => {
  const text = htmlToPlain(resumeToHtml(scrubSampleText(freshStored()), {}, "Untitled Resume"));
  for (const bad of ["University Name", "hello@email.com", "Company Name", "Bachelor of Science", "Remote", "2021-01", "Present", "linkedin.com", "PROJECTS", "SKILLS", "EXPERIENCE", "EDUCATION"]) {
    assert.equal(text.includes(bad), false, `${bad} leaked: ${text}`);
  }
});

test("BUG-1240b a typed value equal to a sample string is kept once the field was edited", () => {
  let c = freshStored();
  const edu = sec(c, "education");
  const ed = edu.items[0];
  // the user first clears the field (the editor prunes on every change), then types the sample text
  ed.school = "";
  c = pruneSampleMarks(c);
  ed.school = "University Name";
  const hdr = sec(c, "header");
  hdr.contact.email = "x";
  c = pruneSampleMarks(c);
  hdr.contact.email = "hello@email.com";
  c = storedResumeContent(c) as ResumeContent;
  const text = htmlToPlain(resumeToHtml(scrubSampleText(c), {}, "R"));
  assert.match(text, /University Name/);
  assert.match(text, /hello@email\.com/);
  assert.match(text, /EDUCATION/);
  assert.equal(text.includes("Bachelor of Science"), false);
});

test("BUG-1240b re-typing the identical sample value clears its mark (touch)", () => {
  const c = touchSampleValue(freshStored(), "University Name", "ed1");
  assert.equal(c.sampleFields!["education/items/ed1/school"], undefined);
  const text = htmlToPlain(resumeToHtml(scrubSampleText(c), {}, "R"));
  assert.match(text, /University Name/);
});

test("BUG-1240b entries added in the editor are marked as sample", () => {
  const before = freshStored();
  const after = structuredClone(before);
  sec(after, "experience").items.push({ id: "exp-new", title: "Title", company: "Company Name", startDate: "", endDate: "", location: "", bullets: ["Highlight"] });
  const marked = markNewEntries(before, after);
  assert.equal(marked.sampleFields!["experience/items/exp-new/company"], "Company Name");
  const text = htmlToPlain(resumeToHtml(scrubSampleText(marked), {}, "R"));
  assert.equal(text.includes("Company Name"), false);
});

test("BUG-1240b old resumes without marks keep the value-based scrub", () => {
  const legacy = structuredClone(createSampleDevopsResume().content);
  delete legacy.sampleFields;
  const text = htmlToPlain(resumeToHtml(scrubSampleText(legacy), {}, "R"));
  assert.equal(text.includes("University Name"), false);
  assert.equal(text.includes("hello@email.com"), false);
  assert.equal(text.includes("PROJECTS"), false, text);
});
