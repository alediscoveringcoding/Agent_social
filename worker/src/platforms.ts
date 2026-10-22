// The platforms the worker knows (PRD 10.5, amendments 04, 05 and 10). Keep in step with
// site/src/lib/social/constants.ts: PLATFORMS, PLATFORM_KIND and DROPPED_PLATFORMS.
// A test checks that the two files list the same names.

export const PLATFORMS = [
  "facebook", "instagram", "linkedin-page", "x", "devto", "hashnode", "substack", "producthunt",
  "threads", "bluesky", "mastodon", "linkedin", "reddit", "pinterest", "telegram", "discord",
  "medium", "farcaster", "nostr", "lemmy",
  "slack", "wordpress", "listmonk", "vk", "gmb", "tumblr", "dribbble", "mewe", "skool", "whop",
  "moltbook", "kick", "twitch", "tiktok", "youtube",
  // Amendment 05: manual channels.
  "quora", "linkedin-article", "tradingview", "investing", "indiehackers", "stackexchange", "github", "forum", "press",
] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Amendment 10: platforms dropped from the app. The first twelve never got a direct adapter
 * after Postiz was removed; WordPress, Discord and Mastodon were excluded by the owner. The
 * generator writes nothing for them and the site offers no new account or request with them.
 * They stay in PLATFORMS because older drafts and accounts may still name them.
 */
export const DROPPED_PLATFORMS = [
  "threads", "reddit", "pinterest", "nostr", "vk", "gmb", "tumblr", "dribbble", "whop", "moltbook", "kick", "twitch",
  "wordpress", "discord", "mastodon",
] as const satisfies readonly Platform[];
export type WritablePlatform = Exclude<Platform, (typeof DROPPED_PLATFORMS)[number]>;
/** The platforms the generator writes for: PLATFORMS without DROPPED_PLATFORMS, in the same order. */
export const WRITABLE_PLATFORMS = PLATFORMS.filter(
  (p): p is WritablePlatform => !(DROPPED_PLATFORMS as readonly string[]).includes(p),
) as [WritablePlatform, ...WritablePlatform[]];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

export function isWritablePlatform(value: unknown): value is WritablePlatform {
  return typeof value === "string" && (WRITABLE_PLATFORMS as readonly string[]).includes(value);
}

export type PostKind = "social" | "article" | "launch";

export const PLATFORM_KIND: Record<Platform, PostKind> = {
  facebook: "social", instagram: "social", "linkedin-page": "social", x: "social",
  devto: "article", hashnode: "article", substack: "article", producthunt: "launch",
  threads: "social", bluesky: "social", mastodon: "social", linkedin: "social", reddit: "social",
  pinterest: "social", telegram: "social", discord: "social", medium: "article", farcaster: "social",
  nostr: "social", lemmy: "social",
  slack: "social", wordpress: "article", listmonk: "article", vk: "social", gmb: "social", tumblr: "social",
  dribbble: "social", mewe: "social", skool: "social", whop: "social", moltbook: "social", kick: "social",
  twitch: "social", tiktok: "social", youtube: "social",
  quora: "social", "linkedin-article": "article", tradingview: "social", investing: "social", indiehackers: "social",
  stackexchange: "social", github: "article", forum: "social", press: "article",
};

export function kindOf(platform: unknown): PostKind | undefined {
  return isPlatform(platform) ? PLATFORM_KIND[platform] : undefined;
}
