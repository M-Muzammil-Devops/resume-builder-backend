import assert from "node:assert/strict";
import test from "node:test";
import { cleanTitle, coverLetterCreate, coverLetterUpdate, letterFileName } from "./coverLetterInput";

test("BUG-315 cover letter input strips markup and caps length", () => {
  const parsed = coverLetterCreate.parse({ title: "<b>Hello</b>", body: "<script>x</script>Dear team" });
  assert.equal(parsed.title, "Hello");
  assert.equal(parsed.body, "xDear team");
  assert.equal(cleanTitle("   "), "Untitled Cover Letter");
  assert.equal(coverLetterUpdate.safeParse({}).success, false);
  assert.equal(letterFileName("Cover / Letter: ACME"), "Cover Letter ACME");
});
