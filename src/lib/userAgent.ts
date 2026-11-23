/**
 * Tiny offline user-agent parser for the admin "Users & Activity" view.
 * Good enough for browser / OS / device class; no dependency, no network.
 */
export type DeviceInfo = {
  browser: string;
  os: string;
  device: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
};

function ver(ua: string, re: RegExp): string {
  const m = re.exec(ua);
  return m && m[1] ? m[1].split(/[._]/)[0] : "";
}

function withVersion(name: string, version: string) {
  return version ? `${name} ${version}` : name;
}

export function parseUserAgent(raw: string | null | undefined): DeviceInfo {
  const ua = String(raw || "").slice(0, 400);
  if (!ua) return { browser: "Unknown", os: "Unknown", device: "unknown" };

  if (/bot|crawler|spider|crawling|headlesschrome|curl\/|wget\/|python-requests|httpclient|postman/i.test(ua)) {
    const name = /HeadlessChrome/i.test(ua) ? "Headless Chrome" : /curl\//i.test(ua) ? "curl" : "Bot";
    return { browser: name, os: osOf(ua), device: "bot" };
  }

  return { browser: browserOf(ua), os: osOf(ua), device: deviceOf(ua) };
}

function browserOf(ua: string): string {
  if (/Edg(e|A|iOS)?\//.test(ua)) return withVersion("Edge", ver(ua, /Edg(?:e|A|iOS)?\/([\d.]+)/));
  if (/OPR\/|Opera/.test(ua)) return withVersion("Opera", ver(ua, /(?:OPR|Opera)\/([\d.]+)/));
  if (/SamsungBrowser\//.test(ua)) return withVersion("Samsung Internet", ver(ua, /SamsungBrowser\/([\d.]+)/));
  if (/YaBrowser\//.test(ua)) return withVersion("Yandex", ver(ua, /YaBrowser\/([\d.]+)/));
  if (/Brave\//.test(ua)) return withVersion("Brave", ver(ua, /Brave\/([\d.]+)/));
  if (/Firefox\/|FxiOS\//.test(ua)) return withVersion("Firefox", ver(ua, /(?:Firefox|FxiOS)\/([\d.]+)/));
  if (/CriOS\//.test(ua)) return withVersion("Chrome", ver(ua, /CriOS\/([\d.]+)/));
  if (/Chrome\/|Chromium\//.test(ua)) return withVersion("Chrome", ver(ua, /(?:Chrome|Chromium)\/([\d.]+)/));
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return withVersion("Safari", ver(ua, /Version\/([\d.]+)/));
  if (/MSIE |Trident\//.test(ua)) return "Internet Explorer";
  return "Other";
}

function osOf(ua: string): string {
  if (/Windows NT 10/.test(ua)) return "Windows";
  if (/Windows NT/.test(ua)) return "Windows (old)";
  if (/iPhone|iPod/.test(ua)) return withVersion("iOS", ver(ua, /OS ([\d_]+) like Mac/));
  if (/iPad/.test(ua)) return withVersion("iPadOS", ver(ua, /OS ([\d_]+) like Mac/));
  if (/Android/.test(ua)) return withVersion("Android", ver(ua, /Android ([\d.]+)/));
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Other";
}

function deviceOf(ua: string): DeviceInfo["device"] {
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|Opera Mini|IEMobile/i.test(ua)) return "mobile";
  if (/Windows|Macintosh|X11|Linux|CrOS/.test(ua)) return "desktop";
  return "unknown";
}
