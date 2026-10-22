-- A durable fence precedes every native remote publication. Uncertain writes
-- remain in reconciliation; neither lease expiry nor an HTTP retry resends them.
CREATE TABLE public.social_native_publications (
  job_id uuid PRIMARY KEY REFERENCES public.social_delivery_jobs(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.social_accounts(id),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  publisher_nonce uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  destination_hash text NOT NULL CHECK (destination_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('publishing','processing','published','rejected','unknown')),
  remote_id text,
  remote_url text,
  metadata jsonb NOT NULL DEFAULT '{}',
  error_code text,
  retry_after_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.social_native_begin_publication(
  p_job uuid, p_worker_id text, p_attempt_no integer, p_nonce uuid,
  p_key text, p_hash text, p_enabled boolean, p_now timestamptz DEFAULT now()
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j public.social_delivery_jobs%ROWTYPE; a public.social_accounts%ROWTYPE;
  d public.social_destinations%ROWTYPE; v_publication public.social_native_publications%ROWTYPE;
BEGIN
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'http',404,'code','NOT_FOUND'); END IF;
  IF j.status <> 'submitting' OR j.lease_owner IS DISTINCT FROM p_worker_id OR
     j.attempts <> p_attempt_no OR j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now THEN
    RETURN public.social_lease_lost();
  END IF;
  SELECT * INTO a FROM public.social_accounts WHERE id = j.account_id FOR UPDATE;
  SELECT * INTO d FROM public.social_destinations WHERE id = j.destination_id;
  IF a.publishing_backend <> 'native' OR a.native_provider_account_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'http',409,'code','NATIVE_ACCOUNT_REQUIRED');
  END IF;
  IF NOT coalesce(p_enabled,false) OR a.paused OR a.mode <> 'auto' OR a.status <> 'connected'
     OR a.postiz_disabled OR j.run_at + j.stale_after <= p_now
     OR NOT EXISTS (SELECT 1 FROM public.social_native_credentials WHERE account_id = a.id)
     OR NOT EXISTS (SELECT 1 FROM public.social_approvals WHERE revision_id = d.revision_id AND revoked_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'http',409,'code','PUBLISHING_PAUSED');
  END IF;
  IF d.destination_hash IS DISTINCT FROM p_hash OR p_hash IS NULL THEN
    RETURN jsonb_build_object('ok',false,'http',409,'code','HASH_MISMATCH');
  END IF;
  SELECT * INTO v_publication FROM public.social_native_publications WHERE job_id = p_job FOR UPDATE;
  IF FOUND AND NOT (v_publication.state = 'rejected' AND v_publication.attempt_no < p_attempt_no) THEN
    RETURN jsonb_build_object('ok',true,'send',false,'publication',to_jsonb(v_publication) - 'publisher_nonce');
  END IF;
  INSERT INTO public.social_native_publications(job_id,account_id,attempt_no,publisher_nonce,idempotency_key,destination_hash,state,created_at,updated_at)
    VALUES (p_job,j.account_id,p_attempt_no,p_nonce,p_key,p_hash,'publishing',p_now,p_now)
    ON CONFLICT(job_id) DO UPDATE SET attempt_no = p_attempt_no, publisher_nonce = p_nonce,
      idempotency_key = p_key, state = 'publishing', remote_id = NULL, remote_url = NULL,
      metadata = '{}', error_code = NULL, retry_after_seconds = NULL, created_at = p_now, updated_at = p_now
    RETURNING * INTO v_publication;
  PERFORM public.social_log_system('social.native_publication_started',public.social_job_post(p_job),p_job,j.account_id,
    jsonb_build_object('worker_id',p_worker_id,'attempt_no',p_attempt_no),p_now);
  RETURN jsonb_build_object('ok',true,'send',true,'publication',to_jsonb(v_publication) - 'publisher_nonce');
END;
$$;

-- The private nonce allows a late answer to be saved after the worker lease
-- expires. It cannot alter the job or overwrite a newer publication attempt.
CREATE OR REPLACE FUNCTION public.social_native_finish_publication(
  p_job uuid, p_nonce uuid, p_state text, p_remote_id text, p_remote_url text,
  p_metadata jsonb, p_error_code text, p_retry_after_seconds integer,
  p_now timestamptz DEFAULT now()
)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_publication public.social_native_publications%ROWTYPE;
BEGIN
  IF p_state NOT IN ('processing','published','rejected','unknown') OR
     jsonb_typeof(p_metadata) <> 'object' OR octet_length(p_metadata::text) > 131072 THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PATCH';
  END IF;
  IF p_state IN ('processing','published') AND (p_remote_id IS NULL OR length(p_remote_id) NOT BETWEEN 1 AND 2048) THEN
    RAISE EXCEPTION 'SOCIAL_NATIVE_ID_REQUIRED';
  END IF;
  IF p_remote_url IS NOT NULL AND (p_remote_url !~ '^https://[^[:space:]]+$' OR length(p_remote_url) > 4096) THEN
    RAISE EXCEPTION 'SOCIAL_BAD_URL';
  END IF;
  SELECT * INTO v_publication FROM public.social_native_publications WHERE job_id = p_job FOR UPDATE;
  IF NOT FOUND OR v_publication.publisher_nonce IS DISTINCT FROM p_nonce THEN RETURN false; END IF;
  IF v_publication.state IN ('published','rejected') THEN RETURN v_publication.state = p_state; END IF;
  UPDATE public.social_native_publications SET state = p_state,
    remote_id = coalesce(p_remote_id,remote_id), remote_url = coalesce(p_remote_url,remote_url),
    metadata = CASE WHEN p_state='unknown' AND p_remote_id IS NULL THEN metadata ELSE p_metadata END, error_code = p_error_code,
    retry_after_seconds = p_retry_after_seconds, updated_at = p_now WHERE job_id = p_job;
  PERFORM public.social_log_system('social.native_publication_recorded',public.social_job_post(p_job),p_job,v_publication.account_id,
    jsonb_build_object('state',p_state,'error_code',p_error_code,'attempt_no',v_publication.attempt_no),p_now);
  RETURN true;
END;
$$;

-- Polling releases its lease with a durable next check. There is no age-based
-- "not found" rule for a native write whose remote result is uncertain.
CREATE OR REPLACE FUNCTION public.social_native_wait(
  p_job uuid, p_worker_id text, p_attempt_no integer, p_now timestamptz DEFAULT now()
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j public.social_delivery_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR j.status NOT IN ('submitting','submitted','reconciling') OR
     j.lease_owner IS DISTINCT FROM p_worker_id OR j.attempts <> p_attempt_no OR
     j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now THEN RETURN public.social_lease_lost(); END IF;
  UPDATE public.social_delivery_jobs SET status = 'reconciling', next_check_at = p_now + interval '2 minutes',
    lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL,
    last_error_code = 'NATIVE_RECONCILING',
    last_error_message = 'Se verifica rezultatul publicarii directe. Nu se retrimite automat.', updated_at = p_now
    WHERE id = p_job;
  PERFORM public.social_log_system('social.native_reconciliation_wait',public.social_job_post(p_job),p_job,j.account_id,
    jsonb_build_object('attempt_no',p_attempt_no,'worker_id',p_worker_id),p_now);
  PERFORM public.social_refresh_post_status(public.social_job_post(p_job),p_now);
  RETURN jsonb_build_object('ok',true,'status','reconciling');
END;
$$;

ALTER TABLE public.social_native_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_native_publications FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.social_native_publications TO service_role;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('social_native_begin_publication','social_native_finish_publication','social_native_wait')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',r.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);
  END LOOP;
END; $$;
