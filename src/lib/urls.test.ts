import assert from "node:assert/strict";
import { test } from "node:test";
import { joinUrl, originOf, stripTrailingSlash, weakSecretReason } from "./urls";

test("trailing slashes never produce double slashes", () => {
  assert.equal(stripTrailingSlash("https://x.example.com/"), "https://x.example.com");
  assert.equal(stripTrailingSlash("https://x.example.com///"), "https://x.example.com");
  assert.equal(joinUrl("https://x.example.com/", "/verify-email"), "https://x.example.com/verify-email");
  assert.equal(joinUrl("https://x.example.com/rb-api/", "/uploads/", "a.png"), "https://x.example.com/rb-api/uploads/a.png");
  assert.equal(originOf("https://x.example.com/some/path/"), "https://x.example.com");
});

test("weak JWT secrets are rejected", () => {
  assert.equal(weakSecretReason(undefined), "is missing");
  assert.equal(weakSecretReason("change-me-to-a-long-random-string"), "is a placeholder value");
  assert.equal(weakSecretReason("dev-secret-change-me"), "is a placeholder value");
  assert.equal(weakSecretReason("short-but-random-123"), "is shorter than 32 characters");
  assert.equal(weakSecretReason("a".repeat(16) + "Zx9!kP2qLm7vB4nR8tY1"), null);
});
