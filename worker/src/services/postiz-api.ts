import { config } from "../config.js";
import type { PostizCreatePost } from "../delivery/postiz-payload.js";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = `${config.POSTIZ_BASE_URL}/api/public/v1`;

// Every call has a deadline: a hung Postiz must not hold a job (and its lease) for ever.
export const POSTIZ_READ_TIMEOUT_MS = 30_000;
export const POSTIZ_WRITE_TIMEOUT_MS = 60_000;
export const POSTIZ_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Postiz answered, with a non-2xx status. A 4xx is a definite answer (nothing was
 * created); a 5xx may have been produced after the post was stored, so callers
 * treat it as unknown. Timeouts and network errors are plain errors, not this class.
 */
export class PostizHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterSeconds?: number,
    what = "request",
  ) {
    super(`Postiz ${what} ${status}: ${body}`);
    this.name = "PostizHttpError";
  }
}

/** Retry-After as seconds: a number of seconds or an HTTP date. Undefined when absent or unusable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v), 86400);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(Math.ceil((at - now) / 1000), 0), 86400);
}

async function fail(res: Response, what: string): Promise<never> {
  const text = await res.text().catch(() => "");
  throw new PostizHttpError(res.status, text.slice(0, 1000), parseRetryAfter(res.headers.get("retry-after")), what);
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: config.POSTIZ_API_KEY },
    signal: AbortSignal.timeout(POSTIZ_READ_TIMEOUT_MS),
  });
  if (!res.ok) await fail(res, "GET");
  return res.json();
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: config.POSTIZ_API_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POSTIZ_WRITE_TIMEOUT_MS),
  });
  if (!res.ok) await fail(res, "POST");
  return res.json();
}

export const postizApi = {
  // List connected integrations (channels)
  listIntegrations: () => get("/integrations"),

  // List posts in a date range. GET /posts needs startDate and endDate (GetPostsDto,
  // v2.25.0) and answers {posts: [...]}; the default window is the last 7 days
  // plus tomorrow. Callers that look for one job's post pass a range around the
  // job's own times. Returns the array.
  listPosts: async (from?: string, to?: string): Promise<any[]> => {
    const params = new URLSearchParams();
    params.set("startDate", from ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    params.set("endDate", to ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    const res = await get(`/posts?${params.toString()}`);
    return Array.isArray(res) ? res : Array.isArray(res?.posts) ? res.posts : [];
  },

  // Create a post (type "now" publishes immediately). The body is Postiz's
  // CreatePostDto, built by delivery/postiz-payload.ts. The answer is a list of
  // {postId, integration}.
  createPost: (payload: PostizCreatePost) => post("/posts", payload),

  // Upload media file (multipart). Node 20's global FormData/Blob are used,
  // no extra dependency needed.
  uploadMedia: async (filePath: string, mimeType: string) => {
    const fileBuffer = fs.readFileSync(filePath);
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: mimeType });
    formData.append("file", blob, path.basename(filePath));

    const res = await fetch(`${BASE}/upload`, {
      method: "POST",
      headers: { Authorization: config.POSTIZ_API_KEY },
      body: formData,
      signal: AbortSignal.timeout(POSTIZ_UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) await fail(res, "upload");
    return res.json();
  },
};
