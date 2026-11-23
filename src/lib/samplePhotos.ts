import { SAMPLE_PHOTO_PATTERN } from "../shared/photoSlot";

/**
 * BUG-1300: the only sample headshots that exist (frontend public/templates/photos/<id>.webp).
 * A drift test compares this list with the files on disk, so adding a photo means adding its id here.
 */
export const SAMPLE_PHOTO_IDS: readonly string[] = ["steady-form", "marketing-cyan", "executive-navy", "saffron-line"];

/** True only for /templates/photos/<id>.webp where <id> is a real sample photo. */
export function isKnownSamplePhoto(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const value = url.trim();
  if (!SAMPLE_PHOTO_PATTERN.test(value)) return false;
  const id = value.slice("/templates/photos/".length, -".webp".length);
  return SAMPLE_PHOTO_IDS.includes(id);
}
