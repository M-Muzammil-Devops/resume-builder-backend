import assert from "node:assert/strict";
import test from "node:test";
import { isPremiumTemplate, planSaveError } from "./planAccess";
import { generateTemplates } from "../shared/templates";

test("premium catalog ids are rejected for a free user", () => {
  const premium = generateTemplates().find((t) => t.isPremium);
  assert.ok(premium);
  assert.equal(isPremiumTemplate(premium.id), true);
  assert.equal(
    planSaveError("user", { sections: [] }, { templateId: premium.id }),
    "This template is on the Pro plan."
  );
  assert.equal(planSaveError("admin", { sections: [] }, { templateId: premium.id }), null);
});

test("a free user cannot add a Custom Title section", () => {
  assert.equal(
    planSaveError("user", { sections: [] }, { content: { sections: [{ type: "custom" }] } }),
    "Custom Title is a Pro section."
  );
  assert.equal(
    planSaveError("user", { sections: [{ type: "custom" }] }, { content: { sections: [{ type: "custom" }] } }),
    null
  );
});
