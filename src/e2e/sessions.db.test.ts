/**
 * BUG-200 against the real database: after a password reset every refresh token is
 * revoked and the session epoch moves, so old access tokens fail app.authenticate.
 * Run: npm run test:db   (uses DATABASE_URL; creates and deletes one throwaway user)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../prisma";
import { consumeAuthToken, issueRefreshToken, revokeUserSessions } from "../lib/authTokens";

test("BUG-200 reset revokes refresh tokens and bumps the session epoch", { skip: !process.env.DATABASE_URL }, async () => {
  const user = await prisma.user.create({
    data: { email: `rb-db-test-${Date.now()}@example.invalid`, passwordHash: "x", role: "user" },
  });
  try {
    const before = user.sessionEpoch;
    const refresh = await issueRefreshToken(user.id);
    const epoch = await revokeUserSessions(user.id);
    assert.equal(epoch, before + 1, "old access tokens carry the old epoch and get 401");
    assert.equal(await consumeAuthToken(refresh, "refresh"), null, "old refresh token gets 401");
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});
