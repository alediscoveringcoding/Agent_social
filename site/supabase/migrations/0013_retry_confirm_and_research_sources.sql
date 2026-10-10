-- ============================================================================
-- 0013: retry confirmation, research drafts need sources, released claims.
--
--   * social_retry_failed (replaces 0011's): a failed job whose last error is
--     POLL_TIMEOUT needs the same confirmation as RECONCILE_MISS. After 24 hours
--     without a result the post may well be live, and a retry clears
--     postiz_post_id and publishes again. The signature is unchanged:
--     p_confirm_reconcile_miss now confirms both codes. Without it the job is
--     skipped with reason NEEDS_CONFIRMATION.
--   * social_job_result (replaces 0011's): a 'retry' outcome is refused while
--     the job is 'submitted'. The post already exists in Postiz; a retry would
--     clear its id and create it a second time. Everything else is 0011 verbatim.
--   * social_approve_revision (replaces 0012's): a post whose generation request
--     asked for research (input.research = true, or a news source) and that has
--     no row in social_post_sources is refused with SOCIAL_SOURCES_MISSING.
--     Everything else is 0012 verbatim.
--   * social_job_submitting (replaces 0011's): when its last gate hands the claim
--     back (kill switch, pause, account state or approval), the claim's attempt
--     is given back and its never-started attempt row removed, exactly as
--     social_release_deliveries does. Before, the attempt stayed counted and
--     three such releases used up the retry budget without a single send.
--
-- Nothing already deployed is edited. This file runs on a database that already
-- holds real rows: it creates no table and changes no data, every function is
-- CREATE OR REPLACE with its signature unchanged, and running it twice leaves
-- the same result.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Retry failed: POLL_TIMEOUT needs confirming too
-- ---------------------------------------------------------------------------

-- "Retry failed destinations only" (F5): same approved content, a new attempt
-- and a fresh retry budget (retry_base = attempts so far). RECONCILE_MISS and
-- POLL_TIMEOUT mean "the platform never said": a person must have checked that
-- the post is not there before the job goes out again.
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
    IF r.last_error_code IN ('RECONCILE_MISS', 'POLL_TIMEOUT') AND NOT coalesce(p_confirm_reconcile_miss, false) THEN
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
-- 2. Job result: no 'retry' for a job that is already submitted
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
    -- Not from 'submitted': the post already exists in Postiz, and a retry
    -- clears its id and creates it a second time. The worker polls it instead.
    IF j.status NOT IN ('claimed', 'submitting') THEN
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
-- 3. Approval: a research draft needs its sources (0012's function, plus one check)
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
  v_unverified integer;
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

  -- Research drafts (0013): a post whose generation request asked for a web
  -- search (research on, or a news source) must carry its sources. Without
  -- any, nothing could be ticked as verified and the check below would pass
  -- on an empty list. The post row is locked above, like the sources' own
  -- functions, so none can vanish between this check and the approval.
  IF v_post.generation_request_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.social_post_sources s WHERE s.post_id = p_post)
     AND EXISTS (SELECT 1 FROM public.social_generation_requests g
                  WHERE g.id = v_post.generation_request_id
                    AND (g.input->>'research' = 'true' OR g.input->'source'->>'type' = 'news')) THEN
    RAISE EXCEPTION 'SOCIAL_SOURCES_MISSING'
      USING DETAIL = 'the draft came from a web search but has no sources';
  END IF;

  -- Sources (amendment 07): a person ticked every link as verified. The post
  -- row is locked above, and ticking takes the same lock, so none can be
  -- unticked between this check and the approval below.
  SELECT count(*)::integer INTO v_unverified
    FROM public.social_post_sources s WHERE s.post_id = p_post AND s.verified_at IS NULL;
  IF v_unverified > 0 THEN
    RAISE EXCEPTION 'SOCIAL_SOURCES_NOT_VERIFIED'
      USING DETAIL = jsonb_build_object('unverified', v_unverified)::text;
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
-- 4. Submitting: a released claim gives its attempt back
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
    -- Handed back unsent, the same way social_release_deliveries does it: the
    -- claim's attempt is refunded and its never-started attempt row removed, so
    -- the next claim reuses the number (UNIQUE (job_id, attempt_no)) and a
    -- kill switch or a pause cannot use up the retry budget.
    UPDATE public.social_delivery_jobs
       SET status = 'queued', attempts = greatest(attempts - 1, 0),
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = p_job;
    DELETE FROM public.social_publish_attempts
     WHERE job_id = p_job AND attempt_no = j.attempts AND submitting_at IS NULL AND finished_at IS NULL;
    PERFORM public.social_log_system('social.delivery_released', public.social_job_post(p_job), p_job, j.account_id,
      jsonb_build_object('worker_id', p_worker_id, 'attempt_no', j.attempts, 'reason', 'submitting_gate'), p_now);
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
-- 5. Function privileges: service role only (same rule as 0001 section 12)
-- ---------------------------------------------------------------------------

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
