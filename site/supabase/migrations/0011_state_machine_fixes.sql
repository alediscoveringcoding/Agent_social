-- ============================================================================
-- 0011: state machine fixes.
--
-- Replaces functions of 0001 / 0005 (nothing already deployed is edited):
--   * approve: destination accounts must belong to the post's brand, and an
--     auto slot already past its stale window is refused;
--   * cancel (one destination): the post is cancelled once nothing live or
--     sent is left, exactly like the whole-post path;
--   * sweep: submitted / reconciling jobs older than 24 h fail as
--     POLL_TIMEOUT; requeued jobs refresh the stored post status;
--   * manual retry gets a fresh attempt budget (retry_base) without reusing
--     attempt numbers;
--   * claim locks only the jobs it takes; claim and submitting refresh the
--     post status;
--   * generation_finish: re-delivery needs the original lease owner;
--   * admin_update_account: manual-only platforms come from
--     social_manual_only_platforms();
--   * NEW social_release_deliveries: a worker hands back claimed jobs it
--     will not run.
-- Plus integrity constraints, each skipped with a NOTICE when the existing
-- data would violate it (this file runs on a database that already holds
-- real rows and must never fail on them).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns and helpers
-- ---------------------------------------------------------------------------

-- Attempts already used when the last MANUAL retry was requested. The retry
-- budget (3 attempts, 2 for MEDIA_FETCH_FAILED) counts attempts - retry_base,
-- while attempt numbers keep growing (UNIQUE (job_id, attempt_no)).
ALTER TABLE public.social_delivery_jobs
  ADD COLUMN IF NOT EXISTS retry_base integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_jobs_retry_base_nonneg') THEN
    ALTER TABLE public.social_delivery_jobs
      ADD CONSTRAINT social_jobs_retry_base_nonneg CHECK (retry_base >= 0);
  END IF;
END $$;

-- Activity for transitions nobody clicked (sweeper, worker). Admin actions are
-- logged by the server with the actor; these carry actor_email = 'system'.
CREATE OR REPLACE FUNCTION public.social_log_system(
  p_action text, p_post uuid, p_job uuid, p_account uuid, p_details jsonb, p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO public.social_activity_log (actor_id, actor_email, action, status, post_id, job_id, account_id, details, created_at)
  VALUES (NULL, 'system', p_action, 'success', p_post, p_job, p_account, coalesce(p_details, '{}'::jsonb), p_now)
$$;

-- ---------------------------------------------------------------------------
-- 2. Integrity (each guarded against existing violations)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  n integer;
BEGIN
  -- The same image twice on one destination.
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM public.social_destination_media GROUP BY destination_id, media_id HAVING count(*) > 1
  ) x;
  IF n > 0 THEN
    RAISE NOTICE '0011: % destination(s) attach the same media twice; unique (destination_id, media_id) not created', n;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS social_destination_media_unique_media
      ON public.social_destination_media (destination_id, media_id);
  END IF;

  -- One Postiz post id belongs to one job. (A retry or a not_found clears it
  -- first, so a live id is never shared.)
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM public.social_delivery_jobs WHERE postiz_post_id IS NOT NULL
     GROUP BY postiz_post_id HAVING count(*) > 1
  ) x;
  IF n > 0 THEN
    RAISE NOTICE '0011: % postiz_post_id value(s) are shared by several jobs; unique index not created', n;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS social_jobs_postiz_post_unique
      ON public.social_delivery_jobs (postiz_post_id) WHERE postiz_post_id IS NOT NULL;
  END IF;

  -- Informational: rows the triggers below would have refused. The triggers
  -- only look at new writes, so existing rows are left untouched.
  SELECT count(*) INTO n FROM public.social_delivery_jobs j
    JOIN public.social_destinations d ON d.id = j.destination_id
   WHERE j.account_id IS DISTINCT FROM d.account_id;
  IF n > 0 THEN
    RAISE NOTICE '0011: % delivery job(s) already differ from their destination account', n;
  END IF;
  SELECT count(*) INTO n FROM public.social_posts p
   WHERE p.current_revision_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.social_post_revisions r
                      WHERE r.id = p.current_revision_id AND r.post_id = p.id);
  IF n > 0 THEN
    RAISE NOTICE '0011: % post(s) already point at a revision of another post', n;
  END IF;
END $$;

-- A job's account is its destination's account: the claim and the cap count
-- by job.account_id, approval by destination.account_id.
CREATE OR REPLACE FUNCTION public.social_guard_job_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_account uuid;
BEGIN
  SELECT d.account_id INTO v_account FROM public.social_destinations d WHERE d.id = NEW.destination_id;
  IF v_account IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'SOCIAL_JOB_ACCOUNT_MISMATCH'
      USING DETAIL = 'a delivery job must use the account of its destination';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS social_jobs_account_guard ON public.social_delivery_jobs;
CREATE TRIGGER social_jobs_account_guard
  BEFORE INSERT OR UPDATE OF account_id, destination_id ON public.social_delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION public.social_guard_job_account();

-- The current revision of a post is one of its own revisions.
CREATE OR REPLACE FUNCTION public.social_guard_current_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.social_post_revisions r
        WHERE r.id = NEW.current_revision_id AND r.post_id = NEW.id) THEN
    RAISE EXCEPTION 'SOCIAL_REVISION_NOT_OF_POST'
      USING DETAIL = format('revision %s does not belong to post %s', NEW.current_revision_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS social_posts_current_revision_guard ON public.social_posts;
CREATE TRIGGER social_posts_current_revision_guard
  BEFORE INSERT OR UPDATE OF current_revision_id ON public.social_posts
  FOR EACH ROW EXECUTE FUNCTION public.social_guard_current_revision();

-- ---------------------------------------------------------------------------
-- 3. Sweeper: POLL_TIMEOUT, post status refresh on requeue
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.social_sweep(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v_requeued integer := 0;
  v_reconciling integer := 0;
  v_stale integer := 0;
  v_poll_timeout integer := 0;
  v_manual integer := 0;
  v_gen_requeued integer := 0;
  v_gen_failed integer := 0;
  v_last_seen timestamptz;
  v_silent boolean := false;
BEGIN
  -- claimed + lease expired -> queued: Postiz was never called (the worker
  -- never reached /submitting).
  FOR r IN
    SELECT j.id, j.attempts FROM public.social_delivery_jobs j
     WHERE j.status = 'claimed' AND j.lease_expires_at <= p_now
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.social_delivery_jobs
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = r.id;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'lease_expired'
     WHERE job_id = r.id AND attempt_no = r.attempts AND finished_at IS NULL;
    -- The stored post status said "publishing" while the job was claimed.
    PERFORM public.social_refresh_post_status(public.social_job_post(r.id), p_now);
    v_requeued := v_requeued + 1;
  END LOOP;

  -- submitting + lease expired -> reconciling: the create call may or may not
  -- have reached Postiz, so it is never simply queued again.
  FOR r IN
    SELECT j.id, j.attempts FROM public.social_delivery_jobs j
     WHERE j.status = 'submitting' AND j.lease_expires_at <= p_now
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.social_delivery_jobs
       SET status = 'reconciling', lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL,
           next_check_at = p_now, last_error_code = 'UNKNOWN_RESULT',
           last_error_message = 'Lease expired after /submitting', updated_at = p_now
     WHERE id = r.id;
    UPDATE public.social_publish_attempts
       SET outcome = 'reconciling', error_code = 'UNKNOWN_RESULT'
     WHERE job_id = r.id AND attempt_no = r.attempts AND finished_at IS NULL;
    v_reconciling := v_reconciling + 1;
  END LOOP;

  -- queued past slot + stale window -> failed STALE. A "deadline today" post
  -- must not go out days late (PRD 6.4).
  FOR r IN
    SELECT j.id FROM public.social_delivery_jobs j
     WHERE j.status = 'queued' AND j.run_at + j.stale_after <= p_now
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.social_delivery_jobs
       SET status = 'failed', last_error_code = 'STALE',
           last_error_message = 'Slot plus stale window passed before the job could be published',
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = r.id;
    PERFORM public.social_emit('delivery_stale', public.social_job_context(r.id), p_now);
    PERFORM public.social_refresh_post_status(public.social_job_post(r.id), p_now);
    v_stale := v_stale + 1;
  END LOOP;

  -- submitted / reconciling for more than 24 h -> failed POLL_TIMEOUT. Without
  -- this a job whose post never shows up (or never reports) stays "in flight"
  -- forever, and so does its post. The clock starts at the latest attempt, or
  -- at the last status change when there is none. A person decides what next
  -- (retry failed destinations, or mark it done by hand).
  FOR r IN
    SELECT j.id, j.account_id, j.attempts, j.status AS from_status,
           coalesce((SELECT max(pa.started_at) FROM public.social_publish_attempts pa WHERE pa.job_id = j.id),
                    j.updated_at) AS since
      FROM public.social_delivery_jobs j
     WHERE j.status IN ('submitted', 'reconciling')
       AND coalesce((SELECT max(pa.started_at) FROM public.social_publish_attempts pa WHERE pa.job_id = j.id),
                    j.updated_at) <= p_now - interval '24 hours'
     FOR UPDATE OF j SKIP LOCKED
  LOOP
    UPDATE public.social_delivery_jobs
       SET status = 'failed', last_error_code = 'POLL_TIMEOUT',
           last_error_message = format('No final result after 24 hours (was %s)', r.from_status),
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
     WHERE id = r.id;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'failed', error_code = 'POLL_TIMEOUT'
     WHERE job_id = r.id AND attempt_no = r.attempts AND finished_at IS NULL;
    PERFORM public.social_emit('delivery_failed', public.social_job_context(r.id), p_now);
    PERFORM public.social_log_system('social.poll_timeout', public.social_job_post(r.id), r.id, r.account_id,
      jsonb_build_object('from_status', r.from_status, 'since', r.since), p_now);
    PERFORM public.social_refresh_post_status(public.social_job_post(r.id), p_now);
    v_poll_timeout := v_poll_timeout + 1;
  END LOOP;

  -- Manual destinations notify once, at their slot.
  FOR r IN
    SELECT j.id FROM public.social_delivery_jobs j
     WHERE j.status = 'manual_pending' AND j.run_at <= p_now AND j.manual_notified_at IS NULL
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.social_delivery_jobs SET manual_notified_at = p_now, updated_at = p_now WHERE id = r.id;
    PERFORM public.social_emit('manual_due', public.social_job_context(r.id), p_now);
    v_manual := v_manual + 1;
  END LOOP;

  -- Generation: an expired lease goes back to queued, at most 3 attempts.
  FOR r IN
    SELECT g.id, g.attempts, g.brand_id FROM public.social_generation_requests g
     WHERE g.status = 'running' AND g.lease_expires_at <= p_now
     FOR UPDATE SKIP LOCKED
  LOOP
    IF r.attempts >= 3 THEN
      UPDATE public.social_generation_requests
         SET status = 'failed', error_code = 'LEASE_EXPIRED',
             error_message = 'Lease expired three times', lease_owner = NULL, lease_expires_at = NULL,
             finished_at = p_now, updated_at = p_now
       WHERE id = r.id;
      PERFORM public.social_emit('generation_failed',
        jsonb_build_object('request_id', r.id, 'brand_id', r.brand_id, 'error_code', 'LEASE_EXPIRED'), p_now);
      v_gen_failed := v_gen_failed + 1;
    ELSE
      UPDATE public.social_generation_requests
         SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = p_now
       WHERE id = r.id;
      v_gen_requeued := v_gen_requeued + 1;
    END IF;
  END LOOP;

  -- worker_silent once per silence: no worker call for 10 minutes (NFR
  -- observability). Only meaningful once a worker has ever been seen.
  SELECT max(w.last_seen_at) INTO v_last_seen FROM public.social_workers w;
  IF v_last_seen IS NOT NULL AND v_last_seen < p_now - interval '10 minutes'
     AND NOT EXISTS (SELECT 1 FROM public.social_events e
                      WHERE e.type = 'worker_silent' AND e.created_at >= v_last_seen) THEN
    PERFORM public.social_emit('worker_silent', jsonb_build_object('last_seen_at', v_last_seen), p_now);
    v_silent := true;
  END IF;

  RETURN jsonb_build_object(
    'requeued', v_requeued, 'reconciling', v_reconciling, 'stale', v_stale,
    'poll_timeout', v_poll_timeout,
    'manual_due', v_manual, 'generation_requeued', v_gen_requeued,
    'generation_failed', v_gen_failed, 'worker_silent', v_silent);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Claim: lock only what is taken; refresh the post status
-- ---------------------------------------------------------------------------
-- 0001 looped over a cursor with FOR UPDATE ... SKIP LOCKED, which locks every
-- due job it reads, also those past p_limit. Each pick is now its own
-- ORDER BY ... LIMIT 1 FOR UPDATE SKIP LOCKED. A job held back by the daily cap
-- is remembered (v_skip) so the next pick moves on; it is updated anyway (its
-- message), so its lock is not extra.

CREATE OR REPLACE FUNCTION public.social_claim_deliveries(
  p_worker_id text,
  p_limit integer,
  p_enabled boolean,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 5);
  v_lease timestamptz := p_now + interval '10 minutes';
  v_jobs jsonb := '[]'::jsonb;
  v_taken integer := 0;
  v_used integer;
  v_attempt integer;
  v_skip uuid[] := ARRAY[]::uuid[];
  r record;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN
    RAISE EXCEPTION 'SOCIAL_WORKER_ID_REQUIRED';
  END IF;

  PERFORM public.social_sweep(p_now);

  -- Kill switch: nothing at all, not even polls.
  IF NOT coalesce(p_enabled, false) THEN
    RETURN jsonb_build_object('jobs', v_jobs);
  END IF;

  LOOP
    EXIT WHEN v_taken >= v_limit;

    SELECT j.id, j.account_id, j.run_at, a.daily_cap INTO r
      FROM public.social_delivery_jobs j
      JOIN public.social_accounts a ON a.id = j.account_id
      JOIN public.social_destinations d ON d.id = j.destination_id
     WHERE j.status = 'queued'
       AND j.run_at <= p_now
       AND coalesce(j.next_attempt_at, j.run_at) <= p_now
       AND j.run_at + j.stale_after > p_now
       AND a.mode = 'auto'
       AND a.status = 'connected'
       AND NOT a.paused
       AND NOT a.postiz_disabled
       AND a.postiz_integration_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.social_approvals ap
                    WHERE ap.revision_id = d.revision_id AND ap.revoked_at IS NULL)
       AND j.id <> ALL (v_skip)
     ORDER BY j.run_at, j.id
     LIMIT 1
     FOR UPDATE OF j SKIP LOCKED;
    EXIT WHEN NOT FOUND;

    -- Cap again at claim time (PRD 5). The account row lock serialises two
    -- claimers on the same account, so both cannot pass the count at once.
    PERFORM 1 FROM public.social_accounts a WHERE a.id = r.account_id FOR UPDATE;
    SELECT count(*)::integer INTO v_used
      FROM public.social_delivery_jobs x
     WHERE x.account_id = r.account_id
       AND x.id <> r.id
       AND x.run_at >= (public.social_bucharest_day(r.run_at)::timestamp AT TIME ZONE 'Europe/Bucharest')
       AND x.run_at <  ((public.social_bucharest_day(r.run_at) + 1)::timestamp AT TIME ZONE 'Europe/Bucharest')
       AND x.status IN ('claimed', 'submitting', 'submitted', 'reconciling', 'published', 'manual_done');
    IF v_used >= r.daily_cap THEN
      -- Left queued (it fails as STALE when its window closes); the reason is
      -- visible on the job.
      UPDATE public.social_delivery_jobs
         SET last_error_message = format('Daily cap %s reached for this account on %s; not claimed',
                                         r.daily_cap, public.social_bucharest_day(r.run_at)),
             updated_at = p_now
       WHERE id = r.id;
      v_skip := v_skip || r.id;
      CONTINUE;
    END IF;

    UPDATE public.social_delivery_jobs
       SET status = 'claimed', attempts = attempts + 1, lease_owner = p_worker_id,
           lease_expires_at = v_lease, lease_kind = 'publish', updated_at = p_now
     WHERE id = r.id
     RETURNING attempts INTO v_attempt;

    INSERT INTO public.social_publish_attempts (job_id, attempt_no, worker_id, started_at)
    VALUES (r.id, v_attempt, p_worker_id, p_now);

    PERFORM public.social_refresh_post_status(public.social_job_post(r.id), p_now);

    v_jobs := v_jobs || jsonb_build_object('job_id', r.id, 'kind', 'publish', 'attempt_no', v_attempt,
                                           'lease_expires_at', v_lease);
    v_taken := v_taken + 1;
  END LOOP;

  IF v_taken < v_limit THEN
    FOR r IN
      SELECT j.id, j.attempts FROM public.social_delivery_jobs j
       WHERE j.status = 'reconciling'
         AND (j.next_check_at IS NULL OR j.next_check_at <= p_now)
         AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now OR j.lease_owner = p_worker_id)
       ORDER BY coalesce(j.next_check_at, j.updated_at), j.id
       LIMIT (v_limit - v_taken)
       FOR UPDATE SKIP LOCKED
    LOOP
      UPDATE public.social_delivery_jobs
         SET lease_owner = p_worker_id, lease_expires_at = v_lease, lease_kind = 'reconcile',
             next_check_at = p_now + interval '60 seconds', updated_at = p_now
       WHERE id = r.id;
      v_jobs := v_jobs || jsonb_build_object('job_id', r.id, 'kind', 'reconcile', 'attempt_no', r.attempts,
                                             'lease_expires_at', v_lease);
      v_taken := v_taken + 1;
    END LOOP;
  END IF;

  IF v_taken < v_limit THEN
    FOR r IN
      SELECT j.id, j.attempts FROM public.social_delivery_jobs j
       WHERE j.status = 'submitted'
         AND (j.next_check_at IS NULL OR j.next_check_at <= p_now)
         AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now OR j.lease_owner = p_worker_id)
       ORDER BY coalesce(j.next_check_at, j.updated_at), j.id
       LIMIT (v_limit - v_taken)
       FOR UPDATE SKIP LOCKED
    LOOP
      UPDATE public.social_delivery_jobs
         SET lease_owner = p_worker_id, lease_expires_at = v_lease, lease_kind = 'poll',
             next_check_at = p_now + interval '60 seconds', updated_at = p_now
       WHERE id = r.id;
      v_jobs := v_jobs || jsonb_build_object('job_id', r.id, 'kind', 'poll', 'attempt_no', r.attempts,
                                             'lease_expires_at', v_lease);
      v_taken := v_taken + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('jobs', v_jobs);
END;
$$;

-- A worker hands back claimed jobs it will not run (shutdown, a batch it could
-- not finish). Only jobs still 'claimed' by that worker move; the claim's
-- attempt is given back, and its never-started attempt row removed so the
-- next claim can reuse the number (UNIQUE (job_id, attempt_no)).
CREATE OR REPLACE FUNCTION public.social_release_deliveries(
  p_worker_id text, p_job_ids uuid[], p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v_released integer := 0;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN
    RAISE EXCEPTION 'SOCIAL_WORKER_ID_REQUIRED';
  END IF;

  FOR r IN
    SELECT j.id, j.account_id, j.attempts FROM public.social_delivery_jobs j
     WHERE j.id = ANY (coalesce(p_job_ids, ARRAY[]::uuid[]))
       AND j.status = 'claimed' AND j.lease_owner = p_worker_id
     ORDER BY j.id
     FOR UPDATE OF j
  LOOP
    UPDATE public.social_delivery_jobs
       SET status = 'queued', attempts = greatest(attempts - 1, 0),
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = r.id;
    DELETE FROM public.social_publish_attempts
     WHERE job_id = r.id AND attempt_no = r.attempts AND submitting_at IS NULL AND finished_at IS NULL;
    PERFORM public.social_log_system('social.delivery_released', public.social_job_post(r.id), r.id, r.account_id,
      jsonb_build_object('worker_id', p_worker_id, 'attempt_no', r.attempts), p_now);
    PERFORM public.social_refresh_post_status(public.social_job_post(r.id), p_now);
    v_released := v_released + 1;
  END LOOP;

  RETURN v_released;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Submitting: refresh the post status
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.social_job_submitting(
  p_job uuid, p_worker_id text, p_attempt_no integer, p_enabled boolean, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  j public.social_delivery_jobs%ROWTYPE;
  a public.social_accounts%ROWTYPE;
  v_revision uuid;
BEGIN
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'NOT_FOUND', 'message', 'No such job');
  END IF;

  -- Repeated call for the same attempt: already done.
  IF j.status = 'submitting' AND j.lease_owner = p_worker_id AND j.attempts = p_attempt_no
     AND j.lease_expires_at > p_now THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;

  IF j.status <> 'claimed' OR j.lease_owner IS DISTINCT FROM p_worker_id OR j.attempts <> p_attempt_no
     OR j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now THEN
    RETURN public.social_lease_lost();
  END IF;

  -- Last gate before the create call. Anything that would have stopped the
  -- claim stops the submission too; Postiz has not been called, so the job
  -- can safely go back to the queue (or fail STALE).
  IF j.run_at + j.stale_after <= p_now THEN
    UPDATE public.social_delivery_jobs
       SET status = 'failed', last_error_code = 'STALE',
           last_error_message = 'Stale window passed before submission',
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = p_job;
    UPDATE public.social_publish_attempts SET finished_at = p_now, outcome = 'failed', error_code = 'STALE'
     WHERE job_id = p_job AND attempt_no = j.attempts;
    PERFORM public.social_emit('delivery_stale', public.social_job_context(p_job), p_now);
    PERFORM public.social_refresh_post_status(public.social_job_post(p_job), p_now);
    RETURN public.social_lease_lost('Stale window passed; job failed as STALE');
  END IF;

  SELECT d.revision_id INTO v_revision FROM public.social_destinations d WHERE d.id = j.destination_id;
  SELECT * INTO a FROM public.social_accounts WHERE id = j.account_id;
  IF NOT coalesce(p_enabled, false)
     OR a.paused OR a.status <> 'connected' OR a.mode <> 'auto' OR a.postiz_disabled
     OR NOT EXISTS (SELECT 1 FROM public.social_approvals ap
                     WHERE ap.revision_id = v_revision AND ap.revoked_at IS NULL) THEN
    UPDATE public.social_delivery_jobs
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = p_job;
    UPDATE public.social_publish_attempts SET finished_at = p_now, outcome = 'released'
     WHERE job_id = p_job AND attempt_no = j.attempts;
    PERFORM public.social_refresh_post_status(public.social_job_post(p_job), p_now);
    RETURN public.social_lease_lost('Publishing is paused for this job (kill switch, account or approval)');
  END IF;

  UPDATE public.social_delivery_jobs SET status = 'submitting', updated_at = p_now WHERE id = p_job;
  UPDATE public.social_publish_attempts SET submitting_at = p_now
   WHERE job_id = p_job AND attempt_no = j.attempts;
  PERFORM public.social_refresh_post_status(public.social_job_post(p_job), p_now);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Job result: the retry budget counts from the last manual retry
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.social_job_result(
  p_job uuid,
  p_worker_id text,
  p_attempt_no integer,
  p_outcome text,
  p_remote_url text,
  p_error_code text,
  p_error_message text,
  p_retry_after_seconds integer,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  j public.social_delivery_jobs%ROWTYPE;
  v_last_outcome text;
  v_next timestamptz;
  v_post uuid;
  v_max_attempts integer;
  v_used integer;
BEGIN
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'NOT_FOUND', 'message', 'No such job');
  END IF;

  IF j.lease_owner IS DISTINCT FROM p_worker_id OR j.attempts <> p_attempt_no
     OR j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now THEN
    -- The same final result reported twice (a retried HTTP call) is not a lost lease.
    SELECT pa.outcome INTO v_last_outcome FROM public.social_publish_attempts pa
     WHERE pa.job_id = p_job AND pa.attempt_no = p_attempt_no;
    IF j.attempts = p_attempt_no AND (
         (p_outcome = 'published' AND j.status = 'published')
      OR (p_outcome = 'failed' AND j.status = 'failed' AND j.last_error_code IS NOT DISTINCT FROM p_error_code)
      OR (p_outcome = 'retry' AND v_last_outcome = 'retry')
      OR (p_outcome = 'reconciling' AND j.status = 'reconciling')
      OR (p_outcome = 'not_found' AND v_last_outcome = 'not_found')
    ) THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', j.status);
    END IF;
    RETURN public.social_lease_lost();
  END IF;

  v_post := public.social_job_post(p_job);

  IF p_outcome = 'published' THEN
    IF j.status NOT IN ('submitting', 'submitted', 'reconciling') THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                                'message', format('A %s job cannot be published', j.status));
    END IF;
    UPDATE public.social_delivery_jobs
       SET status = 'published', remote_url = p_remote_url, published_at = p_now,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL,
           last_error_code = NULL, last_error_message = NULL, updated_at = p_now
     WHERE id = p_job;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'published',
           details = details || jsonb_build_object('remote_url', p_remote_url)
     WHERE job_id = p_job AND attempt_no = j.attempts;

  ELSIF p_outcome = 'failed' THEN
    IF p_error_code IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'http', 422, 'code', 'INVALID_BODY', 'message', 'error_code is required');
    END IF;
    IF j.status NOT IN ('claimed', 'submitting', 'submitted', 'reconciling') THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                                'message', format('A %s job cannot fail', j.status));
    END IF;
    UPDATE public.social_delivery_jobs
       SET status = 'failed', last_error_code = p_error_code, last_error_message = p_error_message,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
     WHERE id = p_job;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'failed', error_code = p_error_code,
           details = details || jsonb_build_object('error_message', p_error_message)
     WHERE job_id = p_job AND attempt_no = j.attempts;
    -- PRD 10.7 side effects.
    IF p_error_code = 'AUTH_EXPIRED' THEN
      UPDATE public.social_accounts SET status = 'reconnect_required', updated_at = p_now
       WHERE id = j.account_id AND status <> 'reconnect_required';
      IF FOUND THEN
        PERFORM public.social_emit('account_reconnect_required',
          jsonb_build_object('account_id', j.account_id, 'reason', 'AUTH_EXPIRED', 'job_id', p_job), p_now);
      END IF;
    ELSIF p_error_code = 'PERMISSION_DENIED' THEN
      UPDATE public.social_accounts SET status = 'developer_setup_required', updated_at = p_now
       WHERE id = j.account_id;
    END IF;
    PERFORM public.social_emit('delivery_failed', public.social_job_context(p_job), p_now);

  ELSIF p_outcome = 'retry' THEN
    IF j.status NOT IN ('claimed', 'submitting', 'submitted') THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                                'message', format('A %s job cannot be retried', j.status));
    END IF;
    -- 3 attempts in all; a media fetch failure gets one fresh claim only. The
    -- count starts again after each manual retry (retry_base), while attempt
    -- numbers keep growing.
    v_max_attempts := CASE WHEN p_error_code = 'MEDIA_FETCH_FAILED' THEN 2 ELSE 3 END;
    v_used := j.attempts - j.retry_base;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'retry', error_code = p_error_code,
           details = details || jsonb_build_object('error_message', p_error_message,
                                                   'retry_after_seconds', p_retry_after_seconds)
     WHERE job_id = p_job AND attempt_no = j.attempts;
    IF v_used >= v_max_attempts THEN
      UPDATE public.social_delivery_jobs
         SET status = 'failed', last_error_code = coalesce(p_error_code, 'TRANSIENT'),
             last_error_message = coalesce(p_error_message, 'Retries exhausted'),
             lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
       WHERE id = p_job;
      PERFORM public.social_emit('delivery_failed', public.social_job_context(p_job), p_now);
    ELSE
      -- Backoff 1 / 5 / 15 minutes (PRD 6.4), or what the platform asked for.
      v_next := p_now + CASE
        WHEN p_retry_after_seconds IS NOT NULL AND p_retry_after_seconds > 0
          THEN make_interval(secs => least(p_retry_after_seconds, 3600))
        WHEN v_used <= 1 THEN interval '1 minute'
        WHEN v_used = 2 THEN interval '5 minutes'
        ELSE interval '15 minutes' END;
      UPDATE public.social_delivery_jobs
         SET status = 'queued', next_attempt_at = v_next,
             last_error_code = p_error_code, last_error_message = p_error_message,
             postiz_post_id = NULL, postiz_group = NULL,
             lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
       WHERE id = p_job;
    END IF;

  ELSIF p_outcome = 'reconciling' THEN
    IF j.status NOT IN ('submitting', 'submitted') THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                                'message', format('A %s job cannot go to reconciling', j.status));
    END IF;
    UPDATE public.social_delivery_jobs
       SET status = 'reconciling', last_error_code = coalesce(p_error_code, 'UNKNOWN_RESULT'),
           last_error_message = p_error_message,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = p_now, updated_at = p_now
     WHERE id = p_job;
    UPDATE public.social_publish_attempts
       SET outcome = 'reconciling', error_code = coalesce(p_error_code, 'UNKNOWN_RESULT')
     WHERE job_id = p_job AND attempt_no = j.attempts;

  ELSIF p_outcome = 'not_found' THEN
    IF j.status <> 'reconciling' THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                                'message', format('not_found only applies to a reconciling job, not %s', j.status));
    END IF;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'not_found'
     WHERE job_id = p_job AND attempt_no = j.attempts;
    IF j.reconcile_misses = 0 THEN
      -- First miss: confirmed absent, so it may go out again (once).
      UPDATE public.social_delivery_jobs
         SET status = 'queued', reconcile_misses = 1, next_attempt_at = p_now,
             postiz_post_id = NULL, postiz_group = NULL,
             lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
       WHERE id = p_job;
    ELSE
      UPDATE public.social_delivery_jobs
         SET status = 'failed', reconcile_misses = reconcile_misses + 1, last_error_code = 'RECONCILE_MISS',
             last_error_message = 'Not found in Postiz a second time; a person decides',
             lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
       WHERE id = p_job;
      PERFORM public.social_emit('delivery_failed', public.social_job_context(p_job), p_now);
    END IF;

  ELSE
    RETURN jsonb_build_object('ok', false, 'http', 422, 'code', 'INVALID_BODY',
                              'message', format('Unknown outcome %s', p_outcome));
  END IF;

  PERFORM public.social_refresh_post_status(v_post, p_now);
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job;
  RETURN jsonb_build_object('ok', true, 'status', j.status);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Generation finish: re-delivery needs the lease owner
-- ---------------------------------------------------------------------------
-- The lease owner is kept when the request completes, so a re-delivered
-- /drafts call (a timed-out POST sent again with the same body) can be told
-- from a stranger's. Re-posting the same drafts creates nothing new (each
-- generation_ref is unique), so created = 0 and the call changes nothing and
-- emits nothing. Only when drafts were really created late are created and
-- skipped added and drafts_ready emitted.

CREATE OR REPLACE FUNCTION public.social_generation_finish(
  p_request uuid, p_worker_id text, p_created integer, p_skipped integer, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  g public.social_generation_requests%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.social_generation_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'NOT_FOUND', 'message', 'No such request');
  END IF;
  IF g.status = 'done' THEN
    IF g.lease_owner IS DISTINCT FROM p_worker_id THEN
      RETURN public.social_lease_lost();
    END IF;
    IF coalesce(p_created, 0) > 0 THEN
      UPDATE public.social_generation_requests
         SET drafts_created = drafts_created + coalesce(p_created, 0),
             drafts_skipped = drafts_skipped + coalesce(p_skipped, 0), updated_at = p_now
       WHERE id = p_request;
      PERFORM public.social_emit('drafts_ready',
        jsonb_build_object('request_id', p_request, 'brand_id', g.brand_id, 'created', p_created, 'skipped', p_skipped), p_now);
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;
  IF g.status <> 'running' OR g.lease_owner IS DISTINCT FROM p_worker_id OR g.lease_expires_at <= p_now THEN
    RETURN public.social_lease_lost();
  END IF;
  UPDATE public.social_generation_requests
     SET status = 'done', drafts_created = drafts_created + coalesce(p_created, 0),
         drafts_skipped = drafts_skipped + coalesce(p_skipped, 0),
         lease_expires_at = NULL, finished_at = p_now, updated_at = p_now
   WHERE id = p_request;
  PERFORM public.social_emit('drafts_ready',
    jsonb_build_object('request_id', p_request, 'brand_id', g.brand_id, 'created', p_created, 'skipped', p_skipped), p_now);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Approval: brand match and stale slot
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.social_approve_revision(
  p_post uuid,
  p_revision uuid,
  p_actor uuid,
  p_actor_email text,
  p_approval_hash text,
  p_figures_checked boolean,
  p_destinations jsonb,
  p_now timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_post public.social_posts%ROWTYPE;
  v_count integer;
  v_given integer;
  v_approval uuid;
  v_used integer;
  r record;
  d jsonb;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED';
  END IF;

  SELECT * INTO v_post FROM public.social_posts WHERE id = p_post FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND';
  END IF;
  IF v_post.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'SOCIAL_POST_CANCELLED';
  END IF;
  IF v_post.current_revision_id IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'SOCIAL_STALE_REVISION'
      USING DETAIL = format('current revision is %s', v_post.current_revision_id);
  END IF;
  IF public.social_revision_frozen(p_revision) THEN
    RAISE EXCEPTION 'SOCIAL_ALREADY_APPROVED';
  END IF;

  SELECT count(*) INTO v_count FROM public.social_destinations WHERE revision_id = p_revision;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'SOCIAL_NO_DESTINATIONS';
  END IF;
  SELECT count(DISTINCT x->>'id') INTO v_given
    FROM jsonb_array_elements(coalesce(p_destinations, '[]'::jsonb)) x
   WHERE (x->>'id')::uuid IN (SELECT id FROM public.social_destinations WHERE revision_id = p_revision)
     AND (x->>'destination_hash') ~ '^[0-9a-f]{64}$';
  IF v_given <> v_count THEN
    RAISE EXCEPTION 'SOCIAL_HASHES_INCOMPLETE'
      USING DETAIL = format('%s destinations, %s hashed', v_count, v_given);
  END IF;

  IF EXISTS (SELECT 1 FROM public.social_destinations WHERE revision_id = p_revision AND scheduled_at IS NULL) THEN
    RAISE EXCEPTION 'SOCIAL_MISSING_TIME';
  END IF;

  -- Every destination account belongs to the post's brand. The composer only
  -- offers the brand's accounts, but an account can change brand after a
  -- draft was saved, and the database does not take the form's word for it.
  IF EXISTS (SELECT 1 FROM public.social_destinations sd
               JOIN public.social_accounts a ON a.id = sd.account_id
              WHERE sd.revision_id = p_revision AND a.brand_id IS DISTINCT FROM v_post.brand_id) THEN
    RAISE EXCEPTION 'SOCIAL_BRAND_MISMATCH'
      USING DETAIL = 'a destination account does not belong to the brand of the post';
  END IF;

  -- A slot already past its stale window (2 hours, like social_delivery_jobs.
  -- stale_after) would be approved only to fail as STALE at the first sweep.
  -- Manual destinations never go stale (they wait for a person).
  IF EXISTS (SELECT 1 FROM public.social_destinations sd
               JOIN public.social_accounts a ON a.id = sd.account_id
              WHERE sd.revision_id = p_revision AND a.mode <> 'manual'
                AND sd.scheduled_at + interval '2 hours' <= p_now) THEN
    RAISE EXCEPTION 'SOCIAL_SCHEDULE_STALE'
      USING DETAIL = 'a scheduled time is more than 2 hours in the past; reschedule it';
  END IF;

  -- Figures (PRD 8.2): "figures checked" for any destination with figures, and
  -- no unverified figure at all.
  IF NOT coalesce(p_figures_checked, false) AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_destinations) x WHERE (x->>'contains_figures')::boolean) THEN
    RAISE EXCEPTION 'SOCIAL_FIGURES_NOT_CHECKED';
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.social_destinations sd, jsonb_array_elements(sd.figures) f
        WHERE sd.revision_id = p_revision AND f->>'source' = 'unverified') THEN
    RAISE EXCEPTION 'SOCIAL_UNVERIFIED_FIGURE';
  END IF;

  -- Daily cap (PRD 5), under a lock on each account involved, in id order so
  -- two approvals cannot deadlock.
  PERFORM 1 FROM public.social_accounts a
   WHERE a.id IN (SELECT account_id FROM public.social_destinations WHERE revision_id = p_revision)
   ORDER BY a.id
   FOR UPDATE;
  FOR r IN
    SELECT sd.account_id, a.display_name, a.daily_cap, public.social_bucharest_day(sd.scheduled_at) AS day,
           count(*)::integer AS n
      FROM public.social_destinations sd
      JOIN public.social_accounts a ON a.id = sd.account_id
     WHERE sd.revision_id = p_revision
     GROUP BY sd.account_id, a.display_name, a.daily_cap, public.social_bucharest_day(sd.scheduled_at)
  LOOP
    v_used := public.social_cap_usage(r.account_id, r.day);
    IF v_used + r.n > r.daily_cap THEN
      RAISE EXCEPTION 'SOCIAL_DAILY_CAP'
        USING DETAIL = jsonb_build_object('account_id', r.account_id, 'account', r.display_name, 'day', r.day,
                                          'used', v_used, 'adding', r.n, 'cap', r.daily_cap)::text;
    END IF;
  END LOOP;

  -- Derived columns, written before the approval row exists (afterwards the
  -- revision is frozen).
  FOR d IN SELECT * FROM jsonb_array_elements(p_destinations)
  LOOP
    UPDATE public.social_destinations
       SET destination_hash = d->>'destination_hash',
           validation = coalesce(nullif(d->'validation', 'null'::jsonb), validation),
           contains_figures = coalesce((d->>'contains_figures')::boolean, contains_figures)
     WHERE id = (d->>'id')::uuid AND revision_id = p_revision;
  END LOOP;

  INSERT INTO public.social_approvals
    (revision_id, approved_by, approved_by_email, approved_at, approval_hash, figures_checked)
  VALUES (p_revision, p_actor, p_actor_email, p_now, p_approval_hash, coalesce(p_figures_checked, false))
  RETURNING id INTO v_approval;

  INSERT INTO public.social_delivery_jobs (destination_id, account_id, status, run_at, created_at, updated_at)
  SELECT sd.id, sd.account_id,
         CASE WHEN a.mode = 'manual' THEN 'manual_pending' ELSE 'queued' END,
         sd.scheduled_at, p_now, p_now
    FROM public.social_destinations sd
    JOIN public.social_accounts a ON a.id = sd.account_id
   WHERE sd.revision_id = p_revision;

  PERFORM public.social_refresh_post_status(p_post, p_now);
  RETURN v_approval;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Cancel and retry
-- ---------------------------------------------------------------------------

-- Cancelling the last live destination cancels the post, as the whole-post
-- path does: cancelled_at is set when nothing live (queued, claimed, manual
-- pending) or sent (submitting .. manual_done) is left. The approval is not
-- touched in either path: revoking it would unfreeze a revision whose jobs
-- exist.
CREATE OR REPLACE FUNCTION public.social_cancel(
  p_post uuid, p_job uuid, p_actor uuid, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_post public.social_posts%ROWTYPE;
  v_job public.social_delivery_jobs%ROWTYPE;
  v_cancelled integer := 0;
BEGIN
  SELECT * INTO v_post FROM public.social_posts WHERE id = p_post FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND';
  END IF;

  IF p_job IS NOT NULL THEN
    SELECT * INTO v_job FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
    IF NOT FOUND OR public.social_job_post(p_job) IS DISTINCT FROM p_post THEN
      RAISE EXCEPTION 'SOCIAL_JOB_NOT_FOUND';
    END IF;
    IF v_job.status NOT IN ('queued', 'claimed', 'manual_pending') THEN
      RAISE EXCEPTION 'SOCIAL_NOT_CANCELLABLE' USING DETAIL = v_job.status;
    END IF;
    UPDATE public.social_delivery_jobs
       SET status = 'cancelled', cancelled_at = p_now, cancelled_by = p_actor,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = p_job;
    v_cancelled := 1;

    IF NOT EXISTS (
         SELECT 1 FROM public.social_delivery_jobs j
           JOIN public.social_destinations d ON d.id = j.destination_id
           JOIN public.social_post_revisions r ON r.id = d.revision_id
          WHERE r.post_id = p_post
            AND j.status IN ('queued', 'claimed', 'manual_pending',
                             'submitting', 'submitted', 'reconciling', 'published', 'manual_done')) THEN
      UPDATE public.social_posts SET cancelled_at = p_now, cancelled_by = p_actor, updated_at = p_now
       WHERE id = p_post AND cancelled_at IS NULL;
    END IF;
  ELSE
    WITH c AS (
      UPDATE public.social_delivery_jobs j
         SET status = 'cancelled', cancelled_at = p_now, cancelled_by = p_actor,
             lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
        FROM public.social_destinations d
       WHERE d.id = j.destination_id
         AND d.revision_id = v_post.current_revision_id
         AND j.status IN ('queued', 'claimed', 'manual_pending')
      RETURNING j.id)
    SELECT count(*) INTO v_cancelled FROM c;

    IF NOT EXISTS (
         SELECT 1 FROM public.social_delivery_jobs j
           JOIN public.social_destinations d ON d.id = j.destination_id
           JOIN public.social_post_revisions r ON r.id = d.revision_id
          WHERE r.post_id = p_post
            AND j.status IN ('submitting', 'submitted', 'reconciling', 'published', 'manual_done')) THEN
      UPDATE public.social_posts SET cancelled_at = p_now, cancelled_by = p_actor, updated_at = p_now
       WHERE id = p_post AND cancelled_at IS NULL;
    END IF;
  END IF;

  PERFORM public.social_refresh_post_status(p_post, p_now);
  RETURN jsonb_build_object('cancelled', v_cancelled);
END;
$$;

-- "Retry failed destinations only" (F5): same approved content, a new attempt
-- and a fresh retry budget (retry_base = attempts so far).
CREATE OR REPLACE FUNCTION public.social_retry_failed(
  p_post uuid, p_actor uuid, p_confirm_reconcile_miss boolean, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_post public.social_posts%ROWTYPE;
  v_retried integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_used integer;
  r record;
BEGIN
  SELECT * INTO v_post FROM public.social_posts WHERE id = p_post FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.social_approvals a
                  WHERE a.revision_id = v_post.current_revision_id AND a.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'SOCIAL_NOT_APPROVED';
  END IF;

  FOR r IN
    SELECT j.*, a.daily_cap FROM public.social_delivery_jobs j
      JOIN public.social_destinations d ON d.id = j.destination_id
      JOIN public.social_accounts a ON a.id = j.account_id
     WHERE d.revision_id = v_post.current_revision_id AND j.status = 'failed'
     ORDER BY j.run_at, j.id
     FOR UPDATE OF j
  LOOP
    IF r.run_at + r.stale_after <= p_now THEN
      v_skipped := v_skipped || jsonb_build_object('job_id', r.id, 'reason', 'STALE_WINDOW');
      CONTINUE;
    END IF;
    IF r.last_error_code = 'RECONCILE_MISS' AND NOT coalesce(p_confirm_reconcile_miss, false) THEN
      v_skipped := v_skipped || jsonb_build_object('job_id', r.id, 'reason', 'NEEDS_CONFIRMATION');
      CONTINUE;
    END IF;
    v_used := public.social_cap_usage(r.account_id, public.social_bucharest_day(r.run_at), r.id);
    IF v_used >= r.daily_cap THEN
      v_skipped := v_skipped || jsonb_build_object('job_id', r.id, 'reason', 'DAILY_CAP');
      CONTINUE;
    END IF;
    UPDATE public.social_delivery_jobs
       SET status = 'queued', next_attempt_at = p_now, retry_base = attempts,
           reconcile_misses = CASE WHEN r.last_error_code = 'RECONCILE_MISS' THEN 0 ELSE reconcile_misses END,
           postiz_post_id = NULL, postiz_group = NULL,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
     WHERE id = r.id;
    v_retried := v_retried + 1;
  END LOOP;

  PERFORM public.social_refresh_post_status(p_post, p_now);
  RETURN jsonb_build_object('retried', v_retried, 'skipped', v_skipped);
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. Accounts: manual-only platforms from the one list
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.social_admin_update_account(
  p_account uuid, p_patch jsonb, p_actor uuid, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_old public.social_accounts%ROWTYPE;
  v_new public.social_accounts%ROWTYPE;
  v_bad text;
  v_open integer;
  v_cap numeric;
  r record;
  v_before jsonb;
  v_after jsonb;
  v_changed jsonb;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED';
  END IF;
  IF jsonb_typeof(v_patch) <> 'object' THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PATCH';
  END IF;
  SELECT k INTO v_bad FROM jsonb_object_keys(v_patch) k
   WHERE k NOT IN ('brand_id', 'mode', 'status', 'daily_cap', 'paused', 'open_editor_url', 'display_name', 'profile_url')
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PATCH' USING DETAIL = format('unknown field %s', v_bad);
  END IF;

  SELECT * INTO v_old FROM public.social_accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND';
  END IF;
  v_new := v_old;

  IF v_patch ? 'brand_id' THEN
    v_new.brand_id := nullif(v_patch->>'brand_id', '')::uuid;
    IF v_new.brand_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.social_brands WHERE id = v_new.brand_id) THEN
      RAISE EXCEPTION 'SOCIAL_BRAND_NOT_FOUND';
    END IF;
  END IF;

  IF v_patch ? 'mode' THEN
    v_new.mode := v_patch->>'mode';
    IF v_new.mode IS NULL OR v_new.mode NOT IN ('auto', 'manual') THEN
      RAISE EXCEPTION 'SOCIAL_BAD_MODE';
    END IF;
  END IF;

  IF v_patch ? 'status' THEN
    v_new.status := v_patch->>'status';
    IF v_new.status IS NULL OR v_new.status NOT IN
       ('connected', 'reconnect_required', 'developer_setup_required', 'approval_pending', 'manual') THEN
      RAISE EXCEPTION 'SOCIAL_BAD_STATUS';
    END IF;
  ELSIF v_new.mode IS DISTINCT FROM v_old.mode THEN
    v_new.status := CASE WHEN v_new.mode = 'manual' THEN 'manual' ELSE 'connected' END;
  END IF;

  IF v_patch ? 'daily_cap' THEN
    IF jsonb_typeof(v_patch->'daily_cap') <> 'number' THEN
      RAISE EXCEPTION 'SOCIAL_CAP_RANGE';
    END IF;
    v_cap := (v_patch->>'daily_cap')::numeric;
    IF v_cap <> trunc(v_cap) OR v_cap < 1 OR v_cap > 5 THEN
      RAISE EXCEPTION 'SOCIAL_CAP_RANGE';
    END IF;
    v_new.daily_cap := v_cap::integer;
  END IF;

  IF v_patch ? 'paused' THEN
    IF jsonb_typeof(v_patch->'paused') <> 'boolean' THEN
      RAISE EXCEPTION 'SOCIAL_BAD_PATCH' USING DETAIL = 'paused must be a boolean';
    END IF;
    v_new.paused := (v_patch->>'paused')::boolean;
  END IF;

  IF v_patch ? 'open_editor_url' THEN
    v_new.open_editor_url := nullif(btrim(coalesce(v_patch->>'open_editor_url', '')), '');
    IF v_new.open_editor_url IS NOT NULL
       AND (v_new.open_editor_url !~* '^https?://[^[:space:]]+$' OR length(v_new.open_editor_url) > 2048) THEN
      RAISE EXCEPTION 'SOCIAL_BAD_URL' USING DETAIL = 'open_editor_url';
    END IF;
  END IF;

  IF v_patch ? 'display_name' THEN
    v_new.display_name := btrim(coalesce(v_patch->>'display_name', ''));
    IF v_new.display_name = '' OR length(v_new.display_name) > 120 THEN
      RAISE EXCEPTION 'SOCIAL_NAME_REQUIRED';
    END IF;
  END IF;

  IF v_patch ? 'profile_url' THEN
    v_new.profile_url := nullif(btrim(coalesce(v_patch->>'profile_url', '')), '');
    IF v_new.profile_url IS NOT NULL
       AND (v_new.profile_url !~* '^https?://[^[:space:]]+$' OR length(v_new.profile_url) > 2048) THEN
      RAISE EXCEPTION 'SOCIAL_BAD_URL' USING DETAIL = 'profile_url';
    END IF;
  END IF;

  -- No brand, no publishing.
  IF v_new.brand_id IS NULL THEN
    IF v_patch ? 'paused' AND NOT v_new.paused THEN
      RAISE EXCEPTION 'SOCIAL_ACCOUNT_NO_BRAND';
    END IF;
    v_new.paused := true;
  END IF;

  -- Fields Postiz owns.
  IF v_old.postiz_integration_id IS NOT NULL
     AND (v_new.display_name IS DISTINCT FROM v_old.display_name OR v_new.profile_url IS DISTINCT FROM v_old.profile_url) THEN
    RAISE EXCEPTION 'SOCIAL_SYNCED_FIELD';
  END IF;

  IF v_new.mode IS DISTINCT FROM v_old.mode THEN
    IF v_new.mode = 'auto' AND v_new.postiz_integration_id IS NULL THEN
      RAISE EXCEPTION 'SOCIAL_AUTO_NEEDS_POSTIZ';
    END IF;
    IF v_new.mode = 'auto' AND v_new.platform = ANY (public.social_manual_only_platforms()) THEN
      RAISE EXCEPTION 'SOCIAL_MANUAL_ONLY_PLATFORM';
    END IF;
    IF v_new.mode = 'manual' THEN
      SELECT count(*)::integer INTO v_open FROM public.social_delivery_jobs
       WHERE account_id = p_account AND status IN ('queued', 'claimed');
      IF v_open > 0 THEN
        RAISE EXCEPTION 'SOCIAL_ACCOUNT_HAS_OPEN_JOBS' USING DETAIL = jsonb_build_object('jobs', v_open)::text;
      END IF;
    END IF;
  END IF;

  IF v_new.status IS DISTINCT FROM v_old.status OR v_new.mode IS DISTINCT FROM v_old.mode THEN
    IF (v_new.mode = 'manual' AND v_new.status NOT IN ('manual', 'approval_pending'))
       OR (v_new.mode = 'auto' AND v_new.status = 'manual') THEN
      RAISE EXCEPTION 'SOCIAL_STATUS_FOR_MODE' USING DETAIL = format('%s / %s', v_new.mode, v_new.status);
    END IF;
  END IF;

  IF v_old.brand_id IS NOT NULL AND v_new.brand_id IS DISTINCT FROM v_old.brand_id THEN
    SELECT count(*)::integer INTO v_open FROM public.social_delivery_jobs
     WHERE account_id = p_account
       AND status IN ('queued', 'claimed', 'submitting', 'submitted', 'reconciling', 'manual_pending');
    IF v_open > 0 THEN
      RAISE EXCEPTION 'SOCIAL_ACCOUNT_HAS_OPEN_JOBS' USING DETAIL = jsonb_build_object('jobs', v_open)::text;
    END IF;
  END IF;

  IF v_new.daily_cap < v_old.daily_cap THEN
    FOR r IN
      SELECT public.social_bucharest_day(j.run_at) AS day
        FROM public.social_delivery_jobs j
       WHERE j.account_id = p_account
         AND j.run_at >= (public.social_bucharest_day(p_now)::timestamp AT TIME ZONE 'Europe/Bucharest')
       GROUP BY 1
       ORDER BY 1
    LOOP
      IF public.social_cap_usage(p_account, r.day) > v_new.daily_cap THEN
        RAISE EXCEPTION 'SOCIAL_CAP_BELOW_SCHEDULED'
          USING DETAIL = jsonb_build_object('day', r.day, 'used', public.social_cap_usage(p_account, r.day),
                                            'cap', v_new.daily_cap)::text;
      END IF;
    END LOOP;
  END IF;

  SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb),
         coalesce(jsonb_object_agg(k, to_jsonb(v_old) -> k), '{}'::jsonb),
         coalesce(jsonb_object_agg(k, to_jsonb(v_new) -> k), '{}'::jsonb)
    INTO v_changed, v_before, v_after
    FROM unnest(ARRAY['brand_id', 'mode', 'status', 'daily_cap', 'paused', 'open_editor_url',
                      'display_name', 'profile_url']) AS k
   WHERE (to_jsonb(v_old) -> k) IS DISTINCT FROM (to_jsonb(v_new) -> k);

  IF jsonb_array_length(v_changed) > 0 THEN
    UPDATE public.social_accounts
       SET brand_id = v_new.brand_id, mode = v_new.mode, status = v_new.status, daily_cap = v_new.daily_cap,
           paused = v_new.paused, open_editor_url = v_new.open_editor_url, display_name = v_new.display_name,
           profile_url = v_new.profile_url, updated_at = p_now
     WHERE id = p_account;
  END IF;

  RETURN jsonb_build_object('changed', v_changed, 'before', v_before, 'after', v_after);
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. Function privileges: service role only (same rule as 0001 section 12)
-- ---------------------------------------------------------------------------
-- Covers the functions created or replaced above, and any earlier social_*
-- function that missed the rule (for example the trigger guards).

DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'social\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
