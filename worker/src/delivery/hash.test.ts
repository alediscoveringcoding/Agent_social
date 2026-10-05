import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { destinationHash, approvalHash, toHashTimestamp } from "./hash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = path.resolve(__dirname, "../../../docs/contracts/hash-vectors.json");

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf-8"));

test("destinationHash matches every vector in docs/contracts/hash-vectors.json", () => {
  assert.ok(vectors.destination.length >= 5, "expected at least 5 destination vectors");
  for (const v of vectors.destination) {
    const actual = destinationHash(v.input);
    assert.equal(actual, v.hash, `mismatch for: ${v.name}`);
  }
});

test("approvalHash matches every approval vector", () => {
  assert.ok(vectors.approval.length >= 1, "expected at least 1 approval vector");
  for (const v of vectors.approval) {
    const actual = approvalHash(v.input);
    assert.equal(actual, v.hash, `mismatch for: ${v.name}`);
  }
});

test("toHashTimestamp matches every timestamp_normalization vector", () => {
  assert.ok(vectors.timestamp_normalization.length >= 1);
  for (const v of vectors.timestamp_normalization) {
    assert.equal(toHashTimestamp(v.input), v.expected, `mismatch for input: ${v.input}`);
  }
});
