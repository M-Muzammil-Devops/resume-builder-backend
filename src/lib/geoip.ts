import fs from "fs";
import path from "path";
import net from "net";
import type { CityResponse, Reader } from "maxmind";
import { env } from "../config/env";

/**
 * Offline IP geolocation from the free DB-IP "IP to City Lite" database (CC BY 4.0,
 * https://db-ip.com). Downloaded by `npm run geoip:update` into GEOIP_DB_PATH
 * (default data/geoip/dbip-city-lite.mmdb). No network call is ever made per request.
 *
 * The ~130 MB database is loaded lazily the first time a lookup is needed (admin activity
 * views enrich login events in batches) and released after GEOIP_IDLE_MS of no use, so it
 * does not sit in RAM on a small server.
 */
export type GeoResult = { city: string | null; region: string | null; country: string | null; countryCode: string | null };

const EMPTY: GeoResult = { city: null, region: null, country: null, countryCode: null };

let reader: Reader<CityResponse> | null = null;
let loading: Promise<Reader<CityResponse> | null> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let missingLogged = false;

export function geoDbPath(): string {
  return path.resolve(env.geoipDbPath);
}

export function geoDbAvailable(): boolean {
  try {
    return fs.statSync(geoDbPath()).size > 0;
  } catch {
    return false;
  }
}

/** Loopback, private, link-local and CGNAT addresses never resolve to a place. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/, "");
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(v)) {
    const low = v.toLowerCase();
    return low === "::1" || low === "::" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80");
  }
  return true;
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    reader = null;
    idleTimer = null;
  }, env.geoipIdleMs);
  idleTimer.unref?.();
}

async function getReader(): Promise<Reader<CityResponse> | null> {
  if (reader) {
    touch();
    return reader;
  }
  if (!geoDbAvailable()) {
    if (!missingLogged) {
      missingLogged = true;
      console.warn(`[geoip] ${geoDbPath()} not found; run "npm run geoip:update". Locations stay empty.`);
    }
    return null;
  }
  loading ??= (async () => {
    try {
      const maxmind = await import("maxmind");
      // watchForUpdates off: the refresh script swaps the file and the idle unload picks it up.
      reader = await maxmind.open<CityResponse>(geoDbPath(), { watchForUpdates: false, cache: { max: 2000 } });
      touch();
      return reader;
    } catch (err) {
      console.warn(`[geoip] could not open database: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export async function lookupIp(ip: string | null | undefined): Promise<GeoResult> {
  const value = String(ip || "").trim().replace(/^::ffff:/, "");
  if (!value || !net.isIP(value) || isPrivateIp(value)) return EMPTY;
  const db = await getReader();
  if (!db) return EMPTY;
  try {
    const hit = db.get(value);
    if (!hit) return EMPTY;
    return {
      city: hit.city?.names?.en ?? null,
      region: hit.subdivisions?.[0]?.names?.en ?? null,
      country: hit.country?.names?.en ?? null,
      countryCode: hit.country?.iso_code ?? null,
    };
  } catch {
    return EMPTY;
  }
}
