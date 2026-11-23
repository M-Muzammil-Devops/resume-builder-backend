import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMagicCode, hashMagicCode, magicCodeMatches, normalizeMagicCode } from "./magicCode";
import { __clearEphemeralForTests, ephGet, ephIncr, ephSet, ephTake } from "./ephemeral";
import { magicCodeEmail } from "./emailTemplates";

test("magic code: always 6 digits", () => {
  for (let i = 0; i < 200; i++) assert.match(generateMagicCode(), /^\d{6}$/);
});

test("magic code: stored as an HMAC bound to the email; compare is exact", () => {
  const h = hashMagicCode("secret", "a@b.com", "012345");
  assert.notEqual(h, "012345");
  assert.equal(magicCodeMatches("secret", "a@b.com", "012345", h), true);
  assert.equal(magicCodeMatches("secret", "A@B.com", "012345", h), true);
  assert.equal(magicCodeMatches("secret", "c@b.com", "012345", h), false);
  assert.equal(magicCodeMatches("secret", "a@b.com", "012346", h), false);
  assert.equal(magicCodeMatches("other", "a@b.com", "012345", h), false);
  assert.equal(magicCodeMatches("secret", "a@b.com", "12345", h), false);
});

test("magic code: typed input keeps only digits", () => {
  assert.equal(normalizeMagicCode(" 12 34-56 "), "123456");
  assert.equal(normalizeMagicCode("1234567"), "123456");
});

test("ephemeral store (memory fallback): take is single use, counters count", async () => {
  __clearEphemeralForTests();
  await ephSet("k", { a: 1 }, 60);
  assert.deepEqual(await ephGet("k"), { a: 1 });
  assert.deepEqual(await ephTake("k"), { a: 1 });
  assert.equal(await ephTake("k"), null);
  assert.equal(await ephIncr("c", 60), 1);
  assert.equal(await ephIncr("c", 60), 2);
});

test("magic code email: code in subject, text and HTML; no links", () => {
  const mail = magicCodeEmail("482913", { minutes: 10 });
  assert.match(mail.subject, /482913/);
  assert.match(mail.text, /482913/);
  assert.match(mail.text, /10 minutes/);
  assert.match(mail.html, />4</);
  assert.doesNotMatch(mail.html, /href="http/);
});
