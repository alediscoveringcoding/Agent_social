import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { processJob } from "./delivery.js";
import { destinationHash } from "../delivery/hash.js";
import { siteApi } from "../services/site-api.js";
import { postizApi } from "../services/postiz-api.js";
import { startSyncLoop } from "./sync.js";

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
