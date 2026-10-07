import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPostizPost, postIdFromCreate, postizContent, postizSettings, type UploadedMedia } from "./postiz-payload.js";
import { PLATFORMS, POSTIZ_PROVIDER } from "../platforms.js";

const image: UploadedMedia = { media_id: "media-1", id: "up-1", path: "https://postiz.test/uploads/a.png", alt_text: "Card despre declaratie" };

test("every platform with a Postiz provider yields settings tagged with its identifier; manual-only ones refuse", () => {
  for (const platform of PLATFORMS) {
    const provider = POSTIZ_PROVIDER[platform];
    if (provider === undefined) {
      assert.throws(() => postizSettings(platform, {}), /manual handoff only/, platform);
    } else {
      assert.equal(postizSettings(platform, {}, [image]).__type, provider, platform);
    }
  }
  assert.throws(() => postizSettings("tiktok", {}), /No Postiz provider/);
});

test("Postiz identifiers of the new platforms (v2.25.0)", () => {
  assert.deepEqual(
    Object.fromEntries(["threads", "bluesky", "mastodon", "linkedin", "reddit", "pinterest", "telegram", "discord", "medium", "farcaster", "nostr", "lemmy"].map((p) => [p, POSTIZ_PROVIDER[p as keyof typeof POSTIZ_PROVIDER]])),
    { threads: "threads", bluesky: "bluesky", mastodon: "mastodon", linkedin: "linkedin", reddit: "reddit", pinterest: "pinterest", telegram: "telegram", discord: "discord", medium: "medium", farcaster: "wrapcast", nostr: "nostr", lemmy: "lemmy" },
  );
});

test("platforms without settings send only __type", () => {
  for (const p of ["threads", "bluesky", "mastodon", "telegram", "nostr", "linkedin", "linkedin-page", "facebook"] as const) {
    assert.deepEqual(postizSettings(p, { anything: "ignored" }), { __type: POSTIZ_PROVIDER[p] }, p);
  }
});

test("reddit: a list with one subreddit entry, link only for link posts, flair when given", () => {
  assert.deepEqual(postizSettings("reddit", { subreddit: "r/taxes_ro", title: "Un titlu", post_type: "self", link_url: "https://thecrypto.support/x" }), {
    __type: "reddit",
    subreddit: [{ value: { subreddit: "r/taxes_ro", title: "Un titlu", type: "self", url: "", is_flair_required: false } }],
  });
  assert.deepEqual(postizSettings("reddit", { subreddit: "taxes_ro", title: "T", post_type: "link", link_url: "https://thecrypto.support/x", flair_id: "abc" }).subreddit, [
    { value: { subreddit: "taxes_ro", title: "T", type: "link", url: "https://thecrypto.support/x", is_flair_required: true, flair: { id: "abc", name: "abc" } } },
  ]);
  assert.equal((postizSettings("reddit", { subreddit: "r/x", title: "T", post_type: "bogus" }).subreddit as any)[0].value.type, "self");
});

test("pinterest: numeric board id, title, link; the text is the description and the images are the pin", () => {
  assert.deepEqual(postizSettings("pinterest", { board: "1234567890", title: "Un pin", link: "https://thecrypto.support/ghid/x" }), {
    __type: "pinterest", board: "1234567890", title: "Un pin", link: "https://thecrypto.support/ghid/x",
  });
  const post = buildPostizPost({ platform: "pinterest", integrationId: "int-1", text: "Descrierea pinului", settings: { board: "1", title: "T", link: "https://thecrypto.support/x" }, media: [image] });
  assert.equal(post.posts[0].value[0].content, "Descrierea pinului");
  assert.deepEqual(post.posts[0].value[0].image, [{ id: "up-1", path: image.path, alt: "Card despre declaratie" }]);
});

test("discord: the channel id; farcaster: the channel list Postiz calls subreddit", () => {
  assert.deepEqual(postizSettings("discord", { channel: "123456789012345678" }), { __type: "discord", channel: "123456789012345678" });
  assert.deepEqual(postizSettings("farcaster", { channel: "founders" }), { __type: "wrapcast", subreddit: [{ value: { id: "founders" } }] });
  assert.deepEqual(postizSettings("farcaster", {}), { __type: "wrapcast", subreddit: [] });
});

test("lemmy: community name, numeric community id, title and optional url", () => {
  assert.deepEqual(postizSettings("lemmy", { community: "taxes", community_id: "42", title: "Un titlu" }), {
    __type: "lemmy", subreddit: [{ value: { subreddit: "taxes", id: "42", title: "Un titlu" } }],
  });
  assert.deepEqual((postizSettings("lemmy", { community: "taxes", community_id: "42", title: "T", link: "https://thecrypto.support/x" }).subreddit as any)[0].value.url, "https://thecrypto.support/x");
});

test("medium: title, subtitle, canonical and tags as {value,label}, at most three; the title heads the body", () => {
  const s = { title: "Cum calculezi impozitul", subtitle: "Pas cu pas", canonical_url: "https://thecrypto.support/ghid/x", tags: ["crypto", "taxe", "romania", "extra"] };
  assert.deepEqual(postizSettings("medium", s), {
    __type: "medium", title: "Cum calculezi impozitul", subtitle: "Pas cu pas", canonical: "https://thecrypto.support/ghid/x",
    tags: [{ value: "crypto", label: "crypto" }, { value: "taxe", label: "taxe" }, { value: "romania", label: "romania" }],
  });
  assert.equal(postizContent("medium", "Un ghid.", s), "# Cum calculezi impozitul\n\nUn ghid.");
  assert.equal(postizContent("medium", "# Titlul meu\n\nUn ghid.", s), "# Titlul meu\n\nUn ghid.");
  assert.equal(postizContent("devto", "Un ghid.", s), "Un ghid.");
});

test("the older platforms use Postiz's own key names", () => {
  assert.deepEqual(postizSettings("x", { who_can_reply: "following" }), { __type: "x", who_can_reply_post: "following" });
  assert.deepEqual(postizSettings("x", {}), { __type: "x", who_can_reply_post: "everyone" });
  assert.deepEqual(postizSettings("instagram", { post_type: "post" }), { __type: "instagram-standalone", post_type: "post" });
  const devto = postizSettings("devto", { title: "T", canonical_url: "https://thecrypto.support/x", tags: ["a", "b"], cover_media_id: "media-1" }, [image]);
  assert.deepEqual(devto, {
    __type: "devto", title: "T", canonical: "https://thecrypto.support/x", tags: [{ value: 1, label: "a" }, { value: 2, label: "b" }],
    main_image: { id: "up-1", path: image.path },
  });
});

test("the request body is Postiz's CreatePostDto and the answer is a list of {postId}", () => {
  const post = buildPostizPost({ platform: "bluesky", integrationId: "int-9", text: "Un text", settings: {}, media: [], now: new Date("2026-10-07T08:00:00Z") });
  assert.deepEqual(post, {
    type: "now", shortLink: false, date: "2026-10-07T08:00:00.000Z", tags: [],
    posts: [{ integration: { id: "int-9" }, value: [{ content: "Un text", image: [] }], settings: { __type: "bluesky" } }],
  });
  assert.deepEqual(postIdFromCreate([{ postId: "p-1", integration: "int-9" }]), { postId: "p-1", group: undefined });
  assert.deepEqual(postIdFromCreate({ id: "p-2", group: "g-2" }), { postId: "p-2", group: "g-2" });
  assert.deepEqual(postIdFromCreate({ posts: [{ id: "p-3" }] }), { postId: "p-3", group: undefined });
  assert.deepEqual(postIdFromCreate([]), { postId: undefined, group: undefined });
});
