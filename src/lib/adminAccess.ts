import { prisma } from "../prisma";

/** Manage Team roles. SUPER_ADMIN can also manage the team itself. */
export const TEAM_ROLES = ["SUPER_ADMIN", "OPERATIONS", "SUPPORT", "ANALYST", "CUSTOM"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const TEAM_STATUSES = ["ACTIVE", "INVITED", "DISABLED"] as const;

export type AdminPermissions = {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canBilling: boolean;
  canSystem: boolean;
};

export type AdminAccess = AdminPermissions & {
  /** "owner" = a User with role "admin" (always full access); "team" = an AdminTeamMember row. */
  source: "owner" | "team";
  role: TeamRole;
  superAdmin: boolean;
  memberId: string | null;
};

export const FULL_PERMISSIONS: AdminPermissions = { canRead: true, canWrite: true, canDelete: true, canBilling: true, canSystem: true };

/** Default permission set for each role; CUSTOM starts read-only and is set per member. */
export function roleDefaults(role: TeamRole): AdminPermissions {
  switch (role) {
    case "SUPER_ADMIN":
      return { ...FULL_PERMISSIONS };
    case "OPERATIONS":
      return { canRead: true, canWrite: true, canDelete: true, canBilling: false, canSystem: true };
    case "SUPPORT":
      return { canRead: true, canWrite: true, canDelete: false, canBilling: false, canSystem: false };
    case "ANALYST":
    case "CUSTOM":
    default:
      return { canRead: true, canWrite: false, canDelete: false, canBilling: false, canSystem: false };
  }
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

/**
 * Resolves admin console access for a signed-in user, or null when they have none.
 * Owners (role "admin") always get full access. Team members get access through an ACTIVE or
 * INVITED row with their email (an INVITED row turns ACTIVE on first use). A SUPER_ADMIN member
 * always keeps every permission so the team can never be locked out.
 */
export async function adminAccessFor(user: { id: string; email: string; role: string }): Promise<AdminAccess | null> {
  if (user.role === "admin") {
    return { ...FULL_PERMISSIONS, source: "owner", role: "SUPER_ADMIN", superAdmin: true, memberId: null };
  }
  let member;
  try {
    member = await prisma.adminTeamMember.findUnique({ where: { email: user.email.toLowerCase() } });
  } catch {
    return null;
  }
  if (!member || member.status === "DISABLED") return null;
  const role: TeamRole = isTeamRole(member.role) ? member.role : "CUSTOM";
  const superAdmin = role === "SUPER_ADMIN";
  const perms: AdminPermissions = superAdmin
    ? { ...FULL_PERMISSIONS }
    : {
        canRead: true,
        canWrite: member.canWrite,
        canDelete: member.canDelete,
        canBilling: member.canBilling,
        canSystem: member.canSystem,
      };
  const now = new Date();
  const stale = !member.lastActiveAt || now.getTime() - member.lastActiveAt.getTime() > 5 * 60_000;
  if (member.status === "INVITED" || stale) {
    await prisma.adminTeamMember
      .update({ where: { id: member.id }, data: { status: "ACTIVE", lastActiveAt: now } })
      .catch(() => undefined);
  }
  return { ...perms, source: "team", role, superAdmin, memberId: member.id };
}

export type PermissionNeed = keyof AdminPermissions | "superAdmin" | null;

/**
 * Permission a request to the /admin API needs, from its method and path (path is after /admin).
 * Billing pages need canBilling; system pages (health, audit log, settings, consents) need canSystem;
 * the team section needs a Super Admin; DELETE needs canDelete, other writes canWrite, reads canRead.
 */
export function permissionFor(method: string, rawPath: string): PermissionNeed[] {
  const path = rawPath.split("?")[0].replace(/^.*?\/admin(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  if (path === "/me") return [];
  const m = method.toUpperCase();
  const write = m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
  const needs: PermissionNeed[] = ["canRead"];
  if (path.startsWith("/team")) return write ? ["canRead", "superAdmin"] : ["canRead", "canSystem"];
  if (path.startsWith("/billing")) needs.push("canBilling");
  if (path.startsWith("/health") || path.startsWith("/audit") || path.startsWith("/settings") || path.startsWith("/consents")) {
    needs.push("canSystem");
  }
  if (m === "DELETE") needs.push("canDelete");
  else if (write) needs.push("canWrite");
  return needs;
}

export function allowed(access: AdminAccess, needs: PermissionNeed[]): PermissionNeed | null {
  for (const need of needs) {
    if (!need) continue;
    if (need === "superAdmin") {
      if (!access.superAdmin) return need;
    } else if (!access[need]) return need;
  }
  return null;
}
