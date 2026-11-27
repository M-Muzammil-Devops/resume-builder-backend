import { test } from "node:test";
import assert from "node:assert/strict";
import { allowed, permissionFor, roleDefaults, type AdminAccess } from "./adminAccess";
import { peakWindows, pktDayKey, pktDayStart, rangeStart } from "../routes/adminV2";

const member = (role: "ANALYST" | "SUPPORT" | "OPERATIONS" | "SUPER_ADMIN"): AdminAccess => ({
  ...roleDefaults(role),
  source: "team",
  role,
  superAdmin: role === "SUPER_ADMIN",
  memberId: "m1",
});

test("RBAC: reads need canRead, writes canWrite, DELETE canDelete, billing/system/team their own flag", () => {
  assert.deepEqual(permissionFor("GET", "/admin/me"), []);
  assert.deepEqual(permissionFor("GET", "/admin/users"), ["canRead"]);
  assert.deepEqual(permissionFor("PATCH", "/admin/users/:id/status"), ["canRead", "canWrite"]);
  assert.deepEqual(permissionFor("DELETE", "/admin/users/:id"), ["canRead", "canDelete"]);
  assert.deepEqual(permissionFor("GET", "/admin/billing/invoices/:id/pdf"), ["canRead", "canBilling"]);
  assert.deepEqual(permissionFor("GET", "/admin/health"), ["canRead", "canSystem"]);
  assert.deepEqual(permissionFor("POST", "/admin/team/invite"), ["canRead", "superAdmin"]);
  assert.deepEqual(permissionFor("GET", "/rb-api/admin/audit?take=5"), ["canRead", "canSystem"]);

  assert.equal(allowed(member("ANALYST"), permissionFor("GET", "/admin/overview")), null);
  assert.equal(allowed(member("ANALYST"), permissionFor("PATCH", "/admin/users/:id/plan")), "canWrite");
  assert.equal(allowed(member("SUPPORT"), permissionFor("DELETE", "/admin/users/:id")), "canDelete");
  assert.equal(allowed(member("OPERATIONS"), permissionFor("GET", "/admin/billing")), "canBilling");
  assert.equal(allowed(member("OPERATIONS"), permissionFor("POST", "/admin/team/invite")), "superAdmin");
  assert.equal(allowed(member("SUPER_ADMIN"), permissionFor("DELETE", "/admin/team/:id")), null);
});

test("dashboard time helpers use PKT (UTC+5) days and find peak / quiet windows", () => {
  const at = Date.UTC(2026, 10, 27, 20, 30); // 01:30 PKT on Nov 28
  assert.equal(pktDayKey(at), "2026-11-28");
  assert.equal(new Date(pktDayStart(at)).toISOString(), "2026-11-27T19:00:00.000Z");
  assert.equal(rangeStart("7d", at).toISOString(), "2026-11-21T19:00:00.000Z");
  const hours = Array.from({ length: 24 }, (_, h) => (h === 21 || h === 22 ? 50 : h >= 2 && h <= 5 ? 0 : 5));
  const w = peakWindows(hours);
  assert.equal(w.peak.from, 21);
  assert.equal(w.peak.label, "9 PM – 11 PM");
  assert.equal(w.quiet.from, 2);
});
