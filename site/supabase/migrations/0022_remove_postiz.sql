-- Amendment 10: Postiz is removed and fifteen platforms are dropped.
--
-- Only directly connected (native) accounts publish automatically. History stays as it
-- was: old Postiz account rows, their ids, jobs, approvals and hash vectors are not
-- rewritten. An old Postiz account that was connected is marked reconnect_required,
-- and a person closes any of its jobs that were still waiting for a result.

-- 1. Platforms dropped from the app (the site's DROPPED_PLATFORMS): no direct adapter
--    was built for the first twelve; WordPress, Discord and Mastodon were excluded.
CREATE OR REPLACE FUNCTION public.social_dropped_platforms()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['threads','reddit','pinterest','nostr','vk','gmb','tumblr','dribbble',
    'whop','moltbook','kick','twitch','wordpress','discord','mastodon']::text[];
$$;

CREATE OR REPLACE FUNCTION public.social_native_platforms()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['facebook','instagram','linkedin-page','x','devto','hashnode',
    'bluesky','linkedin','telegram','medium','farcaster','lemmy','slack','listmonk',
    'mewe','skool','tiktok','youtube','github','stackexchange']::text[];
$$;

-- Each patch keeps the latest deployed function and changes only the named text.
-- It aborts when that text is missing, so a changed baseline never goes unnoticed.
DO $$
DECLARE definition text;
BEGIN
  -- 2. The claim: publish, reconcile and poll jobs of native accounts only.
  SELECT pg_get_functiondef('public.social_claim_deliveries(text,integer,boolean,timestamp with time zone)'::regprocedure) INTO definition;
  IF position('a.postiz_integration_id IS NOT NULL OR (a.publishing_backend = ''native''' IN definition) = 0
     OR position('OR EXISTS(SELECT 1 FROM public.social_accounts a WHERE a.id=j.account_id AND a.publishing_backend=''postiz'')' IN definition) = 0 THEN
    RAISE EXCEPTION 'SOCIAL_REMOVE_POSTIZ_CLAIM_BASELINE_CHANGED';
  END IF;
  definition := replace(definition, 'a.postiz_integration_id IS NOT NULL OR (a.publishing_backend = ''native''', '(a.publishing_backend = ''native''');
  definition := replace(definition,
    'OR EXISTS(SELECT 1 FROM public.social_accounts a WHERE a.id=j.account_id AND a.publishing_backend=''postiz'')',
    'AND EXISTS(SELECT 1 FROM public.social_accounts a WHERE a.id=j.account_id AND a.publishing_backend=''native'')');
  EXECUTE definition;

  -- 3. Account edits: automatic mode needs a direct connection; the name and profile
  --    of an old Postiz account are no longer owned by a sync and can be edited.
  SELECT pg_get_functiondef('public.social_admin_update_account(uuid,jsonb,uuid,timestamp with time zone)'::regprocedure) INTO definition;
  IF position('v_new.mode = ''auto'' AND v_new.postiz_integration_id IS NULL AND NOT (' IN definition) = 0
     OR position('IF v_old.postiz_integration_id IS NOT NULL' IN definition) = 0 THEN
    RAISE EXCEPTION 'SOCIAL_REMOVE_POSTIZ_ACCOUNT_BASELINE_CHANGED';
  END IF;
  definition := replace(definition, 'v_new.mode = ''auto'' AND v_new.postiz_integration_id IS NULL AND NOT (', 'v_new.mode = ''auto'' AND NOT (');
  definition := replace(definition, '''SOCIAL_AUTO_NEEDS_POSTIZ''', '''SOCIAL_AUTO_NEEDS_CONNECTION''');
  definition := replace(definition, 'IF v_old.postiz_integration_id IS NOT NULL', 'IF false');
  EXECUTE definition;

  -- 4. An unused old Postiz account can be deleted: no sync brings it back.
  SELECT pg_get_functiondef('public.social_admin_delete_account(uuid,uuid)'::regprocedure) INTO definition;
  IF position('IF v_acc.postiz_integration_id IS NOT NULL THEN' IN definition) = 0 THEN
    RAISE EXCEPTION 'SOCIAL_REMOVE_POSTIZ_DELETE_BASELINE_CHANGED';
  END IF;
  EXECUTE replace(definition, 'IF v_acc.postiz_integration_id IS NOT NULL THEN', 'IF false THEN');

  -- 5. No new account on a dropped platform.
  SELECT pg_get_functiondef('public.social_admin_create_account(jsonb,uuid,timestamp with time zone)'::regprocedure) INTO definition;
  IF position('RAISE EXCEPTION ''SOCIAL_BAD_PLATFORM'';' IN definition) = 0 THEN
    RAISE EXCEPTION 'SOCIAL_REMOVE_POSTIZ_CREATE_BASELINE_CHANGED';
  END IF;
  EXECUTE replace(definition, 'RAISE EXCEPTION ''SOCIAL_BAD_PLATFORM'';',
    'RAISE EXCEPTION ''SOCIAL_BAD_PLATFORM'';
  END IF;
  IF v_platform = ANY (public.social_dropped_platforms()) THEN
    RAISE EXCEPTION ''SOCIAL_PLATFORM_DROPPED'' USING DETAIL = v_platform;');
END;
$$;

-- 6. Old Postiz accounts that were publishing need a direct connection now.
WITH retired AS (
  UPDATE public.social_accounts SET status = 'reconnect_required', updated_at = now()
   WHERE publishing_backend = 'postiz' AND mode = 'auto' AND status = 'connected'
  RETURNING id
)
SELECT public.social_log_system('social.postiz_retired', NULL, NULL, id,
  jsonb_build_object('reason', 'Postiz was removed; connect this account directly in Conturi.'))
  FROM retired;

-- 7. A job of an old Postiz account that was still waiting for a result (submitted or
--    reconciling) cannot be looked up any more: an admin checks the platform and records
--    what they found. Absence can be confirmed at once, because nothing is still sending.
CREATE OR REPLACE FUNCTION public.social_resolve_legacy_job(
  p_job uuid, p_actor uuid, p_found boolean, p_remote_url text, p_note text, p_now timestamptz DEFAULT now()
)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j public.social_delivery_jobs%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 5 AND 1000 OR p_found IS NULL THEN RAISE EXCEPTION 'SOCIAL_NATIVE_RESOLUTION_NOTE'; END IF;
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR j.status NOT IN ('submitted', 'reconciling')
     OR NOT EXISTS (SELECT 1 FROM public.social_accounts WHERE id = j.account_id AND publishing_backend = 'postiz') THEN
    RAISE EXCEPTION 'SOCIAL_LEGACY_NOT_WAITING';
  END IF;
  IF p_found AND (p_remote_url IS NULL OR p_remote_url !~ '^https://[^[:space:]]+$' OR length(p_remote_url) > 4096) THEN
    RAISE EXCEPTION 'SOCIAL_BAD_URL';
  END IF;
  UPDATE public.social_delivery_jobs SET status = CASE WHEN p_found THEN 'published' ELSE 'failed' END,
    remote_url = CASE WHEN p_found THEN p_remote_url ELSE remote_url END,
    published_at = CASE WHEN p_found THEN p_now ELSE published_at END,
    last_error_code = CASE WHEN p_found THEN NULL ELSE 'LEGACY_CONFIRMED_ABSENT' END,
    last_error_message = CASE WHEN p_found THEN NULL ELSE 'Absenta verificata pe platforma de administrator.' END,
    lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
   WHERE id = p_job;
  UPDATE public.social_publish_attempts SET outcome = CASE WHEN p_found THEN 'published' ELSE 'failed' END,
    error_code = CASE WHEN p_found THEN NULL ELSE 'LEGACY_CONFIRMED_ABSENT' END, finished_at = p_now
   WHERE job_id = p_job AND attempt_no = j.attempts AND finished_at IS NULL;
  INSERT INTO public.social_activity_log(actor_id, action, job_id, account_id, post_id, details, created_at)
    VALUES (p_actor, 'social.legacy_resolved', p_job, j.account_id, public.social_job_post(p_job),
      jsonb_build_object('found', p_found, 'note', btrim(p_note), 'remote_url', p_remote_url), p_now);
  PERFORM public.social_refresh_post_status(public.social_job_post(p_job), p_now);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.social_dropped_platforms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_dropped_platforms() TO service_role;
REVOKE ALL ON FUNCTION public.social_native_platforms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_native_platforms() TO service_role;
REVOKE ALL ON FUNCTION public.social_resolve_legacy_job(uuid,uuid,boolean,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_resolve_legacy_job(uuid,uuid,boolean,text,text,timestamptz) TO service_role;
