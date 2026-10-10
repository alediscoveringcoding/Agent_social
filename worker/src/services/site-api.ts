import { config } from "../config.js";

const BASE = `${config.SITE_BASE_URL}/api/worker/social/v1`;

export class LeaseLostError extends Error {
  /** The error `code` of the 409 response body, when the site sent one. */
  code: string | undefined;
  constructor(code?: string) { super("LEASE_LOST"); this.name = "LeaseLostError"; this.code = code; }
}

/** A non-2xx, non-409 answer from the site. */
export class SiteApiError extends Error {
  constructor(public status: number, body: string) { super(`Site API ${status}: ${body}`); this.name = "SiteApiError"; }
}

/** The request may have reached the site: a timeout, a dropped connection or a 5xx. */
export function isAmbiguousSiteError(err: unknown): boolean {
  if (err instanceof SiteApiError) return err.status >= 500;
  return isTransportError(err);
}

/** A timeout or a network failure (no answer at all). */
export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  return err instanceof TypeError && /fetch failed|network|socket|ECONN|terminated/i.test(`${err.message} ${String((err as any).cause ?? "")}`);
}

const SMALL_CALL_TIMEOUT_MS = 30_000;
// Posting a batch creates many posts one by one, so it gets longer.
const DRAFTS_TIMEOUT_MS = 120_000;

async function request(path: string, body?: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const url = `${BASE}${path}`;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? SMALL_CALL_TIMEOUT_MS);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.WORKER_TOKEN}`,
      "X-Worker-Id": config.WORKER_ID,
      "X-Worker-Version": "0.1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });

  if (res.status === 409) {
    const text = await res.text().catch(() => "");
    let code: unknown;
    try { const parsed = JSON.parse(text); code = parsed?.error?.code ?? parsed?.code; } catch { /* not JSON */ }
    throw new LeaseLostError(typeof code === "string" ? code : undefined);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new SiteApiError(res.status, text);
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
      retry_after_seconds?: number;
    },
  ) => request(`/deliveries/${id}/result`, body),

  // Generation endpoints
  claimGeneration: () => request("/generation/claim", { limit: 1 }),
  generationHeartbeat: (id: string, opts: { signal?: AbortSignal } = {}) => request(`/generation/${id}/heartbeat`, {}, opts),
  postDrafts: (id: string, drafts: unknown[], opts: { signal?: AbortSignal } = {}) => request(`/generation/${id}/drafts`, { drafts }, { ...opts, timeoutMs: DRAFTS_TIMEOUT_MS }),
  generationFailed: (id: string, errorCode: string, errorMessage: string, opts: { signal?: AbortSignal } = {}) =>
    request(`/generation/${id}/failed`, { error_code: errorCode, error_message: errorMessage.slice(0, 4000) }, opts),

  // Sync
  syncAccounts: (body: unknown) => request("/accounts/sync", body),
};
