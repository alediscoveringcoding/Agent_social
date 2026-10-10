import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { processGenerationRequest } from "./generator.js";
import { LeaseLostError, SiteApiError } from "../services/site-api.js";
import { modelDraft } from "../test-support/drafts.js";

const input = { source: { type: "topic", topic: "Declaratia" }, platforms: ["x"], kinds: ["social"], count: 1 };
const leaseIn = () => new Date(Date.now() + 600000).toISOString();
const okApi = (extra: Record<string, unknown> = {}) => ({
  generationHeartbeat: async () => ({ lease_expires_at: leaseIn() }),
  postDrafts: async () => ({ created: 1, skipped: 0 }),
  generationFailed: async () => ({}),
  ...extra,
}) as any;
const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

test("GENERATION_REPAIR off: one AI call, drafts posted with their errors", async () => {
  let calls = 0;
  let posted: any[] = [];
  await processGenerationRequest({ request_id: "norepair", brand: "taxes-support", input, lease_expires_at: leaseIn() }, {
    repair: false,
    api: okApi({ postDrafts: async (_id: string, drafts: any[]) => { posted = drafts; return {}; } }),
    generate: async () => { calls++; return { drafts: [modelDraft({ canonical_text: "ă" })], stopReason: "end_turn" }; },
  });
  assert.equal(calls, 1);
  assert.ok(posted[0].validation_errors.length > 0);
});

test("repair on (default): a failing batch gets exactly one extra call", async () => {
  let calls = 0;
  await processGenerationRequest({ request_id: "repair", brand: "taxes-support", input, lease_expires_at: leaseIn() }, {
    repair: true,
    api: okApi(),
    generate: async () => { calls++; return { drafts: [modelDraft({ canonical_text: "ă" })], stopReason: "end_turn" }; },
  });
  assert.equal(calls, 2);
});

test("a timed-out postDrafts is retried once with the same body and no new AI call", async () => {
  let ai = 0;
  const bodies: any[] = [];
  const failed: string[] = [];
  await processGenerationRequest({ request_id: "retry", brand: "taxes-support", input, lease_expires_at: leaseIn() }, {
    api: okApi({
      postDrafts: async (_id: string, drafts: any[]) => {
        bodies.push(drafts);
        if (bodies.length === 1) throw timeout();
        return { created: 1, skipped: 0 };
      },
      generationFailed: async (_id: string, code: string) => { failed.push(code); return {}; },
    }),
    generate: async () => { ai++; return { drafts: [modelDraft()], stopReason: "end_turn" }; },
  });
  assert.equal(ai, 1);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(failed, []);
});

test("two postDrafts timeouts are reported as uncertain, so no re-claim pays for a new AI call", async () => {
  const failed: string[] = [];
  let posts = 0;
  await processGenerationRequest({ request_id: "retry2", brand: "taxes-support", input, lease_expires_at: leaseIn() }, {
    api: okApi({
      postDrafts: async () => { posts++; throw timeout(); },
      generationFailed: async (_id: string, code: string) => { failed.push(code); return {}; },
    }),
    generate: async () => ({ drafts: [modelDraft()], stopReason: "end_turn" }),
  });
  assert.equal(posts, 2);
  assert.deepEqual(failed, ["DRAFTS_POST_UNCERTAIN"]);
});

test("a site 4xx on postDrafts is not retried and is reported", async () => {
  const failed: string[] = [];
  let posts = 0;
  await processGenerationRequest({ request_id: "r422", brand: "taxes-support", input, lease_expires_at: leaseIn() }, {
    api: okApi({
      postDrafts: async () => { posts++; throw new SiteApiError(422, "bad"); },
      generationFailed: async (_id: string, code: string) => { failed.push(code); return {}; },
    }),
    generate: async () => ({ drafts: [modelDraft()], stopReason: "end_turn" }),
  });
  assert.equal(posts, 1);
  assert.deepEqual(failed, ["GENERATION_ERROR"]);
});

test("a broken brand is reported through /failed, not thrown", async () => {
  const failed: string[] = [];
  await processGenerationRequest({ request_id: "badbrand", brand: "../../etc/passwd\0", input, lease_expires_at: leaseIn() }, {
    api: okApi({ generationFailed: async (_id: string, code: string, message: string) => { failed.push(`${code}:${message}`); return {}; } }),
    generate: async () => ({ drafts: [modelDraft()], stopReason: "end_turn" }),
  });
  assert.ok(failed.length <= 1);
});

test("409 responses carry the body error code on LeaseLostError", async () => {
  const { siteApi } = await import("../services/site-api.js");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ error: { code: "LEASE_LOST", message: "x" } }, { status: 409 })) as typeof fetch;
  try {
    await assert.rejects(siteApi.generationHeartbeat("x"), (err: any) => err instanceof LeaseLostError && err.code === "LEASE_LOST");
  } finally { globalThis.fetch = realFetch; }
});
