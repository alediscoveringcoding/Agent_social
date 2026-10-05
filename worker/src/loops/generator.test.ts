import "../test-support/env.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { modelDraft } from "../test-support/drafts.js";

let child: ChildProcess;
let base: string;
let generator: typeof import('./generator.js');
let api: typeof import('../services/site-api.js');
const input = { source: { type: "topic", topic: "Declaratia" }, platforms: ["x"], kinds: ["social"], count: 2 };

before(async () => {
  child = spawn(process.execPath, ["test/mock-site.mjs"], {
    cwd: new URL("../..", import.meta.url), env: { ...process.env, MOCK_SITE_PORT: "0", MOCK_SITE_NO_SEED: "true", MOCK_SITE_LEASE_MS: "1500" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => reject(new Error(`Mock site did not start: ${text}`)), 15000);
    child.once("error", err => { clearTimeout(timeout); reject(err); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Mock site exited: ${code}: ${text}`)); });
    child.stdout!.on("data", data => {
      text += String(data);
      const match = text.match(/"msg":"mock-site listening","port":(\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    child.stderr!.on("data", data => { text += String(data); });
  });
  base = `http://127.0.0.1:${port}`;
  process.env.SITE_BASE_URL = base;
  generator = await import('./generator.js');
  api = await import('../services/site-api.js');
});
after(async () => {
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
});

test("generate plus repair longer than initial lease posts all drafts with live heartbeats", async () => {
  await fetch(`${base}/debug/generation-request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand: "taxes-support", input }) });
  const { requests } = await api.siteApi.claimGeneration();
  let calls = 0;
  await generator.processGenerationRequest(requests[0], {
    heartbeatMs: 100,
    generate: async (_system, user, _choice, opts) => {
      calls++;
      await delay(1100, undefined, { signal: opts?.signal });
      if (calls === 1) return { drafts: [modelDraft({ canonical_text: "ă" }), modelDraft({ client_ref: "two" })], stopReason: "end_turn" };
      assert.ok(!user.includes('"client_ref": "two"'));
      return { drafts: [modelDraft()], stopReason: "end_turn" };
    },
  });
  const state = await (await fetch(`${base}/debug/state`)).json();
  const request = state.generationRequests.find((r: any) => r.request_id === requests[0].request_id);
  assert.equal(calls, 2);
  assert.equal(request.status, "done");
  assert.equal(request.drafts.length, 2);
  assert.ok(request.heartbeats > 1);
  assert.equal(request.drafts[0].validation_errors.length, 0);
});

test("409 heartbeat aborts generation and reports no drafts or failure", async () => {
  let reported = 0;
  let aborted = false;
  await generator.processGenerationRequest({ request_id: "lost", brand: "taxes-support", input, lease_expires_at: new Date(Date.now() + 5000).toISOString() }, {
    heartbeatMs: 10,
    api: {
      generationHeartbeat: async () => { throw new api.LeaseLostError(); },
      postDrafts: async () => { reported++; return {}; },
      generationFailed: async () => { reported++; return {}; },
    },
    generate: async (_s, _u, _c, opts) => {
      try { await delay(5000, undefined, { signal: opts?.signal }); }
      catch (err) { aborted = opts!.signal!.aborted; throw err; }
      return { drafts: [modelDraft()], stopReason: "end_turn" };
    },
  });
  assert.equal(aborted, true);
  assert.equal(reported, 0);
});

test("already expired lease does no generation or reporting; successful work clears timers", async () => {
  let calls = 0;
  const deps = {
    api: { generationHeartbeat: async () => { calls++; return {}; }, postDrafts: async () => { calls++; return {}; }, generationFailed: async () => { calls++; return {}; } },
    generate: async () => { calls++; return { drafts: [modelDraft()], stopReason: "end_turn" }; },
    heartbeatMs: 10,
  };
  await generator.processGenerationRequest({ request_id: "expired", brand: "taxes-support", input, lease_expires_at: new Date(Date.now() - 1).toISOString() }, deps);
  assert.equal(calls, 0);
  await generator.processGenerationRequest({ request_id: "fast", brand: "taxes-support", input, lease_expires_at: new Date(Date.now() + 5000).toISOString() }, deps);
  assert.equal(calls, 2);
  await delay(30);
  assert.equal(calls, 2, "no heartbeat fires after completion");
});
