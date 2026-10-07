-- ============================================================================
-- 0010: manual-only channels (amendment 05).
--
-- Adds quora, linkedin-article, tradingview, investing, indiehackers,
-- stackexchange, github, forum and press. None has a Postiz provider or an API
-- this app uses, so all nine are manual-only: their accounts are always manual
-- and their jobs never reach the worker.
--
-- Everything that lists platforms already calls the two functions below (the
-- platform checks of 0008, the manual-only constraint and trigger of 0009, and
-- social_admin_create_account), so replacing the functions is the whole change.
-- Nothing in 0001..0009 is edited.
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
    'moltbook', 'kick', 'twitch', 'tiktok', 'youtube',
    'quora', 'linkedin-article', 'tradingview', 'investing', 'indiehackers', 'stackexchange',
    'github', 'forum', 'press'
  ]::text[]
$$;

CREATE OR REPLACE FUNCTION public.social_manual_only_platforms()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'substack', 'producthunt', 'youtube',
    'quora', 'linkedin-article', 'tradingview', 'investing', 'indiehackers', 'stackexchange',
    'github', 'forum', 'press'
  ]::text[]
$$;

REVOKE ALL ON FUNCTION public.social_known_platforms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_known_platforms() TO service_role;
REVOKE ALL ON FUNCTION public.social_manual_only_platforms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_manual_only_platforms() TO service_role;
