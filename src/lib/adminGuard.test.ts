import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { adminRoutes } from "../routes/admin";

/**
 * Every route in the admin router must sit under /admin and be rejected before its
 * handler runs when the caller is not authenticated (router-level adminGuard).
 */
test("all admin routes are under /admin and blocked without a session", async () => {
  const app = Fastify();
  const routes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method !== "HEAD") routes.push({ method, url: route.url });
    }
  });
  app.decorate("authenticate", async (_request: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    reply.code(401).send({ error: "Unauthorized" });
  });
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.ready();

  assert.ok(routes.length >= 7, `expected admin routes, got ${routes.length}`);
  for (const route of routes) {
    assert.match(route.url, /^\/admin\//, `${route.method} ${route.url} is outside /admin`);
    const res = await app.inject({ method: route.method as "GET", url: route.url.replace(/:(\w+)/g, "x") });
    assert.equal(res.statusCode, 401, `${route.method} ${route.url} reachable without auth`);
  }
  await app.close();
});