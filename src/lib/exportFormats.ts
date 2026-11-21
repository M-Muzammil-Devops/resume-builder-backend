import { Document, ExternalHyperlink, Packer, Paragraph, TextRun } from "docx";

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

/** Server-side DOCX from the same plain text the TXT export uses. */
export async function docxFromText(
  text: string,
  options: { pageSize: "A4" | "US Letter"; fontFamily?: string }
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
        children: text.split("\n").map((line) => paragraph(line, font)),
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
