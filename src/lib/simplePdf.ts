/**
 * Minimal single-page PDF writer (Helvetica, text + rules). Used for invoice receipts so the
 * admin download needs no headless browser. Text is limited to Latin-1; other characters become "?".
 */
type Line = { x: number; y: number; text: string; size?: number; bold?: boolean; color?: [number, number, number] };
type Rule = { x1: number; y1: number; x2: number; y2: number; color?: [number, number, number] };
type Box = { x: number; y: number; w: number; h: number; color: [number, number, number] };

function esc(text: string): string {
  return text
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

const rgb = (c: [number, number, number]) => c.map((v) => (v / 255).toFixed(3)).join(" ");

export function buildPdf(page: { lines: Line[]; rules?: Rule[]; boxes?: Box[] }): Buffer {
  const ops: string[] = [];
  for (const b of page.boxes || []) ops.push(`${rgb(b.color)} rg ${b.x} ${b.y} ${b.w} ${b.h} re f`);
  for (const r of page.rules || []) ops.push(`${rgb(r.color || [220, 224, 235])} RG 0.8 w ${r.x1} ${r.y1} m ${r.x2} ${r.y2} l S`);
  for (const l of page.lines) {
    ops.push(`BT /${l.bold ? "F2" : "F1"} ${l.size || 10} Tf ${rgb(l.color || [30, 35, 60])} rg ${l.x} ${l.y} Td (${esc(l.text)}) Tj ET`);
  }
  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
