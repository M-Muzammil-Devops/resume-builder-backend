import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { BUILTIN_TEMPLATES, builtinIdOfTemplateId } from "./builtinTemplates";

test("built-in template list matches the frontend catalog", (t) => {
  const file = path.resolve(__dirname, "../../../resume-builder-frontend/src/lib/landingTemplates.ts");
  if (!fs.existsSync(file)) return t.skip("frontend checkout not next to the backend");
  const src = fs.readFileSync(file, "utf8");
  const ids = [...src.matchAll(/^\s{4}id: "([\w-]+)",$/gm)].map((m) => m[1]);
  assert.deepEqual(ids, BUILTIN_TEMPLATES.map((x) => x.id));
  for (const tpl of BUILTIN_TEMPLATES) assert.ok(src.includes(`name: "${tpl.name}"`), tpl.name);
});

test("maps resume template ids", () => {
  assert.equal(BUILTIN_TEMPLATES.length, 12);
  assert.equal(builtinIdOfTemplateId("tmpl-landing-tech-hex"), "tech-hex");
  assert.equal(builtinIdOfTemplateId("tmpl-devops-classic-0"), null);
});
