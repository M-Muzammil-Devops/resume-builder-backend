function isLoopbackHost(host: string) {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "[::1]";
}

/**
 * Public links come from APP_URL. A loopback APP_URL is ignored so emails
 * are not pointed at the machine that happens to be running the API.
 * The request host is used only when it is not loopback and APP_URL is unset.
 */
export function resolvePublicAppUrl(input: {
  appUrl?: string;
  fallback?: string;
  forwardedHost?: string;
  forwardedProto?: string;
  host?: string;
}): string {
  const configured = (input.appUrl || "").trim().replace(/\/+$/, "");
  if (configured) {
    try {
      const host = new URL(configured.includes("://") ? configured : `https://${configured}`).host;
      if (!isLoopbackHost(host)) return configured;
    } catch {
      /* ignore a bad APP_URL and fall through */
    }
  }
  const rawHost = (input.forwardedHost || input.host || "").split(",")[0].trim();
  if (rawHost && !isLoopbackHost(rawHost)) {
    const proto = (input.forwardedProto || "https").split(",")[0].trim() === "http" ? "http" : "https";
    return `${proto}://${rawHost}`;
  }
  return (configured || input.fallback || "").trim().replace(/\/+$/, "");
}
