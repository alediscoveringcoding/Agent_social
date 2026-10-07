import { config } from "../config.js";
import type { PostizCreatePost } from "../delivery/postiz-payload.js";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = `${config.POSTIZ_BASE_URL}/api/public/v1`;

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: config.POSTIZ_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Postiz GET ${res.status}: ${text}`);
  }
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
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Postiz POST ${res.status}: ${text}`);
  }
  return res.json();
}

export const postizApi = {
  // List connected integrations (channels)
  listIntegrations: () => get("/integrations"),

  // List posts in a date range. GET /posts needs startDate and endDate (GetPostsDto,
  // v2.25.0) and answers {posts: [...]}; the default window is the last 7 days
  // plus tomorrow. Returns the array.
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
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Postiz upload ${res.status}: ${text}`);
    }
    return res.json();
  },
};
