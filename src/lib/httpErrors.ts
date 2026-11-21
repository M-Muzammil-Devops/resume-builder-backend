import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

type PrismaLike = { code?: unknown; name?: unknown; clientVersion?: unknown };

function prismaCode(err: unknown): string | null {
  const e = err as PrismaLike;
  return e && typeof e.code === "string" && /^P\d{4}$/.test(e.code) && e.clientVersion ? e.code : null;
}

function isPrismaValidation(err: unknown): boolean {
  return (err as PrismaLike)?.name === "PrismaClientValidationError";
}

/** Short field list for a Zod failure, e.g. "content: Required". Never echoes values. */
function zodMessage(err: ZodError): string {
  const parts = err.issues.slice(0, 3).map((issue) => {
    const field = issue.path.join(".");
    return field ? `${field}: ${issue.message}` : issue.message;
  });
  return parts.join("; ") || "Invalid request";
}

export type PublicError = { status: number; body: { error: string; message?: string } };

/**
 * BUG-1103 / BUG-802: map any thrown error to a short public response.
 * Validation problems are 400, missing records 404, conflicts 409. Everything else is a
 * generic 500: no Prisma text, user ids, stack traces or filesystem paths reach the client.
 */
export function publicError(err: unknown): PublicError {
  if (err instanceof ZodError) {
    return { status: 400, body: { error: "Invalid request", message: zodMessage(err) } };
  }
  const code = prismaCode(err);
  if (code === "P2025" || code === "P2001" || code === "P2015" || code === "P2018") {
    return { status: 404, body: { error: "Not found" } };
  }
  if (code === "P2002") return { status: 409, body: { error: "Already exists" } };
  if (code === "P2003" || code === "P2000" || code === "P2006" || code === "P2007" || code === "P2011" || code === "P2012" || code === "P2023") {
    return { status: 400, body: { error: "Invalid request" } };
  }
  if (isPrismaValidation(err)) return { status: 400, body: { error: "Invalid request" } };

  const fe = err as Partial<FastifyError>;
  const status = typeof fe?.statusCode === "number" ? fe.statusCode : 500;
  if (status >= 400 && status < 500) {
    // Fastify's own client errors (bad JSON, body too large, ...) carry safe messages.
    const message = String(fe.message || "Bad request")
      .replace(/[A-Za-z]:\\[^\s'"]+/g, "")
      .replace(/\/(?:[\w.-]+\/)+[\w.-]+/g, "")
      .slice(0, 200);
    return { status, body: { error: message || "Bad request" } };
  }
  return { status: 500, body: { error: "Internal Server Error", message: "Something went wrong. Please try again." } };
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, request, reply) => {
    const mapped = publicError(err);
    if (mapped.status >= 500) request.log.error({ err }, "request failed");
    else request.log.info({ status: mapped.status, code: prismaCode(err) }, "request rejected");
    void reply.code(mapped.status).send(mapped.body);
  });
}
