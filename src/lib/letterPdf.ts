import { resolveChromeExecutable } from "./chrome";

/**
 * Batch 2: business-letter PDF from self-contained HTML (no scripts, no network).
 * Uses the same Chrome as the resume PDF export.
 */
export async function pdfFromHtml(html: string, pageSize: "A4" | "US Letter" = "A4"): Promise<Buffer> {
  const puppeteer = await import("puppeteer");
  const executablePath = resolveChromeExecutable();
  const browser = await puppeteer.default.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    // Only the inline document itself; nothing can be fetched.
    page.on("request", (req) => (req.url().startsWith("data:") || req.url() === "about:blank" ? req.continue() : req.abort()));
    await page.setContent(html, { waitUntil: "load", timeout: 20000 });
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      width: pageSize === "US Letter" ? "8.5in" : "210mm",
      height: pageSize === "US Letter" ? "11in" : "297mm",
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
