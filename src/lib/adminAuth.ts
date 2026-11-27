import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma";
import { adminAccessFor, allowed, permissionFor, type AdminAccess } from "./adminAccess";

export type AdminUser = { id: string; email: string; role: string; name: string | null };

declare module "fastify" {
  interface FastifyRequest {
    /** Set by adminGuard on every route inside the /admin router. */
    adminUser?: AdminUser;
    /** Role + permissions of the admin (owner or Manage Team member). */
    adminAccess?: AdminAccess;
  }
}

export const ADMIN_ROLE = "admin";

export function isAdminRole(role: string | null | undefined): boolean {
  return role === ADMIN_ROLE;
}

const PERMISSION_LABEL: Record<string, string> = {
  canRead: "read",
  canWrite: "write",
  canDelete: "delete",
  canBilling: "billing",
  canSystem: "system",
  superAdmin: "Super Admin",
};

/**
 * Router-level guard for the /admin API. It runs as an onRequest hook on the whole
 * admin plugin, so no admin handler can run without a valid, non-revoked session
 * whose user currently has admin access in the database (the JWT role claim is
 * not trusted on its own): an owner (role "admin") or an active Manage Team member.
 * Each request is then checked against the member's Read / Write / Delete / Billing / System permissions.
 */
export function adminGuard(app: FastifyInstance) {
  return async function adminGuardHook(request: FastifyRequest, reply: FastifyReply) {
    await app.authenticate(request, reply);
    if (reply.sent) return reply;

    const user = await prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { id: true, email: true, role: true, name: true, status: true },
    });

    const access = user && user.status === "ACTIVE" ? await adminAccessFor(user) : null;
    if (!user || !access) {
      request.log.warn({ userId: request.user.userId }, "admin access denied");
      return reply.code(403).send({ error: "Admin access required" });
    }

    const missing = allowed(access, permissionFor(request.method, request.routeOptions?.url || request.url));
    if (missing) {
      request.log.warn({ userId: user.id, missing, url: request.url }, "admin permission denied");
      return reply
        .code(403)
        .send({ error: `Your team role does not include ${PERMISSION_LABEL[missing] || missing} access.`, code: "PERMISSION_DENIED" });
    }

    request.adminUser = { id: user.id, email: user.email, role: user.role, name: user.name };
    request.adminAccess = access;
  };
}

/** The admin resolved by adminGuard. Throws if a route was mounted outside the guard. */
export function adminOf(request: FastifyRequest): AdminUser {
  if (!request.adminUser) throw new Error("admin route mounted without adminGuard");
  return request.adminUser;
}

/** True when the user may open the admin console (owner or active/invited team member). */
export async function hasAdminAccess(user: { id: string; email: string; role: string; status?: string }): Promise<boolean> {
  if (user.status && user.status !== "ACTIVE") return false;
  return Boolean(await adminAccessFor(user));
}
