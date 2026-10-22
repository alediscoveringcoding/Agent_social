-- Independent native platform connections. Existing Postiz rows and approvals
-- are retained. Every native state change and its activity entry are atomic.

ALTER TABLE public.social_accounts
  ADD COLUMN publishing_backend text NOT NULL DEFAULT 'postiz'
    CHECK (publishing_backend IN ('postiz', 'native')),
  ADD COLUMN native_provider_account_id text,
  ADD COLUMN native_instance_url text NOT NULL DEFAULT '';

ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_native_identity
    CHECK (publishing_backend <> 'native' OR
      (native_provider_account_id IS NOT NULL AND length(native_provider_account_id) BETWEEN 1 AND 512 AND postiz_integration_id IS NULL)),
  ADD CONSTRAINT social_accounts_native_unique UNIQUE (platform, native_instance_url, native_provider_account_id);

ALTER TABLE public.social_accounts DROP CONSTRAINT social_accounts_auto_needs_integration;
ALTER TABLE public.social_accounts ADD CONSTRAINT social_accounts_auto_needs_integration
  CHECK (mode = 'manual' OR postiz_integration_id IS NOT NULL OR
    (publishing_backend = 'native' AND native_provider_account_id IS NOT NULL));

CREATE TABLE public.social_native_credentials (
  account_id uuid PRIMARY KEY REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  encrypted text NOT NULL CHECK (length(encrypted) BETWEEN 40 AND 262144),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.social_native_oauth_attempts (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  brand_id uuid REFERENCES public.social_brands(id),
  encrypted text NOT NULL CHECK (length(encrypted) BETWEEN 40 AND 262144),
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_native_oauth_expiry ON public.social_native_oauth_attempts(expires_at);

CREATE OR REPLACE FUNCTION public.social_native_platforms()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['facebook','instagram','linkedin-page','x','devto','hashnode',
    'threads','bluesky','mastodon','linkedin','reddit','pinterest','telegram',
    'discord','medium','farcaster','nostr','lemmy','slack','wordpress','listmonk',
    'vk','gmb','tumblr','dribbble','mewe','skool','whop','moltbook','kick',
    'twitch','tiktok','youtube']::text[];
$$;

CREATE OR REPLACE FUNCTION public.social_native_connect(
  p_platform text, p_remote_id text, p_instance_url text, p_name text,
  p_profile_url text, p_picture_url text, p_brand uuid, p_encrypted text,
  p_metadata jsonb, p_expires_at timestamptz, p_actor uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_account uuid;
  v_existing public.social_accounts%ROWTYPE;
  v_instance text := coalesce(p_instance_url, '');
  v_manual boolean;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  IF p_platform IS NULL OR NOT (p_platform = ANY(public.social_native_platforms())) THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PLATFORM';
  END IF;
  IF p_remote_id IS NULL OR length(p_remote_id) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'SOCIAL_NATIVE_ID_REQUIRED';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'SOCIAL_NAME_REQUIRED';
  END IF;
  IF v_instance <> '' AND (v_instance !~ '^https://[^[:space:]]+$' OR length(v_instance) > 2048) THEN
    RAISE EXCEPTION 'SOCIAL_BAD_URL';
  END IF;
  IF (p_profile_url IS NOT NULL AND (p_profile_url !~ '^https://[^[:space:]]+$' OR length(p_profile_url) > 2048))
     OR (p_picture_url IS NOT NULL AND (p_picture_url !~ '^https://[^[:space:]]+$' OR length(p_picture_url) > 2048)) THEN
    RAISE EXCEPTION 'SOCIAL_BAD_URL';
  END IF;
  IF p_brand IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.social_brands WHERE id = p_brand) THEN
    RAISE EXCEPTION 'SOCIAL_BRAND_NOT_FOUND';
  END IF;
  IF p_encrypted IS NULL OR length(p_encrypted) NOT BETWEEN 40 AND 262144 THEN
    RAISE EXCEPTION 'SOCIAL_NATIVE_CREDENTIALS_REQUIRED';
  END IF;
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' OR octet_length(p_metadata::text) > 131072 THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PATCH';
  END IF;

  -- Serialize connections to the same identity, including before a row exists.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_platform || E'\n' || v_instance || E'\n' || p_remote_id, 0));
  SELECT * INTO v_existing FROM public.social_accounts
    WHERE platform = p_platform AND native_instance_url = v_instance
      AND native_provider_account_id = p_remote_id FOR UPDATE;
  IF FOUND THEN
    v_account := v_existing.id;
    -- Reconnecting never reassigns a brand or silently unpauses an account.
    UPDATE public.social_accounts SET display_name = btrim(p_name),
      profile_url = p_profile_url, picture_url = p_picture_url,
      status = CASE WHEN mode = 'manual' THEN 'manual' ELSE 'connected' END,
      last_synced_at = p_now, updated_at = p_now WHERE id = v_account;
  ELSE
    v_manual := p_platform = ANY(public.social_manual_only_platforms());
    INSERT INTO public.social_accounts (
      platform, publishing_backend, native_provider_account_id, native_instance_url,
      brand_id, display_name, profile_url, picture_url, mode, status, paused,
      last_synced_at, created_at, updated_at
    ) VALUES (
      p_platform, 'native', p_remote_id, v_instance, p_brand, btrim(p_name),
      p_profile_url, p_picture_url, CASE WHEN v_manual THEN 'manual' ELSE 'auto' END,
      CASE WHEN v_manual THEN 'manual' ELSE 'connected' END, true, p_now, p_now, p_now
    ) RETURNING id INTO v_account;
  END IF;

  INSERT INTO public.social_native_credentials(account_id, encrypted, metadata, expires_at, connected_by, updated_at)
  VALUES (v_account, p_encrypted, p_metadata, p_expires_at, p_actor, p_now)
  ON CONFLICT (account_id) DO UPDATE SET encrypted = excluded.encrypted,
    metadata = excluded.metadata, expires_at = excluded.expires_at,
    version = social_native_credentials.version + 1, connected_by = p_actor, updated_at = p_now;
  INSERT INTO public.social_activity_log(actor_id, action, account_id, details, created_at)
    VALUES (p_actor, 'social.native_connected', v_account, jsonb_build_object('platform', p_platform), p_now);
  RETURN v_account;
END;
$$;

CREATE OR REPLACE FUNCTION public.social_native_rotate_credentials(
  p_account uuid, p_version integer, p_encrypted text, p_expires_at timestamptz,
  p_actor uuid, p_worker_id text, p_now timestamptz DEFAULT now()
)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_changed integer;
BEGIN
  IF p_actor IS NULL AND coalesce(p_worker_id, '') = '' THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  IF p_encrypted IS NULL OR length(p_encrypted) NOT BETWEEN 40 AND 262144 THEN
    RAISE EXCEPTION 'SOCIAL_NATIVE_CREDENTIALS_REQUIRED';
  END IF;
  -- Disconnect and reconnect hold the account row before changing credentials.
  PERFORM 1 FROM public.social_accounts WHERE id = p_account AND publishing_backend = 'native' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND'; END IF;
  UPDATE public.social_native_credentials SET encrypted = p_encrypted,
    expires_at = p_expires_at, version = version + 1, updated_at = p_now
    WHERE account_id = p_account AND version = p_version;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed = 0 THEN RETURN false; END IF;
  INSERT INTO public.social_activity_log(actor_id, action, account_id, details, created_at)
    VALUES (p_actor, 'social.native_credentials_rotated', p_account,
      jsonb_build_object('version', p_version + 1, 'worker_id', p_worker_id), p_now);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.social_native_disconnect(
  p_account uuid, p_actor uuid, p_now timestamptz DEFAULT now()
)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_mode text; v_removed integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  SELECT mode INTO v_mode FROM public.social_accounts
    WHERE id = p_account AND publishing_backend = 'native' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND'; END IF;
  DELETE FROM public.social_native_credentials WHERE account_id = p_account;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  IF v_removed = 0 THEN RETURN false; END IF;
  UPDATE public.social_accounts SET paused = true,
    status = CASE WHEN v_mode = 'manual' THEN 'manual' ELSE 'reconnect_required' END,
    updated_at = p_now WHERE id = p_account;
  INSERT INTO public.social_activity_log(actor_id, action, account_id, created_at)
    VALUES (p_actor, 'social.native_disconnected', p_account, p_now);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.social_native_oauth_begin(
  p_id uuid, p_state_hash text, p_browser_hash text, p_actor uuid, p_platform text,
  p_brand uuid, p_encrypted text, p_redirect_uri text,
  p_now timestamptz DEFAULT now()
)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  IF p_platform IS NULL OR NOT (p_platform = ANY(public.social_native_platforms())) THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PLATFORM';
  END IF;
  IF p_redirect_uri IS NULL OR p_redirect_uri !~ '^https?://[^[:space:]]+$' OR length(p_redirect_uri) > 2048 THEN
    RAISE EXCEPTION 'SOCIAL_BAD_URL';
  END IF;
  INSERT INTO public.social_native_oauth_attempts(
    id, state_hash, browser_hash, actor_id, platform, brand_id, encrypted, redirect_uri, expires_at, created_at
  ) VALUES (p_id, p_state_hash, p_browser_hash, p_actor, p_platform, p_brand,
    p_encrypted, p_redirect_uri, p_now + interval '10 minutes', p_now);
  INSERT INTO public.social_activity_log(actor_id, action, details, created_at)
    VALUES (p_actor, 'social.native_oauth_started', jsonb_build_object('platform', p_platform), p_now);
  RETURN p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.social_native_oauth_consume(
  p_state_hash text, p_browser_hash text, p_actor uuid, p_now timestamptz DEFAULT now()
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_attempt public.social_native_oauth_attempts%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  SELECT * INTO v_attempt FROM public.social_native_oauth_attempts
    WHERE state_hash = p_state_hash AND actor_id = p_actor
      AND browser_hash = p_browser_hash AND consumed_at IS NULL AND expires_at > p_now FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOCIAL_NATIVE_OAUTH_EXPIRED'; END IF;
  UPDATE public.social_native_oauth_attempts SET consumed_at = p_now WHERE id = v_attempt.id;
  INSERT INTO public.social_activity_log(actor_id, action, details, created_at)
    VALUES (p_actor, 'social.native_oauth_consumed', jsonb_build_object('platform', v_attempt.platform), p_now);
  RETURN jsonb_build_object('id', v_attempt.id, 'platform', v_attempt.platform,
    'brand_id', v_attempt.brand_id, 'encrypted', v_attempt.encrypted, 'redirect_uri', v_attempt.redirect_uri);
END;
$$;

-- Preserve the latest deployed account/claim functions, changing only their
-- integration-eligibility predicates. Abort if the expected definitions differ.
DO $$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.social_claim_deliveries(text,integer,boolean,timestamp with time zone)'::regprocedure)
    INTO v_definition;
  IF position('AND a.postiz_integration_id IS NOT NULL' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'SOCIAL_NATIVE_CLAIM_BASELINE_CHANGED';
  END IF;
  EXECUTE replace(v_definition, 'AND a.postiz_integration_id IS NOT NULL',
    'AND (a.postiz_integration_id IS NOT NULL OR (a.publishing_backend = ''native'' AND a.native_provider_account_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.social_native_credentials nc WHERE nc.account_id = a.id)))');
  SELECT pg_get_functiondef('public.social_admin_update_account(uuid,jsonb,uuid,timestamp with time zone)'::regprocedure)
    INTO v_definition;
  IF position('v_new.mode = ''auto'' AND v_new.postiz_integration_id IS NULL' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'SOCIAL_NATIVE_ACCOUNT_BASELINE_CHANGED';
  END IF;
  EXECUTE replace(v_definition, 'v_new.mode = ''auto'' AND v_new.postiz_integration_id IS NULL',
    'v_new.mode = ''auto'' AND v_new.postiz_integration_id IS NULL AND NOT (v_new.publishing_backend = ''native'' AND v_new.native_provider_account_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.social_native_credentials nc WHERE nc.account_id = v_new.id))');
END;
$$;

ALTER TABLE public.social_native_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_native_oauth_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_native_credentials, public.social_native_oauth_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.social_native_credentials, public.social_native_oauth_attempts TO service_role;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'social_native_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.signature);
  END LOOP;
END;
$$;
