import * as os from "node:os";
import * as path from "node:path";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { siteApi, LeaseLostError } from "../services/site-api.js";
import { postizApi, PostizHttpError } from "../services/postiz-api.js";
import { destinationHash } from "../delivery/hash.js";
import {
  buildPostizPost,
  postizContent,
  postIdFromCreate,
  PostizPayloadError,
  type PostizCreatePost,
  type UploadedMedia,
} from "../delivery/postiz-payload.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Delivery leases last 10 minutes (social_claim_deliveries); extend them well before that. */
export const HEARTBEAT_INTERVAL_MS = 120_000;
/** A signed media URL must answer within this time. */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Reconcile only trusts a post created this much before the attempt started (clock skew between hosts). */
export const RECONCILE_CLOCK_SKEW_MS = 2 * 60_000;
/** A reconciling job reports not_found only once the attempt is this old: Postiz may still be writing the post. */
export const RECONCILE_MIN_AGE_MS = 10 * 60_000;
/** Poll looks this many days either side of the job's own times. */
const POLL_WINDOW_DAYS = 3;

/** A running lease extension for one claimed job. `lost` turns true once the site refuses the lease. */
export interface JobHeartbeat {
  readonly lost: boolean;
  stop(): void;
}

export function startHeartbeat(job: { job_id: string; attempt_no: number }, intervalMs = HEARTBEAT_INTERVAL_MS): JobHeartbeat {
  const state = { lost: false };
  const timer = setInterval(() => {
    if (state.lost) return;
    siteApi.heartbeat(job.job_id, job.attempt_no).catch((err: unknown) => {
      const code = leaseErrorCode(err);
      if (code) {
        state.lost = true;
        clearInterval(timer);
        logger.warn("Lease lost during work; no further steps will be taken", { jobId: job.job_id, code });
      } else {
        logger.warn("Heartbeat failed", { jobId: job.job_id, error: String(err) });
      }
    });
  }, intervalMs);
  timer.unref?.();
  return {
    get lost() { return state.lost; },
    stop() { clearInterval(timer); },
  };
}

/** The site answers 409 for a lost lease and for a refused transition; the error code tells them apart. */
function leaseErrorCode(err: unknown): string | null {
  if (!(err instanceof LeaseLostError)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code ? code : "LEASE_LOST";
}

/**
 * Report a result. A 409 is not an error to retry: LEASE_LOST means another claim owns the
 * job now (the sweeper or a new claim carries on), INVALID_TRANSITION means the job already
 * moved past a state that takes this report. Either way this worker stops reporting.
 * Returns false on a 409.
 */
async function reportResult(jobId: string, body: Parameters<typeof siteApi.result>[1] & { retry_after_seconds?: number }): Promise<boolean> {
  try {
    await siteApi.result(jobId, body);
    return true;
  } catch (err) {
    const code = leaseErrorCode(err);
    if (!code) throw err;
    if (code === "LEASE_LOST") {
      logger.warn("Lease lost before the result was recorded", { jobId, outcome: body.outcome });
    } else {
      logger.warn("The site refused the result for the job's current state", { jobId, outcome: body.outcome, code });
    }
    return false;
  }
}

let tickRunning = false;

export function startDeliveryLoop() {
  async function tick() {
    // A slow batch (media, Postiz) must not overlap the next tick: two ticks would claim and send twice.
    if (tickRunning) return;
    tickRunning = true;
    try {
      const { jobs } = await siteApi.claimDeliveries(5);
      if (!jobs || jobs.length === 0) return;

      logger.info("Claimed delivery jobs", { count: jobs.length });

      // Jobs run one after another; every lease keeps being extended while it waits its turn.
      const beats = new Map<string, JobHeartbeat>(jobs.map((j: any) => [j.job_id, startHeartbeat(j)]));
      try {
        for (const job of jobs) {
          try {
            await processJob(job, { heartbeat: beats.get(job.job_id) });
          } catch (err) {
            logger.error("Job processing error", {
              jobId: job.job_id,
              error: String(err),
            });
          } finally {
            beats.get(job.job_id)?.stop();
          }
        }
      } finally {
        for (const beat of beats.values()) beat.stop();
      }
    } catch (err) {
      logger.error("Delivery loop error", { error: String(err) });
    } finally {
      tickRunning = false;
    }
  }

  setInterval(tick, config.DELIVERY_LOOP_INTERVAL_MS);
  // Run immediately on start
  tick();
}

export interface ProcessOptions {
  /** A heartbeat the caller already started (the delivery loop starts all of a batch up front). */
  heartbeat?: JobHeartbeat;
  /** Heartbeat interval when processJob starts its own; tests shorten it. */
  heartbeatMs?: number;
}

export async function processJob(job: any, opts: ProcessOptions = {}) {
  const { job_id, kind, account } = job;
  logger.info("Processing job", { jobId: job_id, kind, platform: account.platform });

  const ownBeat = opts.heartbeat ? null : startHeartbeat(job, opts.heartbeatMs);
  const beat = opts.heartbeat ?? ownBeat!;
  try {
    if (kind === "publish") {
      await handlePublish(job, beat);
    } else if (kind === "poll") {
      await handlePoll(job);
    } else if (kind === "reconcile") {
      await handleReconcile(job);
    }
  } finally {
    ownBeat?.stop();
  }
}

/** What createPost's failure means for the job. Only a definite 4xx answer proves nothing was created. */
export function classifyCreateError(err: unknown): {
  outcome: "failed" | "retry" | "reconciling";
  error_code: string;
  retry_after_seconds?: number;
} {
  if (err instanceof PostizHttpError) {
    const s = err.status;
    // 401/403 mean Postiz refused the worker (its API key), not that this channel's token expired: no account side effects.
    if (s === 401) return { outcome: "failed", error_code: "POSTIZ_UNAUTHORIZED" };
    if (s === 403) return { outcome: "failed", error_code: "POSTIZ_FORBIDDEN" };
    if (s === 429) {
      return { outcome: "retry", error_code: "RATE_LIMITED", ...(err.retryAfterSeconds ? { retry_after_seconds: err.retryAfterSeconds } : {}) };
    }
    if (s === 400 || s === 422) return { outcome: "failed", error_code: "VALIDATION_REJECTED" };
    if (s === 404) return { outcome: "failed", error_code: "INTEGRATION_NOT_FOUND" };
    // 408 says the request timed out on the way: unknown. Any other 4xx is a plain refusal.
    if (s >= 400 && s < 500 && s !== 408) return { outcome: "failed", error_code: "POSTIZ_REJECTED" };
  }
  // Timeouts, network errors and 5xx: the post may exist.
  return { outcome: "reconciling", error_code: "UNKNOWN_RESULT" };
}

async function handlePublish(job: any, beat: JobHeartbeat) {
  const { job_id, attempt_no, destination, account, media } = job;

  // 1. Verify content hash
  const computedHash = destinationHash({
    account_id: account.id,
    platform: account.platform,
    text: destination.text,
    settings: destination.settings,
    scheduled_at: destination.scheduled_at,
    media: (media || []).map((m: any) => ({
      sha256: m.sha256,
      alt_text: m.alt_text || "",
    })),
  });

  if (computedHash !== destination.destination_hash) {
    logger.error("Hash mismatch", { jobId: job_id });
    await reportResult(job_id, {
      attempt_no,
      outcome: "failed",
      error_code: "HASH_MISMATCH",
      error_message: "Content hash does not match approved content",
    });
    return;
  }

  // 2. Download media and upload to Postiz. Every job gets its own temp directory,
  // so two jobs (or two workers) with the same media never share a file.
  const postizMedia: UploadedMedia[] = [];
  if (media && media.length > 0) {
    // Windows has no /tmp; use the OS temp dir.
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "social-media-"));
    try {
      for (const m of media) {
        const tmpPath = path.join(tmpDir, `media-${m.media_id}`);
        try {
          if (!m.url) throw new Error("No signed media URL");
          const res = await fetch(m.url, { signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS) });
          if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          if (createHash("sha256").update(buffer).digest("hex") !== m.sha256) {
            throw new Error("Media checksum does not match approved media");
          }

          // Dry run still proves signed media is readable, but never calls Postiz.
          if (!config.WORKER_DRY_RUN) {
            await writeFile(tmpPath, buffer);
            const uploaded = await postizApi.uploadMedia(tmpPath, m.mime);
            postizMedia.push({ media_id: m.media_id, id: uploaded.id, path: uploaded.path, alt_text: m.alt_text || "" });
          }
        } catch (err) {
          logger.error("Media transfer failed", { jobId: job_id, mediaId: m.media_id });
          // PRD 10.7: MEDIA_FETCH_FAILED retries once with a fresh claim, so this
          // must be "retry", not "failed" (which the site would never requeue).
          await reportResult(job_id, {
            attempt_no,
            outcome: "retry",
            error_code: "MEDIA_FETCH_FAILED",
            error_message: String(err),
          });
          return;
        }
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (beat.lost) {
    logger.warn("Lease lost before submit", { jobId: job_id });
    return;
  }

  // 3. Mark as submitting
  try {
    await siteApi.submitting(job_id, attempt_no);
  } catch (err) {
    const code = leaseErrorCode(err);
    if (code) {
      // The site only answers 409 here when it does not hold the claim for us (lease lost, or the job
      // was released: stale, kill switch, account paused, approval revoked). Postiz is not called.
      logger.warn("Not submitting: the site refused the claim", { jobId: job_id, code });
      return;
    }
    throw err;
  }

  // 4. Submit to Postiz (or dry-run)
  if (config.WORKER_DRY_RUN) {
    logger.info("DRY RUN: would submit to Postiz", {
      jobId: job_id,
      platform: account.platform,
      textLength: destination.text.length,
      mediaCount: media?.length ?? 0,
    });
    await reportResult(job_id, {
      attempt_no,
      outcome: "published",
      remote_url: `https://example.com/dry-run/${job_id}`,
    });
    return;
  }

  let postizPayload: PostizCreatePost;
  try {
    postizPayload = buildPostizPost({
      platform: account.platform,
      integrationId: account.postiz_integration_id,
      text: destination.text,
      settings: destination.settings || {},
      media: postizMedia,
    });
  } catch (err) {
    // A platform with no Postiz provider, or missing settings, cannot be delivered: retrying would not help.
    logger.error("Cannot build the Postiz post", { jobId: job_id, platform: account.platform, error: String(err) });
    await reportResult(job_id, {
      attempt_no,
      outcome: "failed",
      error_code: err instanceof PostizPayloadError ? err.code : "VALIDATION_REJECTED",
      error_message: String(err),
    });
    return;
  }

  if (beat.lost) {
    // Nothing was sent; the site hands the job to the next claim.
    logger.warn("Lease lost before the Postiz call; not sending", { jobId: job_id });
    return;
  }

  let postizResult: unknown;
  try {
    postizResult = await postizApi.createPost(postizPayload);
  } catch (err) {
    const verdict = classifyCreateError(err);
    if (verdict.error_code === "POSTIZ_UNAUTHORIZED" || verdict.error_code === "POSTIZ_FORBIDDEN") {
      logger.error("Postiz refused the worker; check POSTIZ_API_KEY (and that the key belongs to this Postiz)", { jobId: job_id, code: verdict.error_code });
    }
    logger.error("Postiz submit failed", { jobId: job_id, error: String(err), outcome: verdict.outcome, code: verdict.error_code });
    await reportResult(job_id, {
      attempt_no,
      outcome: verdict.outcome,
      error_code: verdict.error_code,
      error_message: String(err).slice(0, 1000),
      ...(verdict.retry_after_seconds ? { retry_after_seconds: verdict.retry_after_seconds } : {}),
    });
    return;
  }

  const { postId, group } = postIdFromCreate(postizResult);
  if (!postId) {
    logger.warn("No post ID in Postiz response", { jobId: job_id });
    await reportResult(job_id, {
      attempt_no,
      outcome: "reconciling",
      error_code: "UNKNOWN_RESULT",
      error_message: "No post ID returned",
    });
    return;
  }

  try {
    await siteApi.submitted(job_id, attempt_no, postId, group || postId);
    logger.info("Submitted to Postiz", { jobId: job_id, postizPostId: postId });
  } catch (err) {
    const code = leaseErrorCode(err);
    if (code === "LEASE_LOST") {
      // The post exists in Postiz. The sweeper moves the job to reconciling and reconcile finds it by content.
      logger.error("Lease lost after the Postiz call; reconcile has to find the post", { jobId: job_id, postizPostId: postId });
    } else if (code) {
      logger.error("The site refused submitted for the job's current state", { jobId: job_id, postizPostId: postId, code });
    } else {
      logger.error("Could not record the Postiz post id", { jobId: job_id, postizPostId: postId, error: String(err) });
      // The call may not have reached the site: ask for reconciliation, which finds the post again.
      await reportResult(job_id, {
        attempt_no,
        outcome: "reconciling",
        error_code: "UNKNOWN_RESULT",
        error_message: `Post created (${postId}) but not recorded: ${String(err).slice(0, 500)}`,
      });
    }
  }
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function httpUrlOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? v.trim() : undefined;
}

async function handlePoll(job: any) {
  const { job_id, attempt_no, postiz } = job;
  if (config.WORKER_DRY_RUN) {
    logger.info("DRY RUN: skipping Postiz poll", { jobId: job_id });
    return;
  }
  if (!postiz?.post_id) return;

  try {
    // Look around the job's own times, not just the default window: a scheduled post
    // may sit further out, and a late poll must still reach back to the attempt.
    const refs = [job.attempt_started_at, job.destination?.scheduled_at, job.run_at]
      .map((v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN))
      .filter((n: number) => !Number.isNaN(n));
    const now = Date.now();
    const lo = Math.min(now, ...refs) - POLL_WINDOW_DAYS * DAY_MS;
    const hi = Math.max(now, ...refs) + POLL_WINDOW_DAYS * DAY_MS;
    const posts = await postizApi.listPosts(iso(lo), iso(hi));
    const found = posts?.find?.((p: any) => p.id === postiz.post_id);
    if (!found) return;

    const url = httpUrlOrUndefined(found.releaseURL) ?? httpUrlOrUndefined(found.release_url);
    const state = typeof found.state === "string" ? found.state.toUpperCase() : "";
    if (url || found.releaseId || state === "PUBLISHED") {
      await reportResult(job_id, {
        attempt_no,
        outcome: "published",
        ...(url ? { remote_url: url } : {}),
      });
    } else if (state === "ERROR") {
      await reportResult(job_id, {
        attempt_no,
        outcome: "failed",
        error_code: "VALIDATION_REJECTED",
        error_message: "Platform rejected the post",
      });
    }
    // Otherwise, still pending; will be polled again next loop
  } catch (err) {
    logger.error("Poll error", { jobId: job_id, error: String(err) });
  }
}

/** Text as Postiz stores it: tags and entities gone, case, punctuation and spacing ignored. */
export function normalizeContent(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'").replace(/&amp;/gi, "&")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Equal, or one is the start of the other (a provider that truncates or adds a footer). */
function sameContent(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 20 && longer.startsWith(shorter.slice(0, 120));
}

export interface ReconcileQuery {
  integrationId: string;
  platform: string;
  text: string;
  settings: Record<string, unknown>;
  attemptStartMs: number;
}

/**
 * The post this attempt created: same channel, created no earlier than the attempt (less a
 * clock skew) and with the job's text. Several matches: the one closest after the attempt start.
 */
export function pickReconcileMatch(posts: any[], q: ReconcileQuery): { match: any | null; count: number } {
  let wanted: string[];
  try {
    wanted = [normalizeContent(q.text), normalizeContent(postizContent(q.platform, q.text, q.settings))];
  } catch {
    wanted = [normalizeContent(q.text)];
  }
  const matches: Array<{ post: any; distance: number }> = [];
  for (const p of posts || []) {
    // GET /posts lists `integration: {id, ...}`; older mocks put the id there directly.
    if ((p.integration?.id ?? p.integration) !== q.integrationId) continue;
    if (p.deletedAt) continue;
    const content = normalizeContent(p.content);
    if (!wanted.some((w) => sameContent(w, content))) continue;
    const at = Date.parse(p.createdAt ?? p.created_at ?? p.publishDate ?? "");
    // A post without a usable time is not excluded: the range query already narrowed it.
    if (!Number.isNaN(at) && at < q.attemptStartMs - RECONCILE_CLOCK_SKEW_MS) continue;
    matches.push({ post: p, distance: Number.isNaN(at) ? Number.MAX_SAFE_INTEGER : Math.abs(at - q.attemptStartMs) });
  }
  matches.sort((a, b) => a.distance - b.distance);
  return { match: matches[0]?.post ?? null, count: matches.length };
}

async function handleReconcile(job: any) {
  const { job_id, attempt_no, account, destination, postiz } = job;
  if (config.WORKER_DRY_RUN) {
    logger.info("DRY RUN: skipping Postiz reconciliation", { jobId: job_id });
    return;
  }
  logger.info("Reconciling job", { jobId: job_id });

  try {
    const startMs = typeof job.attempt_started_at === "string" ? Date.parse(job.attempt_started_at) : NaN;
    if (Number.isNaN(startMs)) {
      // Without the attempt's start there is no safe match, and not_found would allow a second post.
      logger.warn("Reconcile job has no attempt start; leaving it for a later claim", { jobId: job_id });
      return;
    }

    const posts = await postizApi.listPosts(iso(startMs - DAY_MS), iso(Math.max(Date.now(), startMs) + DAY_MS));

    // The site may already know the post id (a poll job's neighbour); then only that post counts.
    const known = postiz?.post_id ? (posts || []).find((p: any) => p.id === postiz.post_id) : null;
    let best = known;
    if (!best) {
      const { match, count } = pickReconcileMatch(posts, {
        integrationId: account.postiz_integration_id,
        platform: account.platform,
        text: destination?.text ?? "",
        settings: destination?.settings ?? {},
        attemptStartMs: startMs,
      });
      if (count > 1) {
        logger.warn("Several Postiz posts match the job; taking the closest to the attempt start", { jobId: job_id, count, postizPostId: match?.id });
      }
      best = match;
    }

    if (best) {
      try {
        await siteApi.submitted(job_id, attempt_no, String(best.id), String(best.group || best.id));
      } catch (err) {
        const code = leaseErrorCode(err);
        if (!code) throw err;
        logger.warn("The site refused submitted for the reconciled post", { jobId: job_id, postizPostId: best.id, code });
      }
      return;
    }

    if (Date.now() - startMs < RECONCILE_MIN_AGE_MS) {
      // Too early to call it missing. The site re-issues a reconcile claim after about a minute.
      logger.info("Post not in Postiz yet; checking again later", { jobId: job_id });
      return;
    }
    await reportResult(job_id, {
      attempt_no,
      outcome: "not_found",
      error_code: "RECONCILE_MISS",
      error_message: "Post not found in Postiz after reconciliation",
    });
  } catch (err) {
    logger.error("Reconcile error", { jobId: job_id, error: String(err) });
  }
}
