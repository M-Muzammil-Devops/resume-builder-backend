import type { FastifyInstance } from "fastify";
import { TEMPLATES } from "../shared";
import { prisma } from "../prisma";

export async function templateRoutes(app: FastifyInstance) {
  app.get("/templates", async (request) => {
    const { department } = request.query as { department?: string };
    try {
      const rows = await prisma.template.findMany({
        where: department ? { department } : undefined,
        orderBy: { name: "asc" },
      });
      if (rows.length) return { templates: rows };
    } catch {
      // DB may be empty before seed
    }
    const templates = department
      ? TEMPLATES.filter((t) => t.department === department)
      : TEMPLATES;
    return { templates };
  });
}
