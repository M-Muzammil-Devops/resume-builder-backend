import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { CONTACT_LIMIT_PER_HOUR, checkContact, contactClientIp, contactRoutes, isBot } from "./contact";

type Sent = { to: string; subject: string; text: string; html?: string };

async function build(sent: Sent[], opts: { configured?: boolean; fail?: boolean } = {}) {
  const app = Fastify();
  await app.register(contactRoutes, {
    send: async (m: Sent) => {
      if (opts.fail) throw new Error("smtp down");
      sent.push(m);
      return { delivered: true };
    },
    configured: () => opts.configured ?? true,
    to: () => "owner@example.com",
  });
  return app;
}

const good = { name: "Ayesha Khan", email: "ayesha@example.com", message: "Hello, I have a question about PDF export." };

test("checkContact validates name, email and message", () => {
  assert.equal(checkContact(good).ok, true);
  assert.deepEqual(checkContact({ ...good, name: " " }), { ok: false, field: "name", message: "Please enter your name." });
  assert.equal((checkContact({ ...good, email: "nope" }) as { field: string }).field, "email");
  assert.equal((checkContact({ ...good, message: "short" }) as { field: string }).field, "message");
  assert.equal(checkContact(null).ok, false);
  const r = checkContact({ ...good, name: "Eve\r\nBcc: x@y.z" });
  assert.ok(r.ok && !/[\r\n]/.test(r.value.name), "CR/LF stripped from single-line fields");
});

test("honeypot and client IP helpers", () => {
  assert.equal(isBot({ ...good, website: "http://spam" }), true);
  assert.equal(isBot({ ...good, website: "" }), false);
  assert.equal(contactClientIp({ ip: "127.0.0.1", headers: { "x-real-ip": "203.0.113.9" } }), "203.0.113.9");
  // X-Real-IP from a non-loopback peer is ignored (cannot be spoofed past nginx).
  assert.equal(contactClientIp({ ip: "198.51.100.1", headers: { "x-real-ip": "203.0.113.9" } }), "198.51.100.1");
});

test("POST /contact emails ADMIN_EMAIL and escapes HTML", async () => {
  const sent: Sent[] = [];
  const app = await build(sent);
  const res = await app.inject({ method: "POST", url: "/contact", headers: { "x-real-ip": "10.0.0.1" }, payload: { ...good, message: "<script>alert(1)</script> please help" } });
  assert.equal(res.statusCode, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "owner@example.com");
  assert.match(sent[0].text, /ayesha@example.com/);
  assert.ok(!sent[0].html!.includes("<script>"));
  await app.close();
});

test("POST /contact: honeypot sends nothing, bad input is 400, SMTP off is 503, SMTP error is 502", async () => {
  const sent: Sent[] = [];
  const app = await build(sent);
  const bot = await app.inject({ method: "POST", url: "/contact", headers: { "x-real-ip": "10.0.0.2" }, payload: { ...good, website: "x" } });
  assert.equal(bot.statusCode, 202);
  assert.equal(sent.length, 0);
  const bad = await app.inject({ method: "POST", url: "/contact", headers: { "x-real-ip": "10.0.0.2" }, payload: { ...good, email: "bad" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().field, "email");
  await app.close();
  const off = await build(sent, { configured: false });
  assert.equal((await off.inject({ method: "POST", url: "/contact", headers: { "x-real-ip": "10.0.0.3" }, payload: good })).statusCode, 503);
  await off.close();
  const down = await build(sent, { fail: true });
  assert.equal((await down.inject({ method: "POST", url: "/contact", headers: { "x-real-ip": "10.0.0.4" }, payload: good })).statusCode, 502);
  await down.close();
});

test(`POST /contact is limited to ${CONTACT_LIMIT_PER_HOUR} per hour per IP`, async () => {
  const sent: Sent[] = [];
  const app = await build(sent);
  for (let i = 0; i < CONTACT_LIMIT_PER_HOUR; i++) {
    const r = await app.inject({ method: "POST", url: "/contact", headers: { "x-real-ip": "10.9.9.9" }, payload: good });
    assert.equal(r.statusCode, 202);
  }
  const blocked = await app.inject({ method: "POST", url: "/contact", headers: { "x-real-ip": "10.9.9.9" }, payload: good });
  assert.equal(blocked.statusCode, 429);
  const other = await app.inject({ method: "POST", url: "/contact", headers: { "x-real-ip": "10.9.9.10" }, payload: good });
  assert.equal(other.statusCode, 202);
  await app.close();
});
