import assert from "node:assert/strict";
import { test } from "node:test";
import { __setRedisClientForTests, cacheDelPrefix, cacheGet, cacheSet } from "./redis";

function fakeRedis(store: Map<string, string>) {
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
    del: async (...ks: string[]) => void ks.forEach((k) => store.delete(k)),
    quit: async () => undefined,
    // two-page SCAN to exercise the cursor loop
    scan: async (cursor: string, _m: string, pattern: string) => {
      const prefix = pattern.replace(/\*$/, "");
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      return cursor === "0" ? (["1", keys.slice(0, 1)] as [string, string[]]) : (["0", keys] as [string, string[]]);
    },
  };
}

test("BUG-1317 cacheDelPrefix drops every landing-templates variant and nothing else", async () => {
  const store = new Map<string, string>();
  __setRedisClientForTests(fakeRedis(store));
  try {
    await cacheSet("landing:templates:v1:all:all:all", { templates: [1] });
    await cacheSet("landing:templates:v1:photo:single:Sales", { templates: [2] });
    await cacheSet("landing:templates:v1:none:double:all", { templates: [3] });
    await cacheSet("admin:stats:v1", { ok: true });
    await cacheDelPrefix("landing:templates:v1");
    assert.equal(await cacheGet("landing:templates:v1:all:all:all"), null);
    assert.equal(await cacheGet("landing:templates:v1:photo:single:Sales"), null);
    assert.equal(await cacheGet("landing:templates:v1:none:double:all"), null);
    assert.deepEqual(await cacheGet("admin:stats:v1"), { ok: true });
  } finally {
    __setRedisClientForTests(null);
  }
});

test("cacheDelPrefix is a no-op without redis", async () => {
  __setRedisClientForTests(null);
  await cacheDelPrefix("landing:templates:v1");
});

