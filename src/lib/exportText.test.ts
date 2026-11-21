import assert from "node:assert/strict";
import test from "node:test";
import { htmlToPlain, resumeToHtml } from "../routes/export";

test("BUG-1104 TXT export separates contact fields", () => {
  const html = resumeToHtml(
    {
      sections: [
        {
          id: "header",
          type: "header",
          fullName: "Jane",
          settings: {},
          contact: { phone: "+1-(234)-555-1234", email: "hello@email.com", linkedin: "linkedin.com", location: "City, Country" },
        },
      ],
      leftColumnIds: [],
      rightColumnIds: [],
    },
    {},
    "Resume"
  );
  const text = htmlToPlain(html);
  assert.match(text, /\+1-\(234\)-555-1234 \| hello@email\.com \| linkedin\.com \| City, Country/);
});
