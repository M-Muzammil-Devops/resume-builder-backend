import assert from "node:assert/strict";
import { test } from "node:test";
import { clearLoginFailures, loginBlocked, recordLoginFailure } from "./loginGuard";

test("BUG-202 lockout follows the account, not a client address", () => {
  const email = `qa-lock-${Date.now()}@example.com`;
  assert.equal(loginBlocked(email), false);
  for (let i = 0; i < 5; i += 1) recordLoginFailure(email);
  assert.equal(loginBlocked(email), true);
  clearLoginFailures(email);
  assert.equal(loginBlocked(email), false);
});
