-- ============================================================================
-- 0008: more platforms (amendment 04).
--
-- Adds threads, bluesky, mastodon, linkedin (personal profile), reddit,
-- pinterest, telegram, discord, medium, farcaster, nostr and lemmy, and the
-- `pinterest` card format (1000x1500).
--
-- Every new platform has a Postiz provider (v2.25.0), so none is manual-only:
-- Substack and Product Hunt stay the only platforms whose account must be
-- manual (the 0001 constraint social_accounts_manual_only_platforms and the
-- check in social_admin_update_account of 0005 are unchanged). Any account,
-- including a new platform's, can still be switched to manual mode.
--
-- The platform list lives in one IMMUTABLE function, so the next platform is a
-- one-function change. Nothing in 0001..0007 is edited; this file only
-- replaces what they created.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.social_known_platforms()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'facebook', 'instagram', 'linkedin-page', 'x', 'devto', 'hashnode', 'substack', 'producthunt',
    'threads', 'bluesky', 'mastodon', 'linkedin', 'reddit', 'pinterest', 'telegram', 'discord',
    'medium', 'farcaster', 'nostr', 'lemmy'
  ]::text[]
$$;

-- Like every social_* function: the browser roles get nothing (0001).
REVOKE ALL ON FUNCTION public.social_known_platforms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_known_platforms() TO service_role;

-- ---------------------------------------------------------------------------
-- 1. Widen the platform checks (accounts, destinations) and the card format
--    check (media). The old checks are found by what they test, so a
--    differently named constraint is replaced too.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'c'
       AND (
         (c.conrelid IN ('public.social_accounts'::regclass, 'public.social_destinations'::regclass)
          AND pg_get_constraintdef(c.oid) LIKE '%platform = ANY%')
         OR (c.conrelid = 'public.social_media'::regclass
             AND pg_get_constraintdef(c.oid) LIKE '%ph_gallery%')
       )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_platform_allowed
  CHECK (platform = ANY (public.social_known_platforms()));

ALTER TABLE public.social_destinations
  ADD CONSTRAINT social_destinations_platform_allowed
  CHECK (platform = ANY (public.social_known_platforms()));

ALTER TABLE public.social_media
  ADD CONSTRAINT social_media_format_allowed
  CHECK (format IS NULL OR format IN
    ('square', 'portrait', 'x', 'devto_cover', 'hashnode_cover', 'ph_gallery', 'pinterest'));

-- ---------------------------------------------------------------------------
-- 2. Manual-only accounts (0005): the same function, with the platform list
--    taken from social_known_platforms().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.social_admin_create_account(
  p_fields jsonb, p_actor uuid, p_now timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_platform text := p_fields->>'platform';
  v_brand uuid := nullif(p_fields->>'brand_id', '')::uuid;
  v_name text := btrim(coalesce(p_fields->>'display_name', ''));
  v_editor text := nullif(btrim(coalesce(p_fields->>'open_editor_url', '')), '');
  v_profile text := nullif(btrim(coalesce(p_fields->>'profile_url', '')), '');
  v_cap numeric := coalesce((p_fields->>'daily_cap')::numeric, 5);
  v_id uuid;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED';
  END IF;
  IF v_platform IS NULL OR NOT (v_platform = ANY (public.social_known_platforms())) THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PLATFORM';
  END IF;
  IF v_brand IS NULL OR NOT EXISTS (SELECT 1 FROM public.social_brands WHERE id = v_brand) THEN
    RAISE EXCEPTION 'SOCIAL_BRAND_NOT_FOUND';
  END IF;
  IF v_name = '' OR length(v_name) > 120 THEN
    RAISE EXCEPTION 'SOCIAL_NAME_REQUIRED';
  END IF;
  IF v_editor IS NOT NULL AND (v_editor !~* '^https?://[^[:space:]]+$' OR length(v_editor) > 2048) THEN
    RAISE EXCEPTION 'SOCIAL_BAD_URL' USING DETAIL = 'open_editor_url';
  END IF;
  IF v_profile IS NOT NULL AND (v_profile !~* '^https?://[^[:space:]]+$' OR length(v_profile) > 2048) THEN
    RAISE EXCEPTION 'SOCIAL_BAD_URL' USING DETAIL = 'profile_url';
  END IF;
  IF v_cap <> trunc(v_cap) OR v_cap < 1 OR v_cap > 5 THEN
    RAISE EXCEPTION 'SOCIAL_CAP_RANGE';
  END IF;

  INSERT INTO public.social_accounts
    (brand_id, platform, mode, status, postiz_integration_id, display_name, profile_url, open_editor_url,
     daily_cap, paused, created_at, updated_at)
  VALUES (v_brand, v_platform, 'manual', 'manual', NULL, v_name, v_profile, v_editor,
          v_cap::integer, false, p_now, p_now)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
