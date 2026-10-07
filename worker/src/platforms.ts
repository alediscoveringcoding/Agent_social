// The platforms the worker knows (PRD 10.5, amendment 04). Keep in step with
// site/src/lib/social/constants.ts: PLATFORMS, PLATFORM_KIND and
// PROVIDER_TO_PLATFORM. A test checks that the two files list the same names.

export const PLATFORMS = [
  "facebook", "instagram", "linkedin-page", "x", "devto", "hashnode", "substack", "producthunt",
  "threads", "bluesky", "mastodon", "linkedin", "reddit", "pinterest", "telegram", "discord",
  "medium", "farcaster", "nostr", "lemmy",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

export type PostKind = "social" | "article" | "launch";

export const PLATFORM_KIND: Record<Platform, PostKind> = {
  facebook: "social", instagram: "social", "linkedin-page": "social", x: "social",
  devto: "article", hashnode: "article", substack: "article", producthunt: "launch",
  threads: "social", bluesky: "social", mastodon: "social", linkedin: "social", reddit: "social",
  pinterest: "social", telegram: "social", discord: "social", medium: "article", farcaster: "social",
  nostr: "social", lemmy: "social",
};

/** Platforms with no publishing API: always a manual handoff (the site decides; the worker never delivers them). */
export const MANUAL_ONLY_PLATFORMS: readonly Platform[] = ["substack", "producthunt"];

/**
 * Our platform to the Postiz provider identifier (the `identifier` of
 * GET /public/v1/integrations and the `__type` of a post's settings, Postiz
 * v2.25.0). Instagram is the standalone provider; the Facebook-linked one is
 * `instagram` and is also mapped to our `instagram` platform on the way in.
 * Farcaster is `wrapcast` in Postiz. Manual-only platforms have none.
 */
export const POSTIZ_PROVIDER: Partial<Record<Platform, string>> = {
  facebook: "facebook", instagram: "instagram-standalone", "linkedin-page": "linkedin-page", x: "x",
  devto: "devto", hashnode: "hashnode",
  threads: "threads", bluesky: "bluesky", mastodon: "mastodon", linkedin: "linkedin", reddit: "reddit",
  pinterest: "pinterest", telegram: "telegram", discord: "discord", medium: "medium", farcaster: "wrapcast",
  nostr: "nostr", lemmy: "lemmy",
};

/** Postiz identifiers (with the spellings seen in v2.25.0) to our platforms. */
export const PROVIDER_TO_PLATFORM: Record<string, Platform> = {
  x: "x", facebook: "facebook", instagram: "instagram", "instagram-standalone": "instagram",
  "instagram.standalone": "instagram", "linkedin-page": "linkedin-page", "linkedin.page": "linkedin-page",
  devto: "devto", "dev.to": "devto", hashnode: "hashnode",
  threads: "threads", bluesky: "bluesky", mastodon: "mastodon", "mastodon-custom": "mastodon",
  linkedin: "linkedin", reddit: "reddit", pinterest: "pinterest", telegram: "telegram", discord: "discord",
  medium: "medium", wrapcast: "farcaster", farcaster: "farcaster", nostr: "nostr", lemmy: "lemmy",
};

export function platformForProvider(provider: unknown): Platform | null {
  return typeof provider === "string" ? PROVIDER_TO_PLATFORM[provider.trim().toLowerCase()] ?? null : null;
}

export function kindOf(platform: unknown): PostKind | undefined {
  return isPlatform(platform) ? PLATFORM_KIND[platform] : undefined;
}
