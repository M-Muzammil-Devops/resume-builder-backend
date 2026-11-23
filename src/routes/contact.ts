import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../config/env";
import { hitLimit } from "../lib/loginGuard";
import { mailConfigured, sendMail } from "../lib/mailer";

/** Public contact form (/contact page) → one email to ADMIN_EMAIL through the existing SMTP mailer. */
export const CONTACT_LIMIT_PER_HOUR = 5;
/** Same sender address, whatever network it comes from (QA run3: rotating proxy IPs slipped past the per-IP limit). */
export const CONTACT_EMAIL_LIMIT_PER_HOUR = 5;
/** Site-wide ceiling so a botnet cannot flood the admin inbox. */
export const CONTACT_GLOBAL_LIMIT_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

export type ContactInput = { name: string; email: string; message: string };
export type ContactCheck = { ok: true; value: ContactInput } | { ok: false; field: "name" | "email" | "message"; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Control characters (except tab / newline) never belong in a message; CR/LF never in a header-bound field.
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(value: unknown, max: number, singleLine: boolean): string {
  if (typeof value !== "string") return "";
  let out = value.replace(CTRL_RE, "");
  if (singleLine) out = out.replace(/[\r\n]+/g, " ");
  return out.trim().slice(0, max);
}

/** Validation shared by the route and its tests. */
export function checkContact(body: unknown): ContactCheck {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const name = clean(b.name, 100, true);
  const email = clean(b.email, 254, true);
  const message = clean(b.message, 5000, false);
  if (name.length < 2) return { ok: false, field: "name", message: "Please enter your name." };
  if (!EMAIL_RE.test(email)) return { ok: false, field: "email", message: "Please enter a valid email address." };
  if (message.length < 10) return { ok: false, field: "message", message: "Please write a message of at least 10 characters." };
  return { ok: true, value: { name, email, message } };
}

/** True when the hidden honeypot field was filled in (bots fill every input). */
export function isBot(body: unknown): boolean {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return typeof b.website === "string" && b.website.trim() !== "";
}

/**
 * Real client IP. Fastify's trustProxy (TRUST_PROXY, default loopback only) already resolves request.ip from the
 * X-Forwarded-For that host nginx overwrites with $remote_addr. X-Real-IP is a fallback used only when the peer is
 * still loopback (a local caller without X-Forwarded-For); a remote peer can never choose its own IP.
 */
export function contactClientIp(request: Pick<FastifyRequest, "ip" | "headers">): string {
  const peer = request.ip || "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const real = request.headers["x-real-ip"];
  if (loopback && typeof real === "string" && real.trim()) return real.trim().slice(0, 64);
  return peer || "unknown";
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function contactRoutes(
  app: FastifyInstance,
  opts: { send?: typeof sendMail; configured?: () => boolean; to?: () => string } = {}
) {
  const send = opts.send ?? sendMail;
  const configured = opts.configured ?? mailConfigured;
  const to = opts.to ?? (() => env.adminEmail);

  app.post("/contact", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const ip = contactClientIp(request);
    if (hitLimit(`contact:${ip}`, CONTACT_LIMIT_PER_HOUR, HOUR_MS)) {
      reply.header("Retry-After", "3600");
      return reply.code(429).send({ error: "Too many messages from this network. Please try again in an hour.", code: "RATE_LIMITED" });
    }
    // Honeypot: pretend success so bots learn nothing; nothing is sent.
    if (isBot(request.body)) return reply.code(202).send({ ok: true });

    const check = checkContact(request.body);
    if (!check.ok) return reply.code(400).send({ error: check.message, field: check.field, code: "BAD_CONTACT" });
    if (!configured()) {
      request.log.warn("contact form: SMTP is not configured");
      return reply.code(503).send({ error: "Messages can't be delivered right now. Please try again later.", code: "MAIL_UNAVAILABLE" });
    }

    const { name, email, message } = check.value;
    if (
      hitLimit(`contact:email:${email.toLowerCase()}`, CONTACT_EMAIL_LIMIT_PER_HOUR, HOUR_MS) ||
      hitLimit("contact:all", CONTACT_GLOBAL_LIMIT_PER_HOUR, HOUR_MS)
    ) {
      reply.header("Retry-After", "3600");
      return reply.code(429).send({ error: "Too many messages from this network. Please try again in an hour.", code: "RATE_LIMITED" });
    }
    const when = new Date().toISOString();
    const subject = `[ResumeBuilder] Contact form: ${name}`.slice(0, 160);
    const text = `New message from the ResumeBuilder contact form\n\nName: ${name}\nEmail: ${email}\nIP: ${ip}\nTime: ${when}\n\n${message}\n`;
    const html =
      `<h2>New contact form message</h2>` +
      `<p><b>Name:</b> ${escapeHtml(name)}<br><b>Email:</b> ${escapeHtml(email)}<br><b>IP:</b> ${escapeHtml(ip)}<br><b>Time:</b> ${when}</p>` +
      `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(message)}</pre>`;
    try {
      const res = await send({ to: to(), subject, text, html });
      request.log.info({ delivered: res.delivered, messageId: res.messageId, smtp: res.response }, "contact email attempted");
      if (!res.delivered) return reply.code(503).send({ error: "Messages can't be delivered right now. Please try again later.", code: "MAIL_UNAVAILABLE" });
    } catch (err) {
      request.log.error({ err: err instanceof Error ? err.message : String(err) }, "contact form: send failed");
      return reply.code(502).send({ error: "We couldn't send your message. Please try again in a few minutes.", code: "MAIL_FAILED" });
    }
    return reply.code(202).send({ ok: true });
  });
}
