import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { processJob } from "./delivery.js";
import { destinationHash } from "../delivery/hash.js";
import { siteApi } from "../services/site-api.js";
import { postizApi } from "../services/postiz-api.js";
import { startSyncLoop } from "./sync.js";
import { config } from "../config.js";

function fixture() {
  const bytes = Buffer.from("test-image");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const account = { id: randomUUID(), platform: "x", postiz_integration_id: "mock-x" };
  const destination = { text: "Taxes Support", settings: {}, scheduled_at: new Date().toISOString(), destination_hash: "" };
  const media = [{ media_id: randomUUID(), sha256, alt_text: "Card", url: "http://local.test/media", mime: "image/png" }];
  destination.destination_hash = destinationHash({ account_id: account.id, platform: account.platform, ...destination, media });
  return { bytes, job: { job_id: randomUUID(), kind: "publish", attempt_no: 1, account, destination, media } };
}
test("dry run downloads and checks media, submits a result without contacting Postiz", async t => {
  const { bytes, job } = fixture();
  t.mock.method(globalThis, "fetch", async () => new Response(bytes));
  const upload = t.mock.method(postizApi, "uploadMedia", async () => { throw new Error("Unexpected Postiz upload"); });
  const create = t.mock.method(postizApi, "createPost", async () => { throw new Error("Unexpected Postiz publish"); });
  t.mock.method(siteApi, "submitting", async () => ({}));
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await processJob(job);
  assert.equal(upload.mock.callCount(), 0);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(result.mock.calls[0].arguments[1]?.outcome, "published");
});
test("media bytes that do not match approved SHA retry instead of publishing", async t => {
  const { job } = fixture();
  t.mock.method(globalThis, "fetch", async () => new Response("tampered"));
  const result = t.mock.method(siteApi, "result", async () => ({}));
  const submitting = t.mock.method(siteApi, "submitting", async () => ({}));
  await processJob(job);
  assert.equal(submitting.mock.callCount(), 0);
  assert.equal(result.mock.calls[0].arguments[1]?.outcome, "retry");
  assert.equal(result.mock.calls[0].arguments[1]?.error_code, "MEDIA_FETCH_FAILED");
});
test("dry run poll, reconciliation and sync never call Postiz", async t => {
  const list = t.mock.method(postizApi, "listPosts", async () => { throw new Error("Unexpected Postiz read"); });
  const integrations = t.mock.method(postizApi, "listIntegrations", async () => { throw new Error("Unexpected Postiz sync"); });
  const { job } = fixture();
  await processJob({ ...job, kind: "poll", postiz: { post_id: "existing" } });
  await processJob({ ...job, kind: "reconcile" });
  startSyncLoop();
  assert.equal(list.mock.callCount(), 0);
  assert.equal(integrations.mock.callCount(), 0);
});

// Amendment 04: the live path (not a dry run) builds Postiz's own request body per platform.
async function live<T>(run: () => Promise<T>): Promise<T> {
  const previous = config.WORKER_DRY_RUN;
  config.WORKER_DRY_RUN = false;
  try { return await run(); } finally { config.WORKER_DRY_RUN = previous; }
}
function jobFor(platform: string, text: string, settings: Record<string, unknown>) {
  const account = { id: randomUUID(), platform, postiz_integration_id: `mock-${platform}` };
  const destination = { text, settings, scheduled_at: new Date().toISOString(), destination_hash: "" };
  destination.destination_hash = destinationHash({ account_id: account.id, platform, ...destination, media: [] });
  return { job_id: randomUUID(), kind: "publish", attempt_no: 1, account, destination, media: [] as unknown[] };
}
test("a Reddit post goes to Postiz as a CreatePostDto with the subreddit list", async t => {
  const job = jobFor("reddit", "Termenul este 25 mai.", { subreddit: "r/taxes_ro", title: "Un titlu", post_type: "self" });
  t.mock.method(siteApi, "submitting", async () => ({}));
  const create = t.mock.method(postizApi, "createPost", async () => [{ postId: "post-77", integration: "mock-reddit" }]);
  const submitted = t.mock.method(siteApi, "submitted", async () => ({}));
  await live(() => processJob(job));
  const body = create.mock.calls[0].arguments[0]!;
  assert.equal(body.type, "now");
  assert.deepEqual(body.posts[0].integration, { id: "mock-reddit" });
  assert.equal(body.posts[0].value[0].content, "Termenul este 25 mai.");
  assert.deepEqual(body.posts[0].settings, {
    __type: "reddit",
    subreddit: [{ value: { subreddit: "r/taxes_ro", title: "Un titlu", type: "self", url: "", is_flair_required: false } }],
  });
  assert.deepEqual(submitted.mock.calls[0].arguments, [job.job_id, 1, "post-77", "post-77"]);
});
test("a Bluesky post needs no settings; the answer's postId is kept", async t => {
  const job = jobFor("bluesky", "Ai pana pe 25 mai.", {});
  t.mock.method(siteApi, "submitting", async () => ({}));
  const create = t.mock.method(postizApi, "createPost", async () => [{ postId: "post-5", integration: "mock-bluesky" }]);
  const submitted = t.mock.method(siteApi, "submitted", async () => ({}));
  await live(() => processJob(job));
  assert.deepEqual(create.mock.calls[0].arguments[0]!.posts[0]!.settings, { __type: "bluesky" });
  assert.equal(submitted.mock.calls[0].arguments[2], "post-5");
});
test("a manual-only platform that reaches the worker fails without calling Postiz", async t => {
  const job = jobFor("substack", "Un articol", { title: "T" });
  t.mock.method(siteApi, "submitting", async () => ({}));
  const create = t.mock.method(postizApi, "createPost", async () => { throw new Error("Unexpected Postiz publish"); });
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.equal(create.mock.callCount(), 0);
  assert.equal(result.mock.calls[0].arguments[1]?.outcome, "failed");
  assert.equal(result.mock.calls[0].arguments[1]?.error_code, "VALIDATION_REJECTED");
});
