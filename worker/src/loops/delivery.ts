import { config } from "../config.js";
import { logger } from "../logger.js";
import { siteApi, LeaseLostError } from "../services/site-api.js";
import { destinationHash } from "../delivery/hash.js";

/** Delivery leases last 10 minutes (social_claim_deliveries); extend them well before that. */
export const HEARTBEAT_INTERVAL_MS = 120_000;

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
async function reportResult(jobId: string, body: Parameters<typeof siteApi.result>[1]): Promise<boolean> {
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
    // A slow batch (video uploads) must not overlap the next tick: two ticks would claim and send twice.
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

/**
 * The site owns the platform credentials and makes every remote request (amendment 08); the
 * worker only schedules: it checks the approved hash, marks the attempt and asks the site to
 * publish or to check an earlier attempt. It never receives a platform token.
 */
export async function processJob(job: any, opts: ProcessOptions = {}) {
  const { job_id, kind, account, attempt_no } = job;
  logger.info("Processing job", { jobId: job_id, kind, platform: account.platform });

  const ownBeat = opts.heartbeat ? null : startHeartbeat(job, opts.heartbeatMs);
  const beat = opts.heartbeat ?? ownBeat!;
  try {
    if (account.publishing_backend !== "native") {
      // Amendment 10: Postiz is gone. Migration 0022 keeps old Postiz accounts out of the claim;
      // an older site may still hand one out. Nothing can publish it or check it from here.
      if (kind === "publish") {
        await reportResult(job_id, { attempt_no, outcome: "failed", error_code: "LEGACY_POSTIZ_ACCOUNT",
          error_message: "This account still uses the removed Postiz connection. Connect it directly in Conturi." });
      } else {
        logger.warn("A job of an old Postiz account cannot be checked here; resolve it on the post page", { jobId: job_id });
      }
      return;
    }
    if (kind === "publish") {
      await handlePublish(job, beat);
      return;
    }
    if (config.WORKER_DRY_RUN) {
      logger.info("DRY RUN: native check skipped", { jobId: job_id });
      return;
    }
    // A processing upload (YouTube, TikTok) or an attempt whose response was lost: the site
    // looks it up through its journal and records the outcome.
    await siteApi.nativeDelivery(job_id, attempt_no, "check");
  } finally {
    ownBeat?.stop();
  }
}

async function handlePublish(job: any, beat: JobHeartbeat) {
  const { job_id, attempt_no, destination, account, media } = job;

  // 1. The approved content, exactly: the same hash the site computed at approval.
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

  if (beat.lost) {
    logger.warn("Lease lost before submit", { jobId: job_id });
    return;
  }

  // 2. Mark the attempt. The site answers 409 when it no longer holds the claim for us (lease lost,
  // or the job was released: stale, kill switch, account paused, approval revoked).
  try {
    await siteApi.submitting(job_id, attempt_no);
  } catch (err) {
    const code = leaseErrorCode(err);
    if (code) {
      logger.warn("Not submitting: the site refused the claim", { jobId: job_id, code });
      return;
    }
    throw err;
  }

  if (config.WORKER_DRY_RUN) {
    logger.info("DRY RUN: publication verified", {
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

  if (beat.lost) {
    logger.warn("Lease lost before the publish call; not sending", { jobId: job_id });
    return;
  }

  // 3. Publish. The site rechecks approval, media and the kill switch, journals the remote
  // request and records the outcome. A lost response is reconciled through that journal.
  try {
    await siteApi.nativeDelivery(job_id, attempt_no, "publish");
  } catch (error) {
    if (leaseErrorCode(error)) return;
    await reportResult(job_id, { attempt_no, outcome: "reconciling", error_code: "NATIVE_RESPONSE_LOST",
      error_message: "The direct publication result will be recovered from the site's durable journal." });
  }
}
