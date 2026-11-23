import { scrubSampleText } from "../lib/sampleText";
import { isLetterPage, isSingleColumnLayout, normalizePageSize, resolveColumns, resolvePhotoSlot, type ResumeContent } from "../shared";
import { joinUrl, originOf } from "../lib/urls";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { env } from "../config/env";
import { resolveChromeExecutable } from "../lib/chrome";
import { storedResumeContent, storedResumeDesign } from "../lib/resumeContent";
import { safePhotoUrl } from "../lib/resumeSchema";
import { tooLongError } from "./resumes";
import {
  EXPORT_MIME,
  PrintRenderError,
  docxFromText,
  loadDocxPhoto,
  exportErrorBody,
  parseExportFormat,
  type ExportFormat,
} from "../lib/exportFormats";

function fontBase64(fileName: string): string | null {
  const bundled = path.resolve(process.cwd(), "../frontend/public/fonts", fileName);
  if (!existsSync(bundled)) return null;
  return readFileSync(bundled).toString("base64");
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Editable fields may contain light HTML — strip tags for PDF text. */
function plain(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function e(value: unknown) {
  return escapeHtml(plain(value));
}

export function htmlToPlain(html: string) {
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // BUG-1201: skill tags are adjacent inline spans; keep them apart in TXT/DOCX.
    .replace(/<\/span>\s*(?=<span data-rb-skill)/gi, "</span>, ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return stripped
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    // BUG-1250: drop lines that are only a star/bullet glyph (blank sample items).
    .split("\n")
    .filter((line) => !/^\s*[★☆•·▪\-–—*]+\s*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type AnySec = Record<string, unknown>;
type Design = {
  accentColor?: string;
  inkColor?: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  pageMargins?: number;
  pageSize?: "A4" | "US Letter";
  sectionSpacing?: number;
  background?: string;
  columnLayout?: "single" | "wide-left" | "equal" | "wide-right";
  headerStyle?: "default" | "banner" | "centered";
  photoPosition?: "left" | "right";
  titlePlacement?: "below" | "beside";
  sectionHeadingStyle?: "underline" | "icon-line" | "numbered";
  headerMonogram?: boolean;
  contactLayout?: "row" | "grid";
  entryLayout?: "side-meta" | "stacked";
};

type Theme = {
  accent: string;
  ink: string;
  headingStyle: "underline" | "icon-line" | "numbered";
  entryLayout: "side-meta" | "stacked";
};

/** BUG-1296: the header photo the export HTML shows (real photo slot only, never the monogram). */
export async function docxPhotoFromHtml(html: string) {
  const m = /<div class="rb-photo-slot" style="width:([\d.]+)px;height:([\d.]+)px[^"]*">\s*<img src="([^"]+)"/.exec(html);
  if (!m) return null;
  return loadDocxPhoto(m[3].replace(/&amp;/g, "&"), Number(m[1]), Number(m[2]));
}

function paperBg(bg?: string) {
  switch (bg) {
    case "soft-gray":
      return "#f7f8f9";
    case "mint":
      return "#eef4f3";
    case "warm":
      return "#f5f0e8";
    default:
      return "#ffffff";
  }
}

function columnWidths(layout?: Design["columnLayout"]) {
  switch (layout) {
    case "single":
      return { left: "100%", right: "0%", gap: "0" };
    case "wide-right":
      return { left: "38%", right: "62%", gap: "18px" };
    case "equal":
      return { left: "50%", right: "50%", gap: "18px" };
    default:
      return { left: "62%", right: "38%", gap: "18px" };
  }
}

function sectionHeading(title: string, theme: Theme) {
  const color = theme.headingStyle === "underline" ? theme.ink : theme.accent;
  return `<h2 style="margin:0 0 8px;padding-bottom:3px;border-bottom:1.5px solid ${color};color:${color};font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">${e(title)}</h2>`;
}

function bulletsHtml(bullets: unknown) {
  const list = Array.isArray(bullets) ? bullets.map(plain).filter(Boolean) : [];
  if (!list.length) return "";
  // Fixed dark circle — does NOT follow accent (matches editor on all templates)
  return `<ul style="margin:4px 0 0;padding:0;list-style:none">${list
    .map(
      (b) =>
        `<li style="margin:3px 0;padding-left:12px;position:relative"><span style="position:absolute;left:0;top:6px;width:5px;height:5px;border-radius:50%;background:#374151"></span>${escapeHtml(b)}</li>`
    )
    .join("")}</ul>`;
}

function contactIconSvg(kind: string, color: string) {
  const common = `xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  switch (kind) {
    case "phone":
      return `<svg ${common}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 22 16.92z"/></svg>`;
    case "email":
      return `<svg ${common}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`;
    case "link":
      return `<svg ${common}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
    case "location":
      return `<svg ${common}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
    case "nationality":
      return `<svg ${common}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>`;
    case "dob":
      return `<svg ${common}><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>`;
    default:
      return `<svg ${common}><circle cx="12" cy="12" r="3"/></svg>`;
  }
}

function settingsOf(sec: AnySec): Record<string, unknown> {
  return ((sec.settings as Record<string, unknown>) || {}) as Record<string, unknown>;
}

function contactBits(header: AnySec) {
  const contact = (header.contact as Record<string, unknown>) || {};
  const settings = settingsOf(header);
  const rows: { kind: string; label: string; show: boolean }[] = [
    { kind: "phone", label: plain(contact.phone), show: settings.phone !== false },
    { kind: "email", label: plain(contact.email), show: settings.email !== false },
    {
      kind: "link",
      label: plain(contact.linkedin || contact.website || contact.github),
      show: settings.link !== false,
    },
    { kind: "location", label: plain(contact.location), show: settings.location !== false },
    { kind: "nationality", label: plain(contact.nationality), show: settings.nationality === true },
    { kind: "dob", label: plain(contact.dateOfBirth), show: settings.dateOfBirth === true },
    {
      kind: "link",
      label: plain(contact.extraLink),
      show: settings.extraLink === true,
    },
    {
      kind: "location",
      label: plain(contact.extraField),
      show: settings.extraField === true,
    },
  ];
  return rows.filter((r) => r.show && r.label);
}

export const CONTACT_SEPARATOR = '<span style="display:none" aria-hidden="true"> | </span>';

function renderHeader(sec: AnySec, design: Design, theme: Theme): string {
  const settings = settingsOf(sec);
  const photoSrc = safePhotoUrl(sec.photoUrl);
  // Same single slot as the canvas/PDF: photo, else the template monogram, same side and shape.
  const slot = resolvePhotoSlot({
    photoOn: settings.photo !== false,
    photoUrl: photoSrc,
    photoStyle: typeof settings.photoStyle === "string" ? settings.photoStyle : undefined,
    headerStyle: design.headerStyle,
    photoPosition: design.photoPosition,
    monogram: Boolean(design.headerMonogram),
    fullName: plain(sec.fullName),
    editing: false,
  });
  const ring = typeof settings.photoAccent === "string" && /^#[0-9a-f]{3,8}$/i.test(settings.photoAccent) ? settings.photoAccent : theme.accent;
  const titleBeside = design.titlePlacement === "beside";
  const headerStyle = design.headerStyle || "default";
  const isBanner = headerStyle === "banner";
  const isCentered = headerStyle === "centered";
  const bits = contactBits(sec);

  const slotBox = `width:${slot.width}px;height:${slot.height}px;border-radius:${slot.radius};overflow:hidden;flex-shrink:0;box-shadow:0 0 0 2px ${ring}33`;
  const photoHtml =
    slot.kind === "photo"
      ? `<div class="rb-photo-slot" style="${slotBox};background:#d5d8dd">
        <img src="${escapeHtml(photoSrc)}" alt="" style="width:100%;height:100%;object-fit:cover"/>
      </div>`
      : slot.kind === "monogram"
        ? // Initials come from a CSS attribute so the TXT/DOCX text never gains a stray "MM".
          `<div class="rb-photo-slot rb-mono" data-initials="${escapeHtml(slot.initials)}" aria-hidden="true" style="${slotBox};background:${theme.accent};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${slot.initialsFontSize}px;line-height:1;letter-spacing:.02em;white-space:nowrap"></div>`
        : "";
  const nameColor = isBanner ? "#ffffff" : theme.ink;
  const titleColor = isBanner ? "rgba(255,255,255,.9)" : theme.accent;
  const contactColor = isBanner ? "rgba(255,255,255,.88)" : "#5a6470";

  const titleHtml =
    settings.title !== false && sec.title
      ? titleBeside
        ? `<span style="color:${titleColor};font-size:13px;font-style:italic;font-weight:500">${e(sec.title)}</span>`
        : `<p style="margin:4px 0 0;color:${titleColor};font-size:13px;font-weight:600">${e(sec.title)}</p>`
      : "";

  const nameBlock = titleBeside
    ? `<div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:10px">
        <h1 style="margin:0;font-size:24px;font-weight:700;letter-spacing:.04em;color:${nameColor};${settings.uppercaseName === false ? "" : "text-transform:uppercase"}">${e(sec.fullName)}</h1>
        ${titleHtml}
      </div>`
    : `<h1 style="margin:0;font-size:24px;font-weight:700;letter-spacing:.04em;color:${nameColor};${settings.uppercaseName === false ? "" : "text-transform:uppercase"}">${e(sec.fullName)}</h1>${titleHtml}`;

  const iconColor = isBanner ? "#ffffff" : theme.accent;
  const contactHtml = bits.length
    ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px 14px;color:${contactColor};font-size:11px">
        ${bits
          .map(
            (b) =>
              `<span style="display:inline-flex;align-items:center;gap:5px">${contactIconSvg(b.kind, iconColor)}<span>${escapeHtml(b.label)}</span></span>`
          )
          // BUG-1104: a separator the TXT/DOCX export keeps; hidden in the HTML/PDF layout.
          .join(CONTACT_SEPARATOR)}
      </div>`
    : "";

  const textCol = `<div style="min-width:0;flex:1">${nameBlock}${contactHtml}</div>`;

  const inner =
    isCentered
      ? `<div style="text-align:center;width:100%">${photoHtml ? `<div style="display:flex;justify-content:center;margin-bottom:8px">${photoHtml}</div>` : ""}${nameBlock}${contactHtml}</div>`
      : slot.position === "left"
        ? `${photoHtml}${textCol}`
        : `${textCol}${photoHtml}`;

  const pad = isBanner ? "16px 20px" : "0 0 12px";
  const border = isBanner
    ? "none"
    : `border-bottom:2px solid ${theme.ink};`;
  const bg = isBanner ? `background:${theme.accent};color:#fff;` : "";

  return `<header style="${border}${bg}padding:${pad};margin-bottom:14px;display:flex;gap:14px;align-items:flex-start;${isCentered ? "justify-content:center" : ""}">
    ${inner}
  </header>`;
}

function renderSection(sec: AnySec, theme: Theme): string {
  const type = String(sec.type || "");
  const st = settingsOf(sec);
  const { accent, ink } = theme;

  if (type === "header") return "";

  if (type === "summary") {
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || "SUMMARY"), theme)}
      <p style="margin:0;color:${ink};line-height:1.45">${e(sec.content)}</p></section>`;
  }

  if (type === "experience") {
    const items = (sec.items as AnySec[]) || [];
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || "EXPERIENCE"), theme)}
      ${items
        .map((it) => {
          const meta = `<div style="color:#6b7280;font-size:10px;white-space:nowrap">
              ${[it.startDate || it.endDate ? `${e(it.startDate)} – ${e(it.endDate || "Present")}` : "", it.location ? e(it.location) : ""].filter(Boolean).join(" · ")}
            </div>`;
          const title =
            st.title !== false
              ? `<div style="font-weight:700;color:${ink};font-size:12.5px">${e(it.title)}</div>`
              : "";
          const company =
            st.subtitle !== false
              ? `<div style="color:${accent};font-weight:600;font-size:12px">${e(it.company)}</div>`
              : "";
          const body =
            theme.entryLayout === "stacked"
              ? `${title}${company}<div style="margin-top:2px">${meta}</div>`
              : `<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
                  <div>${title}${company}</div>${meta}
                </div>`;
          return `<div style="margin-bottom:11px">
          ${body}
          ${st.description !== false && it.description ? `<p style="margin:4px 0 0;color:#4b5563;font-size:11px">${e(it.description)}</p>` : ""}
          ${st.bullets !== false ? bulletsHtml(it.bullets) : ""}
        </div>`;
        })
        .join("")}
    </section>`;
  }

  if (type === "skills") {
    const cats = (sec.categories as AnySec[]) || [];
    const layout = String(st.skillsLayout || "tags");
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || "SKILLS"), theme)}
      ${cats
        .map((cat) => {
          const skills = Array.isArray(cat.skills)
            ? (cat.skills as unknown[]).map(plain).filter(Boolean)
            : [];
          const group =
            st.groupName !== false
              ? `<div style="font-weight:700;font-size:11px;color:${ink};margin-bottom:4px">${e(cat.name)}</div>`
              : "";
          if (layout === "underline") {
            return `<div style="margin-bottom:8px">${group}
              <div style="display:flex;flex-wrap:wrap;gap:4px 12px">${skills
                .map(
                  (s) =>
                    `<span data-rb-skill style="border-bottom:1.5px solid ${theme.accent};padding:1px 0;font-size:10.5px;color:#374151">${escapeHtml(s)}</span>`
                )
                .join("")}</div></div>`;
          }
          if (layout === "tags") {
            return `<div style="margin-bottom:8px">${group}
              <div style="display:flex;flex-wrap:wrap;gap:5px">${skills
                .map(
                  (s) =>
                    `<span data-rb-skill style="border:1px solid #d5d8dd;border-radius:4px;padding:2px 7px;font-size:10.5px;color:#374151">${escapeHtml(s)}</span>`
                )
                .join("")}</div></div>`;
          }
          if (layout === "bullets") {
            return `<div style="margin-bottom:8px">${group}<ul style="margin:0;padding-left:14px;font-size:11px;color:#374151">${skills
              .map((s) => `<li>${escapeHtml(s)}</li>`)
              .join("")}</ul></div>`;
          }
          return `<div style="margin-bottom:8px">${group}
            <div style="color:#374151;font-size:11px;line-height:1.45">${skills.map(escapeHtml).join(" · ")}</div>
          </div>`;
        })
        .join("")}
    </section>`;
  }

  if (type === "projects") {
    const items = (sec.items as AnySec[]) || [];
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || "PROJECTS"), theme)}
      ${items
        .map((it) => {
          const tech = Array.isArray(it.technologies)
            ? (it.technologies as unknown[]).map(plain).filter(Boolean)
            : [];
          return `<div style="margin-bottom:10px">
            <div style="font-weight:700;color:${ink}">${e(it.name)}</div>
            <p style="margin:3px 0 0;color:#374151;font-size:11px">${e(it.description)}</p>
            ${tech.length ? `<div style="margin-top:3px;color:${accent};font-size:11px">${tech.map(escapeHtml).join(" · ")}</div>` : ""}
          </div>`;
        })
        .join("")}
    </section>`;
  }

  if (type === "achievements" || type === "strengths") {
    const items = (sec.items as AnySec[]) || [];
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || "KEY ACHIEVEMENTS"), theme)}
      ${items
        .map((it) => {
          const title = plain(it.title || it.text);
          const desc = plain(it.description);
          return `<div style="display:flex;gap:8px;margin-bottom:8px">
            <div style="width:22px;height:22px;border-radius:999px;background:${accent}22;color:${accent};flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">★</div>
            <div>
              ${st.title !== false ? `<div style="font-weight:700;color:${ink};font-size:12px">${escapeHtml(title)}</div>` : ""}
              ${st.description !== false && desc ? `<div style="color:#4b5563;font-size:11px;margin-top:1px">${escapeHtml(desc)}</div>` : ""}
            </div>
          </div>`;
        })
        .join("")}
    </section>`;
  }

  if (type === "certifications" || type === "awards") {
    const items = (sec.items as AnySec[]) || [];
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || "CERTIFICATION"), theme)}
      ${items
        .map(
          (it) => `<div style="margin-bottom:6px">
          <div style="font-weight:700;font-size:12px;color:${ink}">${e(it.name)}</div>
          <div style="color:#6b7280;font-size:11px">${e(it.issuer)}${it.date ? ` · ${e(it.date)}` : ""}</div>
        </div>`
        )
        .join("")}
    </section>`;
  }

  if (type === "education") {
    const items = (sec.items as AnySec[]) || [];
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || "EDUCATION"), theme)}
      ${items
        .map(
          (it) => `<div style="margin-bottom:8px">
          ${st.title !== false ? `<div style="font-weight:700;color:${ink}">${e(it.degree)}</div>` : ""}
          ${st.institution !== false ? `<div style="color:${accent};font-size:12px;font-weight:600">${e(it.school)}</div>` : ""}
          <div style="color:#6b7280;font-size:10px">${e(it.startDate)}${it.startDate || it.endDate ? " – " : ""}${e(it.endDate)}${it.location ? ` · ${e(it.location)}` : ""}${it.gpa ? ` · GPA ${e(it.gpa)}` : ""}</div>
        </div>`
        )
        .join("")}
    </section>`;
  }

  if (type === "languages") {
    const items = (sec.items as AnySec[]) || [];
    const showBars = st.description !== false;
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || "LANGUAGES"), theme)}
      ${items
        .map((it) => {
          const pct = Math.min(100, Math.max(0, Number(it.proficiency ?? 80)));
          return `<div style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;font-size:12px;gap:8px">
              <strong style="color:${ink}">${e(it.name)}</strong>
              <span style="color:#6b7280">${e(it.level)}</span>
            </div>
            ${
              showBars
                ? `<div style="margin-top:4px;height:6px;background:#e5e7eb;border-radius:999px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:${accent};border-radius:999px"></div>
                  </div>`
                : ""
            }
          </div>`;
        })
        .join("")}
    </section>`;
  }

  if (type === "volunteering" || type === "custom") {
    const items = (sec.items as AnySec[]) || [];
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || type), theme)}
      ${items
        .map(
          (it) => `<div style="margin-bottom:8px">
          <div style="font-weight:700;color:${ink}">${e(it.title || it.role)}</div>
          <div style="color:${accent};font-size:12px">${e(it.organization || "")}</div>
          <p style="margin:3px 0 0;color:#374151;font-size:11px">${e(it.description)}</p>
        </div>`
        )
        .join("")}
    </section>`;
  }

  if (type === "interests") {
    const items = (sec.items as AnySec[]) || [];
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || "PASSIONS"), theme)}
      ${items
        .map(
          (it) =>
            `<div style="margin-bottom:6px"><strong style="color:${accent}">${e(it.title)}</strong><div style="color:#374151;font-size:11px">${e(it.description)}</div></div>`
        )
        .join("")}
    </section>`;
  }

  if (type === "philosophy") {
    return `<section style="margin-bottom:14px">${sectionHeading(String(sec.title || "PHILOSOPHY"), theme)}
      <p style="margin:0;font-style:italic;color:#374151">“${e(sec.quote)}”</p>
      ${sec.author ? `<p style="margin:4px 0 0;color:#6b7280;font-size:11px">— ${e(sec.author)}</p>` : ""}
    </section>`;
  }

  const title = String(sec.title || type || "Section");
  return `<section style="margin-bottom:14px">${sectionHeading(title, theme)}
    <p style="margin:0;color:#6b7280;font-size:11px">Content unavailable for this section type.</p>
  </section>`;
}

export function resumeToHtml(content: unknown, design: unknown, title: string, layoutKey?: string | null): string {
  const c = (content || {}) as {
    sections?: AnySec[];
    leftColumnIds?: string[];
    rightColumnIds?: string[];
  };
  const d = (design || {}) as Design;

  const accent = d.accentColor || "#00b6cb";
  const ink = d.inkColor || "#343334";
  const font = d.fontFamily || "Raleway";
  const fontSize = 11 + (Number(d.fontSize ?? 2) * 0.6);
  const lineHeight = 1.35 + (Number(d.lineHeight ?? 1) * 0.08);
  const marginLevel = Math.min(8, Math.max(0, Number(d.pageMargins ?? 4)));
  const margin = Math.round(48 + (marginLevel / 8) * 48);
  const letter = isLetterPage(d.pageSize);
  const bg = paperBg(d.background);
  const widths = columnWidths(d.columnLayout);
  const theme: Theme = {
    accent,
    ink,
    headingStyle: d.sectionHeadingStyle || "underline",
    entryLayout: d.entryLayout || "side-meta",
  };

  const sections = c.sections || [];
  const byId = new Map(sections.map((s) => [String(s.id), s]));
  const header = sections.find((s) => s.type === "header");

  // BUG-1280: same column rules as the canvas/PDF; sections in neither list join the main column.
  const columns = resolveColumns(
    {
      sections: sections as unknown as ResumeContent["sections"],
      // Legacy fallback only when the resume has no column lists at all; an empty side column is
      // a real choice (one column) and must not be refilled here.
      ...(c.leftColumnIds?.length || c.rightColumnIds?.length
        ? { leftColumnIds: c.leftColumnIds || [], rightColumnIds: c.rightColumnIds || [] }
        : {
            leftColumnIds: ["summary", "experience", "projects"],
            rightColumnIds: ["skills", "achievements", "certifications", "education"],
          }),
    },
    d.columnLayout
  );
  const leftIds = columns.left;
  const rightIds = columns.right;

  const renderIds = (ids: string[]) =>
    ids
      .map((id) => byId.get(id))
      .filter((s): s is AnySec => s !== undefined && s.type !== "header")
      .map((s) => renderSection(s, theme))
      .join("\n");

  const placed = new Set<string>([
    ...(header ? [String(header.id)] : []),
    ...leftIds,
    ...rightIds,
  ]);
  const extras = sections
    .filter((s) => s.type !== "header" && !placed.has(String(s.id)))
    .map((s) => renderSection(s, theme))
    .join("\n");

  const isSingle = isSingleColumnLayout(layoutKey, d.columnLayout, rightIds.length);

  const body = `
    ${header ? renderHeader(header, d, theme) : ""}
    ${
      isSingle
        ? `<div>${renderIds(leftIds)}${renderIds(rightIds)}${extras}</div>`
        : `<div style="display:flex;gap:${widths.gap};align-items:flex-start">
            <div style="width:${widths.left};min-width:0">${renderIds(leftIds)}</div>
            <div style="width:${widths.right};min-width:0;padding-left:12px;border-left:1px solid ${accent}33">${renderIds(rightIds)}</div>
          </div>${extras}`
    }
  `;

  const fontParam = encodeURIComponent(font).replace(/%20/g, "+");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <title>${e(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=${fontParam}:wght@400;500;600;700&display=swap" rel="stylesheet"/>
  <style>
    @page { size: ${letter ? "8.5in 11in" : "A4"}; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    .rb-mono::before { content: attr(data-initials); }
    body {
      font-family: '${font.replace(/'/g, "\\'")}', 'Segoe UI', Helvetica, Arial, sans-serif;
      color: ${ink};
      font-size: ${fontSize.toFixed(1)}px;
      line-height: ${lineHeight.toFixed(2)};
      background: ${bg};
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .page {
      width: ${letter ? "8.5in" : "210mm"};
      min-height: ${letter ? "11in" : "297mm"};
      padding: ${Math.round(margin)}px;
      background: ${bg};
    }
    img { max-width: 100%; }
    p { margin: 0; }
  </style>
  </head><body><div class="page">${body}</div></body></html>`;
}

function safeFileName(raw: string, fallback: string) {
  const cleaned = raw
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function pageSizeOf(design: unknown): "A4" | "US Letter" {
  return normalizePageSize((design as { pageSize?: string } | null)?.pageSize);
}

export async function exportRoutes(app: FastifyInstance) {
  async function buildPdfReply(
    reply: FastifyReply,
    request: {
      user: { userId: string; email: string; role?: string; epoch?: number };
      log: { error: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
    },
    resumeId: string,
    pageSize: "A4" | "US Letter",
    baseName: string
  ) {
    try {
      const puppeteer = await import("puppeteer");
      const executablePath = resolveChromeExecutable();
      const browser = await puppeteer.default.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--hide-scrollbars",
        ],
      });
      try {
        const token = app.jwt.sign(
          {
            userId: request.user.userId,
            email: request.user.email,
            role: request.user.role || "user",
            // BUG-705: carry the session epoch, or the print page gets 401 for any user who
            // ever changed/reset a password and the page never becomes ready.
            epoch: request.user.epoch ?? 0,
          },
          { expiresIn: "2m" }
        );
        // BUG-1100: the token never goes in the URL. A link the page resolves against its own
        // address (an empty href) would otherwise copy the session token into the PDF.
        // Internal render URL (loopback). It must never reach the PDF; see the link rewrite before page.pdf().
        const printUrl = joinUrl(env.printBaseUrl, "print", encodeURIComponent(resumeId));
        const page = await browser.newPage();
        await page.evaluateOnNewDocument((printToken: string) => {
          Object.defineProperty(window, "__RB_PRINT_TOKEN__", { value: printToken, configurable: false });
        }, token);
        const width = pageSize === "US Letter" ? 816 : 794;
        await page.setViewport({ width, height: 1123, deviceScaleFactor: 2 });
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          const url = req.url();
          if (url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com")) {
            void req.abort();
            return;
          }
          void req.continue();
        });
        // BUG-705: keep the print page console so a failed render is explained in the logs.
        const pageLog: string[] = [];
        page.on("console", (msg) => {
          if (pageLog.length < 50) pageLog.push(`[${msg.type()}] ${msg.text()}`.slice(0, 500));
        });
        page.on("pageerror", (err) => {
          if (pageLog.length < 50) pageLog.push(`[pageerror] ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
        });
        page.on("requestfailed", (req) => {
          if (pageLog.length < 50) pageLog.push(`[requestfailed] ${req.url().split("?")[0]} ${req.failure()?.errorText || ""}`);
        });
        const nav = await page.goto(printUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        if (nav && !nav.ok()) {
          throw new PrintRenderError(`The print view returned HTTP ${nav.status()}.`, pageLog);
        }
        try {
          await page.waitForSelector("[data-print-ready], [data-print-error]", { timeout: 20000 });
        } catch {
          throw new PrintRenderError("The print view did not finish loading in time.", pageLog);
        }
        const printError = await page.evaluate(
          () => document.querySelector("[data-print-error]")?.getAttribute("data-print-error") || null
        );
        if (printError) {
          throw new PrintRenderError(`The print view could not load the resume: ${printError}`, pageLog);
        }
        const rootFont = await page.evaluate(() => {
          const root = document.querySelector(".resume-page") || document.querySelector("[data-print-ready]");
          return root ? getComputedStyle(root).fontFamily : "Raleway";
        });
        const familyFiles: Record<string, [string, string]> = {
          Arimo: ["Arimo-Regular.ttf", "Arimo-Bold.ttf"],
          Bitter: ["Bitter-Regular.ttf", "Bitter-Bold.ttf"],
          Chivo: ["Chivo-Regular.ttf", "Chivo-Bold.ttf"],
          "Exo 2": ["Exo2-Regular.ttf", "Exo2-Bold.ttf"],
          Gelasio: ["Gelasio-Regular.ttf", "Gelasio-Bold.ttf"],
          Lato: ["Lato-Regular.ttf", "Lato-Bold.ttf"],
          Montserrat: ["Montserrat-Regular.ttf", "Montserrat-Bold.ttf"],
          Oswald: ["Oswald-Regular.ttf", "Oswald-Bold.ttf"],
          Raleway: ["Raleway-Regular.ttf", "Raleway-Bold.ttf"],
          Rubik: ["Rubik-Regular.ttf", "Rubik-Bold.ttf"],
          Tinos: ["Tinos-Regular.ttf", "Tinos-Bold.ttf"],
          Volkhov: ["Volkhov-Regular.ttf", "Volkhov-Bold.ttf"],
        };
        const picked =
          Object.keys(familyFiles).find((name) => rootFont.toLowerCase().includes(name.toLowerCase())) ||
          "Raleway";
        const [regularName, boldName] = familyFiles[picked];
        const regular = fontBase64(regularName);
        const bold = fontBase64(boldName) || regular;
        request.log.info({ picked, regularBytes: regular?.length || 0, ignored: regularName + "/" + boldName }, "pdf font embed");
        const emojiFile = path.join(process.env.SystemRoot || "C:\\Windows", "Fonts", "seguiemj.ttf");
        const emoji = existsSync(emojiFile) ? readFileSync(emojiFile).toString("base64") : null;
        if (emoji) {
          await page.evaluate((data: string) => {
            const style = document.createElement("style");
            style.textContent =
              '@font-face { font-family: "RBEmoji"; src: url("data:font/ttf;base64,' +
              data +
              '") format("truetype"); }';
            document.head.appendChild(style);
          }, emoji);
        }
        const applied = await page.evaluate(async (fonts: { regular: string | null; bold: string | null; family: string }) => {
          if (!fonts.regular) return "missing";
          const boldData = fonts.bold || fonts.regular;
          const sheets = document.styleSheets;
          for (let s = 0; s < sheets.length; s += 1) {
            let rules: CSSRuleList | null = null;
            try {
              rules = sheets[s].cssRules;
            } catch {
              rules = null;
            }
            if (!rules) continue;
            for (let i = rules.length - 1; i >= 0; i -= 1) {
              if (rules[i].type === 5) {
                try {
                  sheets[s].deleteRule(i);
                } catch {
                  /* keep going */
                }
              }
            }
          }
          const style = document.createElement("style");
          const variable = fonts.regular === boldData;
          const faces = variable
            ? '@font-face { font-family: "RBPrint"; src: url("data:font/ttf;base64,' + fonts.regular + '") format("truetype"); font-weight: 100 900; font-style: normal; }' +
              '@font-face { font-family: "' + fonts.family + '"; src: url("data:font/ttf;base64,' + fonts.regular + '") format("truetype"); font-weight: 100 900; font-style: normal; }'
            : '@font-face { font-family: "RBPrint"; src: url("data:font/ttf;base64,' + fonts.regular + '") format("truetype"); font-weight: 400; font-style: normal; }' +
              '@font-face { font-family: "RBPrint"; src: url("data:font/ttf;base64,' + boldData + '") format("truetype"); font-weight: 700; font-style: normal; }' +
              '@font-face { font-family: "' + fonts.family + '"; src: url("data:font/ttf;base64,' + fonts.regular + '") format("truetype"); font-weight: 400; font-style: normal; }' +
              '@font-face { font-family: "' + fonts.family + '"; src: url("data:font/ttf;base64,' + boldData + '") format("truetype"); font-weight: 700; font-style: normal; }';
          style.textContent = faces + '[data-print-ready], [data-print-ready] * { font-family: "RBPrint", "RBEmoji", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif !important; font-synthesis: none !important; }';
          document.head.appendChild(style);
          const nodes = document.querySelectorAll("[data-print-ready], [data-print-ready] *");
          for (let i = 0; i < nodes.length; i += 1) {
            const node = nodes[i];
            if (node instanceof HTMLElement) node.style.setProperty("font-family", '"RBPrint", "RBEmoji", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif', "important");
          }
          await document.fonts.load('400 16px "RBPrint"');
          await document.fonts.load('700 16px "RBPrint"');
          if (document.fonts?.ready) await document.fonts.ready;
          const root = document.querySelector("[data-print-ready]");
          return root ? getComputedStyle(root).fontFamily : "none";
        }, { regular, bold, family: picked });
        request.log.info({ applied }, "pdf font applied");
        await new Promise((r) => setTimeout(r, 300));
        // Never leak the internal render origin: point any same-origin link at the public site instead.
        await page.evaluate(
          (internalOrigin: string, publicOrigin: string) => {
            document.querySelectorAll("a[href]").forEach((a) => {
              const el = a as HTMLAnchorElement;
              const href = el.href || "";
              if (!href.startsWith(internalOrigin)) return;
              if (publicOrigin) el.setAttribute("href", publicOrigin + href.slice(internalOrigin.length));
              else el.removeAttribute("href");
            });
          },
          originOf(env.printBaseUrl),
          originOf(env.appUrl || env.frontendUrl)
        );
        const pdf = await page.pdf({
          printBackground: true,
          preferCSSPageSize: true,
          width: pageSize === "US Letter" ? "8.5in" : "210mm",
          height: pageSize === "US Letter" ? "11in" : "297mm",
          // Margins are drawn by the print view (repeated per page), so the paper colour is full-bleed.
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
        });
        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="${baseName}.pdf"; filename*=UTF-8''${encodeURIComponent(baseName)}.pdf`
          )
          .send(Buffer.from(pdf));
      } finally {
        await browser.close();
      }
    } catch (err) {
      request.log.error(
        { err, pageLog: err instanceof PrintRenderError ? err.pageLog : undefined },
        "PDF export failed"
      );
      return reply.code(500).send(exportErrorBody(err));
    }
  }

  /** TXT and DOCX share the plain-text rendering of the resume HTML. */
  async function buildTextReply(
    reply: FastifyReply,
    format: Exclude<ExportFormat, "pdf">,
    html: string,
    design: unknown,
    baseName: string
  ) {
    const text = htmlToPlain(html);
    const encoded = encodeURIComponent(baseName);
    if (format === "txt") {
      return reply
        .header("Content-Type", EXPORT_MIME.txt)
        .header("Content-Disposition", `attachment; filename="${baseName}.txt"; filename*=UTF-8''${encoded}.txt`)
        .send(text);
    }
    const fontFamily = (design as { fontFamily?: string } | null)?.fontFamily;
    const photo = await docxPhotoFromHtml(html);
    const buffer = await docxFromText(text, { pageSize: pageSizeOf(design), fontFamily, photo });
    return reply
      .header("Content-Type", EXPORT_MIME.docx)
      .header("Content-Disposition", `attachment; filename="${baseName}.docx"; filename*=UTF-8''${encoded}.docx`)
      .send(buffer);
  }

  app.get("/export/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { format?: string; filename?: string };
    const format = query.format === "html" ? "html" : parseExportFormat(query.format);
    if (!format) return reply.code(400).send({ error: "Unsupported format" });

    const row = await prisma.resume.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!row) return reply.code(404).send({ error: "Not found" });

    const baseName = safeFileName(query.filename || row.title, "Resume");
    const html = resumeToHtml(scrubSampleText(row.content), row.design, row.title, row.layoutKey);

    if (format === "pdf") {
      return buildPdfReply(reply, request, row.id, pageSizeOf(row.design), baseName);
    }

    if (format === "html") {
      return reply
        .header("Content-Disposition", `inline; filename="${baseName}.html"`)
        .type("text/html")
        .send(html);
    }

    return buildTextReply(reply, format, html, row.design, baseName);
  });

  /** Export using live editor payload (exact WYSIWYG) — preferred by Download modal. */
  app.post("/export/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        filename: z.string().optional(),
        title: z.string().optional(),
        content: z.any(),
        design: z.any(),
        format: z.string().optional(),
        layoutKey: z.string().max(40).optional(),
      })
      .parse(request.body ?? {});
    const tooLong = tooLongError(body);
    if (tooLong) return reply.code(400).send({ error: tooLong });
    const query = request.query as { format?: string };
    const format = parseExportFormat(body.format ?? query.format);
    if (!format) return reply.code(400).send({ error: "Unsupported format" });

    const row = await prisma.resume.findFirst({
      where: { id, userId: request.user.userId },
      select: { id: true, title: true, content: true, design: true, layoutKey: true },
    });
    if (!row) return reply.code(404).send({ error: "Not found" });

    // BUG-402: the live payload goes through the same sanitiser as PUT /resumes/:id
    // before it is stored or rendered. A body without content exports the saved resume.
    const content = body.content === undefined ? row.content : storedResumeContent(body.content);
    const design = body.design === undefined ? row.design : storedResumeDesign(body.design);
    const title = (body.title || row.title || "Resume").trim().slice(0, 100) || "Resume";
    const baseName = safeFileName(body.filename || title, "Resume");
    const html = resumeToHtml(scrubSampleText(content), design, title, body.layoutKey ?? row.layoutKey);

    // Persist latest design/content so next GET export matches too
    if (body.content !== undefined || body.design !== undefined || body.title) {
      await prisma.resume.update({
        where: { id },
        data: {
          title,
          content: body.content === undefined ? undefined : (content as object),
          design: body.design === undefined ? undefined : (design as object),
        },
      });
    }

    if (format !== "pdf") return buildTextReply(reply, format, html, design, baseName);
    return buildPdfReply(reply, request, id, pageSizeOf(design), baseName);
  });

  app.post("/export/preview", async (request) => {
    const body = z
      .object({ title: z.string(), content: z.any(), design: z.any(), layoutKey: z.string().max(40).optional() })
      .parse(request.body);
    // Same rules as a stored resume: unknown keys, unsafe images and markup are dropped first.
    return { html: resumeToHtml(storedResumeContent(body.content), storedResumeDesign(body.design), body.title.slice(0, 200), body.layoutKey) };
  });
}
