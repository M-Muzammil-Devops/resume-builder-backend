import type { FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { adminOf } from "./adminAuth";

/** Records an admin write action. Never throws: an audit failure is logged, not surfaced. */
export async function auditAdmin(
  request: FastifyRequest,
  action: string,
  targetType: string,
  targetId: string | null,
  details?: Record<string, unknown>
) {
  try {
    const admin = adminOf(request);
    await prisma.adminAuditLog.create({
      data: {
        adminId: admin.id,
        adminEmail: admin.email,
        action,
        targetType,
        targetId,
        details: details ? (details as Prisma.InputJsonValue) : Prisma.JsonNull,
        ip: request.ip || null,
      },
    });
  } catch (err) {
    request.log.warn({ err, action, targetType }, "admin audit write failed");
  }
}
