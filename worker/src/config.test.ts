import "./test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.js";

const base = { WORKER_TOKEN: "x".repeat(32), POSTIZ_API_KEY: "k" };

test("WORKER_DRY_RUN=false really turns dry run off (z.coerce.boolean read it as true)", () => {
  for (const v of ["false", "FALSE", "0", "no", "off"]) {
    assert.equal(parseConfig({ ...base, WORKER_DRY_RUN: v }).WORKER_DRY_RUN, false, v);
  }
  for (const v of ["true", "True", "1", "yes", "on"]) {
    assert.equal(parseConfig({ ...base, WORKER_DRY_RUN: v }).WORKER_DRY_RUN, true, v);
  }
});

test("WORKER_DRY_RUN unset or blank defaults to true (the safe side)", () => {
  assert.equal(parseConfig(base).WORKER_DRY_RUN, true);
  assert.equal(parseConfig({ ...base, WORKER_DRY_RUN: "" }).WORKER_DRY_RUN, true);
  assert.equal(parseConfig({ ...base, WORKER_DRY_RUN: "  " }).WORKER_DRY_RUN, true);
});

test("a WORKER_DRY_RUN typo is a config error, not a silent true", () => {
  assert.throws(() => parseConfig({ ...base, WORKER_DRY_RUN: "flase" }));
});

test("blank intervals keep their defaults instead of becoming 0", () => {
  const c = parseConfig({ ...base, DELIVERY_LOOP_INTERVAL_MS: "", GENERATION_HEARTBEAT_MS: "" });
  assert.equal(c.DELIVERY_LOOP_INTERVAL_MS, 30_000);
  assert.equal(c.GENERATION_HEARTBEAT_MS, 120_000);
  assert.equal(parseConfig({ ...base, SYNC_LOOP_INTERVAL_MS: "60000" }).SYNC_LOOP_INTERVAL_MS, 60_000);
  assert.throws(() => parseConfig({ ...base, GENERATION_LOOP_INTERVAL_MS: "0" }));
});

test("AI defaults: Claude Opus 5.5 at medium effort, blank keys are unset", () => {
  const c = parseConfig({ ...base, ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GENERATOR_MODEL: "" });
  assert.equal(c.GENERATOR_MODEL, "claude-opus-5-5");
  assert.equal(c.GENERATOR_EFFORT, "medium");
  assert.equal(c.ANTHROPIC_API_KEY, undefined);
  assert.equal(c.GEMINI_API_KEY, undefined);
  assert.equal(parseConfig({ ...base, GENERATOR_EFFORT: "high" }).GENERATOR_EFFORT, "high");
});
