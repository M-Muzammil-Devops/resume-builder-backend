import test from "node:test";
import assert from "node:assert/strict";
import { sectionLimitDecision } from "./sectionGate";
import { DEFAULT_ADMIN_SETTINGS, adminSettingsSchema, normalizeAdminSettings } from "./appSettings";
import { exportPlanOf } from "./exportSettings";

const header = { type: "header", id: "header", fullName: "Jane", title: "Engineer", contact: { email: "j@x.io" } };
const make = (n: number, emptyLast = false) => ({
  sections: [
    header,
    ...Array.from({ length: n }, (_, i) => ({
      type: i === 0 ? "summary" : "experience",
      id: `s${i}`,
      title: `S${i}`,
      ...(emptyLast && i === n - 1 ? { items: [] } : { content: "filled", items: [{ id: "x", title: "Job" }] }),
    })),
  ],
  leftColumnIds: [],
  rightColumnIds: [],
});
const defaults = DEFAULT_ADMIN_SETTINGS.freeLimits;

test("defaults: limit 4, switched on", () => {
  assert.equal(defaults.maxSectionsForFreePdf, 4);
  assert.equal(defaults.enforceFreeSectionLimit, true);
  assert.deepEqual(normalizeAdminSettings(null).freeLimits.maxSectionsForFreePdf, 4);
});

test("Free user with 4 sections: allowed", () => {
  assert.equal(sectionLimitDecision("free", defaults, make(4)), null);
});

test("Free user with 5 sections incl. an empty one: blocked with SECTION_LIMIT", () => {
  const body = sectionLimitDecision("free", defaults, make(5, true));
  assert.ok(body);
  assert.equal(body.error, "SECTION_LIMIT");
  assert.equal(body.code, "SECTION_LIMIT");
  assert.equal(body.limit, 4);
  assert.equal(body.count, 5);
  assert.match(body.message, /allows up to 4 sections .* has 5 sections\. Upgrade your plan to download\./);
});

test("Header / Personal Info is excluded from the count", () => {
  const four = make(4);
  assert.equal(four.sections.length, 5);
  assert.equal(sectionLimitDecision("free", defaults, four), null);
});

test("Pro and Admin with 6 sections: allowed", () => {
  assert.equal(sectionLimitDecision("pro", defaults, make(6)), null);
  assert.equal(sectionLimitDecision("admin", defaults, make(6)), null);
  assert.equal(exportPlanOf("user", "PRO"), "pro");
  assert.equal(exportPlanOf("admin", "FREE"), "admin");
  assert.equal(exportPlanOf("user", "FREE"), "free");
});

test("Admin changes the limit to 6 or 0, or switches it off: applied at once", () => {
  const six = normalizeAdminSettings({ freeLimits: { maxSectionsForFreePdf: 6 } }).freeLimits;
  assert.equal(sectionLimitDecision("free", six, make(6)), null);
  assert.equal(sectionLimitDecision("free", six, make(7))?.limit, 6);
  const zero = normalizeAdminSettings({ freeLimits: { maxSectionsForFreePdf: 0 } }).freeLimits;
  assert.equal(sectionLimitDecision("free", zero, make(20)), null);
  const off = normalizeAdminSettings({ freeLimits: { enforceFreeSectionLimit: false } }).freeLimits;
  assert.equal(sectionLimitDecision("free", off, make(20)), null);
});

test("settings schema: section limit is a whole number 0-100 and the switch a boolean", () => {
  const base = { ...DEFAULT_ADMIN_SETTINGS, freeLimits: { ...defaults } };
  assert.equal(adminSettingsSchema.safeParse(base).success, true);
  assert.equal(adminSettingsSchema.safeParse({ ...base, freeLimits: { ...defaults, maxSectionsForFreePdf: -1 } }).success, false);
  assert.equal(adminSettingsSchema.safeParse({ ...base, freeLimits: { ...defaults, maxSectionsForFreePdf: 2.5 } }).success, false);
  assert.equal(adminSettingsSchema.safeParse({ ...base, freeLimits: { ...defaults, maxSectionsForFreePdf: 101 } }).success, false);
  assert.equal(adminSettingsSchema.safeParse({ ...base, freeLimits: { ...defaults, enforceFreeSectionLimit: "yes" } }).success, false);
  const bad = normalizeAdminSettings({ freeLimits: { maxSectionsForFreePdf: "x", enforceFreeSectionLimit: 1 } }).freeLimits;
  assert.equal(bad.maxSectionsForFreePdf, 4);
  assert.equal(bad.enforceFreeSectionLimit, true);
});
