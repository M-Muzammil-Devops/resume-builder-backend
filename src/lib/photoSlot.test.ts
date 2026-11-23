import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDING_PRESETS,
  applyPresetStructure,
  buildTemplateContent,
  buildTemplateDesign,
  initialsOf,
  resolvePhotoSlot,
} from "../shared";
import { htmlToPlain, resumeToHtml } from "../routes/export";

type AnyRec = Record<string, any>;
// BUG-1294: a user photo is an uploaded data URL (WebP bytes), never an external or /uploads path.
const PHOTO = `data:image/webp;base64,${Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ").toString("base64")}`;
const slots = (html: string) => (html.match(/class="rb-photo-slot/g) || []).length;
const header = (c: AnyRec) => c.sections.find((s: AnyRec) => s.type === "header");

test("initials: two letters max, markup ignored", () => {
  assert.equal(initialsOf("Marcus Miller"), "MM");
  assert.equal(initialsOf("<b>Ana</b> de la Cruz"), "AC");
  assert.equal(initialsOf("Cher"), "C");
  assert.equal(initialsOf(""), "");
});

test("one slot: photo beats monogram beats placeholder; the toggle hides it", () => {
  const base = { photoOn: true, monogram: true, fullName: "Marcus Miller", photoPosition: "left" };
  assert.equal(resolvePhotoSlot({ ...base, photoUrl: PHOTO }).kind, "photo");
  assert.equal(resolvePhotoSlot(base).kind, "monogram");
  assert.equal(resolvePhotoSlot({ ...base, monogram: false, editing: true }).kind, "placeholder");
  assert.equal(resolvePhotoSlot({ ...base, monogram: false, editing: false }).kind, "none");
  assert.equal(resolvePhotoSlot({ ...base, photoOn: false, photoUrl: PHOTO }).kind, "none");
});

test("slot side and shape follow the template and Photo Style", () => {
  assert.equal(resolvePhotoSlot({ photoOn: true, photoPosition: "right" }).position, "right");
  assert.equal(resolvePhotoSlot({ photoOn: true, photoPosition: "left" }).position, "left");
  assert.equal(resolvePhotoSlot({ photoOn: true }).position, "left", "no position -> left of the name");
  assert.equal(resolvePhotoSlot({ photoOn: true, headerStyle: "centered", photoPosition: "right" }).position, "top");
  assert.equal(resolvePhotoSlot({ photoOn: true, photoStyle: "circle" }).radius, "50%");
  assert.equal(resolvePhotoSlot({ photoOn: true, photoStyle: "square" }).radius, "6px");
  const portrait = resolvePhotoSlot({ photoOn: true, photoStyle: "portrait" });
  assert.ok(portrait.height > portrait.width);
});

test("monogram initials fit on one line inside the square", () => {
  const s = resolvePhotoSlot({ photoOn: true, monogram: true, fullName: "Marcus Miller", photoStyle: "square" });
  // Bold capitals are at most ~0.8em wide each.
  assert.ok(s.initialsFontSize * 0.8 * s.initials.length + 8 <= s.width, `${s.initialsFontSize}px x2 in ${s.width}px`);
});

test("Emerald: the initials square is the photo slot (on by default, no duplicate box)", () => {
  const c = buildTemplateContent("emerald-numbered") as AnyRec;
  const d = buildTemplateDesign("emerald-numbered") as AnyRec;
  assert.equal(header(c).settings.photo, true);
  const noPhoto = resumeToHtml(c, d, "R", "numbered");
  assert.equal(slots(noPhoto), 1);
  assert.match(noPhoto, /rb-mono" data-initials="[A-Z]{2}"/);
  assert.doesNotMatch(htmlToPlain(noPhoto), /^\s*[A-Z]{2}\s*$/m, "initials never leak into TXT");
  header(c).photoUrl = PHOTO;
  const withPhoto = resumeToHtml(c, d, "R", "numbered");
  assert.equal(slots(withPhoto), 1, "photo replaces the monogram in the same slot");
  assert.doesNotMatch(withPhoto, /data-initials="/);
  assert.ok(withPhoto.indexOf(PHOTO) < withPhoto.indexOf("<h1"), "photo stays left of the name");
});

test("every landing template renders exactly one slot on its own side once a photo exists", () => {
  for (const [id, preset] of Object.entries(LANDING_PRESETS) as [string, AnyRec][]) {
    const c = buildTemplateContent(id) as AnyRec;
    const d = buildTemplateDesign(id) as AnyRec;
    header(c).photoUrl = PHOTO;
    header(c).settings = { ...header(c).settings, photo: true };
    const html = resumeToHtml(c, d, "R", preset.layoutKey);
    assert.equal(slots(html), 1, `${id}: one slot`);
    const photoAt = html.indexOf(PHOTO);
    const nameAt = html.indexOf("<h1");
    if (d.headerStyle === "centered") assert.ok(photoAt < nameAt, `${id}: centred photo above the name`);
    else if ((d.photoPosition || "left") === "right") assert.ok(photoAt > nameAt, `${id}: photo right of the name`);
    else assert.ok(photoAt < nameAt, `${id}: photo left of the name`);
  }
});

test("unsafe photo URLs never render", () => {
  const c = buildTemplateContent("steady-form") as AnyRec;
  header(c).photoUrl = "javascript:alert(1)";
  header(c).settings = { ...header(c).settings, photo: true };
  const html = resumeToHtml(c, buildTemplateDesign("steady-form"), "R", "high-performer");
  assert.doesNotMatch(html, /javascript:/);
  assert.equal(slots(html), 0);
});

test("template switch keeps an uploaded photo in the new template's slot", () => {
  const c = buildTemplateContent("steady-form") as AnyRec;
  header(c).photoUrl = PHOTO;
  for (const [id, preset] of Object.entries(LANDING_PRESETS) as [string, AnyRec][]) {
    const next = applyPresetStructure(structuredClone(c) as any, preset as any) as AnyRec;
    const h = header(next);
    assert.equal(h.photoUrl, PHOTO, `${id}: photo kept`);
    if (preset.headerStyle === "centered") assert.equal(h.settings.photo, false, `${id}: centred header is text-only`);
    else assert.equal(h.settings.photo, true, `${id}: photo still shown`);
  }
});
