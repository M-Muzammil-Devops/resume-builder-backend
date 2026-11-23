import test from "node:test";
import assert from "node:assert/strict";
import { parseUserAgent } from "./userAgent";

test("parses common desktop and mobile user agents", () => {
  const chromeWin = parseUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  assert.deepEqual(chromeWin, { browser: "Chrome 131", os: "Windows", device: "desktop" });

  const edge = parseUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70"
  );
  assert.equal(edge.browser, "Edge 131");

  const iphone = parseUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
  );
  assert.deepEqual(iphone, { browser: "Safari 17", os: "iOS 17", device: "mobile" });

  const android = parseUserAgent(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  );
  assert.deepEqual(android, { browser: "Chrome 131", os: "Android 14", device: "mobile" });

  const tablet = parseUserAgent(
    "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  assert.equal(tablet.device, "tablet");

  const firefoxMac = parseUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:132.0) Gecko/20100101 Firefox/132.0"
  );
  assert.deepEqual(firefoxMac, { browser: "Firefox 132", os: "macOS", device: "desktop" });
});

test("bots and empty values", () => {
  assert.equal(parseUserAgent("curl/8.5.0").device, "bot");
  assert.equal(parseUserAgent("Googlebot/2.1 (+http://www.google.com/bot.html)").device, "bot");
  assert.deepEqual(parseUserAgent(""), { browser: "Unknown", os: "Unknown", device: "unknown" });
  assert.deepEqual(parseUserAgent(null), { browser: "Unknown", os: "Unknown", device: "unknown" });
});
