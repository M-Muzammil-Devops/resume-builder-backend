import test from "node:test";
import assert from "node:assert/strict";
import { consentAction, consentFromCookieHeader, parseConsentValue } from "./consent";

test("parses the rb_consent cookie value", () => {
  assert.deepEqual(parseConsentValue("1.010.Ab3_x9-Qw.1764000000"), {
    version: 1,
    preferences: false,
    analytics: true,
    marketing: false,
    anonId: "Ab3_x9-Qw",
    at: 1764000000,
  });
  assert.equal(parseConsentValue("1.01.Ab3_x9-Qw.1"), null);
  assert.equal(parseConsentValue("garbage"), null);
  assert.equal(parseConsentValue("1.111.short.1"), null);
});

test("reads it from a Cookie header and ignores other versions", () => {
  const rec = consentFromCookieHeader("a=1; rb_consent=1.111.abcdefgh12.1764000000; b=2");
  assert.equal(rec?.analytics, true);
  assert.equal(consentFromCookieHeader("rb_consent=9.111.abcdefgh12.1764000000"), null);
  assert.equal(consentFromCookieHeader(undefined), null);
});

test("labels the consent action", () => {
  assert.equal(consentAction({ preferences: true, analytics: true, marketing: true }), "accept_all");
  assert.equal(consentAction({ preferences: false, analytics: false, marketing: false }), "reject_all");
  assert.equal(consentAction({ preferences: true, analytics: false, marketing: false }), "custom");
});
