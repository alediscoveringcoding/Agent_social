import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPostizPost, postIdFromCreate, postizContent, postizSettings, PostizPayloadError, type UploadedMedia } from "./postiz-payload.js";
import { MANUAL_ONLY_PLATFORMS, PLATFORMS, POSTIZ_PROVIDER } from "../platforms.js";
import { markdownToPostizHtml } from "./markdown-html.js";

const image: UploadedMedia = { media_id: "media-1", id: "up-1", path: "https://postiz.test/uploads/a.png", alt_text: "Card despre declaratie" };

test("every automatic platform yields settings tagged with its identifier; manual-only ones refuse, YouTube included", () => {
  for (const platform of PLATFORMS) {
    if (MANUAL_ONLY_PLATFORMS.includes(platform)) {
      assert.throws(() => postizSettings(platform, {}), /manual handoff only/, platform);
    } else {
      // Hashnode refuses a post without its publication id.
      assert.equal(postizSettings(platform, { publication: "pub-1" }, [image]).__type, POSTIZ_PROVIDER[platform], platform);
    }
  }
  assert.equal(POSTIZ_PROVIDER.youtube, "youtube", "the channel syncs; the post is never built");
  assert.throws(() => postizSettings("vimeo", {}), /No Postiz provider/);
});

test("Hashnode needs a publication id and sends tags only when they are ids", () => {
  assert.throws(
    () => postizSettings("hashnode", { title: "T", tags: "a,b" }),
    (e: any) => e instanceof PostizPayloadError && e.code === "HASHNODE_CONFIG_MISSING",
  );
  const labels = postizSettings("hashnode", { title: "T", publication: "pub-1", tags: "fiscal, taxe" });
  assert.equal(labels.publication, "pub-1");
  assert.equal("tags" in labels, false);
  const id = "507f1f77bcf86cd799439011";
  assert.deepEqual(postizSettings("hashnode", { publication: "pub-1", tags: id }).tags, [{ value: id, label: id }]);
  assert.equal("tags" in postizSettings("hashnode", { publication: "pub-1", tags: `${id}, fiscal` }), false);
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

// Second batch: every other Postiz provider (v2.25.0).
test("Postiz identifiers of the second batch", () => {
  for (const p of ["slack", "wordpress", "listmonk", "vk", "gmb", "tumblr", "dribbble", "mewe", "skool", "whop", "moltbook", "kick", "twitch", "tiktok", "youtube"] as const) {
    assert.equal(POSTIZ_PROVIDER[p], p, p);
  }
});

test("vk and kick send only __type; slack, discord-like platforms send their channel", () => {
  assert.deepEqual(postizSettings("vk", { anything: "ignored" }), { __type: "vk" });
  assert.deepEqual(postizSettings("kick", {}), { __type: "kick" });
  assert.deepEqual(postizSettings("slack", { channel: "C0123ABCD" }), { __type: "slack", channel: "C0123ABCD" });
});

test("wordpress: the article becomes HTML, the type and status default, the first image is the featured image", () => {
  assert.deepEqual(postizSettings("wordpress", { title: "Un titlu" }, [image]), {
    __type: "wordpress", title: "Un titlu", type: "post", status: "publish", main_image: { id: "up-1", path: image.path },
  });
  assert.deepEqual(postizSettings("wordpress", { title: "T", post_type: "page", status: "draft" }), { __type: "wordpress", title: "T", type: "page", status: "draft" });
  assert.equal(postizSettings("wordpress", { title: "T", status: "bogus" }).status, "publish");
  const post = buildPostizPost({ platform: "wordpress", integrationId: "int-w", text: "# Titlu\n\nUn **ghid** calm.", settings: { title: "Titlu" }, media: [] });
  assert.equal(post.posts[0].value[0].content, "<h1>Titlu</h1><p>Un <strong>ghid</strong> calm.</p>");
});

test("listmonk: subject, preview, list and template; the body is HTML", () => {
  assert.deepEqual(postizSettings("listmonk", { title: "Subiect", subtitle: "Previzualizare", list: "3", template: "2" }), {
    __type: "listmonk", subject: "Subiect", preview: "Previzualizare", list: "3", template: "2",
  });
  assert.deepEqual(postizSettings("listmonk", { title: "Subiect", list: "3" }), { __type: "listmonk", subject: "Subiect", preview: "", list: "3" });
  assert.equal(postizContent("listmonk", "Un text.", {}), "<p>Un text.</p>");
});

test("gmb: a standard post, and a button only when one is chosen (CALL needs no link)", () => {
  assert.deepEqual(postizSettings("gmb", {}), { __type: "gmb", topicType: "STANDARD" });
  assert.deepEqual(postizSettings("gmb", { cta_type: "NONE" }), { __type: "gmb", topicType: "STANDARD" });
  assert.deepEqual(postizSettings("gmb", { cta_type: "LEARN_MORE", cta_url: "https://thecrypto.support/x" }), {
    __type: "gmb", topicType: "STANDARD", callToActionType: "LEARN_MORE", callToActionUrl: "https://thecrypto.support/x",
  });
  assert.deepEqual(postizSettings("gmb", { cta_type: "CALL", cta_url: "https://ignored.test" }), { __type: "gmb", topicType: "STANDARD", callToActionType: "CALL" });
});

test("tumblr, dribbble, mewe, skool, whop, moltbook, twitch", () => {
  assert.deepEqual(postizSettings("tumblr", { title: "T", link: "https://thecrypto.support/x", source_url: "https://thecrypto.support/s", tags: ["taxe", "crypto"] }), {
    __type: "tumblr", title: "T", link: "https://thecrypto.support/x", sourceUrl: "https://thecrypto.support/s", tags: "taxe,crypto",
  });
  assert.deepEqual(postizSettings("tumblr", {}), { __type: "tumblr" });
  assert.deepEqual(postizSettings("dribbble", { title: "Un shot", team: "https://dribbble.com/echipa" }), { __type: "dribbble", title: "Un shot", team: "https://dribbble.com/echipa" });
  assert.deepEqual(postizSettings("mewe", {}), { __type: "mewe", postType: "timeline" });
  assert.deepEqual(postizSettings("mewe", { post_type: "group", group: "123" }), { __type: "mewe", postType: "group", group: "123" });
  assert.deepEqual(postizSettings("mewe", { post_type: "timeline", group: "ignored" }), { __type: "mewe", postType: "timeline" });
  assert.deepEqual(postizSettings("skool", { group: "taxes-ro", label: "abc", title: "Titlu" }), { __type: "skool", group: "taxes-ro", label: "abc", title: "Titlu" });
  assert.deepEqual(postizSettings("whop", { company: "biz_1", experience: "exp_1" }), { __type: "whop", company: "biz_1", experience: "exp_1" });
  assert.deepEqual(postizSettings("moltbook", {}), { __type: "moltbook" });
  assert.deepEqual(postizSettings("moltbook", { submolt: "taxe" }), { __type: "moltbook", submolt: "taxe" });
  assert.deepEqual(postizSettings("twitch", {}), { __type: "twitch" });
  assert.deepEqual(postizSettings("twitch", { message_type: "announcement", announcement_color: "blue" }), { __type: "twitch", messageType: "announcement", announcementColor: "blue" });
});

test("tiktok: a direct photo post, private unless a person says otherwise", () => {
  const base = { __type: "tiktok", privacy_level: "SELF_ONLY", duet: false, stitch: false, comment: true, autoAddMusic: "no", brand_content_toggle: false, brand_organic_toggle: false, content_posting_method: "DIRECT_POST" };
  assert.deepEqual(postizSettings("tiktok", {}), base);
  assert.deepEqual(postizSettings("tiktok", { title: "Titlu", privacy_level: "PUBLIC_TO_EVERYONE" }), { ...base, title: "Titlu", privacy_level: "PUBLIC_TO_EVERYONE" });
  assert.equal(postizSettings("tiktok", { privacy_level: "EVERYONE" }).privacy_level, "SELF_ONLY");
  const post = buildPostizPost({ platform: "tiktok", integrationId: "int-t", text: "Descriere", settings: {}, media: [image, { ...image, id: "up-2" }] });
  assert.equal(post.posts[0].value[0].image.length, 2);
});

test("youtube needs video: the app never builds a Postiz post for it", () => {
  assert.throws(() => postizSettings("youtube", { title: "T" }), /manual handoff only/);
  assert.throws(() => buildPostizPost({ platform: "youtube", integrationId: "int-y", text: "D", settings: {}, media: [] }), /manual handoff only/);
});

test("markdown for HTML-editor providers keeps only the tags Postiz keeps", () => {
  assert.equal(markdownToPostizHtml("# A\n## B\n#### C"), "<h1>A</h1><h2>B</h2><h3>C</h3>");
  assert.equal(markdownToPostizHtml("Prima linie\nal doua rand\n\nUn paragraf nou."), "<p>Prima linie al doua rand</p><p>Un paragraf nou.</p>");
  assert.equal(markdownToPostizHtml("- unu\n- doi\n  continuat"), "<ul><li>unu</li><li>doi continuat</li></ul>");
  assert.equal(markdownToPostizHtml("1. primul\n2. al doilea"), "<ul><li>1) primul</li><li>2) al doilea</li></ul>");
  assert.equal(markdownToPostizHtml("Un *accent*, un `cod` si **tare** si [link](https://thecrypto.support/x) si https://thecrypto.support/y."), '<p>Un accent, un cod si <strong>tare</strong> si <a href="https://thecrypto.support/x">link</a> si <a href="https://thecrypto.support/y">https://thecrypto.support/y</a>.</p>');
  assert.equal(markdownToPostizHtml("```\nlinia 1\n<b>\n```"), "<p>linia 1</p><p>&lt;b&gt;</p>");
  assert.equal(markdownToPostizHtml("> citat\n\n---\n\nFinal"), "<p>citat</p><p>Final</p>");
  assert.equal(markdownToPostizHtml("[rau](javascript:alert(1)) <script>x</script>"), "<p>[rau](javascript:alert(1)) &lt;script&gt;x&lt;/script&gt;</p>");
  assert.equal(markdownToPostizHtml(""), "");
});
