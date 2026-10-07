// Neutral destination settings (PRD 10.5) to Postiz's POST /public/v1/posts
// body (CreatePostDto, Postiz v2.25.0). The shapes below follow the provider
// DTOs under libraries/nestjs-libraries/src/dtos/posts/providers-settings/;
// docs/amendment-04-more-platforms.md lists them per platform.
//
// Postiz overwrites `settings.__type` with the integration's own provider
// identifier, so the value set here is a hint, not the authority.

import { POSTIZ_PROVIDER, type Platform, isPlatform } from "../platforms.js";

type Neutral = Record<string, unknown>;

export interface UploadedMedia {
  /** The site's media id (the neutral `cover_media_id` refers to it). */
  media_id?: string;
  /** Postiz's id and path from POST /upload. */
  id: string;
  path: string;
  alt_text?: string;
}

export interface PostizPostInput {
  platform: string;
  integrationId: string;
  text: string;
  settings: Neutral;
  media: UploadedMedia[];
  now?: Date;
}

export interface PostizCreatePost {
  type: "now";
  shortLink: false;
  date: string;
  tags: [];
  posts: Array<{
    integration: { id: string };
    value: Array<{ content: string; image: Array<{ id: string; path: string; alt?: string }> }>;
    settings: Record<string, unknown>;
  }>;
}

const str = (s: Neutral, key: string): string => (typeof s[key] === "string" ? (s[key] as string).trim() : "");

function tagList(s: Neutral): string[] {
  const t = s.tags;
  const list = Array.isArray(t) ? t : typeof t === "string" ? t.split(",") : [];
  return list.map((x) => String(x).trim()).filter(Boolean);
}

/** Medium and Hashnode take tags as {value, label}; dev.to's value is a number, and only its label is used. */
const labelled = (tags: string[]) => tags.map((label) => ({ value: label, label }));
const numbered = (tags: string[]) => tags.map((label, i) => ({ value: i + 1, label }));

function mainImage(s: Neutral, media: UploadedMedia[]) {
  const cover = str(s, "cover_media_id");
  const m = (cover && media.find((x) => x.media_id === cover)) || media[0];
  return m ? { main_image: { id: m.id, path: m.path } } : {};
}

function omitEmpty(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined && v !== null));
}

export function postizSettings(platform: string, s: Neutral, media: UploadedMedia[] = []): Record<string, unknown> {
  if (!isPlatform(platform) || POSTIZ_PROVIDER[platform] === undefined) {
    throw new Error(`No Postiz provider for platform "${platform}" (manual handoff only)`);
  }
  const __type = POSTIZ_PROVIDER[platform];
  switch (platform as Platform) {
    case "x":
      // XDto: who_can_reply_post is required for a post (not an article).
      return { __type, who_can_reply_post: str(s, "who_can_reply") || "everyone" };
    case "instagram":
      return { __type, post_type: str(s, "post_type") === "story" ? "story" : "post" };
    case "devto":
      return omitEmpty({ __type, title: str(s, "title"), canonical: str(s, "canonical_url"), tags: numbered(tagList(s)), ...mainImage(s, media) });
    case "hashnode":
      // HashnodeSettingsDto also needs `publication` (an id) and tag ids from Postiz's own list.
      return omitEmpty({
        __type, title: str(s, "title"), subtitle: str(s, "subtitle"), canonical: str(s, "canonical_url"),
        publication: str(s, "publication"), tags: labelled(tagList(s)), ...mainImage(s, media),
      });
    case "medium":
      // MediumSettingsDto: title and subtitle are required; at most four tags (Medium uses three).
      return omitEmpty({
        __type, title: str(s, "title"), subtitle: str(s, "subtitle"), canonical: str(s, "canonical_url"),
        tags: labelled(tagList(s).slice(0, 3)),
      });
    case "reddit": {
      // RedditSettingsDto: a list of subreddits, each {value: {...}}.
      const type = ["self", "link", "media"].includes(str(s, "post_type")) ? str(s, "post_type") : "self";
      const flair = str(s, "flair_id");
      return {
        __type,
        subreddit: [{
          value: {
            subreddit: str(s, "subreddit"),
            title: str(s, "title"),
            type,
            url: type === "link" ? str(s, "link_url") : "",
            is_flair_required: Boolean(flair),
            ...(flair ? { flair: { id: flair, name: flair } } : {}),
          },
        }],
      };
    }
    case "pinterest":
      // PinterestSettingsDto: board is the numeric board id; the text is the pin description.
      return omitEmpty({ __type, board: str(s, "board"), title: str(s, "title"), link: str(s, "link") });
    case "discord":
      return { __type, channel: str(s, "channel") };
    case "farcaster": {
      // FarcasterDto names its channel list `subreddit` (a copy of the Reddit one).
      const channel = str(s, "channel");
      return { __type, subreddit: channel ? [{ value: { id: channel } }] : [] };
    }
    case "lemmy":
      // LemmySettingsDto: community name, numeric community id, title, optional url.
      return {
        __type,
        subreddit: [{
          value: omitEmpty({ subreddit: str(s, "community"), id: str(s, "community_id"), title: str(s, "title"), url: str(s, "link") }),
        }],
      };
    default:
      // facebook, linkedin-page, linkedin, threads, bluesky, mastodon, telegram, nostr: no settings.
      return { __type };
  }
}

/**
 * The text Postiz publishes. Medium's API takes the title as metadata only
 * ("the title must be part of the content"), so a body that does not start
 * with a heading gets the title as its H1.
 */
export function postizContent(platform: string, text: string, s: Neutral): string {
  if (platform === "medium") {
    const title = str(s, "title");
    if (title && !/^\s*#\s/.test(text)) return `# ${title}\n\n${text}`;
  }
  return text;
}

export function buildPostizPost(input: PostizPostInput): PostizCreatePost {
  return {
    type: "now",
    shortLink: false,
    date: (input.now ?? new Date()).toISOString(),
    tags: [],
    posts: [{
      integration: { id: input.integrationId },
      value: [{
        content: postizContent(input.platform, input.text, input.settings),
        image: input.media.map((m) => ({ id: m.id, path: m.path, ...(m.alt_text ? { alt: m.alt_text } : {}) })),
      }],
      settings: postizSettings(input.platform, input.settings, input.media),
    }],
  };
}

/** POST /posts answers with a list of {postId, integration}; older mocks answered with {id} or {posts: [{id}]}. */
export function postIdFromCreate(result: any): { postId?: string; group?: string } {
  const first = Array.isArray(result) ? result[0] : result?.posts?.[0] ?? result;
  const postId = first?.postId ?? first?.id;
  return { postId: postId ? String(postId) : undefined, group: result?.group ? String(result.group) : undefined };
}
