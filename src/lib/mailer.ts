import nodemailer from "nodemailer";
import { env } from "../config/env";

export function mailConfigured() {
  return Boolean(env.smtpHost);
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
