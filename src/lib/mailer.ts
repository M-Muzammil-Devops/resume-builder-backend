import nodemailer from "nodemailer";
import { env } from "../config/env";

export function mailConfigured() {
  return Boolean(env.smtpHost);
}

function transportOf() {
  return nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    requireTLS: env.smtpPort !== 465 && env.smtpRequireTls,
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

let verifyCache: { at: number; ok: boolean; error: string | null } | null = null;

/** SMTP login check for the admin System Health card. Cached 10 minutes; never exposes credentials. */
export async function verifyMail(force = false): Promise<{ configured: boolean; ok: boolean; error: string | null; checkedAt: string | null; host: string | null }> {
  if (!env.smtpHost) return { configured: false, ok: false, error: "SMTP_HOST is not set", checkedAt: null, host: null };
  if (force || !verifyCache || Date.now() - verifyCache.at > 10 * 60_000) {
    try {
      await Promise.race([
        transportOf().verify(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("SMTP check timed out")), 10_000)),
      ]);
      verifyCache = { at: Date.now(), ok: true, error: null };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      verifyCache = { at: Date.now(), ok: false, error: raw.replace(/\S+@\S+/g, "***").slice(0, 160) };
    }
  }
  return { configured: true, ok: verifyCache.ok, error: verifyCache.error, checkedAt: new Date(verifyCache.at).toISOString(), host: env.smtpHost };
}

export async function sendMail(input: { to: string; subject: string; text: string; html?: string }): Promise<{
  delivered: boolean;
  messageId?: string;
  response?: string;
  accepted?: string[];
}> {
  if (!env.smtpHost) return { delivered: false };

  const transport = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    requireTLS: env.smtpPort !== 465 && env.smtpRequireTls,
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });

  const info = await transport.sendMail({
    from: env.smtpFrom,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
  });
  return {
    delivered: true,
    messageId: info.messageId,
    response: info.response,
    accepted: (info.accepted || []).map((item) => String(item)),
  };
}
