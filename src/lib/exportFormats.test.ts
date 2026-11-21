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
