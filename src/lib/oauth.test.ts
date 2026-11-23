import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeUrl,
  googleProfileFromIdToken,
  pkceChallenge,
  providerConfigured,
  readCookie,
  redirectUri,
  safeNextPath,
  stateCookie,
  type OAuthConfig,
} from "./oauth";

const cfg: OAuthConfig = {
  googleClientId: "gid.apps.googleusercontent.com",
  googleClientSecret: "gsecret",
  facebookAppId: "",
  facebookAppSecret: "",
  redirectBase: "https://devops.elevatesofts.com/",
  apiPublicPath: "/rb-api",
};

function jwt(claims: Record<string, unknown>) {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

test("SSO: a provider is configured only with both keys and a redirect base", () => {
  assert.equal(providerConfigured(cfg, "google"), true);
  assert.equal(providerConfigured(cfg, "facebook"), false);
  assert.equal(providerConfigured({ ...cfg, redirectBase: "" }, "google"), false);
});

test("SSO: redirect URIs go through the public /rb-api path", () => {
  assert.equal(redirectUri(cfg, "google"), "https://devops.elevatesofts.com/rb-api/auth/oauth/google/callback");
  assert.equal(redirectUri(cfg, "facebook"), "https://devops.elevatesofts.com/rb-api/auth/oauth/facebook/callback");
});

test("SSO: Google authorize URL carries state, nonce and an S256 PKCE challenge", () => {
  const url = new URL(authorizeUrl(cfg, "google", { state: "st", nonce: "nn", verifier: "vv" }));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("nonce"), "nn");
  assert.equal(url.searchParams.get("code_challenge"), pkceChallenge("vv"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
});

test("SSO: Google ID token claims are checked (aud, iss, exp, nonce)", () => {
  const now = Date.now();
  const good = {
    iss: "https://accounts.google.com",
    aud: cfg.googleClientId,
    exp: Math.floor(now / 1000) + 300,
    nonce: "n1",
    sub: "123",
    email: "A@B.com",
    email_verified: true,
    name: "Ann",
  };
  const profile = googleProfileFromIdToken(jwt(good), { clientId: cfg.googleClientId, nonce: "n1", now });
  assert.deepEqual(profile, { providerUserId: "123", email: "a@b.com", emailVerified: true, name: "Ann" });
  assert.equal(googleProfileFromIdToken(jwt({ ...good, aud: "other" }), { clientId: cfg.googleClientId, nonce: "n1", now }), null);
  assert.equal(googleProfileFromIdToken(jwt({ ...good, iss: "https://evil" }), { clientId: cfg.googleClientId, nonce: "n1", now }), null);
  assert.equal(googleProfileFromIdToken(jwt({ ...good, nonce: "x" }), { clientId: cfg.googleClientId, nonce: "n1", now }), null);
  assert.equal(googleProfileFromIdToken(jwt({ ...good, exp: 1 }), { clientId: cfg.googleClientId, nonce: "n1", now }), null);
  assert.equal(googleProfileFromIdToken("garbage", { clientId: cfg.googleClientId, nonce: "n1", now }), null);
});

test("SSO: only same-site relative next paths survive", () => {
  assert.equal(safeNextPath("/user/editor/abc?x=1"), "/user/editor/abc?x=1");
  assert.equal(safeNextPath("//evil.com"), "");
  assert.equal(safeNextPath("https://evil.com"), "");
  assert.equal(safeNextPath("/\\evil.com"), "");
  assert.equal(safeNextPath(undefined), "");
});

test("SSO: state cookie is HttpOnly, Lax, Secure and scoped to the OAuth routes", () => {
  const set = stateCookie(cfg, "abc", true);
  assert.match(set, /^rb_oauth_state=abc; Path=\/rb-api\/auth\/oauth; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/);
  assert.match(stateCookie(cfg, null, true), /Max-Age=0$/);
  assert.equal(readCookie("a=1; rb_oauth_state=abc%3D; b=2", "rb_oauth_state"), "abc=");
});
