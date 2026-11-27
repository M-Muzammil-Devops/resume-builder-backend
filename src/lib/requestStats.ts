import { prisma } from "../prisma";

/**
 * API request / error counters per UTC hour. Counted in memory on every response and flushed to
 * RequestStat once a minute (one upsert per hour bucket), so the hot path never waits on the DB.
 */
const pending = new Map<number, { total: number; errors: number }>();
let timer: NodeJS.Timeout | null = null;

function hourBucket(now = Date.now()): number {
  return Math.floor(now / 3_600_000) * 3_600_000;
}

export function countRequest(status: number, url: string) {
  // Health probes and static uploads would only dilute the rate.
  if (url === "/health" || url.startsWith("/uploads/")) return;
  const key = hourBucket();
  const slot = pending.get(key) || { total: 0, errors: 0 };
  slot.total += 1;
  if (status >= 500) slot.errors += 1;
  pending.set(key, slot);
}

export async function flushRequestStats() {
  if (!pending.size) return;
  const batch = [...pending.entries()];
  pending.clear();
  for (const [bucket, v] of batch) {
    try {
      await prisma.requestStat.upsert({
        where: { bucket: new Date(bucket) },
        create: { bucket: new Date(bucket), total: v.total, errors: v.errors },
        update: { total: { increment: v.total }, errors: { increment: v.errors } },
      });
    } catch {
      // DB briefly unavailable: keep the counts for the next flush.
      const slot = pending.get(bucket) || { total: 0, errors: 0 };
      slot.total += v.total;
      slot.errors += v.errors;
      pending.set(bucket, slot);
    }
  }
}

export function startRequestStats() {
  if (timer) return;
  timer = setInterval(() => void flushRequestStats(), 60_000);
  timer.unref();
}

export async function stopRequestStats() {
  if (timer) clearInterval(timer);
  timer = null;
  await flushRequestStats();
}

/** Unflushed counts since `since` (added to the DB totals so the rate is live). */
export function pendingSince(since: Date): { total: number; errors: number } {
  let total = 0;
  let errors = 0;
  for (const [bucket, v] of pending) {
    if (bucket + 3_600_000 > since.getTime()) {
      total += v.total;
      errors += v.errors;
    }
  }
  return { total, errors };
}
