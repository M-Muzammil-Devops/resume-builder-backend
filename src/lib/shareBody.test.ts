import assert from "node:assert/strict";
import test from "node:test";
import { parseShareBody } from "../routes/resumes";

test("invalid share expiry is a 400-style message, not a crash", () => {
  for (const expiresInDays of [-1, 0, "abc", 100000]) {
    const parsed = parseShareBody({ enabled: true, expiresInDays });
    assert.equal("error" in parsed, true);
  }
  assert.deepEqual(parseShareBody({ enabled: true, expiresInDays: 7 }), {
    enabled: true,
    expiresInDays: 7,
  });
  assert.deepEqual(parseShareBody({ enabled: true, expiresInDays: null }), {
    enabled: true,
    expiresInDays: null,
  });
});
