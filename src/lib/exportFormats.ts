import { readFile } from "node:fs/promises";
import path from "node:path";
import { AlignmentType, Document, ExternalHyperlink, ImageRun, Packer, Paragraph, TextRun } from "docx";
import { isKnownSamplePhoto } from "./samplePhotos";

export type ExportFormat = "pdf" | "docx" | "txt";

export const EXPORT_MIME: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
};

/** Accept ?format= or body.format; default PDF. Unknown values return null (400). */
export function parseExportFormat(raw: unknown): ExportFormat | null {
  if (raw === undefined || raw === null || raw === "") return "pdf";
  const value = String(raw).trim().toLowerCase();
  if (value === "pdf" || value === "docx" || value === "txt") return value;
  return null;
}

function paragraph(line: string, font: string) {
  const trimmed = line.trim();
  const heading = /^[A-Z][A-Z0-9\s/&+-]{2,}$/.test(trimmed);
  if (/^https?:\/\/\S+$/i.test(trimmed) || /^mailto:\S+$/i.test(trimmed)) {
    return new Paragraph({
      spacing: { after: 80 },
      children: [
        new ExternalHyperlink({
          link: trimmed,
          children: [new TextRun({ text: trimmed, font, style: "Hyperlink" })],
        }),
      ],
    });
  }
  return new Paragraph({
    spacing: { after: heading ? 120 : 60 },
    children: [new TextRun({ text: line || " ", bold: heading, font, size: heading ? 24 : 21 })],
  });
}

/** A header photo ready for DOCX: PNG bytes plus the slot size in CSS pixels (BUG-1296). */
export interface DocxPhoto {
  data: Buffer;
  width: number;
  height: number;
}

function photoParagraph(photo?: DocxPhoto | null): Paragraph[] {
  if (!photo) return [];
  return [
    new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 120 },
      children: [new ImageRun({ type: "png", data: photo.data, transformation: { width: photo.width, height: photo.height } })],
    }),
  ];
}

/** Locations of the frontend public folder that holds /templates/photos/<id>.webp. */
function samplePhotoPaths(url: string): string[] {
  const rel = url.replace(/^\//, "");
  const dirs = [process.env.FRONTEND_PUBLIC_DIR, path.resolve(process.cwd(), "..", "resume-builder-frontend", "public")];
  return dirs.filter((d): d is string => Boolean(d)).map((d) => path.join(d, rel));
}

/**
 * BUG-1296: bytes of a header photo (an uploaded data URL or a real sample photo) as a square-cropped PNG
 * of the slot size, or null when it cannot be read. DOCX cannot hold WebP, so everything is re-encoded.
 */
export async function loadDocxPhoto(photoUrl: string, width: number, height: number): Promise<DocxPhoto | null> {
  try {
    let source: Buffer | null = null;
    const data = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(photoUrl);
    if (data) source = Buffer.from(data[1], "base64");
    else if (isKnownSamplePhoto(photoUrl)) {
      for (const file of samplePhotoPaths(photoUrl)) {
        try {
          source = await readFile(file);
          break;
        } catch {
          /* try the next location */
        }
      }
    }
    if (!source) return null;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const sharp = (await import("sharp")).default;
    const png = await sharp(source, { limitInputPixels: 40_000_000 })
      .resize(w * 2, h * 2, { fit: "cover" })
      .png()
      .toBuffer();
    return { data: png, width: w, height: h };
  } catch {
    return null;
  }
}

/** Server-side DOCX from the same plain text the TXT export uses. */
export async function docxFromText(
  text: string,
  options: { pageSize: "A4" | "US Letter"; fontFamily?: string; photo?: DocxPhoto | null }
): Promise<Buffer> {
  const letter = options.pageSize === "US Letter";
  const font = options.fontFamily || "Calibri";
  const file = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: letter ? 12240 : 11906, height: letter ? 15840 : 16838 },
            margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
          },
        },
        children: [...photoParagraph(options.photo), ...text.split("\n").map((line) => paragraph(line, font))],
      },
    ],
  });
  return Packer.toBuffer(file);
}

/** Raised when the print page reports an error or never becomes ready. */
export class PrintRenderError extends Error {
  constructor(message: string, public readonly pageLog: string[]) {
    super(message);
    this.name = "PrintRenderError";
  }
}

/** Public error text for a failed export. Never includes stack traces, paths or tokens. */
export function exportErrorBody(err: unknown): { error: string; message: string } {
  const message = err instanceof Error ? err.message : "";
  if (/Could not find Chrome|Failed to launch/i.test(message)) {
    return { error: "PDF export failed", message: "The PDF renderer is not available on the server. Contact support." };
  }
  if (err instanceof PrintRenderError) {
    return { error: "PDF export failed", message: err.message };
  }
  return { error: "PDF export failed", message: "The PDF could not be created. Please try again." };
}
