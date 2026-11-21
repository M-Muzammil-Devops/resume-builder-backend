import { generateTemplates } from "../shared/templates";

const premiumIds = new Set(generateTemplates().filter((t) => t.isPremium).map((t) => t.id));

export function isPremiumTemplate(templateId: string): boolean {
  return premiumIds.has(templateId);
}

type Section = { type?: string };

function sectionsOf(content: unknown): Section[] {
  if (!content || typeof content !== "object") return [];
  const sections = (content as { sections?: Section[] }).sections;
  return Array.isArray(sections) ? sections : [];
}

/** Free accounts cannot save a PRO template or add a new Custom Title section. */
export function planSaveError(
  role: string | undefined,
  existingContent: unknown,
  next: { templateId?: string; content?: unknown }
): string | null {
  if (role === "admin") return null;
  if (next.templateId && isPremiumTemplate(next.templateId)) {
    return "This template is on the Pro plan.";
  }
  if (!next.content) return null;
  const hadCustom = sectionsOf(existingContent).some((s) => s.type === "custom");
  const hasCustom = sectionsOf(next.content).some((s) => s.type === "custom");
  if (hasCustom && !hadCustom) return "Custom Title is a Pro section.";
  return null;
}
