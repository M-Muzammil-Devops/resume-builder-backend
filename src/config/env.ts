import "dotenv/config";
import { isLoopbackUrl, originOf, stripTrailingSlash, weakSecretReason } from "../lib/urls";

function bool(v: string | undefined, fallback = false) {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(v: string | undefined, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const apiPort = num(process.env.API_PORT, 4000);
/** Public site origin (the tunnel / domain). Every user-facing link is built from this. */
const appUrl = stripTrailingSlash(process.env.APP_URL);
const appOrigin = originOf(appUrl);
/** Path under the public site where Next proxies the API (see frontend/next.config.ts rewrites). */
const apiPublicPath = "/" + (process.env.API_PUBLIC_PATH || "rb-api").replace(/^\/+|\/+$/g, "");

/** Central env config — every runtime knob comes from process.env */
export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  apiPort,
  databaseUrl: process.env.DATABASE_URL || "",
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  /** Comma-separated allowed browser origins. Defaults to the APP_URL origin. */
  corsOrigin:
    (process.env.CORS_ORIGIN || "")
      .split(",")
      .map((o) => stripTrailingSlash(o))
      .filter(Boolean)
      .join(",") || appOrigin || "http://localhost:3000",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  uploadDir: process.env.UPLOAD_DIR || "uploads",
  /** Public base of the API as seen by browsers (used for /uploads links). */
  publicBaseUrl:
    stripTrailingSlash(process.env.PUBLIC_BASE_URL) ||
    (appUrl ? `${appUrl}${apiPublicPath}` : `http://localhost:${apiPort}`),
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  redisEnabled: bool(process.env.REDIS_ENABLED, false),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  redisTtlSeconds: num(process.env.REDIS_TTL_SECONDS, 300),
  adminEmail: process.env.ADMIN_EMAIL || "linux00011@gmail.com",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  seedDemoUser: String(process.env.SEED_DEMO_USER || "false").toLowerCase() === "true",
  demoPassword: process.env.DEMO_PASSWORD || "",
  adminName: process.env.ADMIN_NAME || "Admin",
  chromePath: process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "",
  appUrl,
  /** Public frontend URL (links). Defaults to APP_URL. */
  frontendUrl: stripTrailingSlash(process.env.FRONTEND_URL) || appUrl || "http://127.0.0.1:3000",
  /** Internal URL Puppeteer loads for PDF rendering. Never put this in user-facing output. */
  printBaseUrl: stripTrailingSlash(process.env.PRINT_BASE_URL) || "http://127.0.0.1:3000",
  smtpHost: process.env.SMTP_HOST || process.env.SMTP_ADDRESS || "",
  smtpPort: num(process.env.SMTP_PORT, 587),
  smtpUser: process.env.SMTP_USER || process.env.SMTP_USERNAME || "",
  // Pasted app passwords often carry a trailing space or newline.
  smtpPass: (process.env.SMTP_PASS || process.env.SMTP_PASSWORD || "").trim(),
  smtpFrom: process.env.SMTP_FROM || process.env.MAIL_FROM || process.env.ADMIN_EMAIL || "noreply@localhost",
  /** Fastify trustProxy: the hops whose X-Forwarded-For is believed (host nginx on loopback). */
  trustProxy: process.env.TRUST_PROXY || "127.0.0.1,::1",
  /** Offline DB-IP City Lite database (npm run geoip:update). */
  geoipDbPath: process.env.GEOIP_DB_PATH || "data/geoip/dbip-city-lite.mmdb",
  geoipIdleMs: num(process.env.GEOIP_IDLE_MS, 10 * 60_000),
  smtpRequireTls: bool(process.env.SMTP_REQUIRE_TLS ?? process.env.SMTP_ENABLE_STARTTLS_AUTO, true),
  /** Path under the public site that reaches this API (nginx /rb-api/ -> backend). */
  apiPublicPath,
  /** SSO (optional). A provider's button shows only when both of its keys are set. */
  googleClientId: (process.env.GOOGLE_CLIENT_ID || "").trim(),
  googleClientSecret: (process.env.GOOGLE_CLIENT_SECRET || "").trim(),
  facebookAppId: (process.env.FACEBOOK_APP_ID || "").trim(),
  facebookAppSecret: (process.env.FACEBOOK_APP_SECRET || "").trim(),
  /** Public origin the provider redirects back to (defaults to APP_URL). */
  oauthRedirectBase: stripTrailingSlash(process.env.OAUTH_REDIRECT_BASE) || appUrl,
};

/** Secrets checked at startup. Names only — values are never logged. */
const SECRET_KEYS = ["JWT_SECRET", "JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET", "COOKIE_SECRET", "SESSION_SECRET"];

export const MIN_ADMIN_PASSWORD = 12;

export function assertEnv() {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (!env.isProd) return;
  const problems: string[] = [];
  if (!env.adminPassword) {
    problems.push("ADMIN_PASSWORD is missing (set it in .env; there is no default)");
  } else if (env.adminPassword.length < MIN_ADMIN_PASSWORD) {
    problems.push(`ADMIN_PASSWORD is shorter than ${MIN_ADMIN_PASSWORD} characters`);
  }
  for (const key of SECRET_KEYS) {
    const value = process.env[key];
    // JWT_SECRET is mandatory; the others are checked only when set.
    if (key !== "JWT_SECRET" && value === undefined) continue;
    const reason = weakSecretReason(value);
    if (reason) problems.push(`${key} ${reason}`);
  }
  if (problems.length) {
    throw new Error(
      `Refusing to start in production: ${problems.join("; ")}. Set a random secret of at least 32 characters in backend/.env.`
    );
  }
  if (!env.appUrl || isLoopbackUrl(env.appUrl)) {
    console.warn("[env] APP_URL is unset or loopback; public links may not work outside this machine.");
  }
}
