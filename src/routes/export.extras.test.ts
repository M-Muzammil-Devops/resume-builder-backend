import test from "node:test";
import assert from "node:assert/strict";
import { marginScale, pdfExtrasFor } from "./export";
import { normalizeExportSettings } from "../lib/exportSettings";

test("watermark only for free accounts when enabled", () => {
  const on = normalizeExportSettings({ watermarkFree: true });
  assert.equal(pdfExtrasFor(on, "user").watermark, "Made with ResumeBuilder");
  assert.equal(pdfExtrasFor(on, "admin").watermark, null);
  assert.equal(pdfExtrasFor(normalizeExportSettings({}), "user").watermark, null);
});

test("extra margin scales the page to fit", () => {
  assert.equal(marginScale("A4", 0), 1);
  assert.equal(marginScale("A4", 10), (210 - 20) / 210);
  assert.ok(marginScale("US Letter", 30) < 1);
});
