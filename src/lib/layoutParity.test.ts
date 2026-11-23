import assert from "node:assert/strict";
import test from "node:test";
import { buildTemplateContent, isEmptySection, isSingleColumnLayout, resolveColumns, splitIntoTwoColumns } from "../shared";
import { htmlToPlain, resumeToHtml } from "../routes/export";

type AnyRec = Record<string, any>;
const TWO_COL = /<div style="display:flex;gap:[^"]*;align-items:flex-start">/;

/** The user's Emerald Numbered resume: single column, but with ids spread over both lists. */
function emeraldUserDoc() {
  const c = buildTemplateContent("emerald-numbered") as AnyRec;
  // The Emerald starter only has the previewed sections; this user also added the others.
  const extra = (buildTemplateContent("generic-starter").sections as AnyRec[]).filter(
    (s) => !c.sections.some((x: AnyRec) => x.type === s.type)
  );
  c.sections = [...c.sections, ...extra];
  const id = (type: string) => c.sections.find((s: AnyRec) => s.type === type)?.id;
  c.leftColumnIds = ["summary", "skills", "education", "certifications"].map(id).filter(Boolean);
  c.rightColumnIds = ["achievements", "languages", "experience"].map(id).filter(Boolean);
  return { c, id };
}

test("one column rule is shared: single layout, single-column templates, empty side column", () => {
  assert.equal(isSingleColumnLayout("numbered", "single", 3), true);
  assert.equal(isSingleColumnLayout("single-column", "wide-left", 4), true);
  assert.equal(isSingleColumnLayout("high-performer", "wide-left", 0), true);
  assert.equal(isSingleColumnLayout("high-performer", "wide-left", 2), false);
  assert.equal(isSingleColumnLayout("numbered", "equal", 1), false);
});

test("single-column export reads left then right in one column (matches canvas + modal)", () => {
  const { c } = emeraldUserDoc();
  const html = resumeToHtml(c, { columnLayout: "single" }, "R", "numbered");
  assert.doesNotMatch(html, TWO_COL);
  const cols = resolveColumns(c as any, "single");
  const expected = [...cols.left, ...cols.right]
    .map((sid) => (c.sections as AnyRec[]).find((s) => s.id === sid))
    .filter((s): s is AnyRec => Boolean(s) && !isEmptySection(s))
    .map((s) => String(s.title || "").trim().toLowerCase());
  const headings = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim().toLowerCase()
  );
  assert.deepEqual(headings.slice(0, expected.length), expected, "export order = modal order");
  // Experience was last in the user's lists, so it is last on the page too (not missing).
  assert.ok(headings.some((h) => /experience/.test(h)), "experience is rendered");
});

test("switching to two columns renders two columns in the export", () => {
  const { c } = emeraldUserDoc();
  const split = splitIntoTwoColumns(c as any);
  const html = resumeToHtml({ ...c, leftColumnIds: split.left, rightColumnIds: split.right }, { columnLayout: "wide-left" }, "R", "numbered");
  assert.match(html, TWO_COL);
});

test("an empty side column is a real one-column choice, not refilled with defaults", () => {
  const { c } = emeraldUserDoc();
  const all = [...c.leftColumnIds, ...c.rightColumnIds];
  const html = resumeToHtml({ ...c, leftColumnIds: all, rightColumnIds: [] }, { columnLayout: "wide-left" }, "R", "high-performer");
  assert.doesNotMatch(html, TWO_COL);
});

test("splitIntoTwoColumns keeps every section once, both columns non-empty, order kept", () => {
  const { c } = emeraldUserDoc();
  const all = resolveColumns(c as any, "single");
  const order = [...all.left, ...all.right];
  const split = splitIntoTwoColumns(c as any);
  assert.ok(split.left.length > 0 && split.right.length > 0);
  assert.deepEqual([...split.left, ...split.right].sort(), [...order].sort());
  const rank = (x: string) => order.indexOf(x);
  for (const col of [split.left, split.right]) {
    assert.deepEqual([...col].sort((a, b) => rank(a) - rank(b)), col);
  }
  const typeOf = (x: string) => (c.sections as AnyRec[]).find((s) => s.id === x)?.type;
  assert.ok(split.left.map(typeOf).includes("experience"), "experience stays in the main column");
  const preferred = splitIntoTwoColumns(c as any, ["languages"]);
  assert.deepEqual(preferred.right.map(typeOf), ["languages"]);
});

test("empty certification date / credential URL placeholders never reach the export", () => {
  const { c } = emeraldUserDoc();
  const cert = (c.sections as AnyRec[]).find((s) => s.type === "certifications");
  assert.ok(cert, "emerald has certifications");
  cert.items = [{ ...cert.items[0], id: "cx", date: "", url: "", credentialUrl: "" }];
  const text = htmlToPlain(resumeToHtml(c, { columnLayout: "single" }, "R", "numbered"));
  assert.doesNotMatch(text, /Credential URL/i);
  assert.doesNotMatch(text, /(^|\n)\s*Date\s*($|\n)/);
});
