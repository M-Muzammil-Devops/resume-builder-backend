import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeHtml, sanitizeValue } from "./sanitizeHtml";

test("strips event handlers and disallowed tags", () => {
  const img = sanitizeHtml('<img src=x onerror=window.__x7=1>');
  const svg = sanitizeHtml('<svg onload=window.__x8=1></svg>');
  assert.equal(img.includes("onerror"), false);
  assert.equal(img.includes("<img"), false);
  assert.equal(svg.includes("onload"), false);
  assert.equal(svg.includes("<svg"), false);
});

test("keeps safe formatting and http links only", () => {
  assert.equal(sanitizeHtml("<b>bold</b> <i>x</i>"), "<b>bold</b> <i>x</i>");
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
  assert.equal(
    sanitizeHtml('<a href="https://example.com/in/me">me</a>'),
    '<a href="https://example.com/in/me">me</a>'
  );
});

test("trims a trailing br from edited text", () => {
  assert.equal(sanitizeHtml("QA restored.<br>"), "QA restored.");
});

test("walks nested resume content", () => {
  const clean = sanitizeValue({
    sections: [{ contact: { fullName: '<img src=x onerror=alert(1)>' } }],
  }) as { sections: Array<{ contact: { fullName: string } }> };
  assert.equal(clean.sections[0].contact.fullName.includes("onerror"), false);
});


const XSS_CASES = [
  "<img src=x onerror=window.__x7=1>",
  "<svg onload=window.__x8=1>",
  "<svg><script>window.__x9=1</script></svg>",
  "<img src=x onerror=window.__x7=1",
  "<img src=x onerror=window.__x7=1//",
  '<b title=">" onmouseover="window.__x7=1">x</b>',
  '<a href="java&#x0A;script:alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  "<a href=' javascript:alert(1)'>x</a>",
  '<a href="https://ok.example/x" onclick="window.__x7=1">x</a>',
  "<!--<img src=x onerror=window.__x7=1>",
  "<iframe srcdoc='<script>window.__x7=1</script>'></iframe>",
  "<<img src=x onerror=window.__x7=1>>",
  "<math><mi xlink:href=javascript:alert(1)>x</mi></math>",
];

test("BUG-402 sanitised output never contains a live tag other than the allow-list", () => {
  for (const input of XSS_CASES) {
    const out = sanitizeHtml(input);
    const tags = out.match(/<[a-zA-Z/!?][^>]*>/g) || [];
    for (const tag of tags) {
      assert.match(tag, /^<\/?(b|i|u|br|ul|ol|li|a)>$|^<a href="(https?:|mailto:)[^"]*">$/, `${input} -> ${out}`);
    }
    assert.equal(/on\w+\s*=/i.test(out.replace(/&lt;[^&]*/g, "")), false, `${input} -> ${out}`);
    // An unterminated tag followed by more markup must stay inert text.
    const joined = sanitizeHtml(input + "<b>after</b>");
    assert.equal(/<(img|svg|script|iframe|math)/i.test(joined), false, `${input} -> ${joined}`);
  }
});

test("BUG-402 plain comparisons stay as typed; broken tags are escaped", () => {
  assert.equal(sanitizeHtml("a < b and c > d"), "a < b and c > d");
  assert.equal(sanitizeHtml("<img src=x onerror=1"), "&lt;img src=x onerror=1");
});
