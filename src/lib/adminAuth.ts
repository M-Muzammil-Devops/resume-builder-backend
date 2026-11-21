import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma";

export type AdminUser = { id: string; email: string; role: string; name: string | null };

declare module "fastify" {
  interface FastifyRequest {
    /** Set by adminGuard on every route inside the /admin router. */
    adminUser?: AdminUser;
  }
}

export const ADMIN_ROLE = "admin";

export function isAdminRole(role: string | null | undefined): boolean {
  return role === ADMIN_ROLE;
}

/**
 * Router-level guard for the /admin API. It runs as an onRequest hook on the whole
 * admin plugin, so no admin handler can run without a valid, non-revoked session
 * whose user currently has the admin role in the database (the JWT role claim is
 * not trusted on its own).
 */
export function adminGuard(app: FastifyInstance) {
  return async function adminGuardHook(request: FastifyRequest, reply: FastifyReply) {
    await app.authenticate(request, reply);
    if (reply.sent) return reply;

    const user = await prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { id: true, email: true, role: true, name: true },
    });

    if (!user || !isAdminRole(user.role)) {
      request.log.warn({ userId: request.user.userId }, "admin access denied");
      return reply.code(403).send({ error: "Admin access required" });
    }

    request.adminUser = user;
  };
}

/** The admin resolved by adminGuard. Throws if a route was mounted outside the guard. */
export function adminOf(request: FastifyRequest): AdminUser {
  if (!request.adminUser) throw new Error("admin route mounted without adminGuard");
  return request.adminUser;
}