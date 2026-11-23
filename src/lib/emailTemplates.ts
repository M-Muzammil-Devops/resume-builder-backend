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

/**
 * Magic sign-in code: premium dark-header card with the 6-digit code in large spaced type.
 * The code is digits only, so it is safe to place in the HTML as-is (still escaped).
 */
export function magicCodeEmail(code: string, opts: { minutes: number; newAccount?: boolean }): AuthEmail {
  const support = supportAddress();
  const year = new Date().getFullYear();
  const subject = `${code} is your ResumeBuilder sign-in code`;
  const heading = opts.newAccount ? "Welcome to ResumeBuilder ✨" : "Your magic sign-in code ✨";
  const intro = opts.newAccount
    ? "Enter this code to create your ResumeBuilder account and sign in."
    : "Enter this code on the sign-in page to continue to your ResumeBuilder account.";
  const expiry = `The code expires in ${opts.minutes} minutes and works once.`;
  const ignore = "If you didn't ask for this code, you can ignore this email. Nobody can sign in without it.";
  const text = [
    "ResumeBuilder",
    "",
    heading,
    "",
    intro,
    "",
    `Your code: ${code}`,
    "",
    expiry,
    ignore,
    "",
    "--",
    support ? `Questions? Write to ${support}.` : "",
    `© ${year} ResumeBuilder.`,
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
  const digits = escapeHtml(code)
    .split("")
    .map(
      (d) =>
        `<td style="width:44px;height:56px;background:#eef3ff;border:1px solid #c7d4fb;border-radius:12px;font-family:'SFMono-Regular',Consolas,'Courier New',monospace;font-size:28px;font-weight:bold;color:#1e1b6b;text-align:center">${d}</td>`
    )
    .join('<td style="width:8px"></td>');
  const supportHtml = support
    ? `Questions? Write to <a href="mailto:${escapeHtml(support)}" style="color:#4f46e5">${escapeHtml(support)}</a>.<br>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#0a0f26;font-family:Arial,Helvetica,sans-serif;color:#0b1230">
<div style="display:none;max-height:0;overflow:hidden">Your ResumeBuilder code is ${escapeHtml(code)}. It expires in ${opts.minutes} minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0f26;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden">
<tr><td style="background:#2563eb;background-image:linear-gradient(135deg,#2563eb 0%,#4338ca 55%,#6d28d9 100%);padding:22px 28px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:34px;height:34px;border-radius:10px;background:#ffffff;color:#2457d6;font-weight:bold;font-size:14px;text-align:center">RB</td>
<td style="padding-left:12px;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:.3px">ResumeBuilder</td>
</tr></table>
</td></tr>
<tr><td style="padding:32px 28px 8px">
<h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;color:#0b1230">${escapeHtml(heading)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#545e80">${escapeHtml(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 24px"><tr>${digits}</tr></table>
<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#545e80;text-align:center">${escapeHtml(expiry)}</p>
<p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#8f99ba;text-align:center">${escapeHtml(ignore)}</p>
</td></tr>
<tr><td style="padding:16px 28px;background:#f5f7ff;border-top:1px solid #e3e8fb;font-size:12px;line-height:1.6;color:#6b7399">
${supportHtml}© ${year} ResumeBuilder. Never share this code with anyone, including our team.
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
  return { subject, text, html };
}

/** Sent instead of a code when someone asks to sign in with an email that has no account. */
export function noAccountEmail(registerLink: string): AuthEmail {
  return authEmail({
    subject: "Sign-in attempt on ResumeBuilder",
    heading: "No account uses this email yet",
    intro: "Someone (hopefully you) asked for a ResumeBuilder sign-in code for this address, but there is no account for it. You can create one in a minute.",
    buttonLabel: "Create your account",
    link: registerLink,
    expiry: "No code was sent and nothing changed.",
    ignoreLine: "If this wasn't you, ignore this email.",
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