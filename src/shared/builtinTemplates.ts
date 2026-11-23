/**
 * The 12 built-in landing templates. The frontend catalog (resume-builder-frontend
 * src/lib/landingTemplates.ts) is the source of truth for rendering; this list only carries
 * what the admin panel needs. builtinTemplates.test.ts keeps both in step.
 */
export type BuiltinTemplate = {
  id: string;
  name: string;
  description: string;
  layoutKey: string;
  category: string;
};

function categoryOf(layoutKey: string, department?: string) {
  if (department && department !== "Custom") return department;
  if (layoutKey === "classic" || layoutKey === "elegant" || layoutKey === "timeline") return "Traditional";
  if (["stylish", "polished", "ivy-league", "single-column", "crest"].includes(layoutKey)) return "Leadership";
  return "Modern";
}

const RAW: Array<Omit<BuiltinTemplate, "category"> & { department?: string }> = [
  { id: "classic-serif", name: "Classic Serif", description: "Centered single column with elegant serif headings.", layoutKey: "classic" },
  { id: "marketing-cyan", name: "Growth Cyan", description: "Photo header + two-column marketing layout.", layoutKey: "high-performer" },
  { id: "executive-navy", name: "Executive Navy", description: "Bold navy header block with sidebar accents.", layoutKey: "stylish" },
  { id: "clean-cyan", name: "Clean Cyan", description: "Minimal two-column with soft cyan accents.", layoutKey: "contemporary" },
  { id: "engineer-sky", name: "Engineer Sky", description: "Skills pills + projects sidebar for engineers.", layoutKey: "compact" },
  { id: "product-blue", name: "Product Blue", description: "Product manager style with achievement icons.", layoutKey: "polished" },
  { id: "steady-form", name: "Steady Form", description: "Banner section headers with photo contact grid.", layoutKey: "elegant" },
  { id: "saffron-line", name: "Saffron Line", description: "Serif two-column with warm saffron dividers.", layoutKey: "ivy-league" },
  { id: "tech-hex", name: "Tech Hex", description: "Modern engineer layout with hexagonal accents.", layoutKey: "creative" },
  { id: "strategy-clean", name: "Strategy Clean", description: "Leadership resume with skills descriptions.", layoutKey: "crest", department: "Leadership" },
  { id: "precision-line", name: "Precision Line", description: "Centered header with crisp divider sections.", layoutKey: "timeline" },
  { id: "emerald-numbered", name: "Emerald Numbered", description: "Initials badge with numbered green section headers.", layoutKey: "numbered" },
];

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = RAW.map(({ department, ...t }) => ({
  ...t,
  category: categoryOf(t.layoutKey, department),
}));

export const BUILTIN_TEMPLATE_IDS = new Set(BUILTIN_TEMPLATES.map((t) => t.id));

/** Resume.templateId values that belong to a built-in template. */
export function builtinIdOfTemplateId(templateId: string | null | undefined): string | null {
  const id = String(templateId || "").replace(/^tmpl-landing-/, "");
  return BUILTIN_TEMPLATE_IDS.has(id) ? id : null;
}
