import type { FastifyInstance } from "fastify";
import { z } from "zod";

type NominatimHit = {
  display_name?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    state?: string;
    country?: string;
  };
};

function formatHit(hit: NominatimHit): string | null {
  const a = hit.address || {};
  const city = a.city || a.town || a.village || a.municipality;
  const country = a.country;
  if (city && country) return `${city}, ${country}`;
  if (city && a.state) return `${city}, ${a.state}`;
  // Fallback: first 2 comma parts of display_name
  const parts = (hit.display_name || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}, ${parts[parts.length - 1]}`;
  return parts[0] || null;
}

const LOCAL: string[] = [
  "Lahore, Pakistan",
  "Karachi, Pakistan",
  "Islamabad, Pakistan",
  "Rawalpindi, Pakistan",
  "Multan, Pakistan",
  "Faisalabad, Pakistan",
  "Peshawar, Pakistan",
  "Quetta, Pakistan",
  "Los Angeles, United States",
  "New York, United States",
  "San Francisco, United States",
  "Seattle, United States",
  "Austin, United States",
  "London, United Kingdom",
  "Dubai, United Arab Emirates",
  "Toronto, Canada",
  "Berlin, Germany",
  "Remote",
];

function localSuggest(q: string): string[] {
  const needle = q.toLowerCase();
  return LOCAL.filter((x) => x.toLowerCase().includes(needle)).slice(0, 8);
}

export async function locationRoutes(app: FastifyInstance) {
  app.get("/locations/suggest", async (request, reply) => {
    // BUG-1260: a long or odd query is clamped, never a 400.
    const raw = (request.query as { q?: unknown } | undefined)?.q;
    const q = typeof raw === "string" ? raw : Array.isArray(raw) ? String(raw[0] ?? "") : "";
    const query = q.trim().slice(0, 80).trim();
    if (query.length < 2) return { locations: [] };

    const local = localSuggest(query);

    try {
      const url =
        `https://nominatim.openstreetmap.org/search?` +
        `q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=8`;
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "ResumeBuilder/1.0 (local-dev)",
        },
      });
      if (!res.ok) {
        request.log.warn({ status: res.status }, "Nominatim suggest failed");
        return { locations: local };
      }
      const data = (await res.json()) as NominatimHit[];
      const remote = (Array.isArray(data) ? data : [])
        .map(formatHit)
        .filter((x): x is string => Boolean(x));

      const seen = new Set<string>();
      const locations: string[] = [];
      for (const item of [...local, ...remote]) {
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        locations.push(item);
        if (locations.length >= 10) break;
      }
      return { locations };
    } catch (err) {
      request.log.warn({ err }, "Location suggest error");
      return reply.code(200).send({ locations: local });
    }
  });
}
