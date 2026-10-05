import * as os from "node:os";
import * as path from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { siteApi } from "../services/site-api.js";
import { postizApi } from "../services/postiz-api.js";
import { destinationHash } from "../delivery/hash.js";

export function startDeliveryLoop() {
  async function tick() {
    try {
      const { jobs } = await siteApi.claimDeliveries(5);
      if (!jobs || jobs.length === 0) return;

      logger.info("Claimed delivery jobs", { count: jobs.length });

      for (const job of jobs) {
        try {
          await processJob(job);
        } catch (err) {
          logger.error("Job processing error", {
            jobId: job.job_id,
            error: String(err),
          });
        }
      }
    } catch (err) {
      logger.error("Delivery loop error", { error: String(err) });
    }
  }

  setInterval(tick, config.DELIVERY_LOOP_INTERVAL_MS);
  // Run immediately on start
  tick();
}

async function processJob(job: any) {
  const { job_id, kind, account } = job;
  logger.info("Processing job", { jobId: job_id, kind, platform: account.platform });

  if (kind === "publish") {
    await handlePublish(job);
  } else if (kind === "poll") {
    await handlePoll(job);
  } else if (kind === "reconcile") {
    await handleReconcile(job);
  }
}

async function handlePublish(job: any) {
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
    await siteApi.result(job_id, {
      attempt_no,
      outcome: "failed",
      error_code: "HASH_MISMATCH",
      error_message: "Content hash does not match approved content",
    });
    return;
  }

  // 2. Download media and upload to Postiz
  const postizMedia: Array<{ id: string; path: string }> = [];
  if (media && media.length > 0) {
    for (const m of media) {
      // Windows has no /tmp; use the OS temp dir.
      const tmpPath = path.join(os.tmpdir(), `media-${m.media_id}`);
      try {
        const res = await fetch(m.url);
        if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());

        await writeFile(tmpPath, buffer);
        const uploaded = await postizApi.uploadMedia(tmpPath, m.mime);
        postizMedia.push({ id: uploaded.id, path: uploaded.path });
      } catch (err) {
        logger.error("Media transfer failed", { jobId: job_id, mediaId: m.media_id });
        // PRD 10.7: MEDIA_FETCH_FAILED retries once with a fresh claim, so this
        // must be "retry", not "failed" (which the site would never requeue).
        await siteApi.result(job_id, {
          attempt_no,
          outcome: "retry",
          error_code: "MEDIA_FETCH_FAILED",
          error_message: String(err),
        });
        return;
      } finally {
        await unlink(tmpPath).catch(() => {});
      }
    }
  }

  // 3. Mark as submitting
  try {
    await siteApi.submitting(job_id, attempt_no);
  } catch (err: any) {
    if (err.message === "LEASE_LOST") {
      logger.warn("Lease lost before submit", { jobId: job_id });
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
      mediaCount: postizMedia.length,
    });
    await siteApi.result(job_id, {
      attempt_no,
      outcome: "published",
      remote_url: `https://example.com/dry-run/${job_id}`,
    });
    return;
  }

  try {
    const postizPayload = {
      type: "now" as const,
      posts: [
        {
          content: destination.text,
          integration: account.postiz_integration_id,
          settings: destination.settings || {},
          media: postizMedia.length > 0 ? postizMedia : undefined,
        },
      ],
    };

    const postizResult = await postizApi.createPost(postizPayload);
    const postId = postizResult?.id || postizResult?.posts?.[0]?.id;
    const group = postizResult?.group || postizResult?.id;

    if (postId) {
      await siteApi.submitted(job_id, attempt_no, postId, group);
      logger.info("Submitted to Postiz", { jobId: job_id, postizPostId: postId });
    } else {
      logger.warn("No post ID in Postiz response", { jobId: job_id });
      await siteApi.result(job_id, {
        attempt_no,
        outcome: "reconciling",
        error_code: "UNKNOWN_RESULT",
        error_message: "No post ID returned",
      });
    }
  } catch (err) {
    logger.error("Postiz submit failed", { jobId: job_id, error: String(err) });
    await siteApi.result(job_id, {
      attempt_no,
      outcome: "reconciling",
      error_code: "UNKNOWN_RESULT",
      error_message: String(err),
    });
  }
}

async function handlePoll(job: any) {
  const { job_id, attempt_no, postiz } = job;
  if (!postiz?.post_id) return;

  try {
    const posts = await postizApi.listPosts();
    const found = posts?.find?.((p: any) => p.id === postiz.post_id);

    if (found?.releaseURL || found?.release_url || found?.releaseId) {
      await siteApi.result(job_id, {
        attempt_no,
        outcome: "published",
        remote_url: found.releaseURL || found.release_url || "",
      });
    } else if (found?.state === "ERROR" || found?.state === "error") {
      await siteApi.result(job_id, {
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

async function handleReconcile(job: any) {
  const { job_id, attempt_no, account } = job;
  logger.info("Reconciling job", { jobId: job_id });

  try {
    const posts = await postizApi.listPosts();
    const candidates = (posts || []).filter(
      (p: any) => p.integration === account.postiz_integration_id,
    );

    if (candidates.length > 0) {
      const best = candidates[0];
      await siteApi.submitted(job_id, attempt_no, best.id, best.group || best.id);
    } else {
      await siteApi.result(job_id, {
        attempt_no,
        outcome: "not_found",
        error_code: "RECONCILE_MISS",
        error_message: "Post not found in Postiz after reconciliation",
      });
    }
  } catch (err) {
    logger.error("Reconcile error", { jobId: job_id, error: String(err) });
  }
}
