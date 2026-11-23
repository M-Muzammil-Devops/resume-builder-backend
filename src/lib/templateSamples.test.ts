import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDING_PRESETS,
  TEMPLATE_SAMPLES,
  TEMPLATES,
  buildTemplateContent,
  buildTemplateDesign,
  isEmptySection,
  isLetterPage,
  normalizePageSize,
  pruneSampleMarks,
  resolveColumns,
  type ResumeContent,
} from "../shared";
import { scrubSampleText } from "./sampleText";
import { storedResumeContent, storedResumeDesign } from "./resumeContent";
import { htmlToPlain, resumeToHtml } from "../routes/export";

type AnyRec = Record<string, any>;
const sec = (c: ResumeContent, type: string) => c.sections.find((s) => s.type === type) as AnyRec;
const exportText = (c: unknown) => htmlToPlain(resumeToHtml(scrubSampleText(c), {}, "R"));

test("every landing template ships role-specific starter content", () => {
  for (const id of Object.keys(LANDING_PRESETS)) {
    const sample = TEMPLATE_SAMPLES[id];
    assert.ok(sample, `${id} has no starter content`);
    const c = buildTemplateContent(id);
    assert.equal(sec(c, "header").fullName, sample.fullName, id);
    assert.notEqual(sec(c, "header").fullName, "YOUR NAME", id);
    const exp = sec(c, "experience").items as AnyRec[];
    assert.ok(exp.length >= 3, `${id} needs 3+ experiences`);
    for (const item of exp) assert.ok(item.bullets.length >= 3, `${id}/${item.id} needs 3+ bullets`);
    assert.ok(sec(c, "education").items.length >= 1, id);
    assert.ok(sec(c, "skills").categories.length >= 1, id);
    // Landing-match: the starter holds exactly the sections the preview shows (no orphan page).
    const preset = LANDING_PRESETS[id];
    const shown = [...preset.leftColumnIds, ...preset.rightColumnIds].sort();
    const body = (c.sections as AnyRec[]).filter((s) => s.type !== "header").map((s) => s.id).sort();
    assert.deepEqual(body, shown, `${id}: starter sections must match the preview columns`);
    assert.ok(sec(c, "summary").content.length > 120, id);
    // ids stay unique per list so sample marks and editor paths never collide
    for (const s of c.sections as AnyRec[]) {
      const list = (s.items || s.categories || []) as AnyRec[];
      assert.equal(new Set(list.map((x) => x.id)).size, list.length, `${id}/${s.id} duplicate ids`);
    }
  }
});

test("starter content uses example contact details only", () => {
  for (const [id, sample] of Object.entries(TEMPLATE_SAMPLES)) {
    assert.match(sample.contact.email || "", /@example\.com$/, id);
    assert.equal(/muzammil/i.test(JSON.stringify(sample)), false, `${id} contains personal data`);
  }
});

test("untouched template starter text is kept in the export (usable as-is)", () => {
  for (const id of Object.keys(LANDING_PRESETS)) {
    const c = storedResumeContent(buildTemplateContent(id)) as ResumeContent;
    assert.ok(c.sampleFields, `${id} keeps provenance mode`);
    const sample = TEMPLATE_SAMPLES[id];
    for (const value of Object.values(c.sampleFields!)) {
      assert.equal(JSON.stringify(sample).includes(JSON.stringify(value)), false, `${id}: template text "${value}" is marked as sample`);
    }
    const text = exportText(c);
    for (const keep of [sample.fullName, sample.summary.slice(0, 40), sample.experience[0].bullets[0].slice(0, 40), sample.experience[0].company, sample.contact.email!, sample.experience[0].startDate]) {
      assert.ok(text.includes(keep), `${id}: "${keep}" missing from export`);
    }
    for (const bad of ["Company Name", "University Name", "hello@email.com", "Senior Role Title", "YOUR NAME"]) {
      assert.equal(text.includes(bad), false, `${id}: generic placeholder "${bad}" leaked`);
    }
  }
});

test("edited template fields are kept along with the untouched template text", () => {
  const sample = TEMPLATE_SAMPLES["emerald-numbered"];
  let c = storedResumeContent(buildTemplateContent("emerald-numbered")) as ResumeContent;
  sec(c, "header").fullName = "Ayesha Khan";
  const exp = sec(c, "experience").items[0];
  exp.company = "Indus Cloud";
  exp.bullets[0] = `${exp.bullets[0]} Reviewed.`;
  c = storedResumeContent(pruneSampleMarks(c)) as ResumeContent;
  const text = exportText(c);
  assert.match(text, /Ayesha Khan/);
  assert.match(text, /Indus Cloud/);
  assert.match(text, /Reviewed\./);
  assert.ok(text.includes(sample.experience[1].bullets[0]));
  assert.equal(text.includes(sample.fullName), false);
});

test("generic placeholders added by a template (nationality / DOB hints) stay marked", () => {
  const c = buildTemplateContent("saffron-line");
  const marked = Object.values(c.sampleFields || {});
  assert.equal(marked.includes("Lorenzo Bianchi"), false);
  assert.equal(marked.includes("Italian"), false);
});

test("Emerald Numbered design keeps its numbered headings and initials badge after save", () => {
  const design = storedResumeDesign(buildTemplateDesign("emerald-numbered")) as AnyRec;
  assert.equal(design.sectionHeadingStyle, "numbered");
  assert.equal(design.headerMonogram, true);
  assert.equal(design.columnLayout, "single");
  const c = buildTemplateContent("emerald-numbered");
  assert.equal(sec(c, "skills").settings.skillsLayout, "underline");
  // The initials square is the photo slot, so Photo is on by default (no duplicate box).
  assert.equal(sec(c, "header").settings.photo, true);
});

test("catalog adds the Numbered layout without shifting existing template ids", () => {
  const numbered = TEMPLATES.filter((t) => t.layoutKey === "numbered");
  assert.deepEqual(numbered.map((t) => t.id), ["tmpl-devops-numbered", "tmpl-cloud-numbered", "tmpl-sre-numbered", "tmpl-platform-numbered"]);
  assert.ok(TEMPLATES.some((t) => t.id === "tmpl-devops-high-performer"));
  assert.ok(TEMPLATES.some((t) => t.id === "tmpl-cloud-high-performer-12"));
  assert.equal(new Set(TEMPLATES.map((t) => t.id)).size, TEMPLATES.length);
});

test("BUG-1280 every template renders the same sections in the PDF/canvas as in the TXT export", () => {
  for (const id of Object.keys(LANDING_PRESETS)) {
    const content = storedResumeContent(buildTemplateContent(id)) as ResumeContent;
    const design = buildTemplateDesign(id);
    const exported = scrubSampleText(content) as ResumeContent;
    const txtSections = exported.sections.filter((s) => s.type !== "header" && !isEmptySection(s)).map((s) => s.id).sort();
    // what ResumeCanvas (editor, preview, print/[id] PDF) lays out, minus empty sections it skips read-only
    const cols = resolveColumns(exported, design.columnLayout);
    const byId = new Map(exported.sections.map((s) => [s.id, s]));
    const rendered = [...cols.left, ...cols.right].filter((sid) => !isEmptySection(byId.get(sid))).sort();
    assert.deepEqual(rendered, txtSections, `${id}: canvas/PDF and TXT sections differ`);
    const text = htmlToPlain(resumeToHtml(exported, design, "R"));
    for (const sid of txtSections) {
      const title = String((byId.get(sid) as AnyRec).title || "").trim();
      assert.ok(text.toLowerCase().includes(title.toLowerCase()), `${id}: "${title}" missing from TXT`);
    }
  }
});

test("BUG-1280 sections in neither column list join the main column once, in order", () => {
  // Generic starter (no landing preset) still carries every section type.
  const c = buildTemplateContent("generic-starter");
  const cols = resolveColumns({ ...c, leftColumnIds: ["summary", "summary", "ghost"], rightColumnIds: [] }, "single");
  assert.equal(cols.left[0], "summary");
  assert.equal(cols.left.filter((x) => x === "summary").length, 1);
  assert.equal(cols.left.includes("ghost"), false);
  assert.ok(cols.left.includes("projects") && cols.left.includes("interests") && cols.left.includes("languages"));
  const wide = resolveColumns({ ...c, leftColumnIds: ["skills"], rightColumnIds: ["experience"] }, "wide-right");
  assert.deepEqual(wide.left, ["skills"]);
  assert.ok(wide.right.includes("projects"));
});

test("BUG-704 Letter, letter and US Letter all mean US Letter", () => {
  for (const v of ["US Letter", "Letter", "letter", " LETTER ", "us-letter"]) {
    assert.equal(isLetterPage(v), true, v);
    assert.equal(normalizePageSize(v), "US Letter", v);
  }
  for (const v of ["A4", "a4", "", undefined, "Legal"]) assert.equal(normalizePageSize(v), "A4", String(v));
  assert.equal((storedResumeDesign({ pageSize: "letter" }) as AnyRec).pageSize, "US Letter");
  assert.match(resumeToHtml({ sections: [] }, { pageSize: "Letter" } as AnyRec, "R"), /size: 8\.5in 11in/);
});

test("photo-restore: templates designed with a photo start with their same-origin sample headshot", async () => {
  const { safeImageUrl } = await import("./resumeSchema");
  const { applyPresetStructure, LANDING_PRESETS: P } = await import("../shared");
  const withPhoto = ["marketing-cyan", "executive-navy", "steady-form", "saffron-line"];
  for (const id of withPhoto) {
    const c = buildTemplateContent(id);
    const header = sec(c, "header");
    assert.equal(header.photoUrl, `/templates/photos/${id}.webp`, id);
    assert.notEqual(header.settings?.photo, false, `${id}: photo slot on`);
    // Survives the save sanitizer and stays in the export (template content is real content).
    const stored = storedResumeContent(c) as ResumeContent;
    assert.equal(sec(stored, "header").photoUrl, header.photoUrl, `${id}: kept on save`);
    assert.ok(resumeToHtml(stored, buildTemplateDesign(id), "R").includes(`src="/templates/photos/${id}.webp"`), `${id}: in export`);
  }
  for (const id of Object.keys(LANDING_PRESETS).filter((x) => !withPhoto.includes(x))) {
    assert.equal(sec(buildTemplateContent(id), "header").photoUrl || "", "", `${id}: no sample photo`);
  }
  assert.equal(safeImageUrl("/templates/photos/../secret.webp"), "");
  assert.equal(safeImageUrl("/templates/photos/x.svg"), "");
  assert.equal(safeImageUrl("/templates/other.webp"), "");
  // A sample headshot is not the user's photo: switching to a no-photo template hides it.
  const switched = applyPresetStructure(buildTemplateContent("steady-form"), P["strategy-clean"]);
  assert.equal(sec(switched, "header").settings.photo, false);
});

test("BUG-1294: photoUrl is only an uploaded image or a same-origin sample headshot", async () => {
  const { safePhotoUrl, photoUrlError } = await import("./resumeSchema");
  const webp = `data:image/webp;base64,${Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ").toString("base64")}`;
  assert.equal(safePhotoUrl("/templates/photos/steady-form.webp"), "/templates/photos/steady-form.webp");
  assert.equal(safePhotoUrl(webp), webp);
  for (const bad of [
    "https://evil.example/x.png",
    "http://localhost:4000/x.png",
    "/uploads/a.png",
    "/templates/photos/steady-form.png",
    "/templates/photos/../x.webp",
    "/templates/photos/Steady.webp",
    "//evil.example/templates/photos/x.webp",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "javascript:alert(1)",
  ]) {
    assert.equal(safePhotoUrl(bad), "", bad);
    assert.ok(photoUrlError({ sections: [{ type: "header", photoUrl: bad }] }), bad);
  }
  assert.equal(photoUrlError({ sections: [{ type: "header", photoUrl: "" }] }), null);
  assert.equal(photoUrlError(buildTemplateContent("steady-form")), null);
  // Export never renders a refused URL even if one were stored.
  const c = buildTemplateContent("steady-form");
  sec(c, "header").photoUrl = "https://evil.example/x.png";
  assert.equal(resumeToHtml(c, buildTemplateDesign("steady-form"), "R").includes("evil.example"), false);
});

test("BUG-1299: design values are validated (enums, ranges, hex colours)", async () => {
  const { designError } = await import("./resumeSchema");
  for (const id of Object.keys(LANDING_PRESETS)) assert.equal(designError(buildTemplateDesign(id)), null, id);
  assert.equal(designError(undefined), null);
  assert.equal(designError({ listColumns: null, unknownKey: "x" }), null);
  for (const [key, value] of [
    ["listColumns", 9],
    ["listColumns", 2.5],
    ["entryLayout", "nope"],
    ["density", "huge"],
    ["sectionHeadingStyle", "zzz"],
    ["headerStyle", "wild"],
    ["accentColor", "zzz"],
    ["inkColor", "red;background:url(x)"],
    ["pageMargins", 99],
    ["columnLayout", "triple"],
    ["fontFamily", "x</style>"],
  ] as const) {
    assert.match(String(designError({ [key]: value })), new RegExp(key), `${key}=${value}`);
  }
});
