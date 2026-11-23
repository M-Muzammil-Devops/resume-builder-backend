import { createHash, createHmac, randomBytes } from "crypto";
import { stripTrailingSlash } from "./urls";

/** Google (OIDC, auth code + PKCE) and Facebook (OAuth 2.0 code flow). Both run server-side. */
export type OAuthProvider = "google" | "facebook";
export const OAUTH_PROVIDERS: OAuthProvider[] = ["google", "facebook"];

export type OAuthConfig = {
  googleClientId: string;
  googleClientSecret: string;
  facebookAppId: string;
  facebookAppSecret: string;
  /** Public site origin, e.g. https://devops.elevatesofts.com */
  redirectBase: string;
  /** Path the site proxies to the API, e.g. /rb-api */
  apiPublicPath: string;
};

export const FACEBOOK_GRAPH = "https://graph.facebook.com/v19.0";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as string[]).includes(value);
}

export function providerConfigured(cfg: OAuthConfig, provider: OAuthProvider): boolean {
  if (!cfg.redirectBase) return false;
  return provider === "google"
    ? Boolean(cfg.googleClientId && cfg.googleClientSecret)
    : Boolean(cfg.facebookAppId && cfg.facebookAppSecret);
}

/** The exact redirect URI to register with the provider. */
export function redirectUri(cfg: OAuthConfig, provider: OAuthProvider): string {
  const base = stripTrailingSlash(cfg.redirectBase);
  const prefix = "/" + cfg.apiPublicPath.replace(/^\/+|\/+$/g, "");
  return `${base}${prefix === "/" ? "" : prefix}/auth/oauth/${provider}/callback`;
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function authorizeUrl(
  cfg: OAuthConfig,
  provider: OAuthProvider,
  opts: { state: string; nonce: string; verifier: string }
): string {
  if (provider === "google") {
    const params = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: redirectUri(cfg, provider),
      response_type: "code",
      scope: "openid email profile",
      state: opts.state,
      nonce: opts.nonce,
      code_challenge: pkceChallenge(opts.verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }
  const params = new URLSearchParams({
    client_id: cfg.facebookAppId,
    redirect_uri: redirectUri(cfg, provider),
    response_type: "code",
    scope: "email,public_profile",
    state: opts.state,
  });
  return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
}

/** Decode a JWT payload without verifying the signature (the token came straight from Google over TLS). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type ProviderProfile = { providerUserId: string; email: string; emailVerified: boolean; name: string };

/**
 * OIDC Core 3.1.3.7 checks for an ID token received directly from the token endpoint over TLS:
 * issuer, audience, expiry and our nonce. Returns null on any mismatch.
 */
export function googleProfileFromIdToken(
  idToken: string,
  expect: { clientId: string; nonce: string; now?: number }
): ProviderProfile | null {
  const claims = decodeJwtPayload(idToken);
  if (!claims) return null;
  const now = Math.floor((expect.now ?? Date.now()) / 1000);
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(expect.clientId) : aud === expect.clientId;
  if (!audOk) return null;
  if (!GOOGLE_ISSUERS.includes(String(claims.iss))) return null;
  if (typeof claims.exp !== "number" || claims.exp < now - 60) return null;
  if (!expect.nonce || claims.nonce !== expect.nonce) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  return {
    providerUserId: claims.sub,
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: typeof claims.name === "string" ? claims.name : "",
  };
}

/** Facebook's appsecret_proof for Graph calls. */
export function appSecretProof(accessToken: string, appSecret: string) {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

/** Only same-site relative paths survive as the post-login destination. */
export function safeNextPath(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 300) return "";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "";
  if (/[\u0000-\u001f\\]/.test(raw)) return "";
  return raw;
}

/** Name of the short-lived cookie that binds the OAuth state to the browser that started it. */
export const OAUTH_STATE_COOKIE = "rb_oauth_state";

export function stateCookie(cfg: OAuthConfig, value: string | null, secure: boolean) {
  const prefix = "/" + cfg.apiPublicPath.replace(/^\/+|\/+$/g, "");
  const path = `${prefix === "/" ? "" : prefix}/auth/oauth`;
  const base = `${OAUTH_STATE_COOKIE}=${value ? encodeURIComponent(value) : ""}; Path=${path}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return value ? `${base}; Max-Age=600` : `${base}; Max-Age=0`;
}

export function readCookie(header: unknown, name: string): string {
  const raw = typeof header === "string" ? header : "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return "";
      }
    }
  }
  return "";
}
