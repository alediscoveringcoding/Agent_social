-- ============================================================================
-- 0002: activity log for /admin/social (amendment 02).
--
-- The website's activity log is not available to this app, so admin actions
-- are recorded here: who, what, on which post / job / account, with details.
-- Insert-only: a log that can be edited is not a log. Service role only, like
-- every social_* table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.social_activity_log (
  id          bigserial   PRIMARY KEY,
  actor_id    uuid,
  actor_email text,
  action      text        NOT NULL,
  status      text        NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error')),
  post_id     uuid,
  job_id      uuid,
  account_id  uuid,
  details     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_activity_log_created ON public.social_activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_activity_log_post ON public.social_activity_log (post_id, created_at DESC);

ALTER TABLE public.social_activity_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.social_activity_log FROM anon, authenticated;
GRANT ALL ON TABLE public.social_activity_log TO service_role;
REVOKE ALL ON SEQUENCE public.social_activity_log_id_seq FROM anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.social_activity_log_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.social_guard_activity_log()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SOCIAL_ACTIVITY_LOG_INSERT_ONLY';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.social_guard_activity_log() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS social_activity_log_guard ON public.social_activity_log;
CREATE TRIGGER social_activity_log_guard
  BEFORE UPDATE OR DELETE ON public.social_activity_log
  FOR EACH ROW EXECUTE FUNCTION public.social_guard_activity_log();

COMMENT ON TABLE public.social_activity_log IS
  'Admin actions in /admin/social (0002). Insert-only; written by the server after requireAdmin().';
