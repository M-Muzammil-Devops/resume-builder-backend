import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EXPORT_SETTINGS, exportLimitFor, normalizeExportSettings, startOfUtcMonth } from "./exportSettings";

test("stored export settings merge over the defaults", () => {
  assert.deepEqual(normalizeExportSettings(null), DEFAULT_EXPORT_SETTINGS);
  const s = normalizeExportSettings({ watermarkFree: true, maxExports: { free: 5 } });
  assert.equal(s.watermarkFree, true);
  assert.deepEqual(s.maxExports, { free: 5, pro: 0 });
  assert.equal(s.defaultPageSize, "A4");
  // Invalid values never break exports.
  assert.deepEqual(normalizeExportSettings({ marginMm: 999 }), DEFAULT_EXPORT_SETTINGS);
});

test("export limits per plan", () => {
  const s = normalizeExportSettings({ maxExports: { free: 3, pro: 50 } });
  assert.equal(exportLimitFor(s, "user"), 3);
  assert.equal(exportLimitFor(s, "pro"), 50);
  assert.equal(exportLimitFor(s, "admin"), 0);
  assert.equal(startOfUtcMonth(new Date("2026-11-24T10:00:00Z")).toISOString(), "2026-11-01T00:00:00.000Z");
});
