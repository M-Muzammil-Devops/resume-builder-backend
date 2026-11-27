import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAdvancedAts, dateFormat, jdKeywords, prettyKeyword, strengthenBullet, strengthenSummary } from "./advanced";
import { canonical, stem, gerundToPast } from "./keywordBank";
import { ruleRewrite, rewriteForAts, usableRewrite } from "./rewrite";
import { DEVOPS_JD, STRONG_RESUME, WEAK_RESUME } from "./advanced.fixture";

test("4 layers have the right maxima and the overall score is exactly their sum (0–100)", () => {
  for (const [content, jd] of [[STRONG_RESUME, DEVOPS_JD], [STRONG_RESUME, ""], [WEAK_RESUME, DEVOPS_JD], [WEAK_RESUME, ""], [{ sections: [] }, ""], [null, ""]] as const) {
    const r = analyzeAdvancedAts(content, { jobDescription: jd });
    assert.deepEqual(r.layers.map((l) => [l.id, l.max]), [["parseability", 25], ["keywords", 35], ["impact", 25], ["boards", 15]]);
    for (const l of r.layers) {
      assert.ok(Number.isInteger(l.score) && l.score >= 0 && l.score <= l.max, `${l.id} ${l.score}`);
    }
    assert.equal(r.score, r.layers.reduce((a, l) => a + l.score, 0));
    assert.ok(r.score >= 0 && r.score <= 100);
    assert.equal(r.version, 2);
  }
});

test("a strong, matching resume scores high; a weak one scores low with high-severity issues", () => {
  const good = analyzeAdvancedAts(STRONG_RESUME, { jobDescription: DEVOPS_JD });
  const bad = analyzeAdvancedAts(WEAK_RESUME, { jobDescription: DEVOPS_JD });
  assert.ok(good.score >= 80, `good ${good.score}`);
  assert.ok(bad.score < 40, `bad ${bad.score}`);
  assert.ok(["Excellent", "Good"].includes(good.grade));
  assert.equal(bad.grade, "Needs work");
  assert.ok(bad.issues.some((i) => i.severity === "high"));
  // Issues are sorted high -> medium -> low and use the documented shape.
  const rank = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < bad.issues.length; i++) assert.ok(rank[bad.issues[i - 1].severity] <= rank[bad.issues[i].severity]);
  for (const i of bad.issues) {
    assert.ok(["parseability", "keywords", "impact", "boards"].includes(i.layer));
    assert.ok(["header", "summary", "experience", "education", "skills", "projects", "general"].includes(i.section));
    assert.equal(typeof i.fixable, "boolean");
    assert.ok(i.id && i.title && i.detail);
    if (i.fixable) assert.ok(i.suggestedFix && i.suggestedFix.length > 5);
  }
});

test("parseability flags headings, contact, dates, empty sections and bullet-less roles", () => {
  const r = analyzeAdvancedAts(WEAK_RESUME, {});
  const ids = r.issues.map((i) => i.id);
  assert.ok(ids.includes("parse-heading-experience"), "non-standard 'My Journey'");
  assert.ok(ids.includes("parse-contact"));
  assert.ok(ids.includes("parse-missing-education"));
  assert.ok(ids.includes("parse-date-missing"));
  assert.ok(ids.some((x) => x.startsWith("parse-empty-")));
  assert.ok(ids.includes("parse-no-bullets-1"));
  assert.equal(dateFormat("Jan 2022"), "Mon YYYY");
  assert.equal(dateFormat("01/2020"), "MM/YYYY");
  assert.equal(dateFormat("Present"), null);
  assert.equal(dateFormat("Spring-ish"), "other");
});

test("JD keywords: required vs nice-to-have, synonyms (K8s ↔ Kubernetes) and CI/CD ≈ DevOps", () => {
  const terms = jdKeywords(DEVOPS_JD);
  const group = (t: string) => terms.find((x) => x.term === t)?.group;
  assert.equal(group("aws"), "required");
  assert.equal(group("kubernetes"), "required", "K8s in the JD is read as Kubernetes");
  assert.equal(group("terraform"), "required");
  assert.equal(group("golang"), "required", "'Go' as a proper noun is a skill");
  assert.equal(group("ansible"), "niceToHave");
  assert.equal(group("datadog"), "niceToHave");
  assert.ok(!terms.some((t) => t.term === "golang") || DEVOPS_JD.includes("Go "));

  const r = analyzeAdvancedAts(STRONG_RESUME, { jobDescription: DEVOPS_JD });
  assert.equal(r.keywords.mode, "jd");
  assert.ok(r.keywords.matched.includes("Kubernetes"));
  assert.ok(r.keywords.matched.includes("AWS"));
  assert.ok(r.keywords.missingNiceToHave.includes("Ansible"));
  assert.ok(r.keywords.missingNiceToHave.includes("Datadog"));
  assert.ok(r.keywords.skillCoverage > 60 && r.keywords.skillCoverage <= 100);

  // Synonym match: resume says ReactJS / JS / K8s, JD says React / JavaScript / Kubernetes.
  const syn = analyzeAdvancedAts(
    { sections: [{ type: "skills", id: "k", title: "Skills", categories: [{ id: "c", name: "", skills: ["ReactJS", "JS", "K8s", "DevOps"] }] }] },
    { jobDescription: "Frontend engineer. Requirements: React, JavaScript, Kubernetes and CI/CD experience. Strong communication skills." }
  );
  const kinds = Object.fromEntries(syn.keywords.matches.map((x) => [x.keyword, x.kind]));
  assert.equal(kinds.React, "synonym");
  assert.equal(kinds.JavaScript, "synonym");
  assert.equal(kinds.Kubernetes, "synonym");
  assert.equal(kinds["CI/CD"], "semantic");
  assert.ok(syn.keywords.semanticMatches.length >= 4);

  // "Go" at the start of a sentence / "go-to-market" is not the Go language.
  assert.ok(!jdKeywords("Go above and beyond for customers. You will own go-to-market for our SaaS product. Requirements: Salesforce").some((t) => t.term === "golang"));
  assert.equal(canonical("k8s"), "kubernetes");
  assert.equal(canonical("ReactJS"), "react");
  assert.equal(prettyKeyword("ci/cd"), "CI/CD");
  assert.equal(stem("managed"), stem("managing"));
});

test("without a JD the role benchmark is used (inferred from the headline or a target role)", () => {
  const r = analyzeAdvancedAts(STRONG_RESUME, {});
  assert.equal(r.keywords.mode, "role");
  assert.equal(r.keywords.benchmark, "DevOps / Cloud Engineer");
  assert.ok(r.keywords.total >= 8);
  const pm = analyzeAdvancedAts(STRONG_RESUME, { targetRole: "Product Manager" });
  assert.equal(pm.keywords.benchmark, "Product Manager");
  assert.ok(pm.layers[1].score < r.layers[1].score, "a DevOps resume matches a PM benchmark less");
});

test("impact layer counts metrics, strong verbs, weak phrases and repeated verbs", () => {
  const good = analyzeAdvancedAts(STRONG_RESUME, {});
  const bad = analyzeAdvancedAts(WEAK_RESUME, {});
  assert.ok(good.layers[2].score >= 22, `good impact ${good.layers[2].score}`);
  assert.ok(bad.layers[2].score <= 8, `bad impact ${bad.layers[2].score}`);
  assert.equal(bad.stats.weakBullets, 3);
  const weak = bad.issues.filter((i) => i.id.startsWith("impact-weak-"));
  assert.equal(weak.length, 3);
  assert.equal(weak[0].fieldPath, "items[0].bullets[0]");
  assert.equal(weak[0].itemIndex, 0);
  assert.equal(weak[0].sectionId, "e");
  assert.equal(weak[0].suggestedFix, "Managed the website, improving [key metric] by [X]%");
  const repeat = analyzeAdvancedAts({ sections: [{ type: "experience", id: "e", title: "Experience", items: [{ id: "1", title: "A", company: "B", startDate: "2020", endDate: "2021", bullets: ["Led 3 teams", "Led 4 launches", "Led 5 hires", "Led 9 audits"] }] }] }, {});
  assert.ok(repeat.issues.some((i) => i.id === "impact-repeat-led"));
});

test("all 5 job-board badges are returned with status, score and reason", () => {
  for (const content of [STRONG_RESUME, WEAK_RESUME]) {
    const r = analyzeAdvancedAts(content, { jobDescription: DEVOPS_JD });
    assert.deepEqual(r.boards.map((b) => b.board), ["indeed", "linkedin", "remoteok", "glassdoor", "monster"]);
    for (const b of r.boards) {
      assert.ok(["pass", "warn", "fail"].includes(b.status));
      assert.ok(b.score >= 0 && b.score <= 100);
      assert.ok(b.reason.length > 10);
      assert.equal(b.status, b.score >= 80 ? "pass" : b.score >= 55 ? "warn" : "fail");
    }
  }
  const good = analyzeAdvancedAts(STRONG_RESUME, { jobDescription: DEVOPS_JD });
  assert.ok(good.boards.every((b) => b.status === "pass"), JSON.stringify(good.boards));
  const bad = analyzeAdvancedAts(WEAK_RESUME, {});
  const by = Object.fromEntries(bad.boards.map((b) => [b.board, b]));
  assert.equal(by.monster.status, "fail", "no phone / email");
  assert.equal(by.glassdoor.status, "fail", "missing company and dates");
  assert.notEqual(by.indeed.status, "pass", "two columns + photo + bad headings");
  assert.notEqual(by.linkedin.status, "pass", "no headline");
  assert.equal(by.remoteok.status, "fail", "no tech stack or links");
  // Keyword stuffing is caught.
  const stuffed = analyzeAdvancedAts(
    { sections: [{ type: "summary", id: "s", title: "Summary", content: Array(12).fill("Python").join(" python ") }] },
    {}
  );
  assert.ok(stuffed.issues.some((i) => i.id === "board-stuffing"));
});

test("plain-text preview is the linear text an ATS extracts (headings, contact, roles, bullets, skills)", () => {
  const r = analyzeAdvancedAts(STRONG_RESUME, {});
  const lines = r.plainTextPreview.split("\n");
  assert.equal(lines[0], "SARA MALIK");
  assert.equal(lines[1], "Senior DevOps Engineer");
  assert.match(lines[2], /^Email: sara@example\.com \| Phone: \+92 300 1234567 \| Location: Lahore, Pakistan \| LinkedIn: linkedin\.com\/in\/sara \| GitHub: github\.com\/sara$/);
  for (const h of ["SUMMARY", "EXPERIENCE", "EDUCATION", "SKILLS"]) assert.ok(lines.includes(h), h);
  assert.ok(lines.includes("Senior DevOps Engineer — Acme Cloud | Remote | Jan 2022 – Present"));
  assert.ok(lines.includes("• Migrated 40 microservices to K8s on EKS with Helm, saving $120k per year"), "HTML stripped");
  assert.ok(lines.includes("Cloud: AWS, Kubernetes, Terraform, Docker, Helm"));
  assert.ok(r.plainTextPreview.indexOf("SUMMARY") < r.plainTextPreview.indexOf("EXPERIENCE"));
  assert.ok(!/<|&nbsp;|data:image/.test(r.plainTextPreview));
});

test("deterministic rewrite: weak phrase -> action verb, metric placeholder, never empty", () => {
  assert.equal(strengthenBullet("Responsible for managing a team of 5 engineers"), "Managed a team of 5 engineers");
  assert.equal(strengthenBullet("Helped with onboarding new customers"), "Onboarded new customers, improving [key metric] by [X]%");
  assert.equal(strengthenBullet("Was responsible for building dashboards."), "Built dashboards, improving [key metric] by [X]%");
  assert.equal(strengthenBullet("Worked on the billing system"), "Delivered the billing system, improving [key metric] by [X]%");
  assert.equal(strengthenBullet("Duties included reconciling accounts"), "Reconciled accounts, improving [key metric] by [X]%");
  assert.equal(gerundToPast("supplying"), "supplied");
  const s = strengthenSummary("I am a hard-working team player with experience in sales.", { keywords: ["Salesforce"] });
  assert.doesNotMatch(s, /hard-working|team player|I am/i);
  assert.match(s, /Skilled in Salesforce\./);
  for (const text of ["x", "   ", "Helped"]) {
    const out = ruleRewrite({ section: "experience", text });
    assert.ok(out.text.trim().length > 0);
  }
  assert.equal(usableRewrite("abc", "As an AI language model I cannot"), null);
  assert.equal(usableRewrite("abc", ""), null);
});

test("rewrite uses AI when it returns clean text, and falls back when AI fails or returns junk", async () => {
  const ai = await rewriteForAts({ section: "experience", text: "Worked on the billing system" }, async () => "Rebuilt the billing system, cutting invoice errors by [X%]");
  assert.equal(ai.source, "ai");
  assert.equal(ai.text, "Rebuilt the billing system, cutting invoice errors by [X%]");
  const junk = await rewriteForAts({ section: "experience", text: "Worked on the billing system" }, async () => "Here is a better version: ...");
  assert.equal(junk.source, "rule");
  const boom = await rewriteForAts({ section: "experience", text: "Worked on the billing system" }, async () => {
    throw new Error("quota");
  });
  assert.equal(boom.source, "rule");
  assert.equal(boom.text, "Delivered the billing system, improving [key metric] by [X]%");
  const sum = await rewriteForAts({ section: "summary", text: "I am a passionate developer.", jobDescription: DEVOPS_JD }, null);
  assert.match(sum.text, /Skilled in /);
  assert.ok(sum.changes.length > 0);
});
