import assert from "node:assert/strict";
import test from "node:test";
import { cleanResumeValue } from "./resumeContent";

test("BUG-1240 values the user types are stored even if they match sample text", () => {
  const clean = cleanResumeValue({
    school: "University Name",
    contact: { email: "hello@email.com" },
    items: [{ company: "Company Name" }],
  }) as { school: string; contact: { email: string }; items: Array<{ company: string }> };
  assert.equal(clean.school, "University Name");
  assert.equal(clean.contact.email, "hello@email.com");
  assert.equal(clean.items[0].company, "Company Name");
});

test("summary content is capped", () => {
  const clean = cleanResumeValue({ content: "a".repeat(28000) }) as { content: string };
  assert.equal(clean.content.length, 2000);
});
