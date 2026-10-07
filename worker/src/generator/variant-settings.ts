import type { Platform } from "../platforms.js";

/**
 * The neutral per-platform settings (PRD 10.5) the worker adds to a model
 * variant. The model only supplies a title and a link where a platform needs
 * them (reddit, pinterest, lemmy); the subreddit, board, channel and
 * community are chosen by a person in the composer, so they are never
 * invented here and approval stays blocked until they are filled.
 */
export function variantSettings(
  platform: Platform | string,
  variant: { title?: string; link?: string },
  sourceUrl?: string | null,
): Record<string, string> {
  const title = (variant.title ?? "").trim();
  const link = (variant.link ?? "").trim();
  switch (platform) {
    case "instagram": return { post_type: "post" };
    case "x": return { who_can_reply: "everyone" };
    case "reddit": return { post_type: "self", ...(title ? { title } : {}) };
    case "pinterest": {
      const target = link || (sourceUrl ?? "");
      return { ...(title ? { title } : {}), ...(target ? { link: target } : {}) };
    }
    case "lemmy": return { ...(title ? { title } : {}), ...(link ? { link } : {}) };
    default: return {};
  }
}
