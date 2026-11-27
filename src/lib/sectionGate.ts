import type { AdminSettings } from "./appSettings";
import {
  SECTION_LIMIT_CODE,
  countResumeSections,
  effectiveSectionLimit,
  sectionLimitBlocked,
  sectionLimitMessage,
  type SectionPlan,
} from "../shared/sectionLimit";

/** JSON body of the HTTP 402 sent when a Free PDF download is over the section limit. */
export type SectionLimitBody = {
  error: typeof SECTION_LIMIT_CODE;
  code: typeof SECTION_LIMIT_CODE;
  message: string;
  limit: number;
  count: number;
};

/**
 * Free-plan section limit for PDF download. Returns the 402 body when the download must be
 * blocked, else null. Pro and Admin accounts are never blocked; the limit is off when the admin
 * switched it off or set it to 0.
 */
export function sectionLimitDecision(
  plan: SectionPlan,
  freeLimits: Pick<AdminSettings["freeLimits"], "maxSectionsForFreePdf" | "enforceFreeSectionLimit">,
  content: unknown
): SectionLimitBody | null {
  const limit = effectiveSectionLimit(plan, { enabled: freeLimits.enforceFreeSectionLimit, max: freeLimits.maxSectionsForFreePdf });
  if (!limit) return null;
  const count = countResumeSections(content);
  if (!sectionLimitBlocked(count, limit)) return null;
  return { error: SECTION_LIMIT_CODE, code: SECTION_LIMIT_CODE, message: sectionLimitMessage(limit, count), limit, count };
}
