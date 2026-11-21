import assert from "node:assert/strict";
import { test } from "node:test";
import { passwordError } from "./passwordPolicy";

test("BUG-201 / BUG-080 rejects weak passwords", () => {
  for (const weak of ["123456", "aaaaaa", "password", "abcdef"]) {
    assert.ok(passwordError(weak), weak);
  }
});

test("accepts a mixed password", () => {
  assert.equal(passwordError("BlueRiver92"), null);
});
