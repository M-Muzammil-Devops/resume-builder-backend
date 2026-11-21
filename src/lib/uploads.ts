import { joinUrl } from "./urls";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { env } from "../config/env";

export function ensureUploadDirs() {
  const root = path.resolve(env.uploadDir);
  for (const sub of ["pdfs", "previews"]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

export function saveUpload(subdir: "pdfs" | "previews", filename: string, buf: Buffer) {
  const root = ensureUploadDirs();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const name = `${Date.now()}_${randomUUID().slice(0, 8)}_${safe}`;
  const full = path.join(root, subdir, name);
  fs.writeFileSync(full, buf);
  return path.posix.join(subdir, name);
}

/** Minimal SVG preview when admin skips thumbnail upload */
export function writePlaceholderPreview(opts: {
  name: string;
  department: string;
  accent: string;
  hasPhoto: boolean;
  columns: string;
}) {
  const root = ensureUploadDirs();
  const name = `${Date.now()}_${randomUUID().slice(0, 8)}_preview.svg`;
  const full = path.join(root, "previews", name);
  const photo = opts.hasPhoto
    ? `<circle cx="170" cy="48" r="22" fill="#cbd5e1"/><circle cx="170" cy="42" r="8" fill="#94a3b8"/><ellipse cx="170" cy="62" rx="14" ry="10" fill="#94a3b8"/>`
    : "";
  const col =
    opts.columns === "single"
      ? `<rect x="20" y="90" width="160" height="8" rx="2" fill="#e2e8f0"/><rect x="20" y="108" width="140" height="6" rx="2" fill="#e2e8f0"/><rect x="20" y="124" width="150" height="6" rx="2" fill="#e2e8f0"/>`
      : `<rect x="20" y="90" width="95" height="8" rx="2" fill="#e2e8f0"/><rect x="20" y="108" width="85" height="6" rx="2" fill="#e2e8f0"/><rect x="125" y="90" width="55" height="6" rx="2" fill="#e2e8f0"/><rect x="125" y="104" width="50" height="6" rx="2" fill="#e2e8f0"/>`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="520" viewBox="0 0 200 260">
  <rect width="200" height="260" fill="#fff"/>
  <rect width="200" height="72" fill="${opts.accent}"/>
  <text x="16" y="36" fill="#fff" font-family="Arial,sans-serif" font-size="14" font-weight="700">${escapeXml(opts.name.slice(0, 22))}</text>
  <text x="16" y="54" fill="#e2e8f0" font-family="Arial,sans-serif" font-size="8">${escapeXml(opts.department)}</text>
  ${photo}
  ${col}
  <text x="16" y="248" fill="#94a3b8" font-family="Arial,sans-serif" font-size="7">${opts.columns} · ${opts.hasPhoto ? "photo" : "no photo"}</text>
</svg>`;
  fs.writeFileSync(full, svg, "utf8");
  return path.posix.join("previews", name);
}

function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function fileKind(buf: Buffer): "png" | "jpeg" | "webp" | "pdf" | "svg" | "unknown" {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  const head = buf.subarray(0, 240).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return "unknown";
}

export function rejectUpload(kind: "pdf" | "preview", buf: Buffer): string | null {
  if (kind === "pdf") {
    if (buf.length > 15 * 1024 * 1024) return "PDF must be 15 MB or smaller";
    if (fileKind(buf) !== "pdf") return "Upload a real PDF file";
    return null;
  }
  if (buf.length > 8 * 1024 * 1024) return "Image must be 8 MB or smaller";
  const detected = fileKind(buf);
  if (detected === "svg" || /<script|javascript:|onload\s*=/i.test(buf.toString("utf8"))) {
    return "SVG and script files are blocked";
  }
  if (detected !== "png" && detected !== "jpeg" && detected !== "webp") {
    return "Use a PNG, JPEG, or WebP image";
  }
  return null;
}

export function publicUploadUrl(rel: string) {
  return joinUrl(env.publicBaseUrl, "uploads", rel);
}
