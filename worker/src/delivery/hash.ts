import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export function destinationHash(input: {
  account_id: string;
  platform: string;
  text: string;
  settings: Record<string, unknown>;
  scheduled_at: string; // ISO 8601 UTC, Z suffix
  media: Array<{ sha256: string; alt_text: string }>;
}): string {
  const canonical = canonicalize(input);
  return createHash("sha256").update(canonical!).digest("hex");
}

export function approvalHash(input: {
  post_id: string;
  revision_id: string;
  destinations: string[]; // destination hashes, sorted by destination id
}): string {
  const canonical = canonicalize(input);
  return createHash("sha256").update(canonical!).digest("hex");
}
