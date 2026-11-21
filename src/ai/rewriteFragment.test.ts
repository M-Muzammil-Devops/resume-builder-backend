import assert from "node:assert/strict";
import test from "node:test";
import { rewriteFragment } from "./improveEngine";

test("grammar fixes agreement and teh", () => {
  const out = rewriteFragment("We builds the API for teh team", "grammar");
  assert.match(out, /We build/);
  assert.match(out, /the team/);
  assert.equal(out.includes("teh"), false);
  assert.equal(out.includes("builds"), false);
});

test("longer does not invent a measured number", () => {
  const out = rewriteFragment("Shipped the release on time", "longer");
  assert.equal(/\d/.test(out), false);
  assert.equal(/with a measured/i.test(out), false);
});

test("improve fixes typos and keeps acronyms", () => {
  const out = rewriteFragment("We builds teh team for QA", "improve");
  assert.equal(/^delivered\b/i.test(out), false);
  assert.match(out, /We build/);
  assert.match(out, /the team/);
  assert.match(out, /\bQA\b/);
  assert.equal(out.includes("teh"), false);
  assert.equal(out.includes("qA"), false);
  assert.match(out, /[.!?]$/);
});

test("shorter keeps acronyms and a whole sentence", () => {
  const out = rewriteFragment("QA lead with nine years of experience in test automation.", "shorter");
  assert.match(out, /QA/);
  assert.equal(out.includes("qA"), false);
  assert.match(out, /[.!?]$/);
});

test("retry variant differs from the first rewrite", () => {
  const first = rewriteFragment("Shipped the release on time", "longer", 0);
  const retry = rewriteFragment("Shipped the release on time", "longer", 1);
  assert.notEqual(first, retry);
});
