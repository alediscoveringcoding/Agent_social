import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { unlistedFigures } from "./figures.js";

const fig = (value: string) => ({ value, context: null, source: "confirmed" as const });

test("a short listed figure does not hide a longer one", () => {
  assert.equal(unlistedFigures("Creste cu 15%.", [fig("5%")]).length, 1);
  assert.equal(unlistedFigures("Avem 12 clienti.", [fig("2")]).length, 1);
});

test("spacing, decimal commas and trailing zeros match the same figure", () => {
  assert.equal(unlistedFigures("Creste cu 15 %.", [fig("15%")]).length, 0);
  assert.equal(unlistedFigures("Creste cu 15,0%.", [fig("15%")]).length, 0);
  assert.equal(unlistedFigures("Creste cu 1,5%.", [fig("1.5%")]).length, 0);
  assert.equal(unlistedFigures("Creste cu 1,5%.", [fig("15%")]).length, 1);
});
