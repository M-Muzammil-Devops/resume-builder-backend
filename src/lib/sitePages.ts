/** Public website pages (frontend sitemap.ts + the PDF tool pages in components/nav/tools.ts). */
export const SITE_PAGES = [
  "/",
  "/tools",
  "/tools/audio-noise-remover",
  "/login",
  "/register",
  "/forgot-password",
  "/privacy",
  "/terms",
  "/contact",
] as const;

export const PDF_TOOL_SLUGS = [
  "pdf-editor", "merge", "split", "compress", "repair", "ocr", "jpg-to-pdf", "word-to-pdf", "powerpoint-to-pdf",
  "excel-to-pdf", "html-to-pdf", "pdf-to-jpg", "pdf-to-word", "pdf-to-powerpoint", "pdf-to-excel", "pdf-to-pdfa",
  "rotate", "page-numbers", "watermark", "crop", "forms", "unlock", "protect", "sign", "redact", "compare",
] as const;

export const ALL_SITE_PAGES: string[] = [...SITE_PAGES, ...PDF_TOOL_SLUGS.map((s) => `/tools/pdf/${s}`)];
