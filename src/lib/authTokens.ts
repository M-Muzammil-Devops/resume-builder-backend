import { createHash, randomBytes } from "crypto";
import { prisma } from "../prisma";
import { cacheGet, cacheSet } from "./redis";

export type TokenPurpose = "verify" | "reset" | "refresh";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** How many unused verify links stay valid at once (BUG-1407). */
const VERIFY_LINKS_KEPT = 5;

export async function issueAuthToken(userId: string, purpose: TokenPurpose, hours: number) {
  if (purpose === "verify") {
    // BUG-1407: a new verify email must not kill the link in an earlier one (emails arrive late,
    // land in spam or get threaded). Keep the newest few unused links; all die once one is used.
    await prisma.authToken.deleteMany({
      where: { userId, purpose, OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date() } }] },
    });
    const keep = await prisma.authToken.findMany({
      where: { userId, purpose, usedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true },
      take: VERIFY_LINKS_KEPT - 1,
    });
    await prisma.authToken.deleteMany({
      where: { userId, purpose, usedAt: null, id: { notIn: keep.map((row) => row.id) } },
    });
  } else {
    // A newer reset link replaces the older one.
    await prisma.authToken.deleteMany({ where: { userId, purpose, usedAt: null } });
  }
  const token = randomBytes(32).toString("base64url");
  await prisma.authToken.create({
    data: {
      userId,
      purpose,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
    },
  });
  return token;
}

export async function consumeAuthToken(token: string, purpose: TokenPurpose) {
  const tokenHash = hashToken(token);
  const row = await prisma.authToken.findUnique({ where: { tokenHash } });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    return null;
  }
  await prisma.authToken.update({
    where: { id: row.id },
    data: { usedAt: new Date() },
  });
  return row;
}

/** True when a token of this purpose was issued for the user within the last `minutes`. */
export async function recentAuthToken(userId: string, purpose: TokenPurpose, minutes: number) {
  const row = await prisma.authToken.findFirst({
    where: { userId, purpose, usedAt: null, createdAt: { gt: new Date(Date.now() - minutes * 60 * 1000) } },
    select: { id: true },
  });
  return Boolean(row);
}

/** Mark every unused token of this purpose as used (after a successful verify/reset). */
export async function invalidateAuthTokens(userId: string, purpose: TokenPurpose) {
  await prisma.authToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
}

export async function issueRefreshToken(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await prisma.authToken.create({
    data: {
      userId,
      purpose: "refresh",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  return token;
}

export async function revokeUserSessions(userId: string) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { sessionEpoch: { increment: 1 } },
    select: { sessionEpoch: true },
  });
  await prisma.authToken.updateMany({
    where: { userId, purpose: "refresh", usedAt: null },
    data: { usedAt: new Date() },
  });
  return user.sessionEpoch;
}

export async function revokeRefreshToken(token: string) {
  if (!token) return;
  await prisma.authToken.updateMany({
    where: { tokenHash: hashToken(token), purpose: "refresh", usedAt: null },
    data: { usedAt: new Date() },
  });
}

const revokedUntil = new Map<string, number>();

export async function revokeAccessJti(jti: string) {
  if (!jti) return;
  revokedUntil.set(jti, Date.now() + 16 * 60 * 1000);
  await cacheSet(`auth:revoked:${jti}`, true, 16 * 60);
}

export async function accessJtiRevoked(jti: string | undefined) {
  if (!jti) return false;
  const until = revokedUntil.get(jti);
  if (until && until > Date.now()) return true;
  if (until) revokedUntil.delete(jti);
  return Boolean(await cacheGet(`auth:revoked:${jti}`));
}
