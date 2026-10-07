import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSyncPayload, mapIntegration, mapRecentPost } from "./sync.js";
import { PROVIDER_TO_PLATFORM, platformForProvider } from "../platforms.js";

// What GET /public/v1/integrations returns for each new platform (Postiz v2.25.0).
const NEW_PROVIDERS: Array<[identifier: string, platform: string]> = [
  ["threads", "threads"], ["bluesky", "bluesky"], ["mastodon", "mastodon"], ["mastodon-custom", "mastodon"],
  ["linkedin", "linkedin"], ["reddit", "reddit"], ["pinterest", "pinterest"], ["telegram", "telegram"],
  ["discord", "discord"], ["medium", "medium"], ["wrapcast", "farcaster"], ["nostr", "nostr"], ["lemmy", "lemmy"],
];

test("sync sends the provider of every new platform and maps it to our platform", () => {
  for (const [identifier, platform] of NEW_PROVIDERS) {
    const mapped = mapIntegration({ id: `int-${identifier}`, name: `Canal ${identifier}`, identifier, picture: null, disabled: false });
    assert.equal(mapped.provider, identifier);
    assert.equal(mapped.postiz_integration_id, `int-${identifier}`);
    assert.equal(platformForProvider(mapped.provider), platform, identifier);
    assert.equal(PROVIDER_TO_PLATFORM[identifier], platform);
  }
});

test("the provider field is `identifier` in Postiz's public API; providerIdentifier and provider still work", () => {
  assert.equal(mapIntegration({ id: "1", name: "a", identifier: "bluesky" }).provider, "bluesky");
  assert.equal(mapIntegration({ id: "1", name: "a", providerIdentifier: "reddit" }).provider, "reddit");
  assert.equal(mapIntegration({ id: "1", name: "a", provider: "x" }).provider, "x");
  assert.equal(platformForProvider("LinkedIn-Page"), "linkedin-page");
  assert.equal(platformForProvider("linkedin"), "linkedin");
  assert.equal(platformForProvider("tiktok"), null);
  assert.equal(platformForProvider(undefined), null);
});

test("the sync body keeps unknown providers for the site to ignore, and reads the channel of a recent post", () => {
  const body = buildSyncPayload(
    [{ id: "1", name: "Bluesky", identifier: "bluesky" }, { id: "2", name: "Un canal video", identifier: "tiktok" }],
    [{ id: "post-1", integration: { id: "1" }, publishDate: "2026-10-07T07:00:00.000Z" }, { id: "post-2", integration: "2", createdAt: "2026-10-07T06:00:00Z" }],
  );
  assert.deepEqual(body.integrations.map((i) => i.provider), ["bluesky", "tiktok"]);
  assert.deepEqual(body.postiz_recent_posts.map((p) => p.integration_id), ["1", "2"]);
  assert.deepEqual(mapRecentPost({ id: "p", integrationId: "3" }).integration_id, "3");
});
