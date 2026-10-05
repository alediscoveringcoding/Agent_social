import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { destinationHash } from "./hash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = path.resolve(__dirname, "../../../docs/contracts/hash-vectors.json");

const vectors: Array<{ description: string; input: any; expected_hash: string }> = JSON.parse(
  readFileSync(VECTORS_PATH, "utf-8"),
);

test("destinationHash matches every vector in docs/contracts/hash-vectors.json", () => {
  assert.ok(vectors.length >= 5, "expected at least 5 hash vectors");
  for (const v of vectors) {
    const actual = destinationHash(v.input);
    assert.equal(actual, v.expected_hash, `mismatch for: ${v.description}`);
  }
});
