import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Resolve a Chrome/Chromium binary for Puppeteer PDF export. */
export function resolveChromeExecutable(): string | undefined {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";

  const candidates = [
    // Windows: Google Chrome / Edge
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* skip */
    }
  }

  // Puppeteer cache (default + common Windows paths)
  const cacheRoots = [
    process.env.PUPPETEER_CACHE_DIR,
    path.join(home, ".cache", "puppeteer"),
    path.join(localAppData, "puppeteer"),
    path.join(os.tmpdir(), "puppeteer"),
  ].filter(Boolean) as string[];

  for (const root of cacheRoots) {
    const chromeDir = path.join(root, "chrome");
    if (!fs.existsSync(chromeDir)) continue;
    try {
      const versions = fs.readdirSync(chromeDir);
      for (const ver of versions) {
        const win = path.join(chromeDir, ver, "chrome-win64", "chrome.exe");
        const mac = path.join(
          chromeDir,
          ver,
          "chrome-mac-x64",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing"
        );
        const linux = path.join(chromeDir, ver, "chrome-linux64", "chrome");
        for (const p of [win, mac, linux]) {
          if (fs.existsSync(p)) return p;
        }
      }
    } catch {
      /* skip */
    }
  }

  // Also scan PUPPETEER default cache under TEMP (Cursor sandbox, etc.)
  try {
    const temp = os.tmpdir();
    const sandbox = path.join(temp, "cursor-sandbox-cache");
    if (fs.existsSync(sandbox)) {
      for (const hash of fs.readdirSync(sandbox)) {
        const chromeDir = path.join(sandbox, hash, "puppeteer", "chrome");
        if (!fs.existsSync(chromeDir)) continue;
        for (const ver of fs.readdirSync(chromeDir)) {
          const win = path.join(chromeDir, ver, "chrome-win64", "chrome.exe");
          if (fs.existsSync(win)) return win;
        }
      }
    }
  } catch {
    /* skip */
  }

  return undefined;
}
