CREATE OR REPLACE FUNCTION public.social_native_platforms()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['facebook','instagram','linkedin-page','x','devto','hashnode',
    'threads','bluesky','mastodon','linkedin','reddit','pinterest','telegram',
    'discord','medium','farcaster','nostr','lemmy','slack','wordpress','listmonk',
    'vk','gmb','tumblr','dribbble','mewe','skool','whop','moltbook','kick',
    'twitch','tiktok','youtube','github','stackexchange']::text[];
$$;

-- Historical manual accounts retain their original mode and revisions.
ALTER TABLE public.social_accounts DROP CONSTRAINT social_accounts_manual_only_platforms;
ALTER TABLE public.social_accounts ADD CONSTRAINT social_accounts_manual_only_platforms
  CHECK(platform<>ALL(public.social_manual_only_platforms()) OR mode='manual' OR
    (publishing_backend='native' AND platform=ANY(ARRAY['youtube','github','stackexchange'])));
CREATE OR REPLACE FUNCTION public.social_guard_manual_only_platform()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.mode='auto' AND NEW.platform=ANY(public.social_manual_only_platforms()) AND
    NOT(NEW.publishing_backend='native' AND NEW.platform=ANY(ARRAY['youtube','github','stackexchange'])) THEN
    RAISE EXCEPTION 'SOCIAL_MANUAL_ONLY_PLATFORM' USING DETAIL=NEW.platform;
  END IF;
  RETURN NEW;
END; $$;
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_functiondef('public.social_native_connect(text,text,text,text,text,text,uuid,text,jsonb,timestamp with time zone,uuid,timestamp with time zone)'::regprocedure) INTO definition;
  IF position('AND p_platform <> ''youtube''' IN definition)=0 THEN RAISE EXCEPTION 'SOCIAL_NATIVE_API_BASELINE_CHANGED'; END IF;
  EXECUTE replace(definition,'AND p_platform <> ''youtube''', 'AND p_platform <> ALL(ARRAY[''youtube'',''github'',''stackexchange''])');
  SELECT pg_get_functiondef('public.social_admin_update_account(uuid,jsonb,uuid,timestamp with time zone)'::regprocedure) INTO definition;
  IF position('v_new.platform = ANY (public.social_manual_only_platforms())' IN definition)=0 THEN RAISE EXCEPTION 'SOCIAL_NATIVE_API_ACCOUNT_BASELINE_CHANGED'; END IF;
  EXECUTE replace(definition,'v_new.platform = ANY (public.social_manual_only_platforms())',
    'v_new.platform = ANY (public.social_manual_only_platforms()) AND NOT (v_new.publishing_backend=''native'' AND v_new.platform=ANY(ARRAY[''youtube'',''github'',''stackexchange'']))');
END; $$;
