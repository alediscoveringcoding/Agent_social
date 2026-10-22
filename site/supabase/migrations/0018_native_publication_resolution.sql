CREATE OR REPLACE FUNCTION public.social_native_publication_gate(
  p_job uuid,p_nonce uuid,p_worker_id text,p_attempt_no integer,p_hash text,p_enabled boolean,p_now timestamptz DEFAULT now()
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j public.social_delivery_jobs%ROWTYPE; a public.social_accounts%ROWTYPE; d public.social_destinations%ROWTYPE;
BEGIN
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id=p_job FOR UPDATE;
  IF NOT FOUND OR j.status<>'submitting' OR j.lease_owner IS DISTINCT FROM p_worker_id OR j.attempts<>p_attempt_no
    OR j.lease_expires_at IS NULL OR j.lease_expires_at<=p_now THEN RETURN public.social_lease_lost(); END IF;
  SELECT * INTO a FROM public.social_accounts WHERE id=j.account_id FOR UPDATE;
  SELECT * INTO d FROM public.social_destinations WHERE id=j.destination_id;
  IF NOT coalesce(p_enabled,false) OR a.publishing_backend<>'native' OR a.paused OR a.mode<>'auto' OR a.status<>'connected'
    OR a.postiz_disabled OR d.destination_hash IS DISTINCT FROM p_hash OR j.run_at+j.stale_after<=p_now
    OR NOT EXISTS(SELECT 1 FROM public.social_approvals WHERE revision_id=d.revision_id AND revoked_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM public.social_native_credentials WHERE account_id=a.id)
    OR NOT EXISTS(SELECT 1 FROM public.social_native_publications WHERE job_id=p_job AND publisher_nonce=p_nonce AND state IN ('publishing','processing')) THEN
    RETURN jsonb_build_object('ok',false,'http',409,'code','PUBLISHING_PAUSED');
  END IF;
  RETURN jsonb_build_object('ok',true);
END; $$;

CREATE OR REPLACE FUNCTION public.social_native_resolve(
  p_job uuid,p_actor uuid,p_found boolean,p_remote_url text,p_note text,p_now timestamptz DEFAULT now()
)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j public.social_delivery_jobs%ROWTYPE; v public.social_native_publications%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 5 AND 1000 OR p_found IS NULL THEN RAISE EXCEPTION 'SOCIAL_NATIVE_RESOLUTION_NOTE'; END IF;
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id=p_job FOR UPDATE;
  IF NOT FOUND OR j.status<>'reconciling' THEN RAISE EXCEPTION 'SOCIAL_NATIVE_NOT_RECONCILING'; END IF;
  SELECT * INTO v FROM public.social_native_publications WHERE job_id=p_job FOR UPDATE;
  IF NOT FOUND OR v.state NOT IN ('publishing','processing','unknown') THEN RAISE EXCEPTION 'SOCIAL_NATIVE_NOT_RECONCILING'; END IF;
  IF p_found AND (p_remote_url IS NULL OR p_remote_url !~ '^https://[^[:space:]]+$' OR length(p_remote_url)>4096) THEN RAISE EXCEPTION 'SOCIAL_BAD_URL'; END IF;
  -- Native requests have a four-minute operation deadline and a gate before
  -- each final write. Give a much larger margin before accepting absence.
  IF NOT p_found AND v.created_at>p_now-interval '30 minutes' THEN RAISE EXCEPTION 'SOCIAL_NATIVE_RESOLUTION_TOO_EARLY'; END IF;
  UPDATE public.social_native_publications SET publisher_nonce=gen_random_uuid(),
    state=CASE WHEN p_found THEN 'published' ELSE 'rejected' END,
    remote_id=CASE WHEN p_found THEN coalesce(remote_id,p_remote_url) ELSE remote_id END,
    remote_url=CASE WHEN p_found THEN p_remote_url ELSE remote_url END,
    error_code=CASE WHEN p_found THEN NULL ELSE 'NATIVE_CONFIRMED_ABSENT' END,
    metadata=metadata-'_private',updated_at=p_now WHERE job_id=p_job;
  UPDATE public.social_delivery_jobs SET status=CASE WHEN p_found THEN 'published' ELSE 'failed' END,
    remote_url=CASE WHEN p_found THEN p_remote_url ELSE remote_url END,
    published_at=CASE WHEN p_found THEN p_now ELSE published_at END,
    last_error_code=CASE WHEN p_found THEN NULL ELSE 'NATIVE_CONFIRMED_ABSENT' END,
    last_error_message=CASE WHEN p_found THEN NULL ELSE 'Absenta verificata pe platforma de administrator.' END,
    lease_owner=NULL,lease_expires_at=NULL,lease_kind=NULL,next_check_at=NULL,updated_at=p_now WHERE id=p_job;
  UPDATE public.social_publish_attempts SET outcome=CASE WHEN p_found THEN 'published' ELSE 'failed' END,
    error_code=CASE WHEN p_found THEN NULL ELSE 'NATIVE_CONFIRMED_ABSENT' END,finished_at=p_now WHERE job_id=p_job AND attempt_no=j.attempts;
  INSERT INTO public.social_activity_log(actor_id,action,job_id,account_id,post_id,details,created_at)
    VALUES(p_actor,'social.native_resolved',p_job,j.account_id,public.social_job_post(p_job),
      jsonb_build_object('found',p_found,'note',btrim(p_note),'remote_url',p_remote_url),p_now);
  PERFORM public.social_refresh_post_status(public.social_job_post(p_job),p_now);
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.social_native_publication_gate(uuid,uuid,text,integer,text,boolean,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.social_native_publication_gate(uuid,uuid,text,integer,text,boolean,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.social_native_resolve(uuid,uuid,boolean,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.social_native_resolve(uuid,uuid,boolean,text,text,timestamptz) TO service_role;
