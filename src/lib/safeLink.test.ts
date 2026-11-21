import assert from "node:assert/strict";
import test from "node:test";
import { safeHrefValue, safeLinkLabel } from "./safeLink";
import { storedResumeContent } from "./resumeContent";

test("BUG-1102 href fields keep only http(s), mailto and tel", () => {
  assert.equal(safeHrefValue("https://linkedin.com/in/x"), "https://linkedin.com/in/x");
  assert.equal(safeHrefValue("mailto:a@b.co"), "mailto:a@b.co");
  assert.equal(safeHrefValue("tel:+123456789"), "tel:+123456789");
  assert.equal(safeHrefValue("linkedin.com/in/x"), "https://linkedin.com/in/x");
  assert.equal(safeHrefValue("javascript:window.__xl=1"), "");
  assert.equal(safeHrefValue(" java\tscript:alert(1)"), "");
  assert.equal(safeHrefValue("javascript&colon;alert(1)"), "");
  assert.equal(safeHrefValue("data:text/html;base64,xx"), "");
  assert.equal(safeHrefValue("vbscript:msgbox"), "");
  assert.equal(safeHrefValue("file:///etc/passwd"), "");
  assert.equal(safeHrefValue(42), "");
});

test("BUG-1102 link labels drop other schemes but keep plain text", () => {
  assert.equal(safeLinkLabel("javascript:alert(1)"), "");
  assert.equal(safeLinkLabel("linkedin.com/in/x"), "linkedin.com/in/x");
  assert.equal(safeLinkLabel("https://x.dev"), "https://x.dev");
  assert.equal(safeLinkLabel("localhost:3000/me"), "localhost:3000/me");
});

test("BUG-1102 stored resume never keeps a javascript: href", () => {
  const out = storedResumeContent({
    sections: [
      {
        type: "header",
        contact: {
          linkedin: "My profile",
          linkedinHref: "javascript:window.__xl=1",
          extraLink: "",
          extraLinkHref: "javascript:alert(1)",
        },
      },
      { type: "projects", items: [{ name: "P", link: "javascript:alert(1)", url: "data:x" }] },
    ],
  }) as { sections: Array<{ contact?: Record<string, string>; items?: Array<Record<string, string>> }> };
  assert.equal(out.sections[0].contact?.linkedinHref, "");
  assert.equal(out.sections[0].contact?.extraLinkHref, "");
  assert.equal(out.sections[1].items?.[0].link, "");
  // "url" is not a projects field, so BUG-1401 drops it entirely; either way no data: URL survives.
  assert.ok(!out.sections[1].items?.[0].url);
});

test("BUG-400 header link target follows typed URL text", () => {
  const out = storedResumeContent({
    sections: [{ type: "header", contact: { linkedin: "linkedin.com/in/QA-Test", linkedinHref: "https://linkedin.com" } }],
  }) as { sections: Array<{ contact: Record<string, string> }> };
  assert.equal(out.sections[0].contact.linkedinHref, "https://linkedin.com/in/QA-Test");
});
