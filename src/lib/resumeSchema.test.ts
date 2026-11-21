import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateHost, oversizedField, pruneResumeContent, safeImageUrl } from "./resumeSchema";
import { storedResumeContent } from "./resumeContent";
import { tooLongError } from "../routes/resumes";
import { authEmail, mailErrorMeta } from "./emailTemplates";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString("base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]).toString("base64");

test("BUG-1401 photoUrl keeps real raster images and the app's own uploads", () => {
  assert.equal(safeImageUrl(`data:image/png;base64,${PNG}`), `data:image/png;base64,${PNG}`);
  assert.equal(safeImageUrl(`data:image/jpeg;base64,${JPEG}`), `data:image/jpeg;base64,${JPEG}`);
  assert.equal(safeImageUrl("/uploads/previews/a_b.png"), "/uploads/previews/a_b.png");
  assert.equal(safeImageUrl("https://cdn.example.com/me.webp"), "https://cdn.example.com/me.webp");
  assert.equal(safeImageUrl(""), "");
});

test("BUG-1401 photoUrl rejects script, SVG, disguised HTML and private hosts", () => {
  const svg = Buffer.from('<svg onload="alert(1)"><script>alert(1)</script></svg>').toString("base64");
  const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
  for (const bad of [
    "javascript:alert(1)",
    `data:image/svg+xml;base64,${svg}`,
    `data:image/png;base64,${html}`,
    `data:image/png;base64,${svg}`,
    `data:image/jpeg;base64,${PNG}`,
    "data:text/html,<script>alert(1)</script>",
    "http://127.0.0.1:3000/x.png",
    "https://127.0.0.1/x.png",
    "https://localhost/x.png",
    "https://10.0.0.5/x.png",
    "https://192.168.1.1/x.png",
    "https://169.254.169.254/latest",
    "https://[::1]/x.png",
    "https://intranet/x.png",
    "https://example.com/x.svg",
    "http://example.com/x.png",
    "/uploads/../.env",
    "//evil.com/x.png",
  ]) {
    assert.equal(safeImageUrl(bad), "", bad);
  }
  assert.equal(isPrivateHost("172.20.0.1"), true);
  assert.equal(isPrivateHost("example.com"), false);
});

test("BUG-1401 unknown keys are dropped, known ones kept", () => {
  const out = pruneResumeContent({
    sections: [
      {
        id: "h", type: "header", title: "", fullName: "A", photoUrl: "", photo: "x", image: "y", avatar: "z",
        contact: { email: "a@b.co", evil: "1" }, settings: { photo: true, onload: "x" },
      },
      { id: "e", type: "experience", title: "Experience", items: [{ id: "1", title: "Dev", bullets: ["a"], extra: 1, projects: [{ id: "p", name: "n", description: "d", x: 1 }] }] },
      { id: "s", type: "skills", title: "Skills", categories: [{ id: "c", name: "n", skills: ["k"], bad: 1 }] },
    ],
    leftColumnIds: ["h"],
    rightColumnIds: [],
    injected: true,
  }) as { sections: Record<string, unknown>[]; injected?: unknown };
  assert.equal(out.injected, undefined);
  const [header, exp, skills] = out.sections;
  assert.deepEqual(Object.keys(header).sort(), ["contact", "fullName", "id", "photoUrl", "settings", "title", "type"]);
  assert.deepEqual(header.contact, { email: "a@b.co" });
  assert.deepEqual(header.settings, { photo: true });
  const item = (exp.items as Record<string, unknown>[])[0];
  assert.equal(item.extra, undefined);
  assert.deepEqual(item.projects, [{ id: "p", name: "n", description: "d" }]);
  assert.deepEqual(skills.categories, [{ id: "c", name: "n", skills: ["k"] }]);
});

test("BUG-1401 a stored photo is not truncated and a bad one is blanked", () => {
  const big = `data:image/png;base64,${PNG}${"A".repeat(5000)}`;
  const kept = storedResumeContent({ sections: [{ id: "h", type: "header", title: "", fullName: "A", contact: {}, photoUrl: big }] }) as { sections: { photoUrl: string }[] };
  assert.equal(kept.sections[0].photoUrl.length, big.length);
  const blank = storedResumeContent({ sections: [{ id: "h", type: "header", title: "", fullName: "A", contact: {}, photoUrl: "javascript:alert(1)" }] }) as { sections: { photoUrl: string }[] };
  assert.equal(blank.sections[0].photoUrl, "");
});

test("BUG-1402 an over-long field is reported with its path", () => {
  assert.equal(oversizedField({ sections: [{ fullName: "x".repeat(300_000) }] }), "content.sections[0].fullName");
  assert.equal(oversizedField({ sections: [{ fullName: "ok", photoUrl: "x".repeat(50_000) }] }), null);
  assert.match(tooLongError({ content: { sections: [{ fullName: "x".repeat(10_001) }] } }) || "", /too long/);
  assert.equal(tooLongError({ content: { sections: [{ fullName: "x".repeat(10_000) }] } }), null);
});

test("BUG-1408 auth emails have HTML, text, footer and an ignore line; links are escaped", () => {
  const mail = authEmail({
    subject: "S", heading: "H", intro: "I", buttonLabel: "B", link: "https://x.test/verify-email?token=a&b=<c>",
    expiry: "E", ignoreLine: "If this wasn't you, ignore this email.",
  });
  assert.match(mail.html, /<a href="https:\/\/x\.test\/verify-email\?token=a&amp;b=&lt;c&gt;"/);
  assert.match(mail.text, /https:\/\/x\.test\/verify-email\?token=a&b=<c>/);
  assert.match(mail.html, /ignore this email/);
  assert.match(mail.text, /ResumeBuilder/);
  assert.doesNotMatch(mail.html, /<script/i);
});

test("mail errors log only code and responseCode", () => {
  const meta = mailErrorMeta({ code: "EAUTH", responseCode: 535, message: "secret banner", response: "535 creds" });
  assert.deepEqual(meta, { code: "EAUTH", responseCode: 535 });
});
test("BUG-1402 an over-long header field is a 400 with its path, not truncated", async () => {
  const { oversizedHeaderField } = await import("./resumeSchema");
  const content = { sections: [{ type: "header", fullName: "A", title: "x", contact: { phone: "1".repeat(51), email: "a@b.co" } }] };
  assert.deepEqual(oversizedHeaderField(content), { path: "content.sections[0].contact.phone", max: 50 });
  content.sections[0].contact.phone = "123";
  content.sections[0].fullName = "N".repeat(201);
  assert.deepEqual(oversizedHeaderField(content), { path: "content.sections[0].fullName", max: 200 });
  content.sections[0].fullName = "Jane";
  assert.equal(oversizedHeaderField(content), null);
});

test("BUG-027 template sample text is blanked for export, real values stay", async () => {
  const { scrubSampleText } = await import("./sampleText");
  const out = scrubSampleText({ sections: [{ type: "projects", items: [{ id: "p1", name: "Flagship Project", description: "Real work I did" }, { name: "Bachelor of Science" }] }] }) as { sections: Array<{ type: string; items: Array<Record<string, string>> }> };
  assert.equal(out.sections[0].type, "projects");
  assert.equal(out.sections[0].items[0].name, "");
  assert.equal(out.sections[0].items[0].id, "p1");
  assert.equal(out.sections[0].items[0].description, "Real work I did");
  assert.equal(out.sections[0].items[1].name, "Bachelor of Science");
});
