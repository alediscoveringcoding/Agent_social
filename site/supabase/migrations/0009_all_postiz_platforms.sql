-- ============================================================================
-- 0009: every Postiz provider (amendment 04, second batch).
--
-- Adds slack, wordpress, listmonk, vk, gmb (Google Business), tumblr, dribbble,
-- mewe, skool, whop, moltbook, kick, twitch, tiktok and youtube, and the
-- `dribbble` card format (800x600, the size Dribbble shots must have).
--
-- YouTube is manual-only: its Postiz provider publishes video only, and this
-- app makes text and images. Its channel still syncs and shows, but the
-- account is always manual (the worker never gets its jobs). The manual-only
-- list moves into one function, and a trigger gives the friendly error
-- SOCIAL_MANUAL_ONLY_PLATFORM that social_admin_update_account (0005) raises
-- for Substack and Product Hunt, so that function needs no copy.
--
-- Aliases are not platforms: instagram-standalone is instagram,
-- mastodon-custom is mastodon, tiktok-business is tiktok, wrapcast is
-- farcaster (mapped in the site's PROVIDER_TO_PLATFORM).
-- Nothing in 0001..0008 is edited.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.social_known_platforms()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'facebook', 'instagram', 'linkedin-page', 'x', 'devto', 'hashnode', 'substack', 'producthunt',
    'threads', 'bluesky', 'mastodon', 'linkedin', 'reddit', 'pinterest', 'telegram', 'discord',
    'medium', 'farcaster', 'nostr', 'lemmy',
    'slack', 'wordpress', 'listmonk', 'vk', 'gmb', 'tumblr', 'dribbble', 'mewe', 'skool', 'whop',
    'moltbook', 'kick', 'twitch', 'tiktok', 'youtube'
  ]::text[]
$$;

-- The platforms whose account is always manual: no publishing API (Substack,
-- Product Hunt) or video only (YouTube).
CREATE OR REPLACE FUNCTION public.social_manual_only_platforms()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['substack', 'producthunt', 'youtube']::text[]
$$;

REVOKE ALL ON FUNCTION public.social_manual_only_platforms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_manual_only_platforms() TO service_role;

-- The platform checks of 0008 call social_known_platforms(), so they already
-- accept the new names. The card format check lists its values: widen it.
ALTER TABLE public.social_media DROP CONSTRAINT IF EXISTS social_media_format_allowed;
ALTER TABLE public.social_media
  ADD CONSTRAINT social_media_format_allowed
  CHECK (format IS NULL OR format IN
    ('square', 'portrait', 'x', 'devto_cover', 'hashnode_cover', 'ph_gallery', 'pinterest', 'dribbble'));

-- Manual-only accounts (0001 had the literal list).
ALTER TABLE public.social_accounts DROP CONSTRAINT IF EXISTS social_accounts_manual_only_platforms;
ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_manual_only_platforms
  CHECK (NOT (platform = ANY (public.social_manual_only_platforms())) OR mode = 'manual');

CREATE OR REPLACE FUNCTION public.social_guard_manual_only_platform()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.mode = 'auto' AND NEW.platform = ANY (public.social_manual_only_platforms()) THEN
    RAISE EXCEPTION 'SOCIAL_MANUAL_ONLY_PLATFORM' USING DETAIL = NEW.platform;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.social_guard_manual_only_platform() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_guard_manual_only_platform() TO service_role;

DROP TRIGGER IF EXISTS social_accounts_manual_only ON public.social_accounts;
CREATE TRIGGER social_accounts_manual_only
  BEFORE INSERT OR UPDATE OF mode, platform ON public.social_accounts
  FOR EACH ROW EXECUTE FUNCTION public.social_guard_manual_only_platform();
