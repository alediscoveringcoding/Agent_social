import { config } from "../config.js";
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

  // List posts in a date range
  listPosts: (from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return get(`/posts${qs ? `?${qs}` : ""}`);
  },

  // Create a post (type: "now" for immediate publish)
  createPost: (payload: {
    type: "now" | "draft" | "schedule";
    date?: string;
    posts: Array<{
      content: string;
      integration: string; // Postiz integration ID
      settings?: Record<string, unknown>;
      media?: Array<{ id?: string; path?: string }>;
    }>;
  }) => post("/posts", payload),

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
