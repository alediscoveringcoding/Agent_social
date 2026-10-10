import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import * as nodeOs from "node:os";
import { classifyCreateError, pickReconcileMatch, normalizeContent, processJob, RECONCILE_MIN_AGE_MS } from "./delivery.js";
import { destinationHash } from "../delivery/hash.js";
import { siteApi, LeaseLostError } from "../services/site-api.js";
import { postizApi, PostizHttpError, parseRetryAfter } from "../services/postiz-api.js";
import { config } from "../config.js";

// Delivery hardening: createPost verdicts, reconcile matching, heartbeats, 409s, temp files.

async function live<T>(run: () => Promise<T>): Promise<T> {
  const previous = config.WORKER_DRY_RUN;
  config.WORKER_DRY_RUN = false;
  try { return await run(); } finally { config.WORKER_DRY_RUN = previous; }
}
function jobFor(platform: string, text: string, settings: Record<string, unknown>) {
  const account = { id: randomUUID(), platform, postiz_integration_id: `mock-${platform}` };
  const destination = { text, settings, scheduled_at: new Date().toISOString(), destination_hash: "" };
  destination.destination_hash = destinationHash({ account_id: account.id, platform, ...destination, media: [] });
  return { job_id: randomUUID(), kind: "publish", attempt_no: 1, account, destination, media: [] as any[] };
}
/** The site's 409 error, with the code of the body (site-api.ts carries it on `code`). */
const lease = (code?: string) => Object.assign(new LeaseLostError(), code ? { code } : {});

test("a definite 4xx from Postiz is a failure or a retry; timeouts, network errors and 5xx stay unknown", () => {
  const http = (status: number, retry?: number) => new PostizHttpError(status, "x", retry);
  assert.deepEqual(classifyCreateError(http(401)), { outcome: "failed", error_code: "POSTIZ_UNAUTHORIZED" });
  assert.deepEqual(classifyCreateError(http(403)), { outcome: "failed", error_code: "POSTIZ_FORBIDDEN" });
  assert.deepEqual(classifyCreateError(http(429, 42)), { outcome: "retry", error_code: "RATE_LIMITED", retry_after_seconds: 42 });
  assert.deepEqual(classifyCreateError(http(429)), { outcome: "retry", error_code: "RATE_LIMITED" });
  assert.equal(classifyCreateError(http(400)).error_code, "VALIDATION_REJECTED");
  assert.equal(classifyCreateError(http(422)).error_code, "VALIDATION_REJECTED");
  assert.equal(classifyCreateError(http(404)).outcome, "failed");
  assert.equal(classifyCreateError(http(408)).outcome, "reconciling");
  assert.equal(classifyCreateError(http(500)).outcome, "reconciling");
  assert.equal(classifyCreateError(http(502)).outcome, "reconciling");
  assert.equal(classifyCreateError(new DOMException("timed out", "TimeoutError")).outcome, "reconciling");
  assert.equal(classifyCreateError(new TypeError("fetch failed")).outcome, "reconciling");
});

test("Retry-After accepts seconds and dates", () => {
  assert.equal(parseRetryAfter("30"), 30);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("nonsense"), undefined);
  assert.equal(parseRetryAfter(new Date(1_000_000 + 90_000).toUTCString(), 1_000_000), 90);
});

for (const [status, outcome, code] of [[401, "failed", "POSTIZ_UNAUTHORIZED"], [403, "failed", "POSTIZ_FORBIDDEN"], [500, "reconciling", "UNKNOWN_RESULT"]] as const) {
  test(`createPost answering ${status} is reported as ${outcome} ${code}`, async t => {
    const job = jobFor("bluesky", "Un text.", {});
    t.mock.method(siteApi, "submitting", async () => ({}));
    t.mock.method(postizApi, "createPost", async () => { throw new PostizHttpError(status, "no"); });
    const result = t.mock.method(siteApi, "result", async () => ({}));
    await live(() => processJob(job));
    assert.equal(result.mock.callCount(), 1);
    assert.equal(result.mock.calls[0].arguments[1]?.outcome, outcome);
    assert.equal(result.mock.calls[0].arguments[1]?.error_code, code);
  });
}

test("a 429 retries with the Retry-After seconds", async t => {
  const job = jobFor("bluesky", "Un text.", {});
  t.mock.method(siteApi, "submitting", async () => ({}));
  t.mock.method(postizApi, "createPost", async () => { throw new PostizHttpError(429, "slow down", 120); });
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  const body = result.mock.calls[0].arguments[1] as any;
  assert.equal(body.outcome, "retry");
  assert.equal(body.retry_after_seconds, 120);
});

test("Hashnode without a publication id fails before Postiz is called", async t => {
  const job = jobFor("hashnode", "Un articol.", { title: "T", tags: "a,b" });
  t.mock.method(siteApi, "submitting", async () => ({}));
  const create = t.mock.method(postizApi, "createPost", async () => { throw new Error("Unexpected Postiz publish"); });
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.equal(create.mock.callCount(), 0);
  assert.equal(result.mock.calls[0].arguments[1]?.outcome, "failed");
  assert.equal(result.mock.calls[0].arguments[1]?.error_code, "HASHNODE_CONFIG_MISSING");
});

test("submitted refused with INVALID_TRANSITION or LEASE_LOST is logged, not reported again", async t => {
  for (const code of ["INVALID_TRANSITION", "LEASE_LOST"]) {
    const job = jobFor("bluesky", "Un text.", {});
    t.mock.method(siteApi, "submitting", async () => ({}));
    t.mock.method(postizApi, "createPost", async () => [{ postId: "p1", integration: "x" }]);
    t.mock.method(siteApi, "submitted", async () => { throw lease(code); });
    const result = t.mock.method(siteApi, "result", async () => ({}));
    await live(() => processJob(job));
    assert.equal(result.mock.callCount(), 0, code);
    t.mock.restoreAll();
  }
});

test("submitted failing on the network asks for reconciliation", async t => {
  const job = jobFor("bluesky", "Un text.", {});
  t.mock.method(siteApi, "submitting", async () => ({}));
  t.mock.method(postizApi, "createPost", async () => [{ postId: "p1", integration: "x" }]);
  t.mock.method(siteApi, "submitted", async () => { throw new Error("Site API 502"); });
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.equal(result.mock.calls[0].arguments[1]?.outcome, "reconciling");
});

test("a refused /submitting stops before Postiz, whatever the 409 code", async t => {
  for (const code of ["LEASE_LOST", "INVALID_TRANSITION", undefined]) {
    const job = jobFor("bluesky", "Un text.", {});
    t.mock.method(siteApi, "submitting", async () => { throw lease(code); });
    const create = t.mock.method(postizApi, "createPost", async () => { throw new Error("Unexpected Postiz publish"); });
    await live(() => processJob(job));
    assert.equal(create.mock.callCount(), 0, String(code));
    t.mock.restoreAll();
  }
});

test("the lease is extended while a job runs, and the timer stops afterwards", async t => {
  const job = jobFor("bluesky", "Un text.", {});
  t.mock.method(siteApi, "submitting", async () => ({}));
  t.mock.method(postizApi, "createPost", async () => {
    await new Promise((r) => setTimeout(r, 150));
    return [{ postId: "p1", integration: "x" }];
  });
  t.mock.method(siteApi, "submitted", async () => ({}));
  const beat = t.mock.method(siteApi, "heartbeat", async () => ({}));
  await live(() => processJob(job, { heartbeatMs: 20 }));
  const during = beat.mock.callCount();
  assert.ok(during >= 2, `expected heartbeats while running, got ${during}`);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(beat.mock.callCount(), during, "no heartbeat after the job ended");
});

test("a heartbeat answered 409 stops the job before the Postiz call", async t => {
  const job = jobFor("bluesky", "Un text.", {});
  t.mock.method(siteApi, "heartbeat", async () => { throw lease("LEASE_LOST"); });
  t.mock.method(siteApi, "submitting", async () => {
    await new Promise((r) => setTimeout(r, 100));
    return {};
  });
  const create = t.mock.method(postizApi, "createPost", async () => { throw new Error("Unexpected Postiz publish"); });
  await live(() => processJob(job, { heartbeatMs: 10 }));
  assert.equal(create.mock.callCount(), 0);
});

test("each job downloads media to its own temp directory, removed afterwards", async t => {
  const tmpDirs = () => readdirSync(nodeOs.tmpdir()).filter((n) => n.startsWith("social-media-")).length;
  const before = tmpDirs();
  const seen: string[] = [];
  t.mock.method(postizApi, "uploadMedia", async (p: string) => { seen.push(p); return { id: "u", path: "/u.png" }; });
  t.mock.method(siteApi, "submitting", async () => ({}));
  t.mock.method(postizApi, "createPost", async () => [{ postId: "p1", integration: "x" }]);
  t.mock.method(siteApi, "submitted", async () => ({}));
  const bytes = Buffer.from("test-image");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  t.mock.method(globalThis, "fetch", async () => new Response(bytes));
  for (let n = 0; n < 2; n++) {
    const job = jobFor("bluesky", "Un text.", {});
    // The same media id in both jobs.
    job.media = [{ media_id: "same-media", sha256, alt_text: "Card", url: "http://local.test/media", mime: "image/png" }];
    job.destination.destination_hash = destinationHash({ account_id: job.account.id, platform: "bluesky", ...job.destination, media: job.media });
    await live(() => processJob(job));
  }
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(tmpDirs(), before);
});

// --- Reconcile ---------------------------------------------------------------
const T0 = Date.parse("2026-10-10T10:00:00.000Z");
const post = (id: string, content: string, at: number, integration = "mock-bluesky") =>
  ({ id, content, publishDate: new Date(at).toISOString(), integration: { id: integration } });
const query = { integrationId: "mock-bluesky", platform: "bluesky", text: "Termenul este 25 mai.", settings: {}, attemptStartMs: T0 };

test("reconcile matches by channel, content and time, ignoring HTML and case", () => {
  const posts = [
    post("old", "Termenul este 25 mai.", T0 - 10 * 60_000), // before the attempt
    post("other-text", "Altceva cu totul si mai lung", T0 + 1000),
    post("other-channel", "Termenul este 25 mai.", T0 + 1000, "mock-x"),
    post("mine", "<p>TERMENUL este 25 mai.</p>", T0 + 5000),
  ];
  const { match, count } = pickReconcileMatch(posts, query);
  assert.equal(match.id, "mine");
  assert.equal(count, 1);
});

test("reconcile tolerates two minutes of clock skew but not more", () => {
  assert.equal(pickReconcileMatch([post("a", query.text, T0 - 90_000)], query).match?.id, "a");
  assert.equal(pickReconcileMatch([post("a", query.text, T0 - 150_000)], query).match, null);
});

test("with several matches reconcile takes the closest to the attempt start", () => {
  const { match, count } = pickReconcileMatch([post("late", query.text, T0 + 600_000), post("near", query.text, T0 + 3000)], query);
  assert.equal(count, 2);
  assert.equal(match.id, "near");
});

test("normalizeContent strips tags and entities", () => {
  assert.equal(normalizeContent("<p>Ana &amp; Ion</p><p>sunt</p>"), "ana ion sunt");
});

function reconcileJob(startedAt: string | null) {
  const j = jobFor("bluesky", "Termenul este 25 mai.", {});
  return { ...j, kind: "reconcile", attempt_started_at: startedAt };
}

test("reconcile marks the matching post submitted", async t => {
  const job = reconcileJob(new Date(Date.now() - 60_000).toISOString());
  t.mock.method(postizApi, "listPosts", async () => [
    post("someone-else", "Alt text complet diferit", Date.now() - 30_000),
    post("pz-9", "Termenul este 25 mai.", Date.now() - 50_000),
  ]);
  const submitted = t.mock.method(siteApi, "submitted", async () => ({}));
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.deepEqual(submitted.mock.calls[0].arguments, [job.job_id, 1, "pz-9", "pz-9"]);
  assert.equal(result.mock.callCount(), 0);
});

test("reconcile with no match reports nothing while the attempt is young", async t => {
  const job = reconcileJob(new Date(Date.now() - 60_000).toISOString());
  const list = t.mock.method(postizApi, "listPosts", async () => []);
  const submitted = t.mock.method(siteApi, "submitted", async () => ({}));
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.equal(submitted.mock.callCount(), 0);
  assert.equal(result.mock.callCount(), 0);
  // The range starts before the attempt.
  assert.ok(Date.parse(list.mock.calls[0].arguments[0] as string) < Date.parse(job.attempt_started_at!));
});

test("reconcile reports not_found once the attempt is old enough, and ignores unrelated posts", async t => {
  const job = reconcileJob(new Date(Date.now() - RECONCILE_MIN_AGE_MS - 60_000).toISOString());
  t.mock.method(postizApi, "listPosts", async () => [post("unrelated", "Cu totul alt text de la altcineva", Date.now() - 30_000)]);
  const submitted = t.mock.method(siteApi, "submitted", async () => ({}));
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.equal(submitted.mock.callCount(), 0);
  assert.equal(result.mock.calls[0].arguments[1]?.outcome, "not_found");
});

test("reconcile without an attempt start never reports not_found", async t => {
  const job = reconcileJob(null);
  t.mock.method(postizApi, "listPosts", async () => []);
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.equal(result.mock.callCount(), 0);
});

// --- Poll ----------------------------------------------------------------------
test("poll asks Postiz for a range around the job and omits an empty remote_url", async t => {
  const started = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const job = { ...jobFor("bluesky", "Un text.", {}), kind: "poll", attempt_started_at: started, postiz: { post_id: "pz-1" } };
  const list = t.mock.method(postizApi, "listPosts", async () => [{ id: "pz-1", state: "PUBLISHED", releaseURL: "" }]);
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.ok(Date.parse(list.mock.calls[0].arguments[0] as string) < Date.parse(started));
  const body = result.mock.calls[0].arguments[1] as any;
  assert.equal(body.outcome, "published");
  assert.equal("remote_url" in body, false);
});

test("poll keeps a real release URL", async t => {
  const job = { ...jobFor("bluesky", "Un text.", {}), kind: "poll", postiz: { post_id: "pz-1" } };
  t.mock.method(postizApi, "listPosts", async () => [{ id: "pz-1", releaseURL: "https://bsky.app/profile/x/post/1" }]);
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.equal((result.mock.calls[0].arguments[1] as any).remote_url, "https://bsky.app/profile/x/post/1");
});
