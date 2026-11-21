import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePublicAppUrl } from "./publicUrl";

test("BUG-067 / BUG-100 prefers APP_URL and never invents loopback", () => {
  assert.equal(
    resolvePublicAppUrl({
      appUrl: "https://app.example.com",
      host: "127.0.0.1:3000",
    }),
    "https://app.example.com"
  );
  assert.equal(
    resolvePublicAppUrl({
      appUrl: "http://127.0.0.1:3000",
      forwardedHost: "app.example.com",
      forwardedProto: "https",
    }),
    "https://app.example.com"
  );
  assert.equal(resolvePublicAppUrl({ appUrl: "", host: "127.0.0.1:3000", fallback: "" }), "");
});
