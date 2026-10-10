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

test("GENERATION_REPAIR and CLAUDE_SERVER_FALLBACK default to true and parse like the other booleans", () => {
  assert.equal(parseConfig(base).GENERATION_REPAIR, true);
  assert.equal(parseConfig(base).CLAUDE_SERVER_FALLBACK, true);
  assert.equal(parseConfig({ ...base, GENERATION_REPAIR: "false", CLAUDE_SERVER_FALLBACK: "off" }).GENERATION_REPAIR, false);
  assert.equal(parseConfig({ ...base, GENERATION_REPAIR: "false", CLAUDE_SERVER_FALLBACK: "off" }).CLAUDE_SERVER_FALLBACK, false);
  assert.equal(parseConfig({ ...base, GENERATION_REPAIR: "" }).GENERATION_REPAIR, true);
});

test("RESEARCH_MAX_SEARCHES is 1 to 20 and defaults to 5; RESEARCH_TIMEOUT_MS is optional", () => {
  assert.equal(parseConfig(base).RESEARCH_MAX_SEARCHES, 5);
  assert.equal(parseConfig({ ...base, RESEARCH_MAX_SEARCHES: "" }).RESEARCH_MAX_SEARCHES, 5);
  assert.equal(parseConfig({ ...base, RESEARCH_MAX_SEARCHES: "1" }).RESEARCH_MAX_SEARCHES, 1);
  assert.equal(parseConfig({ ...base, RESEARCH_MAX_SEARCHES: "20" }).RESEARCH_MAX_SEARCHES, 20);
  for (const bad of ["0", "21", "-1", "2.5", "many"]) assert.throws(() => parseConfig({ ...base, RESEARCH_MAX_SEARCHES: bad }), bad);
  assert.equal(parseConfig(base).RESEARCH_TIMEOUT_MS, undefined);
  assert.equal(parseConfig({ ...base, RESEARCH_TIMEOUT_MS: "" }).RESEARCH_TIMEOUT_MS, undefined);
  assert.equal(parseConfig({ ...base, RESEARCH_TIMEOUT_MS: "90000" }).RESEARCH_TIMEOUT_MS, 90_000);
  assert.throws(() => parseConfig({ ...base, RESEARCH_TIMEOUT_MS: "0" }));
});

test("RESEARCH_TIMEOUT_MS stays inside the generation lease: at most 540000", () => {
  assert.equal(parseConfig({ ...base, RESEARCH_TIMEOUT_MS: "540000" }).RESEARCH_TIMEOUT_MS, 540_000);
  for (const bad of ["540001", "600000", "9999999", "-5", "1.5", "soon"]) {
    assert.throws(() => parseConfig({ ...base, RESEARCH_TIMEOUT_MS: bad }), bad);
  }
});

test("a blank WORKER_ID keeps the default", () => {
  assert.equal(parseConfig({ ...base, WORKER_ID: "" }).WORKER_ID, "worker-local-01");
  assert.equal(parseConfig({ ...base, WORKER_ID: "w2" }).WORKER_ID, "w2");
});
