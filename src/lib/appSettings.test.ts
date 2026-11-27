import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ADMIN_SETTINGS, adminSettingsSchema, normalizeAdminSettings } from "./appSettings";

test("admin settings: defaults when nothing is stored", () => {
  assert.deepEqual(normalizeAdminSettings(null), DEFAULT_ADMIN_SETTINGS);
  assert.equal(DEFAULT_ADMIN_SETTINGS.siteName, "ResumeBuilder");
  assert.equal(DEFAULT_ADMIN_SETTINGS.freeLimits.pdfExportsPerMonth, 5);
  assert.equal(DEFAULT_ADMIN_SETTINGS.registrationOpen, true);
  assert.equal(DEFAULT_ADMIN_SETTINGS.maintenance.enabled, false);
});

test("admin settings: bad stored fields fall back one by one", () => {
  const v = normalizeAdminSettings({ siteName: "", supportEmail: "nope", registrationOpen: false, freeLimits: { maxResumes: -1, audioMinutesPerMonth: 30 } });
  assert.equal(v.siteName, "ResumeBuilder");
  assert.equal(v.supportEmail, "");
  assert.equal(v.registrationOpen, false);
  assert.equal(v.freeLimits.maxResumes, 5);
  assert.equal(v.freeLimits.audioMinutesPerMonth, 30);
});

test("admin settings: live export values win for PDF limit and watermark", () => {
  const v = normalizeAdminSettings({ freeLimits: { pdfExportsPerMonth: 9, watermark: true } }, { pdfExportsPerMonth: 0, watermark: false });
  assert.equal(v.freeLimits.pdfExportsPerMonth, 0);
  assert.equal(v.freeLimits.watermark, false);
});

test("admin settings: schema rejects a bad support email", () => {
  assert.equal(adminSettingsSchema.safeParse({ ...DEFAULT_ADMIN_SETTINGS, supportEmail: "x@" }).success, false);
  assert.equal(adminSettingsSchema.safeParse({ ...DEFAULT_ADMIN_SETTINGS, supportEmail: "help@example.com" }).success, true);
});
