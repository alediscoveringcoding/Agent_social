ALTER TABLE public.social_workers ADD COLUMN capabilities text[] NOT NULL DEFAULT ARRAY[]::text[];
CREATE OR REPLACE FUNCTION public.social_native_worker(p_worker_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM public.social_workers WHERE worker_id=p_worker_id AND 'native-v1'=ANY(capabilities));
$$;
REVOKE ALL ON FUNCTION public.social_native_worker(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.social_native_worker(text) TO service_role;

-- Old workers retain exactly their legacy job shape and cannot accidentally
-- claim a native destination with a null Postiz ID.
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_functiondef('public.social_claim_deliveries(text,integer,boolean,timestamp with time zone)'::regprocedure) INTO definition;
  IF position('a.publishing_backend = ''native'' AND a.native_provider_account_id' IN definition)=0 THEN RAISE EXCEPTION 'SOCIAL_NATIVE_WORKER_BASELINE_CHANGED'; END IF;
  definition := replace(definition,'a.publishing_backend = ''native'' AND a.native_provider_account_id',
    'a.publishing_backend = ''native'' AND public.social_native_worker(p_worker_id) AND a.native_provider_account_id');
  definition := replace(definition,'WHERE j.status = ''reconciling''',
    'WHERE j.status = ''reconciling'' AND (public.social_native_worker(p_worker_id) OR EXISTS(SELECT 1 FROM public.social_accounts a WHERE a.id=j.account_id AND a.publishing_backend=''postiz''))');
  definition := replace(definition,'WHERE j.status = ''submitted''',
    'WHERE j.status = ''submitted'' AND (public.social_native_worker(p_worker_id) OR EXISTS(SELECT 1 FROM public.social_accounts a WHERE a.id=j.account_id AND a.publishing_backend=''postiz''))');
  EXECUTE definition;
END; $$;
