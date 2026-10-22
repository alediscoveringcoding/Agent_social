import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { processJob } from "./delivery.js";
import { destinationHash } from "../delivery/hash.js";
import { siteApi, LeaseLostError } from "../services/site-api.js";
import { config } from "../config.js";

// The worker schedules; the site publishes through its own adapters (amendments 08 and 10).

async function live<T>(run: () => Promise<T>): Promise<T> {
  const previous = config.WORKER_DRY_RUN;
  config.WORKER_DRY_RUN = false;
  try { return await run(); } finally { config.WORKER_DRY_RUN = previous; }
}

function jobFor(kind = "publish", backend: string | null = "native") {
  const account = { id: randomUUID(), platform: "bluesky", publishing_backend: backend, native_provider_account_id: "did:plc:test" };
  const destination = { text: "Taxes Support", settings: {}, scheduled_at: new Date().toISOString(), destination_hash: "" };
  const media = [{ media_id: randomUUID(), sha256: "a".repeat(64), alt_text: "Card", mime: "image/png" }];
  destination.destination_hash = destinationHash({ account_id: account.id, platform: account.platform, ...destination, media });
  return { job_id: randomUUID(), kind, attempt_no: 1, account, destination, media };
}

/** The site's 409 error, with the code of the body (site-api.ts carries it on `code`). */
const lease = (code?: string) => Object.assign(new LeaseLostError(), code ? { code } : {});

test("publish marks the attempt, then asks the site to publish; the worker gets no platform credential", async t => {
  const job = jobFor();
  const order: string[] = [];
  t.mock.method(siteApi, "submitting", async () => { order.push("submitting"); return {}; });
  const send = t.mock.method(siteApi, "nativeDelivery", async () => { order.push("native"); return { ok: true }; });
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.deepEqual(order, ["submitting", "native"]);
  assert.deepEqual(send.mock.calls[0].arguments, [job.job_id, 1, "publish"]);
  assert.equal(result.mock.callCount(), 0, "the site records the outcome itself");
  assert.ok(!JSON.stringify(job).match(/token|secret|password/i));
});

test("a lost publish response asks for reconciliation and never sends the publish twice", async t => {
  const job = jobFor();
  t.mock.method(siteApi, "submitting", async () => ({}));
  const send = t.mock.method(siteApi, "nativeDelivery", async () => { throw new TypeError("fetch failed"); });
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.equal(send.mock.callCount(), 1);
  assert.equal(result.mock.calls[0].arguments[1]?.outcome, "reconciling");
  assert.equal(result.mock.calls[0].arguments[1]?.error_code, "NATIVE_RESPONSE_LOST");
});

test("a 409 from the publish call is the site's answer: nothing more is reported", async t => {
  for (const code of ["LEASE_LOST", "PUBLISHING_PAUSED", undefined]) {
    const job = jobFor();
    t.mock.method(siteApi, "submitting", async () => ({}));
    t.mock.method(siteApi, "nativeDelivery", async () => { throw lease(code); });
    const result = t.mock.method(siteApi, "result", async () => ({}));
    await live(() => processJob(job));
    assert.equal(result.mock.callCount(), 0, String(code));
    t.mock.restoreAll();
  }
});

test("poll and reconcile jobs are checked by the site through its journal", async t => {
  const check = t.mock.method(siteApi, "nativeDelivery", async () => ({}));
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(jobFor("poll")));
  await live(() => processJob(jobFor("reconcile")));
  assert.equal(check.mock.callCount(), 2);
  assert.ok(check.mock.calls.every(call => call.arguments[2] === "check"));
  assert.equal(result.mock.callCount(), 0, "absence is never guessed by the worker");
});

test("dry run never asks the site to publish or check, and reports a fake published URL", async t => {
  const job = jobFor();
  t.mock.method(siteApi, "submitting", async () => ({}));
  const result = t.mock.method(siteApi, "result", async () => ({}));
  const send = t.mock.method(siteApi, "nativeDelivery", async () => { throw new Error("Unexpected real publication"); });
  await processJob(job);
  await processJob(jobFor("poll"));
  await processJob(jobFor("reconcile"));
  assert.equal(send.mock.callCount(), 0);
  assert.equal(result.mock.callCount(), 1);
  assert.equal(result.mock.calls[0].arguments[1]?.outcome, "published");
  assert.match(String(result.mock.calls[0].arguments[1]?.remote_url), /^https:\/\/example\.com\/dry-run\//);
});

test("content that does not match the approved hash fails before anything is sent", async t => {
  const job = jobFor();
  job.destination.text = "Alt text decat cel aprobat";
  const submitting = t.mock.method(siteApi, "submitting", async () => ({}));
  const send = t.mock.method(siteApi, "nativeDelivery", async () => ({}));
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(job));
  assert.equal(submitting.mock.callCount(), 0);
  assert.equal(send.mock.callCount(), 0);
  assert.equal(result.mock.calls[0].arguments[1]?.error_code, "HASH_MISMATCH");
});

test("a refused /submitting stops before the publish call, whatever the 409 code", async t => {
  for (const code of ["LEASE_LOST", "INVALID_TRANSITION", undefined]) {
    t.mock.method(siteApi, "submitting", async () => { throw lease(code); });
    const send = t.mock.method(siteApi, "nativeDelivery", async () => { throw new Error("Unexpected publication"); });
    await live(() => processJob(jobFor()));
    assert.equal(send.mock.callCount(), 0, String(code));
    t.mock.restoreAll();
  }
});

test("the lease is extended while a job runs, and the timer stops afterwards", async t => {
  t.mock.method(siteApi, "submitting", async () => ({}));
  t.mock.method(siteApi, "nativeDelivery", async () => {
    await new Promise((r) => setTimeout(r, 150));
    return {};
  });
  const beat = t.mock.method(siteApi, "heartbeat", async () => ({}));
  await live(() => processJob(jobFor(), { heartbeatMs: 20 }));
  const during = beat.mock.callCount();
  assert.ok(during >= 2, `expected heartbeats while running, got ${during}`);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(beat.mock.callCount(), during, "no heartbeat after the job ended");
});

test("a heartbeat answered 409 stops the job before the publish call", async t => {
  t.mock.method(siteApi, "heartbeat", async () => { throw lease("LEASE_LOST"); });
  t.mock.method(siteApi, "submitting", async () => {
    await new Promise((r) => setTimeout(r, 100));
    return {};
  });
  const send = t.mock.method(siteApi, "nativeDelivery", async () => { throw new Error("Unexpected publication"); });
  await live(() => processJob(jobFor(), { heartbeatMs: 10 }));
  assert.equal(send.mock.callCount(), 0);
});

test("a job of an old Postiz account fails to publish and is never looked up", async t => {
  const send = t.mock.method(siteApi, "nativeDelivery", async () => { throw new Error("Unexpected call"); });
  const submitting = t.mock.method(siteApi, "submitting", async () => ({}));
  const result = t.mock.method(siteApi, "result", async () => ({}));
  await live(() => processJob(jobFor("publish", "postiz")));
  await live(() => processJob(jobFor("poll", "postiz")));
  await live(() => processJob(jobFor("reconcile", null)));
  assert.equal(send.mock.callCount(), 0);
  assert.equal(submitting.mock.callCount(), 0);
  assert.equal(result.mock.callCount(), 1, "only the publish job is reported");
  assert.equal(result.mock.calls[0].arguments[1]?.outcome, "failed");
  assert.equal(result.mock.calls[0].arguments[1]?.error_code, "LEGACY_POSTIZ_ACCOUNT");
});

test("a result refused with 409 is logged, not thrown", async t => {
  for (const code of ["LEASE_LOST", "INVALID_TRANSITION"]) {
    const job = jobFor();
    job.destination.text = "changed";
    t.mock.method(siteApi, "result", async () => { throw lease(code); });
    await assert.doesNotReject(live(() => processJob(job)), code);
    t.mock.restoreAll();
  }
});
