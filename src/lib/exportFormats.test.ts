import assert from "node:assert/strict";
import test from "node:test";
import { EXPORT_MIME, PrintRenderError, docxFromText, exportErrorBody, parseExportFormat } from "./exportFormats";

test("BUG-705 export format parsing defaults to pdf and rejects unknown formats", () => {
  assert.equal(parseExportFormat(undefined), "pdf");
  assert.equal(parseExportFormat(""), "pdf");
  assert.equal(parseExportFormat("PDF"), "pdf");
  assert.equal(parseExportFormat("docx"), "docx");
  assert.equal(parseExportFormat("txt"), "txt");
  assert.equal(parseExportFormat("exe"), null);
});

test("BUG-705 DOCX export is a real OOXML zip with the DOCX MIME type", async () => {
  const buf = await docxFromText("JANE DOE\nEngineer\nhttps://example.com/in/jane", { pageSize: "A4" });
  assert.ok(buf.length > 1000);
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  assert.equal(EXPORT_MIME.docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.match(EXPORT_MIME.txt, /^text\/plain/);
  assert.equal(EXPORT_MIME.pdf, "application/pdf");
});

test("BUG-705 export errors are explicit and never leak paths or stacks", () => {
  const body = exportErrorBody(new PrintRenderError("The print view did not finish loading in time.", ["[error] x"]));
  assert.equal(body.message, "The print view did not finish loading in time.");
  const generic = exportErrorBody(new Error("ENOENT: C:\\Users\\me\\secret.ttf at foo (D:\\x.ts:1:1)"));
  assert.equal(/[A-Z]:\\|ENOENT|\.ts:/.test(JSON.stringify(generic)), false);
  assert.equal(/Waiting for selector/.test(JSON.stringify(generic)), false);
});

import { readdirSync } from "node:fs";
import path from "node:path";
import { SAMPLE_PHOTO_IDS, isKnownSamplePhoto } from "./samplePhotos";
import { designError, photoUrlError, safePhotoUrl } from "./resumeSchema";
import { loadDocxPhoto } from "./exportFormats";
import { docxPhotoFromHtml } from "../routes/export";

test("BUG-1300 sample photo allowlist matches the files in frontend public/templates/photos", () => {
  const dir = path.resolve(process.cwd(), "..", "resume-builder-frontend", "public", "templates", "photos");
  const onDisk = readdirSync(dir).filter((f) => f.endsWith(".webp")).map((f) => f.replace(/\.webp$/, "")).sort();
  assert.deepEqual([...SAMPLE_PHOTO_IDS].sort(), onDisk);
});

test("BUG-1300 only real sample photo ids are accepted as photoUrl", () => {
  for (const id of SAMPLE_PHOTO_IDS) assert.equal(safePhotoUrl(`/templates/photos/${id}.webp`), `/templates/photos/${id}.webp`);
  assert.equal(isKnownSamplePhoto("/templates/photos/nope-nothing.webp"), false);
  assert.equal(safePhotoUrl("/templates/photos/nope-nothing.webp"), "");
  const bad = { sections: [{ type: "header", photoUrl: "/templates/photos/nope-nothing.webp" }] };
  assert.ok(photoUrlError(bad));
  assert.equal(photoUrlError({ sections: [{ type: "header", photoUrl: "/templates/photos/steady-form.webp" }] }), null);
});

test("BUG-1301 design pageSize and background are strict enums", () => {
  for (const v of ["Legal", "A3", "x"]) assert.ok(designError({ pageSize: v }), `pageSize ${v}`);
  for (const v of ["A4", "a4", "US Letter", "Letter", "letter"]) assert.equal(designError({ pageSize: v }), null, v);
  assert.ok(designError({ background: "purple" }));
  for (const v of ["white", "soft-gray", "mint", "warm"]) assert.equal(designError({ background: v }), null, v);
  assert.ok(designError({ columnLayout: "triple" }));
  assert.ok(designError({ listColumns: 5 }));
  assert.ok(designError({ accentColor: "red" }));
});

test("BUG-1296 DOCX embeds the header photo (webp sample converted to PNG)", async () => {
  const photo = await loadDocxPhoto("/templates/photos/steady-form.webp", 96, 96);
  assert.ok(photo && photo.data.subarray(1, 4).toString("latin1") === "PNG");
  const withPhoto = await docxFromText("JANE DOE", { pageSize: "A4", photo });
  const without = await docxFromText("JANE DOE", { pageSize: "A4" });
  assert.ok(withPhoto.length > without.length + 1000);
  assert.ok(withPhoto.includes(Buffer.from("word/media/")));
  assert.equal(await loadDocxPhoto("/templates/photos/nope-nothing.webp", 96, 96), null);
  const html = `<div class="rb-photo-slot" style="width:96px;height:96px;border-radius:50%;overflow:hidden">
        <img src="/templates/photos/steady-form.webp" alt="" style="width:100%"/></div>`;
  assert.ok(await docxPhotoFromHtml(html));
  assert.equal(await docxPhotoFromHtml("<div class=\"rb-photo-slot rb-mono\"></div>"), null);
});
