import assert from "node:assert/strict";
import test from "node:test";
import { redactPublicContent } from "./publicResume";

test("public payload drops hidden contact fields and empty values", () => {
  const out = redactPublicContent({
    sections: [
      {
        type: "header",
        settings: {
          phone: false,
          email: true,
          dateOfBirth: false,
          nationality: false,
          extraField: false,
          extraLink: false,
        },
        contact: {
          fullName: "Ayesha",
          phone: "+1 555",
          email: "",
          dateOfBirth: "1990-05-05",
          nationality: "QA-Testland",
          extraField: "hidden extra",
          extraLink: "https://secret.example",
          extraLinkHref: "https://secret.example",
        },
      },
    ],
  });
  const contact = out.sections[0].contact as Record<string, string>;
  assert.equal(contact.fullName, "Ayesha");
  assert.equal("phone" in contact, false);
  assert.equal("email" in contact, false);
  assert.equal("dateOfBirth" in contact, false);
  assert.equal("nationality" in contact, false);
  assert.equal("extraField" in contact, false);
  assert.equal("extraLink" in contact, false);
});
