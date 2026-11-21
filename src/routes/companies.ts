import type { FastifyInstance } from "fastify";
import { z } from "zod";

type ClearbitHit = {
  name?: string;
  domain?: string;
  logo?: string | null;
};

function logoForDomain(domain: string, clearbitLogo?: string | null) {
  const d = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  // Prefer Google favicons — Clearbit logo CDN often fails in browsers.
  if (clearbitLogo) return clearbitLogo;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`;
}

export async function companyRoutes(app: FastifyInstance) {
  app.get("/companies/suggest", async (request, reply) => {
    const { q } = z
      .object({ q: z.string().min(1).max(80) })
      .parse(request.query);

    const query = q.trim();
    if (query.length < 2) return { companies: [] };

    try {
      const url = `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        request.log.warn({ status: res.status }, "Clearbit suggest failed");
        return reply.code(200).send({ companies: [] });
      }
      const data = (await res.json()) as ClearbitHit[];
      const companies = (Array.isArray(data) ? data : [])
        .filter((c) => c.name && c.domain)
        .slice(0, 10)
        .map((c) => ({
          name: c.name as string,
          domain: (c.domain as string).toLowerCase(),
          logo: logoForDomain(c.domain as string, c.logo),
        }));
      return { companies };
    } catch (err) {
      request.log.warn({ err }, "Company suggest error");
      return { companies: [] };
    }
  });
}
