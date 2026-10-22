ALTER TABLE public.social_native_credentials ADD COLUMN refresh_owner uuid, ADD COLUMN refresh_expires_at timestamptz;

CREATE OR REPLACE FUNCTION public.social_native_refresh_claim(
  p_account uuid,p_version integer,p_owner uuid,p_worker_id text,p_now timestamptz DEFAULT now()
)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p_worker_id,'')='' OR p_owner IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  PERFORM 1 FROM public.social_accounts WHERE id=p_account AND publishing_backend='native' AND status='connected' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.social_native_credentials SET refresh_owner=p_owner,refresh_expires_at=p_now+interval '2 minutes'
    WHERE account_id=p_account AND version=p_version AND (refresh_expires_at IS NULL OR refresh_expires_at<=p_now);
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.social_log_system('social.native_refresh_started',NULL,NULL,p_account,jsonb_build_object('worker_id',p_worker_id),p_now);
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.social_native_refresh_finish(
  p_account uuid,p_version integer,p_owner uuid,p_worker_id text,p_encrypted text,p_expires_at timestamptz,
  p_error_code text,p_now timestamptz DEFAULT now()
)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p_worker_id,'')='' THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  PERFORM 1 FROM public.social_accounts WHERE id=p_account AND publishing_backend='native' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_error_code IS NULL AND (p_encrypted IS NULL OR length(p_encrypted) NOT BETWEEN 40 AND 262144) THEN RAISE EXCEPTION 'SOCIAL_NATIVE_CREDENTIALS_REQUIRED'; END IF;
  UPDATE public.social_native_credentials SET encrypted=coalesce(p_encrypted,encrypted),
    expires_at=CASE WHEN p_error_code IS NULL THEN p_expires_at ELSE expires_at END,
    version=version+1,refresh_owner=NULL,refresh_expires_at=NULL,updated_at=p_now
    WHERE account_id=p_account AND version=p_version AND refresh_owner=p_owner;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_error_code IS NOT NULL THEN
    UPDATE public.social_accounts SET status='reconnect_required',paused=true,updated_at=p_now WHERE id=p_account;
    PERFORM public.social_emit('account_reconnect_required',jsonb_build_object('account_id',p_account,'reason','NATIVE_REFRESH_FAILED'),p_now);
  END IF;
  PERFORM public.social_log_system('social.native_refresh_finished',NULL,NULL,p_account,
    jsonb_build_object('worker_id',p_worker_id,'error_code',p_error_code),p_now);
  RETURN true;
END; $$;

CREATE TABLE public.social_native_candidates (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_id uuid NOT NULL REFERENCES public.social_brands(id),
  platform text NOT NULL,
  encrypted text NOT NULL CHECK(length(encrypted) BETWEEN 40 AND 262144),
  destinations jsonb NOT NULL CHECK(jsonb_typeof(destinations)='array' AND jsonb_array_length(destinations) BETWEEN 1 AND 100),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.social_native_candidates_store(
  p_id uuid,p_actor uuid,p_brand uuid,p_platform text,p_encrypted text,p_destinations jsonb,p_now timestamptz DEFAULT now()
)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  IF p_platform IS NULL OR NOT(p_platform=ANY(public.social_native_platforms())) THEN RAISE EXCEPTION 'SOCIAL_BAD_PLATFORM'; END IF;
  -- Expired temporary secrets are removed as part of the audited connection operation.
  DELETE FROM public.social_native_candidates WHERE expires_at<=p_now;
  DELETE FROM public.social_native_oauth_attempts WHERE expires_at<=p_now;
  INSERT INTO public.social_native_candidates(id,actor_id,brand_id,platform,encrypted,destinations,expires_at,created_at)
    VALUES(p_id,p_actor,p_brand,p_platform,p_encrypted,p_destinations,p_now+interval '15 minutes',p_now);
  INSERT INTO public.social_activity_log(actor_id,action,details,created_at)
    VALUES(p_actor,'social.native_destinations_discovered',jsonb_build_object('platform',p_platform,'count',jsonb_array_length(p_destinations)),p_now);
  RETURN p_id;
END; $$;
CREATE OR REPLACE FUNCTION public.social_native_candidates_consume(
  p_id uuid,p_actor uuid,p_now timestamptz DEFAULT now()
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v public.social_native_candidates%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  SELECT * INTO v FROM public.social_native_candidates WHERE id=p_id AND actor_id=p_actor AND consumed_at IS NULL AND expires_at>p_now FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOCIAL_NATIVE_OAUTH_EXPIRED'; END IF;
  UPDATE public.social_native_candidates SET consumed_at=p_now,encrypted=repeat('x',40) WHERE id=p_id;
  INSERT INTO public.social_activity_log(actor_id,action,details,created_at)
    VALUES(p_actor,'social.native_destination_selected',jsonb_build_object('platform',v.platform),p_now);
  RETURN jsonb_build_object('encrypted',v.encrypted,'brand_id',v.brand_id,'platform',v.platform);
END; $$;

ALTER TABLE public.social_native_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_native_candidates FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.social_native_candidates TO service_role;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('social_native_refresh_claim','social_native_refresh_finish','social_native_candidates_store','social_native_candidates_consume')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',r.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);
  END LOOP;
END; $$;
