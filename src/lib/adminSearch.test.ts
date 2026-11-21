import assert from "node:assert/strict";
import test from "node:test";
import { adminUserWhere } from "./adminSearch";

test("BUG-800 admin user search filters by email or name", () => {
  assert.deepEqual(adminUserWhere(undefined), { role: "user" });
  assert.deepEqual(adminUserWhere("   "), { role: "user" });
  const where = adminUserWhere(" qa-p8a ") as unknown as { OR: Array<Record<string, { contains: string; mode: string }>> };
  assert.equal(where.OR[0].email.contains, "qa-p8a");
  assert.equal(where.OR[0].email.mode, "insensitive");
  assert.equal(where.OR[1].name.contains, "qa-p8a");
});
