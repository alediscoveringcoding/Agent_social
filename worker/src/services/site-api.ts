import { config } from "../config.js";

const BASE = `${config.SITE_BASE_URL}/api/worker/social/v1`;

async function request(path: string, body?: unknown) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.WORKER_TOKEN}`,
      "X-Worker-Id": config.WORKER_ID,
      "X-Worker-Version": "0.1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 409) {
    throw new Error("LEASE_LOST");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Site API ${res.status}: ${text}`);
  }
  return res.json();
}

// Delivery endpoints
export const siteApi = {
  claimDeliveries: (limit = 5) => request("/deliveries/claim", { limit }),
  heartbeat: (id: string, attemptNo: number) =>
    request(`/deliveries/${id}/heartbeat`, { attempt_no: attemptNo }),
  submitting: (id: string, attemptNo: number) =>
    request(`/deliveries/${id}/submitting`, { attempt_no: attemptNo }),
  submitted: (id: string, attemptNo: number, postizPostId: string, postizGroup: string) =>
    request(`/deliveries/${id}/submitted`, {
      attempt_no: attemptNo,
      postiz_post_id: postizPostId,
      postiz_group: postizGroup,
    }),
  result: (
    id: string,
    body: {
      attempt_no: number;
      outcome: "published" | "failed" | "retry" | "reconciling" | "not_found";
      remote_url?: string;
      error_code?: string;
      error_message?: string;
    },
  ) => request(`/deliveries/${id}/result`, body),

  // Generation endpoints
  claimGeneration: () => request("/generation/claim", { limit: 1 }),
  postDrafts: (id: string, drafts: unknown[]) => request(`/generation/${id}/drafts`, { drafts }),
  generationFailed: (id: string, errorCode: string, errorMessage: string) =>
    request(`/generation/${id}/failed`, { error_code: errorCode, error_message: errorMessage }),

  // Sync
  syncAccounts: (body: unknown) => request("/accounts/sync", body),
};
