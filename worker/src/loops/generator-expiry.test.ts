import '../test-support/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { processGenerationRequest } from './generator.js';
import { modelDraft } from '../test-support/drafts.js';

test('lease expiry cancels generation even when heartbeat hangs', async () => {
  let reported = 0;
  let aborted = false;
  await processGenerationRequest({ request_id: 'hang', brand: 'taxes-support', input: { source: { type: 'topic', topic: 'Taxe' }, platforms: ['x'], count: 1 }, lease_expires_at: new Date(Date.now() + 300).toISOString() }, {
    heartbeatMs: 20,
    api: {
      generationHeartbeat: async (_id, opts) => { await delay(5000, undefined, { signal: opts?.signal }); return {}; },
      postDrafts: async () => { reported++; return {}; },
      generationFailed: async () => { reported++; return {}; },
    },
    generate: async (_system, _user, _choice, opts) => {
      try { await delay(5000, undefined, { signal: opts?.signal }); }
      catch (err) { aborted = !!opts?.signal?.aborted; throw err; }
      return { drafts: [modelDraft()], stopReason: 'end_turn' };
    },
  });
  assert.equal(aborted, true);
  assert.equal(reported, 0);
});
