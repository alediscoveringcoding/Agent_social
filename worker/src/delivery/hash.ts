// Mirrors site/src/lib/social/hash.ts exactly (PRD 10.6) — both sides must
// produce identical bytes, or the worker's pre-publish hash check rejects
// every job as HASH_MISMATCH. Shared vectors: docs/contracts/hash-vectors.json.

import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export interface HashMedia {
  sha256: string;
  alt_text: string;
}

export interface DestinationHashInput {
  account_id: string;
  platform: string;
  text: string;
  settings: Record<string, unknown>;
  /** Any instant; normalized with toHashTimestamp. */
  scheduled_at: string | Date;
  /** In position order. */
  media: ReadonlyArray<HashMedia>;
}

export interface ApprovalHashInput {
  post_id: string;
  revision_id: string;
  destinations: ReadonlyArray<{ id: string; destination_hash: string }>;
}

/** "2026-11-02T08:00:00Z": UTC, whole seconds (truncated), Z suffix. */
export function toHashTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`toHashTimestamp: not a valid instant: ${String(value)}`);
  }
  const truncated = new Date(Math.floor(ms / 1000) * 1000);
  return truncated.toISOString().replace(".000Z", "Z");
}

function jcs(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new Error("JCS: value cannot be canonicalized");
  return out;
}

/** Plain JSON data: drops `undefined`, rejects what JSON cannot carry. */
function plainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function destinationHashObject(input: DestinationHashInput) {
  return {
    account_id: input.account_id,
    platform: input.platform,
    text: input.text,
    settings: plainJson(input.settings ?? {}),
    scheduled_at: toHashTimestamp(input.scheduled_at),
    media: input.media.map((m) => ({ sha256: m.sha256, alt_text: m.alt_text })),
  };
}

export function canonicalDestination(input: DestinationHashInput): string {
  return jcs(destinationHashObject(input));
}

export function destinationHash(input: DestinationHashInput): string {
  return sha256Hex(canonicalDestination(input));
}

function byIdAscending(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function canonicalApproval(input: ApprovalHashInput): string {
  const ordered = [...input.destinations].sort(byIdAscending);
  return jcs({
    post_id: input.post_id,
    revision_id: input.revision_id,
    destinations: ordered.map((d) => d.destination_hash),
  });
}

export function approvalHash(input: ApprovalHashInput): string {
  return sha256Hex(canonicalApproval(input));
}
