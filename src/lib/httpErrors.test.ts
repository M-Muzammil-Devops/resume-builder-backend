import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { publicError } from "./httpErrors";

test("BUG-1103 validation errors are 400 with a short message", () => {
  const result = z.object({ layoutKey: z.string(), content: z.object({}) }).safeParse({});
  assert.equal(result.success, false);
  if (result.success) return;
  const mapped = publicError(result.error);
  assert.equal(mapped.status, 400);
  assert.equal(mapped.body.error, "Invalid request");
  assert.match(mapped.body.message || "", /layoutKey/);
});

test("BUG-802 Prisma not-found is 404 without internals", () => {
  const err = Object.assign(new Error("Invalid `prisma.landingTemplate.delete()` invocation in\nd:\\Github_Repo\\Resume-Builder\\backend\\src\\routes\\admin.ts:309"), {
    code: "P2025",
    clientVersion: "6.5.0",
  });
  const mapped = publicError(err);
  assert.equal(mapped.status, 404);
  assert.equal(JSON.stringify(mapped.body).includes("admin.ts"), false);
});

test("BUG-1103 Prisma validation and unknown errors never leak text", () => {
  const validation = Object.assign(new Error("Invalid `prisma.resume.create()` invocation: Argument `userId` ... cmh123"), {
    name: "PrismaClientValidationError",
  });
  const v = publicError(validation);
  assert.equal(v.status, 400);
  assert.equal(/prisma|userId|cmh123/i.test(JSON.stringify(v.body)), false);
  const crash = publicError(new Error("ENOENT D:\\secret\\path.ts:1"));
  assert.equal(crash.status, 500);
  assert.equal(/ENOENT|secret|\.ts/.test(JSON.stringify(crash.body)), false);
});

test("Fastify client errors keep their status without paths", () => {
  const err = Object.assign(new Error("Body is not valid JSON but content-type is set to 'application/json'"), { statusCode: 400 });
  const mapped = publicError(err);
  assert.equal(mapped.status, 400);
});
