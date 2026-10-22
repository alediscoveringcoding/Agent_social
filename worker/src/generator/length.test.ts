import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFTS_PER_CALL, LENGTH_TARGETS, draftBatches, lengthTarget, postLengthOf, validateCanonicalLength, validateLength } from "./length.js";

const rules = (errors: { rule: string }[]) => errors.map((e) => e.rule);

test("one target for every platform with room, most of the limit on the others", () => {
  for (const p of ["linkedin", "linkedin-page", "facebook", "instagram", "slack", "lemmy", "tiktok", "youtube", "quora"]) {
    assert.deepEqual(lengthTarget(p, "long"), { min: 1200, max: 2000 }, p);
    assert.deepEqual(lengthTarget(p, "short"), { min: 250, max: 600 }, p);
  }
  assert.deepEqual(lengthTarget("x", "long"), { min: 196, max: 280 });
  assert.deepEqual(lengthTarget("x", "short"), { min: 112, max: 280 });
  assert.deepEqual(lengthTarget("bluesky", "long"), { min: 210, max: 300 });
  assert.deepEqual(lengthTarget("farcaster", "long"), { min: 224, max: 320 });
  assert.deepEqual(lengthTarget("telegram", "long"), { min: 716, max: 1024 }, "a card makes the text a caption");
  assert.deepEqual(lengthTarget("telegram", "short"), { min: 250, max: 600 });
  for (const p of ["devto", "medium", "listmonk", "github", "press", "producthunt", "not-a-platform"]) {
    assert.equal(lengthTarget(p, "long"), null, `${p} has no social text`);
  }
});

test("a request without the field is long; only 'short' picks short", () => {
  assert.equal(postLengthOf({}), "long");
  assert.equal(postLengthOf(undefined), "long");
  assert.equal(postLengthOf({ length: "short" }), "short");
  assert.equal(postLengthOf({ length: "medium" }), "long");
});

test("too short and too far over the form are errors; the hard limit stays its own rule", () => {
  assert.deepEqual(rules(validateLength("a".repeat(1199), "linkedin", "long")), ["too_short"]);
  assert.deepEqual(rules(validateLength("a".repeat(1200), "linkedin", "long")), []);
  assert.deepEqual(rules(validateLength("a".repeat(2500), "linkedin", "long")), [], "within 25% over the max");
  assert.deepEqual(rules(validateLength("a".repeat(2501), "linkedin", "long")), ["too_long_for_form"]);
  assert.deepEqual(rules(validateLength("a".repeat(900), "facebook", "short")), ["too_long_for_form"]);
  assert.deepEqual(rules(validateLength("a".repeat(400), "facebook", "short")), []);
  assert.deepEqual(rules(validateLength("a".repeat(195), "x", "long")), ["too_short"]);
  assert.deepEqual(rules(validateLength("a".repeat(300), "x", "long")), [], "over 280 is the platform's `length` rule");
  assert.deepEqual(rules(validateLength("", "linkedin", "long")), [], "an empty text is EMPTY_TEXT");
  assert.deepEqual(rules(validateLength("scurt", "devto", "long")), []);
  const [error] = validateLength("Un text scurt.", "instagram", "long");
  assert.match(error.message, /Long form: the instagram text has 14 characters; it needs 1200 to 2000/);
  assert.match(error.message, /do not pad/);
});

test("canonical_text follows the same target", () => {
  assert.deepEqual(rules(validateCanonicalLength("a".repeat(LENGTH_TARGETS.long.min - 1), "long")), ["too_short"]);
  assert.deepEqual(rules(validateCanonicalLength("a".repeat(LENGTH_TARGETS.short.min), "short")), []);
  assert.deepEqual(rules(validateCanonicalLength("", "short")), []);
});

test("drafts are split into even batches per call", () => {
  assert.deepEqual(DRAFTS_PER_CALL, { short: 8, long: 3 });
  assert.deepEqual(draftBatches(5, "long"), [3, 2]);
  assert.deepEqual(draftBatches(3, "long"), [3]);
  assert.deepEqual(draftBatches(7, "long"), [3, 2, 2]);
  assert.deepEqual(draftBatches(20, "long"), [3, 3, 3, 3, 3, 3, 2]);
  assert.deepEqual(draftBatches(5, "short"), [5]);
  assert.deepEqual(draftBatches(20, "short"), [7, 7, 6]);
  assert.deepEqual(draftBatches(0, "long"), [1]);
  assert.deepEqual(draftBatches(undefined as unknown as number, "short"), [1]);
});
