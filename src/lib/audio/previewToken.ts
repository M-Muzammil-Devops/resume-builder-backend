import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * BUG-1341: short-lived signed preview links, so <audio src> can stream (Range/206) without a Bearer
 * header. The signature binds job id + track + OWNER user id + expiry; a link for one user's job is
 * useless for any other job, track or user, and dies after PREVIEW_TTL_SECONDS. The secret comes from
 * AUDIO_PREVIEW_SECRET or is random per process (links simply expire on restart).
 */
export const PREVIEW_TTL_SECONDS = 300;
export type PreviewTrack = "original" | "clean";

export function makePreviewSigner(secret: string | undefined = process.env.AUDIO_PREVIEW_SECRET) {
  const key = secret && secret.length >= 16 ? Buffer.from(secret) : randomBytes(32);
  const mac = (jobId: string, which: PreviewTrack, userId: string, exp: number) =>
    createHmac("sha256", key).update(`audio-preview.v1|${jobId}|${which}|${userId}|${exp}`).digest("base64url").slice(0, 43);
  return {
    /** Path under the API root, e.g. /audio/p/<job>/<track>/<exp>/<sig>. */
    sign(jobId: string, which: PreviewTrack, userId: string, now = Date.now(), ttl = PREVIEW_TTL_SECONDS) {
      const exp = Math.floor(now / 1000) + ttl;
      return { path: `/audio/p/${jobId}/${which}/${exp}/${mac(jobId, which, userId, exp)}`, exp };
    },
    /** "ok" | "expired" | "bad". Constant-time compare; expiry checked after the signature. */
    verify(jobId: string, which: PreviewTrack, userId: string, exp: number, sig: string, now = Date.now(), ttl = PREVIEW_TTL_SECONDS): "ok" | "expired" | "bad" {
      if (!Number.isInteger(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return "bad";
      const want = Buffer.from(mac(jobId, which, userId, exp));
      const got = Buffer.from(sig);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return "bad";
      const left = exp - Math.floor(now / 1000);
      if (left < 0) return "expired";
      if (left > ttl + 60) return "bad"; // not issued by us with this TTL
      return "ok";
    },
  };
}
