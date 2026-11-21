import { env } from "../config/env";

/** BUG-1408: branded HTML + plain-text auth emails with a footer and a support address. */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Bare address from ADMIN_EMAIL or the From header ("Name <a@b>"). */
export function supportAddress(): string {
  const fromHeader = /<([^>]+)>/.exec(env.smtpFrom)?.[1] || env.smtpFrom;
  const candidates = [process.env.SUPPORT_EMAIL, env.adminEmail, fromHeader];
  for (const value of candidates) {
    const email = String(value || "").trim();
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) && !/@localhost$/i.test(email)) return email;
  }
  return "";
}

export type AuthEmail = { subject: string; text: string; html: string };

export function authEmail(opts: {
  subject: string;
  heading: string;
  intro: string;
  buttonLabel: string;
  link: string;
  expiry: string;
  ignoreLine: string;
}): AuthEmail {
  const support = supportAddress();
  const year = new Date().getFullYear();
  const supportText = support ? `Questions? Write to ${support}.` : "";
  const text = [
    "ResumeBuilder",
    "",
    opts.heading,
    "",
    opts.intro,
    "",
    opts.link,
    "",
    opts.expiry,
    opts.ignoreLine,
    "",
    "--",
    supportText,
    `© ${year} ResumeBuilder. You received this email because of an action on your ResumeBuilder account.`,
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");

  const link = escapeHtml(opts.link);
  const supportHtml = support
    ? `Questions? Write to <a href="mailto:${escapeHtml(support)}" style="color:#0f766e">${escapeHtml(support)}</a>.<br>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
<tr><td style="background:#0f766e;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:.3px">ResumeBuilder</td></tr>
<tr><td style="padding:28px 24px 8px">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#0f172a">${escapeHtml(opts.heading)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#334155">${escapeHtml(opts.intro)}</p>
<p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:8px">${escapeHtml(opts.buttonLabel)}</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#64748b">${escapeHtml(opts.expiry)}</p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#64748b">${escapeHtml(opts.ignoreLine)}</p>
<p style="margin:0 0 24px;font-size:12px;line-height:1.6;color:#94a3b8;word-break:break-all">If the button does not work, paste this link into your browser:<br><a href="${link}" style="color:#0f766e">${link}</a></p>
</td></tr>
<tr><td style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.6;color:#64748b">
${supportHtml}© ${year} ResumeBuilder. You received this email because of an action on your ResumeBuilder account.
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
  return { subject: opts.subject, text, html };
}

export function verifyEmail(link: string): AuthEmail {
  return authEmail({
    subject: "Verify your ResumeBuilder email",
    heading: "Confirm your email address",
    intro: "Thanks for signing up. Confirm your email to finish creating your ResumeBuilder account.",
    buttonLabel: "Verify email",
    link,
    expiry: "This link expires in 24 hours.",
    ignoreLine: "If you did not create a ResumeBuilder account, you can ignore this email. No account will be activated.",
  });
}

export function resetEmail(link: string): AuthEmail {
  return authEmail({
    subject: "Reset your ResumeBuilder password",
    heading: "Reset your password",
    intro: "We received a request to reset the password for your ResumeBuilder account.",
    buttonLabel: "Choose a new password",
    link,
    expiry: "This link expires in 1 hour and works once.",
    ignoreLine: "If this wasn't you, ignore this email. Your password stays the same.",
  });
}

/** SMTP failure details that are safe to log: never the message, credentials or server banner. */
export function mailErrorMeta(err: unknown): { code?: string; responseCode?: number } {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    responseCode: typeof e.responseCode === "number" ? e.responseCode : undefined,
  };
}