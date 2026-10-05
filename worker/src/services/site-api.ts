import { config } from "../config.js";

const BASE = `${config.SITE_BASE_URL}/api/worker/social/v1`;

export class LeaseLostError extends Error {
  constructor() { super("LEASE_LOST"); this.name = "LeaseLostError"; }
}

async function request(path: string, body?: unknown, opts: { signal?: AbortSignal } = {}) {
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
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });

  if (res.status === 409) {
    throw new LeaseLostError();
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
  generationHeartbeat: (id: string, opts: { signal?: AbortSignal } = {}) => request(`/generation/${id}/heartbeat`, {}, opts),
  postDrafts: (id: string, drafts: unknown[], opts: { signal?: AbortSignal } = {}) => request(`/generation/${id}/drafts`, { drafts }, opts),
  generationFailed: (id: string, errorCode: string, errorMessage: string, opts: { signal?: AbortSignal } = {}) =>
    request(`/generation/${id}/failed`, { error_code: errorCode, error_message: errorMessage.slice(0, 4000) }, opts),

  // Sync
  syncAccounts: (body: unknown) => request("/accounts/sync", body),
};
