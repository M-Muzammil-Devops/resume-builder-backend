import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { lookupIp } from "./geoip";
import { parseUserAgent } from "./userAgent";

/**
 * Login events are written by the auth routes with the raw ip + user-agent. This fills in
 * city / region / country (offline DB-IP lookup) and browser / OS / device class, in batches,
 * right before the admin reads them. Any login path that creates a LoginEvent is covered.
 */
export async function enrichPendingLoginEvents(limit = 500): Promise<number> {
  const rows = await prisma.loginEvent.findMany({
    where: { enrichedAt: null },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, ip: true, userAgent: true, country: true, city: true },
  });
  for (const row of rows) {
    const geo = await lookupIp(row.ip);
    const dev = parseUserAgent(row.userAgent);
    await prisma.loginEvent.update({
      where: { id: row.id },
      data: {
        // The geo DB wins over the location a client typed at sign-in.
        city: geo.city ?? row.city,
        region: geo.region,
        country: geo.country ?? row.country,
        countryCode: geo.countryCode,
        browser: dev.browser,
        os: dev.os,
        device: dev.device,
        enrichedAt: new Date(),
      },
    });
  }
  return rows.length;
}

export type ActivityFilters = {
  search?: string;
  from?: Date;
  to?: Date;
  country?: string;
  device?: string;
  userId?: string;
};

export function activityWhere(f: ActivityFilters): Prisma.LoginEventWhereInput {
  const where: Prisma.LoginEventWhereInput = {};
  if (f.userId) where.userId = f.userId;
  if (f.from || f.to) where.createdAt = { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) };
  if (f.country) where.country = f.country === "Unknown" ? null : f.country;
  if (f.device) where.device = f.device;
  const q = f.search?.trim();
  if (q) {
    where.OR = [
      { user: { email: { contains: q, mode: "insensitive" } } },
      { user: { name: { contains: q, mode: "insensitive" } } },
      { ip: { startsWith: q } },
      { city: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

/** "to" given as a plain date means the whole day. */
export function parseDateBound(value: string | undefined, end: boolean): Date | undefined {
  if (!value) return undefined;
  const plainDay = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(plainDay ? `${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z` : value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** RFC 4180 cell, with spreadsheet formula injection neutralised. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
