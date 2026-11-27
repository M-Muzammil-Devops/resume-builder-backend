import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  generateLetterBody,
  letterDocx,
  letterFacts,
  letterHtml,
  letterText,
  parseTone,
  stableJson,
  templateLetter,
  usableAiBody,
} from "./coverLetterGen";
import { RESUME_CONTENT } from "./coverLetterGen.fixture";

test("letterFacts reads name, headline, contact, roles, numbered achievements and skills", () => {
  const f = letterFacts(RESUME_CONTENT, "Account Name", "acct@example.com");
  assert.equal(f.name, "Sara Malik");
  assert.equal(f.headline, "Senior DevOps Engineer");
  assert.equal(f.email, "sara@example.com");
  assert.equal(f.roles[0].company, "Acme Cloud");
  assert.match(f.achievements[0], /60%/);
  assert.ok(f.skills.includes("Kubernetes"));
});

test("letterFacts falls back to the account name and email for an empty resume", () => {
  const f = letterFacts({ sections: [] }, "Ali Raza", "ali@example.com");
  assert.equal(f.name, "Ali Raza");
  assert.equal(f.email, "ali@example.com");
  assert.ok(templateLetter(f, { tone: "professional" }).length > 100);
  const none = letterFacts(null);
  assert.ok(templateLetter(none, { tone: "concise" }).startsWith("Dear Hiring Manager,"));
});

test("template letter uses real facts, target company and each tone", () => {
  const f = letterFacts(RESUME_CONTENT);
  const pro = templateLetter(f, { tone: "professional", targetCompany: "Stripe", targetRole: "Platform Engineer", jobDescription: "We need Terraform and AWS" });
  assert.match(pro, /^Dear Stripe Hiring Team,/);
  assert.match(pro, /Platform Engineer role at Stripe/);
  assert.match(pro, /Acme Cloud/);
  assert.match(pro, /60%/);
  assert.match(pro, /Terraform/);
  assert.match(pro, /Sincerely,\nSara Malik$/);
  const concise = templateLetter(f, { tone: "concise" });
  assert.ok(concise.length < pro.length);
  assert.match(concise, /Best regards,/);
  assert.match(templateLetter(f, { tone: "enthusiastic" }), /excited/);
  assert.equal(parseTone("CONCISE"), "concise");
  assert.equal(parseTone("weird"), "professional");
});

test("generation falls back to the template when AI is off, throws or returns junk", async () => {
  const f = letterFacts(RESUME_CONTENT);
  const opts = { tone: "professional" as const };
  assert.equal((await generateLetterBody(f, opts)).source, "template");
  const thrown = await generateLetterBody(f, opts, async () => {
    throw new Error("429 rate limited");
  });
  assert.equal(thrown.source, "template");
  assert.ok(thrown.body.length > 200);
  assert.equal((await generateLetterBody(f, opts, async () => "too short")).source, "template");
  const good = "Dear Hiring Manager,\n\n" + "I bring real results. ".repeat(20) + "\n\nSincerely,\nSara";
  const ai = await generateLetterBody(f, opts, async () => good);
  assert.equal(ai.source, "ai");
  assert.equal(usableAiBody("<b>x</b>"), null);
});

test("letter HTML escapes user text", () => {
  const f = letterFacts(RESUME_CONTENT);
  const html = letterHtml({ title: "T", body: "Dear <script>alert(1)</script>\n\nBye", facts: f, targetCompany: "A&B" });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("A&amp;B Hiring Team"));
  assert.equal(escapeHtml(`"'&`), "&quot;&#39;&amp;");
});

test("DOCX is a real Word file and TXT keeps the letterhead", async () => {
  const f = letterFacts(RESUME_CONTENT);
  const buf = await letterDocx({ title: "Cover", body: "Dear Team,\n\nHello there.\n\nSincerely,\nSara Malik", facts: f, targetRole: "SRE" });
  assert.equal(buf.subarray(0, 2).toString(), "PK");
  const txt = letterText({ title: "Cover", body: "Dear Team,", facts: f });
  assert.match(txt, /^Sara Malik\nSenior DevOps Engineer/);
});

test("stableJson ignores key order", () => {
  assert.equal(stableJson({ b: 1, a: [{ y: 2, x: 1 }] }), stableJson({ a: [{ x: 1, y: 2 }], b: 1 }));
  assert.notEqual(stableJson({ a: 1 }), stableJson({ a: 2 }));
});

test("values with trailing dots and piped headlines read cleanly", () => {
  const f = letterFacts({
    sections: [
      { type: "header", id: "h", fullName: "Maya Collins.", title: "Senior Product Manager | Strategy | B2B SaaS.", contact: {} },
      { type: "summary", id: "s", title: "S", content: "Led products for 20K+ customers.." },
      { type: "skills", id: "k", title: "K", categories: [{ id: "c", name: "x", skills: ["Roadmapping.", "OKRs."] }] },
    ],
  });
  const body = templateLetter(f, { tone: "professional" });
  assert.match(body, /the Senior Product Manager role\./);
  assert.match(body, /Roadmapping and OKRs,/);
  assert.ok(!/\.\./.test(body), body);
  assert.match(body, /Sincerely,\nMaya Collins$/);
});

test("a resume with no usable facts still gets a complete letter (no invented details)", () => {
  const facts = letterFacts({ sections: [] }, "Ayesha Khan", "ayesha@example.com");
  for (const tone of ["professional", "concise", "enthusiastic"] as const) {
    const body = templateLetter(facts, { tone, targetRole: "Platform Engineer", targetCompany: "Stripe", jobDescription: "We need Kubernetes, Terraform and observability skills." });
    assert.ok(body.split(/\n\n/).length >= 4, `${tone}: has paragraphs`);
    assert.match(body, /^Dear Stripe Hiring Team,/);
    assert.match(body, /Platform Engineer role at Stripe/);
    assert.match(body, /Ayesha Khan$/);
    assert.doesNotMatch(body, /\d+%/, "no invented numbers");
  }
});
