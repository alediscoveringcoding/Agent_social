// The platforms the worker knows (PRD 10.5, amendment 04). Keep in step with
// site/src/lib/social/constants.ts: PLATFORMS, PLATFORM_KIND, MANUAL_ONLY_PLATFORMS
// and PROVIDER_TO_PLATFORM. A test checks that the two files list the same names.

export const PLATFORMS = [
  "facebook", "instagram", "linkedin-page", "x", "devto", "hashnode", "substack", "producthunt",
  "threads", "bluesky", "mastodon", "linkedin", "reddit", "pinterest", "telegram", "discord",
  "medium", "farcaster", "nostr", "lemmy",
  "slack", "wordpress", "listmonk", "vk", "gmb", "tumblr", "dribbble", "mewe", "skool", "whop",
  "moltbook", "kick", "twitch", "tiktok", "youtube",
  // Amendment 05: manual-only channels, no Postiz provider.
  "quora", "linkedin-article", "tradingview", "investing", "indiehackers", "stackexchange", "github", "forum", "press",
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
  slack: "social", wordpress: "article", listmonk: "article", vk: "social", gmb: "social", tumblr: "social",
  dribbble: "social", mewe: "social", skool: "social", whop: "social", moltbook: "social", kick: "social",
  twitch: "social", tiktok: "social", youtube: "social",
  quora: "social", "linkedin-article": "article", tradingview: "social", investing: "social", indiehackers: "social",
  stackexchange: "social", github: "article", forum: "social", press: "article",
};

/**
 * Platforms whose account is always manual (the site decides; the worker never
 * receives their jobs and refuses to build a Postiz post for them): no publishing
 * API (Substack, Product Hunt) or video only (YouTube: this app makes text and images), or a channel the app posts to by hand (amendment 05).
 */
export const MANUAL_ONLY_PLATFORMS: readonly Platform[] = [
  "substack", "producthunt", "youtube",
  // Amendment 05: no API we use (Quora, TradingView, Investing.com, Indie Hackers), an API we do not automate
  // (LinkedIn articles, Stack Exchange, GitHub) or one account per forum or outlet (forum, press).
  "quora", "linkedin-article", "tradingview", "investing", "indiehackers", "stackexchange", "github", "forum", "press",
];

/**
 * Our platform to the Postiz provider identifier (the `identifier` of
 * GET /public/v1/integrations and the `__type` of a post's settings, Postiz
 * v2.25.0). Instagram is the standalone provider; the Facebook-linked one is
 * `instagram` and is also mapped to our `instagram` platform on the way in.
 * Farcaster is `wrapcast` in Postiz. Substack and Product Hunt have none.
 */
export const POSTIZ_PROVIDER: Partial<Record<Platform, string>> = {
  facebook: "facebook", instagram: "instagram-standalone", "linkedin-page": "linkedin-page", x: "x",
  devto: "devto", hashnode: "hashnode",
  threads: "threads", bluesky: "bluesky", mastodon: "mastodon", linkedin: "linkedin", reddit: "reddit",
  pinterest: "pinterest", telegram: "telegram", discord: "discord", medium: "medium", farcaster: "wrapcast",
  nostr: "nostr", lemmy: "lemmy",
  slack: "slack", wordpress: "wordpress", listmonk: "listmonk", vk: "vk", gmb: "gmb", tumblr: "tumblr",
  dribbble: "dribbble", mewe: "mewe", skool: "skool", whop: "whop", moltbook: "moltbook", kick: "kick",
  twitch: "twitch", tiktok: "tiktok", youtube: "youtube",
};

/**
 * Postiz identifiers (with the spellings seen in v2.25.0) to our platforms.
 * Aliases are one platform each: instagram-standalone is instagram,
 * mastodon-custom is mastodon, tiktok-business is tiktok, wrapcast is farcaster.
 */
export const PROVIDER_TO_PLATFORM: Record<string, Platform> = {
  x: "x", facebook: "facebook", instagram: "instagram", "instagram-standalone": "instagram",
  "instagram.standalone": "instagram", "linkedin-page": "linkedin-page", "linkedin.page": "linkedin-page",
  devto: "devto", "dev.to": "devto", hashnode: "hashnode",
  threads: "threads", bluesky: "bluesky", mastodon: "mastodon", "mastodon-custom": "mastodon",
  linkedin: "linkedin", reddit: "reddit", pinterest: "pinterest", telegram: "telegram", discord: "discord",
  medium: "medium", wrapcast: "farcaster", farcaster: "farcaster", nostr: "nostr", lemmy: "lemmy",
  slack: "slack", wordpress: "wordpress", listmonk: "listmonk", vk: "vk", gmb: "gmb", tumblr: "tumblr",
  dribbble: "dribbble", mewe: "mewe", skool: "skool", whop: "whop", moltbook: "moltbook", kick: "kick",
  twitch: "twitch", tiktok: "tiktok", "tiktok-business": "tiktok", youtube: "youtube",
};

export function platformForProvider(provider: unknown): Platform | null {
  return typeof provider === "string" ? PROVIDER_TO_PLATFORM[provider.trim().toLowerCase()] ?? null : null;
}

export function kindOf(platform: unknown): PostKind | undefined {
  return isPlatform(platform) ? PLATFORM_KIND[platform] : undefined;
}
