import test from "node:test";
import assert from "node:assert/strict";
import { activityWhere, csvCell, parseDateBound, toCsv } from "./activity";
import { isPrivateIp } from "./geoip";

test("csv cells are quoted and formula-safe", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell(null), "");
  assert.equal(toCsv(["a", "b"], [[1, "x"]]), "a,b\r\n1,x\r\n");
});

test("date bounds and filters", () => {
  assert.equal(parseDateBound("2026-11-24", true)?.toISOString(), "2026-11-24T23:59:59.999Z");
  assert.equal(parseDateBound("2026-11-24", false)?.toISOString(), "2026-11-24T00:00:00.000Z");
  assert.equal(parseDateBound("nope", false), undefined);
  const w = activityWhere({ country: "Unknown", device: "mobile", search: "ali" });
  assert.equal(w.country, null);
  assert.equal(w.device, "mobile");
  assert.equal(Array.isArray(w.OR), true);
});

test("private addresses are never geolocated", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "172.20.1.1", "::1", "fd00::1", "100.64.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("2001:4860:4860::8888"), false);
});
