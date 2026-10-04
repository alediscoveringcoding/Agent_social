-- ============================================================================
-- 0001: social publishing (/admin/social). PRD "Social publishing for Taxes
-- Support", section 10 (contracts), with amendments 01 (localhost MVP) and
-- 02 (standalone site with its own Supabase project).
--
-- What lives here:
--   * every table of PRD 10.1 except analytics (phase 2);
--   * RLS ON with NO policies, and no table rights for anon/authenticated:
--     only server code with the service role reads or writes these tables;
--   * guard triggers: a revision that was ever approved is frozen (its
--     destinations and their media can be neither changed nor deleted), and a
--     destination's content is insert-only (an edit is a new revision);
--   * the delivery state machine of PRD 10.2 as functions, so each transition
--     is one transaction under a row lock: claim (FOR UPDATE SKIP LOCKED,
--     10 minute leases, daily cap, 2 hour stale window, kill switch, kinds
--     publish / poll / reconcile), heartbeat, submitting, submitted, result,
--     and the sweeper that applies the lease-expiry rules;
--   * approve / save revision / cancel / retry / mark-manual-done as functions,
--     so approval and job creation happen in the same transaction (F5);
--   * the private `social-media` Storage bucket (images, 8 MiB);
--   * seed rows for the three brands.
--
-- Times are timestamptz (UTC); the daily cap is counted per Europe/Bucharest
-- calendar day, which Postgres computes with the tz database (DST included).
--
-- The first migration of this app's own database; `supabase db reset`
-- rebuilds it, seeds included. Only outside reference: auth.users (Supabase).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.social_brands (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name       text        NOT NULL,
  logo_path  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.social_accounts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id              uuid        REFERENCES public.social_brands(id) ON DELETE SET NULL,
  platform              text        NOT NULL CHECK (platform IN
                          ('facebook', 'instagram', 'linkedin-page', 'x', 'devto', 'hashnode', 'substack', 'producthunt')),
  mode                  text        NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'manual')),
  status                text        NOT NULL DEFAULT 'connected' CHECK (status IN
                          ('connected', 'reconnect_required', 'developer_setup_required', 'approval_pending', 'manual')),
  -- Plain UNIQUE (NULLs allowed many times): manual accounts have none.
  postiz_integration_id text        UNIQUE,
  postiz_provider       text,
  postiz_disabled       boolean     NOT NULL DEFAULT false,
  display_name          text        NOT NULL,
  picture_url           text,
  profile_url           text,
  open_editor_url       text,
  daily_cap             integer     NOT NULL DEFAULT 5 CHECK (daily_cap BETWEEN 1 AND 5),
  paused                boolean     NOT NULL DEFAULT false,
  rules                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Automatic publishing goes through a Postiz channel; without one an
  -- account can only be manual.
  CONSTRAINT social_accounts_auto_needs_integration
    CHECK (mode = 'manual' OR postiz_integration_id IS NOT NULL),
  -- No publishing API for these two (PRD section 5).
  CONSTRAINT social_accounts_manual_only_platforms
    CHECK (platform NOT IN ('substack', 'producthunt') OR mode = 'manual')
);

CREATE TABLE IF NOT EXISTS public.social_media (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text        NOT NULL DEFAULT 'image' CHECK (kind = 'image'),
  source       text        NOT NULL CHECK (source IN ('generated', 'upload')),
  storage_path text        NOT NULL UNIQUE,
  mime         text        NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  width        integer     NOT NULL CHECK (width > 0),
  height       integer     NOT NULL CHECK (height > 0),
  bytes        bigint      NOT NULL CHECK (bytes > 0 AND bytes <= 8388608),
  sha256       text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The suggested alt text. What is published is the per-attachment copy in
  -- social_destination_media.alt_text, which is frozen with its revision.
  alt_text     text        NOT NULL DEFAULT '',
  card_spec    jsonb,
  format       text        CHECK (format IS NULL OR format IN
                 ('square', 'portrait', 'x', 'devto_cover', 'hashnode_cover', 'ph_gallery')),
  brand_id     uuid        REFERENCES public.social_brands(id) ON DELETE SET NULL,
  created_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.social_generation_requests (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         uuid        NOT NULL REFERENCES public.social_brands(id),
  input            jsonb       NOT NULL,
  status           text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  requested_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  -- n8n idempotency key (automation API, deferred in the MVP). NULL for UI requests.
  workflow         text,
  event_id         text,
  lease_owner      text,
  lease_expires_at timestamptz,
  attempts         integer     NOT NULL DEFAULT 0,
  error_code       text,
  error_message    text,
  drafts_created   integer     NOT NULL DEFAULT 0,
  drafts_skipped   integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CONSTRAINT social_generation_requests_workflow_event UNIQUE (workflow, event_id),
  CONSTRAINT social_generation_requests_workflow_pair CHECK ((workflow IS NULL) = (event_id IS NULL))
);

CREATE TABLE IF NOT EXISTS public.social_posts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id              uuid        NOT NULL REFERENCES public.social_brands(id),
  kind                  text        NOT NULL DEFAULT 'social' CHECK (kind IN ('social', 'article', 'launch')),
  title                 text,
  source_url            text,
  generation_request_id uuid        REFERENCES public.social_generation_requests(id) ON DELETE SET NULL,
  -- request id + ':' + client_ref. Plain UNIQUE, so re-delivered drafts are
  -- skipped by ON CONFLICT and never duplicated.
  generation_ref        text        UNIQUE,
  status                text        NOT NULL DEFAULT 'draft' CHECK (status IN
                          ('draft', 'approved', 'publishing', 'published', 'partial', 'failed', 'cancelled')),
  current_revision_id   uuid,
  cancelled_at          timestamptz,
  cancelled_by          uuid,
  created_by            uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.social_post_revisions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id          uuid        NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  number           integer     NOT NULL CHECK (number >= 1),
  canonical_text   text        NOT NULL DEFAULT '',
  body_markdown    text,
  article          jsonb,
  launch           jsonb,
  card_spec        jsonb,
  -- The draft's figure list [{value, context, source}] (PRD 10.5).
  figures          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Generator variants as delivered, including platforms with no account yet.
  variants         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  notes            text,
  generator_errors jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_post_revisions_number UNIQUE (post_id, number)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_posts_current_revision_fk') THEN
    ALTER TABLE public.social_posts
      ADD CONSTRAINT social_posts_current_revision_fk
      FOREIGN KEY (current_revision_id) REFERENCES public.social_post_revisions(id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.social_destinations (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id      uuid        NOT NULL REFERENCES public.social_post_revisions(id) ON DELETE CASCADE,
  account_id       uuid        NOT NULL REFERENCES public.social_accounts(id),
  platform         text        NOT NULL CHECK (platform IN
                     ('facebook', 'instagram', 'linkedin-page', 'x', 'devto', 'hashnode', 'substack', 'producthunt')),
  text             text        NOT NULL DEFAULT '',
  settings         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  scheduled_at     timestamptz,
  scheduled_tz     text        NOT NULL DEFAULT 'Europe/Bucharest',
  contains_figures boolean     NOT NULL DEFAULT false,
  figures          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  validation       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  destination_hash text        CHECK (destination_hash IS NULL OR destination_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_destinations_one_per_account UNIQUE (revision_id, account_id)
);

CREATE TABLE IF NOT EXISTS public.social_destination_media (
  destination_id uuid    NOT NULL REFERENCES public.social_destinations(id) ON DELETE CASCADE,
  media_id       uuid    NOT NULL REFERENCES public.social_media(id) ON DELETE RESTRICT,
  position       integer NOT NULL CHECK (position >= 0),
  alt_text       text    NOT NULL DEFAULT '',
  PRIMARY KEY (destination_id, position)
);

CREATE TABLE IF NOT EXISTS public.social_approvals (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id       uuid        NOT NULL REFERENCES public.social_post_revisions(id) ON DELETE RESTRICT,
  -- No FK: an approval is an audit record and outlives the account that gave it.
  approved_by       uuid        NOT NULL,
  approved_by_email text,
  approved_at       timestamptz NOT NULL DEFAULT now(),
  approval_hash     text        NOT NULL CHECK (approval_hash ~ '^[0-9a-f]{64}$'),
  figures_checked   boolean     NOT NULL DEFAULT false,
  revoked_at        timestamptz,
  revoked_reason    text
);

-- One ACTIVE approval per revision. Partial on purpose; never an upsert target.
CREATE UNIQUE INDEX IF NOT EXISTS social_approvals_one_active
  ON public.social_approvals (revision_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.social_delivery_jobs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id     uuid        NOT NULL UNIQUE REFERENCES public.social_destinations(id) ON DELETE RESTRICT,
  -- Copied from the destination: the claim and the cap count by account.
  account_id         uuid        NOT NULL REFERENCES public.social_accounts(id),
  status             text        NOT NULL CHECK (status IN
                       ('queued', 'claimed', 'submitting', 'submitted', 'reconciling', 'published',
                        'failed', 'cancelled', 'manual_pending', 'manual_done')),
  -- The approved slot. Never moves: a later time is a new revision.
  run_at             timestamptz NOT NULL,
  stale_after        interval    NOT NULL DEFAULT interval '2 hours',
  -- Backoff after a retryable failure; the claim waits for it.
  next_attempt_at    timestamptz,
  attempts           integer     NOT NULL DEFAULT 0,
  lease_owner        text,
  lease_expires_at   timestamptz,
  lease_kind         text        CHECK (lease_kind IS NULL OR lease_kind IN ('publish', 'poll', 'reconcile')),
  -- Pacing of poll / reconcile claims.
  next_check_at      timestamptz,
  reconcile_misses   integer     NOT NULL DEFAULT 0,
  postiz_post_id     text,
  postiz_group       text,
  remote_url         text,
  published_at       timestamptz,
  last_error_code    text,
  last_error_message text,
  manual_notified_at timestamptz,
  manual_done_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  manual_done_at     timestamptz,
  cancelled_at       timestamptz,
  cancelled_by       uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_jobs_status_run_at ON public.social_delivery_jobs (status, run_at);
CREATE INDEX IF NOT EXISTS idx_social_jobs_account_run_at ON public.social_delivery_jobs (account_id, run_at);
CREATE INDEX IF NOT EXISTS idx_social_jobs_postiz_post ON public.social_delivery_jobs (postiz_post_id);

CREATE TABLE IF NOT EXISTS public.social_publish_attempts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid        NOT NULL REFERENCES public.social_delivery_jobs(id) ON DELETE CASCADE,
  attempt_no    integer     NOT NULL CHECK (attempt_no >= 1),
  worker_id     text        NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  submitting_at timestamptz,
  finished_at   timestamptz,
  outcome       text,
  error_code    text,
  http_status   integer,
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT social_publish_attempts_job_attempt UNIQUE (job_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS public.social_events (
  id         bigserial   PRIMARY KEY,
  type       text        NOT NULL CHECK (type IN
               ('delivery_failed', 'delivery_stale', 'account_reconnect_required', 'manual_due',
                'drafts_ready', 'generation_failed', 'foreign_post', 'worker_silent')),
  payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- "Mark as seen" on the Overview (amendment A10).
  seen_at    timestamptz,
  seen_by    uuid
);

CREATE INDEX IF NOT EXISTS idx_social_events_unseen ON public.social_events (id) WHERE seen_at IS NULL;

CREATE TABLE IF NOT EXISTS public.social_automation_runs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow   text        NOT NULL,
  event_id   text        NOT NULL,
  status     text        NOT NULL,
  details    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_automation_runs_workflow_event UNIQUE (workflow, event_id)
);

CREATE TABLE IF NOT EXISTS public.social_workers (
  worker_id            text        PRIMARY KEY,
  version              text,
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_account_sync_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. Access: service role only
-- ---------------------------------------------------------------------------
-- RLS on, no policies. On top of that the browser roles get no table rights at
-- all: Supabase grants anon/authenticated everything on a new table by default,
-- and revoking it makes these tables invisible to the anon key rather than
-- merely empty.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'social_brands', 'social_accounts', 'social_media', 'social_generation_requests',
    'social_posts', 'social_post_revisions', 'social_destinations', 'social_destination_media',
    'social_approvals', 'social_delivery_jobs', 'social_publish_attempts', 'social_events',
    'social_automation_runs', 'social_workers'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

REVOKE ALL ON SEQUENCE public.social_events_id_seq FROM anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.social_events_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Guards: approved revisions are frozen, destination content is insert-only
-- ---------------------------------------------------------------------------

-- "Was this revision ever approved?" A revoked approval still freezes it: the
-- record of what was approved must not change after the fact.
CREATE OR REPLACE FUNCTION public.social_revision_frozen(p_revision uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM public.social_approvals a WHERE a.revision_id = p_revision)
$$;

CREATE OR REPLACE FUNCTION public.social_guard_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.social_revision_frozen(OLD.id) THEN
    RAISE EXCEPTION 'SOCIAL_REVISION_FROZEN'
      USING DETAIL = format('revision %s was approved and cannot be changed or deleted', OLD.id);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS social_post_revisions_guard ON public.social_post_revisions;
CREATE TRIGGER social_post_revisions_guard
  BEFORE UPDATE OR DELETE ON public.social_post_revisions
  FOR EACH ROW EXECUTE FUNCTION public.social_guard_revision();

CREATE OR REPLACE FUNCTION public.social_guard_destination()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_platform text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.social_revision_frozen(NEW.revision_id) THEN
      RAISE EXCEPTION 'SOCIAL_REVISION_FROZEN'
        USING DETAIL = format('revision %s was approved; add destinations to a new revision', NEW.revision_id);
    END IF;
    SELECT a.platform INTO v_platform FROM public.social_accounts a WHERE a.id = NEW.account_id;
    IF v_platform IS DISTINCT FROM NEW.platform THEN
      RAISE EXCEPTION 'SOCIAL_PLATFORM_MISMATCH'
        USING DETAIL = format('destination platform %s, account platform %s', NEW.platform, v_platform);
    END IF;
    RETURN NEW;
  END IF;

  IF public.social_revision_frozen(OLD.revision_id) THEN
    RAISE EXCEPTION 'SOCIAL_REVISION_FROZEN'
      USING DETAIL = format('destination %s belongs to an approved revision', OLD.id);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Content is written once. Saving an edit inserts a new revision (F4);
    -- only the derived columns are filled in later, by the approval itself.
    IF NEW.revision_id IS DISTINCT FROM OLD.revision_id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.platform IS DISTINCT FROM OLD.platform
       OR NEW.text IS DISTINCT FROM OLD.text
       OR NEW.settings IS DISTINCT FROM OLD.settings
       OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
       OR NEW.scheduled_tz IS DISTINCT FROM OLD.scheduled_tz
       OR NEW.figures IS DISTINCT FROM OLD.figures THEN
      RAISE EXCEPTION 'SOCIAL_DESTINATION_IMMUTABLE'
        USING DETAIL = 'destination content is insert-only; save a new revision instead';
    END IF;
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS social_destinations_guard ON public.social_destinations;
CREATE TRIGGER social_destinations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.social_destinations
  FOR EACH ROW EXECUTE FUNCTION public.social_guard_destination();

CREATE OR REPLACE FUNCTION public.social_guard_destination_media()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_destination uuid;
  v_revision uuid;
BEGIN
  v_destination := CASE WHEN TG_OP = 'DELETE' THEN OLD.destination_id ELSE NEW.destination_id END;
  SELECT d.revision_id INTO v_revision FROM public.social_destinations d WHERE d.id = v_destination;
  -- A cascade from a deleted destination finds no row: the destination guard
  -- already decided.
  IF v_revision IS NOT NULL AND public.social_revision_frozen(v_revision) THEN
    RAISE EXCEPTION 'SOCIAL_REVISION_FROZEN'
      USING DETAIL = format('media of destination %s belong to an approved revision', v_destination);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.destination_id IS DISTINCT FROM NEW.destination_id THEN
    SELECT d.revision_id INTO v_revision FROM public.social_destinations d WHERE d.id = OLD.destination_id;
    IF v_revision IS NOT NULL AND public.social_revision_frozen(v_revision) THEN
      RAISE EXCEPTION 'SOCIAL_REVISION_FROZEN';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS social_destination_media_guard ON public.social_destination_media;
CREATE TRIGGER social_destination_media_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.social_destination_media
  FOR EACH ROW EXECUTE FUNCTION public.social_guard_destination_media();

-- The bytes a hash was computed over must never change under it.
CREATE OR REPLACE FUNCTION public.social_guard_media()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.mime IS DISTINCT FROM OLD.mime
     OR NEW.width IS DISTINCT FROM OLD.width
     OR NEW.height IS DISTINCT FROM OLD.height
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'SOCIAL_MEDIA_IMMUTABLE'
      USING DETAIL = 'only alt_text of a media row can change; upload a new image instead';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS social_media_guard ON public.social_media;
CREATE TRIGGER social_media_guard
  BEFORE UPDATE ON public.social_media
  FOR EACH ROW EXECUTE FUNCTION public.social_guard_media();

-- An approval is never deleted and never rewritten; it can only be revoked once.
CREATE OR REPLACE FUNCTION public.social_guard_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SOCIAL_APPROVAL_IMMUTABLE' USING DETAIL = 'approvals are never deleted; revoke instead';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_by_email IS DISTINCT FROM OLD.approved_by_email
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approval_hash IS DISTINCT FROM OLD.approval_hash
     OR NEW.figures_checked IS DISTINCT FROM OLD.figures_checked
     OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_APPROVAL_IMMUTABLE' USING DETAIL = 'only an unrevoked approval can be revoked, once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS social_approvals_guard ON public.social_approvals;
CREATE TRIGGER social_approvals_guard
  BEFORE UPDATE OR DELETE ON public.social_approvals
  FOR EACH ROW EXECUTE FUNCTION public.social_guard_approval();

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.social_emit(p_type text, p_payload jsonb, p_now timestamptz DEFAULT now())
RETURNS bigint
LANGUAGE sql
AS $$
  INSERT INTO public.social_events (type, payload, created_at)
  VALUES (p_type, coalesce(p_payload, '{}'::jsonb), p_now)
  RETURNING id
$$;

-- The Bucharest calendar day of an instant.
CREATE OR REPLACE FUNCTION public.social_bucharest_day(p_ts timestamptz)
RETURNS date
LANGUAGE sql STABLE
AS $$
  SELECT (p_ts AT TIME ZONE 'Europe/Bucharest')::date
$$;

-- PRD 5 "Daily cap": destinations approved and scheduled that Bucharest day,
-- plus those already published that day. Manual destinations count too.
-- The day runs from local midnight to local midnight, so it is 23 or 25 hours
-- long across a DST change.
CREATE OR REPLACE FUNCTION public.social_cap_usage(p_account uuid, p_day date, p_exclude_job uuid DEFAULT NULL)
RETURNS integer
LANGUAGE sql STABLE
AS $$
  SELECT count(*)::integer
  FROM public.social_delivery_jobs j
  WHERE j.account_id = p_account
    AND j.run_at >= (p_day::timestamp AT TIME ZONE 'Europe/Bucharest')
    AND j.run_at <  ((p_day + 1)::timestamp AT TIME ZONE 'Europe/Bucharest')
    AND j.status IN ('queued', 'claimed', 'submitting', 'submitted', 'reconciling',
                     'published', 'manual_pending', 'manual_done')
    AND (p_exclude_job IS NULL OR j.id <> p_exclude_job)
$$;

CREATE OR REPLACE FUNCTION public.social_job_context(p_job uuid)
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT jsonb_build_object(
    'job_id', j.id,
    'post_id', r.post_id,
    'revision_id', d.revision_id,
    'destination_id', d.id,
    'account_id', j.account_id,
    'account', a.display_name,
    'platform', d.platform,
    'run_at', j.run_at,
    'status', j.status,
    'error_code', j.last_error_code,
    'error_message', j.last_error_message
  )
  FROM public.social_delivery_jobs j
  JOIN public.social_destinations d ON d.id = j.destination_id
  JOIN public.social_post_revisions r ON r.id = d.revision_id
  JOIN public.social_accounts a ON a.id = j.account_id
  WHERE j.id = p_job
$$;

CREATE OR REPLACE FUNCTION public.social_job_post(p_job uuid)
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT r.post_id
  FROM public.social_delivery_jobs j
  JOIN public.social_destinations d ON d.id = j.destination_id
  JOIN public.social_post_revisions r ON r.id = d.revision_id
  WHERE j.id = p_job
$$;

-- PRD 10.2: the post status is derived from its current revision's jobs and
-- stored for listing.
CREATE OR REPLACE FUNCTION public.social_refresh_post_status(p_post uuid, p_now timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_post public.social_posts%ROWTYPE;
  v_status text;
  n_total integer;
  n_cancelled integer;
  n_waiting integer;
  n_inflight integer;
  n_done integer;
  n_failed integer;
BEGIN
  SELECT * INTO v_post FROM public.social_posts WHERE id = p_post;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_post.cancelled_at IS NOT NULL THEN
    v_status := 'cancelled';
  ELSIF v_post.current_revision_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.social_approvals a
                     WHERE a.revision_id = v_post.current_revision_id AND a.revoked_at IS NULL) THEN
    v_status := 'draft';
  ELSE
    SELECT count(*),
           count(*) FILTER (WHERE j.status = 'cancelled'),
           count(*) FILTER (WHERE j.status IN ('queued', 'manual_pending')),
           count(*) FILTER (WHERE j.status IN ('claimed', 'submitting', 'submitted', 'reconciling')),
           count(*) FILTER (WHERE j.status IN ('published', 'manual_done')),
           count(*) FILTER (WHERE j.status = 'failed')
      INTO n_total, n_cancelled, n_waiting, n_inflight, n_done, n_failed
      FROM public.social_delivery_jobs j
      JOIN public.social_destinations d ON d.id = j.destination_id
     WHERE d.revision_id = v_post.current_revision_id;

    IF n_total = 0 OR n_total = n_cancelled THEN
      v_status := 'cancelled';
    ELSIF n_inflight > 0 OR (n_waiting > 0 AND (n_done + n_failed) > 0) THEN
      v_status := 'publishing';
    ELSIF n_waiting > 0 THEN
      v_status := 'approved';
    ELSIF n_failed = 0 THEN
      v_status := 'published';
    ELSIF n_done = 0 THEN
      v_status := 'failed';
    ELSE
      v_status := 'partial';
    END IF;
  END IF;

  IF v_status IS DISTINCT FROM v_post.status THEN
    UPDATE public.social_posts SET status = v_status, updated_at = p_now WHERE id = p_post;
  END IF;
  RETURN v_status;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Sweeper: lease expiry, stale window, manual due, worker silence
-- ---------------------------------------------------------------------------
-- Runs at the start of every claim and when the Overview loads. Idempotent.

CREATE OR REPLACE FUNCTION public.social_sweep(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v_requeued integer := 0;
  v_reconciling integer := 0;
  v_stale integer := 0;
  v_manual integer := 0;
  v_gen_requeued integer := 0;
  v_gen_failed integer := 0;
  v_last_seen timestamptz;
  v_silent boolean := false;
BEGIN
  -- claimed + lease expired -> queued: Postiz was never called (the worker
  -- never reached /submitting).
  FOR r IN
    SELECT j.id, j.attempts FROM public.social_delivery_jobs j
     WHERE j.status = 'claimed' AND j.lease_expires_at <= p_now
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.social_delivery_jobs
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = r.id;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'lease_expired'
     WHERE job_id = r.id AND attempt_no = r.attempts AND finished_at IS NULL;
    v_requeued := v_requeued + 1;
  END LOOP;

  -- submitting + lease expired -> reconciling: the create call may or may not
  -- have reached Postiz, so it is never simply queued again.
  FOR r IN
    SELECT j.id, j.attempts FROM public.social_delivery_jobs j
     WHERE j.status = 'submitting' AND j.lease_expires_at <= p_now
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.social_delivery_jobs
       SET status = 'reconciling', lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL,
           next_check_at = p_now, last_error_code = 'UNKNOWN_RESULT',
           last_error_message = 'Lease expired after /submitting', updated_at = p_now
     WHERE id = r.id;
    UPDATE public.social_publish_attempts
       SET outcome = 'reconciling', error_code = 'UNKNOWN_RESULT'
     WHERE job_id = r.id AND attempt_no = r.attempts AND finished_at IS NULL;
    v_reconciling := v_reconciling + 1;
  END LOOP;

  -- queued past slot + stale window -> failed STALE. A "deadline today" post
  -- must not go out days late (PRD 6.4).
  FOR r IN
    SELECT j.id FROM public.social_delivery_jobs j
     WHERE j.status = 'queued' AND j.run_at + j.stale_after <= p_now
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.social_delivery_jobs
       SET status = 'failed', last_error_code = 'STALE',
           last_error_message = 'Slot plus stale window passed before the job could be published',
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = r.id;
    PERFORM public.social_emit('delivery_stale', public.social_job_context(r.id), p_now);
    PERFORM public.social_refresh_post_status(public.social_job_post(r.id), p_now);
    v_stale := v_stale + 1;
  END LOOP;

  -- Manual destinations notify once, at their slot.
  FOR r IN
    SELECT j.id FROM public.social_delivery_jobs j
     WHERE j.status = 'manual_pending' AND j.run_at <= p_now AND j.manual_notified_at IS NULL
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.social_delivery_jobs SET manual_notified_at = p_now, updated_at = p_now WHERE id = r.id;
    PERFORM public.social_emit('manual_due', public.social_job_context(r.id), p_now);
    v_manual := v_manual + 1;
  END LOOP;

  -- Generation: an expired lease goes back to queued, at most 3 attempts.
  FOR r IN
    SELECT g.id, g.attempts, g.brand_id FROM public.social_generation_requests g
     WHERE g.status = 'running' AND g.lease_expires_at <= p_now
     FOR UPDATE SKIP LOCKED
  LOOP
    IF r.attempts >= 3 THEN
      UPDATE public.social_generation_requests
         SET status = 'failed', error_code = 'LEASE_EXPIRED',
             error_message = 'Lease expired three times', lease_owner = NULL, lease_expires_at = NULL,
             finished_at = p_now, updated_at = p_now
       WHERE id = r.id;
      PERFORM public.social_emit('generation_failed',
        jsonb_build_object('request_id', r.id, 'brand_id', r.brand_id, 'error_code', 'LEASE_EXPIRED'), p_now);
      v_gen_failed := v_gen_failed + 1;
    ELSE
      UPDATE public.social_generation_requests
         SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = p_now
       WHERE id = r.id;
      v_gen_requeued := v_gen_requeued + 1;
    END IF;
  END LOOP;

  -- worker_silent once per silence: no worker call for 10 minutes (NFR
  -- observability). Only meaningful once a worker has ever been seen.
  SELECT max(w.last_seen_at) INTO v_last_seen FROM public.social_workers w;
  IF v_last_seen IS NOT NULL AND v_last_seen < p_now - interval '10 minutes'
     AND NOT EXISTS (SELECT 1 FROM public.social_events e
                      WHERE e.type = 'worker_silent' AND e.created_at >= v_last_seen) THEN
    PERFORM public.social_emit('worker_silent', jsonb_build_object('last_seen_at', v_last_seen), p_now);
    v_silent := true;
  END IF;

  RETURN jsonb_build_object(
    'requeued', v_requeued, 'reconciling', v_reconciling, 'stale', v_stale,
    'manual_due', v_manual, 'generation_requeued', v_gen_requeued,
    'generation_failed', v_gen_failed, 'worker_silent', v_silent);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Delivery claim (PRD 10.3 POST /deliveries/claim)
-- ---------------------------------------------------------------------------
-- Returns {"jobs": [{job_id, kind, attempt_no, lease_expires_at}]}; the route
-- builds the payload (it needs Storage to sign media URLs).
--
--   publish   : queued, due, inside the stale window, account auto + connected
--               + not paused, revision approval still active, cap respected.
--               -> claimed, attempts + 1, a new publish attempt row.
--   reconcile : reconciling, due for a check.
--   poll      : submitted, due for a check.
-- Poll and reconcile do not change the status or the attempt number. Their
-- lease is 10 minutes like any other, but the SAME worker may take the job
-- again once next_check_at (60 s) has passed: the contract has no "still
-- pending" outcome, and a poll is read-only, so re-polling is harmless.

CREATE OR REPLACE FUNCTION public.social_claim_deliveries(
  p_worker_id text,
  p_limit integer,
  p_enabled boolean,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 5);
  v_lease timestamptz := p_now + interval '10 minutes';
  v_jobs jsonb := '[]'::jsonb;
  v_taken integer := 0;
  v_used integer;
  v_attempt integer;
  r record;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN
    RAISE EXCEPTION 'SOCIAL_WORKER_ID_REQUIRED';
  END IF;

  PERFORM public.social_sweep(p_now);

  -- Kill switch: nothing at all, not even polls.
  IF NOT coalesce(p_enabled, false) THEN
    RETURN jsonb_build_object('jobs', v_jobs);
  END IF;

  FOR r IN
    SELECT j.id, j.account_id, j.run_at, a.daily_cap
      FROM public.social_delivery_jobs j
      JOIN public.social_accounts a ON a.id = j.account_id
      JOIN public.social_destinations d ON d.id = j.destination_id
     WHERE j.status = 'queued'
       AND j.run_at <= p_now
       AND coalesce(j.next_attempt_at, j.run_at) <= p_now
       AND j.run_at + j.stale_after > p_now
       AND a.mode = 'auto'
       AND a.status = 'connected'
       AND NOT a.paused
       AND NOT a.postiz_disabled
       AND a.postiz_integration_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.social_approvals ap
                    WHERE ap.revision_id = d.revision_id AND ap.revoked_at IS NULL)
     ORDER BY j.run_at, j.id
     FOR UPDATE OF j SKIP LOCKED
  LOOP
    EXIT WHEN v_taken >= v_limit;

    -- Cap again at claim time (PRD 5). The account row lock serialises two
    -- claimers on the same account, so both cannot pass the count at once.
    PERFORM 1 FROM public.social_accounts a WHERE a.id = r.account_id FOR UPDATE;
    SELECT count(*)::integer INTO v_used
      FROM public.social_delivery_jobs x
     WHERE x.account_id = r.account_id
       AND x.id <> r.id
       AND x.run_at >= (public.social_bucharest_day(r.run_at)::timestamp AT TIME ZONE 'Europe/Bucharest')
       AND x.run_at <  ((public.social_bucharest_day(r.run_at) + 1)::timestamp AT TIME ZONE 'Europe/Bucharest')
       AND x.status IN ('claimed', 'submitting', 'submitted', 'reconciling', 'published', 'manual_done');
    IF v_used >= r.daily_cap THEN
      -- Left queued (it fails as STALE when its window closes); the reason is
      -- visible on the job.
      UPDATE public.social_delivery_jobs
         SET last_error_message = format('Daily cap %s reached for this account on %s; not claimed',
                                         r.daily_cap, public.social_bucharest_day(r.run_at)),
             updated_at = p_now
       WHERE id = r.id;
      CONTINUE;
    END IF;

    UPDATE public.social_delivery_jobs
       SET status = 'claimed', attempts = attempts + 1, lease_owner = p_worker_id,
           lease_expires_at = v_lease, lease_kind = 'publish', updated_at = p_now
     WHERE id = r.id
     RETURNING attempts INTO v_attempt;

    INSERT INTO public.social_publish_attempts (job_id, attempt_no, worker_id, started_at)
    VALUES (r.id, v_attempt, p_worker_id, p_now);

    v_jobs := v_jobs || jsonb_build_object('job_id', r.id, 'kind', 'publish', 'attempt_no', v_attempt,
                                           'lease_expires_at', v_lease);
    v_taken := v_taken + 1;
  END LOOP;

  IF v_taken < v_limit THEN
    FOR r IN
      SELECT j.id, j.attempts FROM public.social_delivery_jobs j
       WHERE j.status = 'reconciling'
         AND (j.next_check_at IS NULL OR j.next_check_at <= p_now)
         AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now OR j.lease_owner = p_worker_id)
       ORDER BY coalesce(j.next_check_at, j.updated_at), j.id
       FOR UPDATE SKIP LOCKED
    LOOP
      EXIT WHEN v_taken >= v_limit;
      UPDATE public.social_delivery_jobs
         SET lease_owner = p_worker_id, lease_expires_at = v_lease, lease_kind = 'reconcile',
             next_check_at = p_now + interval '60 seconds', updated_at = p_now
       WHERE id = r.id;
      v_jobs := v_jobs || jsonb_build_object('job_id', r.id, 'kind', 'reconcile', 'attempt_no', r.attempts,
                                             'lease_expires_at', v_lease);
      v_taken := v_taken + 1;
    END LOOP;
  END IF;

  IF v_taken < v_limit THEN
    FOR r IN
      SELECT j.id, j.attempts FROM public.social_delivery_jobs j
       WHERE j.status = 'submitted'
         AND (j.next_check_at IS NULL OR j.next_check_at <= p_now)
         AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now OR j.lease_owner = p_worker_id)
       ORDER BY coalesce(j.next_check_at, j.updated_at), j.id
       FOR UPDATE SKIP LOCKED
    LOOP
      EXIT WHEN v_taken >= v_limit;
      UPDATE public.social_delivery_jobs
         SET lease_owner = p_worker_id, lease_expires_at = v_lease, lease_kind = 'poll',
             next_check_at = p_now + interval '60 seconds', updated_at = p_now
       WHERE id = r.id;
      v_jobs := v_jobs || jsonb_build_object('job_id', r.id, 'kind', 'poll', 'attempt_no', r.attempts,
                                             'lease_expires_at', v_lease);
      v_taken := v_taken + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('jobs', v_jobs);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Job transitions reported by the worker
-- ---------------------------------------------------------------------------
-- Each returns {"ok": true, ...} or {"ok": false, "http": 404|409|422, "code", "message"}.
-- 409 = the lease is lost: the worker must stop work on that job at once.

CREATE OR REPLACE FUNCTION public.social_lease_lost(p_message text DEFAULT 'Lease lost')
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
  SELECT jsonb_build_object('ok', false, 'http', 409, 'code', 'LEASE_LOST', 'message', p_message)
$$;

CREATE OR REPLACE FUNCTION public.social_job_heartbeat(
  p_job uuid, p_worker_id text, p_attempt_no integer, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  j public.social_delivery_jobs%ROWTYPE;
  v_lease timestamptz := p_now + interval '10 minutes';
BEGIN
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'NOT_FOUND', 'message', 'No such job');
  END IF;
  IF j.lease_owner IS DISTINCT FROM p_worker_id OR j.attempts <> p_attempt_no
     OR j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now
     OR j.status NOT IN ('claimed', 'submitting', 'submitted', 'reconciling') THEN
    RETURN public.social_lease_lost();
  END IF;
  UPDATE public.social_delivery_jobs SET lease_expires_at = v_lease, updated_at = p_now WHERE id = p_job;
  RETURN jsonb_build_object('ok', true, 'lease_expires_at', v_lease);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_job_submitting(
  p_job uuid, p_worker_id text, p_attempt_no integer, p_enabled boolean, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  j public.social_delivery_jobs%ROWTYPE;
  a public.social_accounts%ROWTYPE;
  v_revision uuid;
BEGIN
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'NOT_FOUND', 'message', 'No such job');
  END IF;

  -- Repeated call for the same attempt: already done.
  IF j.status = 'submitting' AND j.lease_owner = p_worker_id AND j.attempts = p_attempt_no
     AND j.lease_expires_at > p_now THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;

  IF j.status <> 'claimed' OR j.lease_owner IS DISTINCT FROM p_worker_id OR j.attempts <> p_attempt_no
     OR j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now THEN
    RETURN public.social_lease_lost();
  END IF;

  -- Last gate before the create call. Anything that would have stopped the
  -- claim stops the submission too; Postiz has not been called, so the job
  -- can safely go back to the queue (or fail STALE).
  IF j.run_at + j.stale_after <= p_now THEN
    UPDATE public.social_delivery_jobs
       SET status = 'failed', last_error_code = 'STALE',
           last_error_message = 'Stale window passed before submission',
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = p_job;
    UPDATE public.social_publish_attempts SET finished_at = p_now, outcome = 'failed', error_code = 'STALE'
     WHERE job_id = p_job AND attempt_no = j.attempts;
    PERFORM public.social_emit('delivery_stale', public.social_job_context(p_job), p_now);
    PERFORM public.social_refresh_post_status(public.social_job_post(p_job), p_now);
    RETURN public.social_lease_lost('Stale window passed; job failed as STALE');
  END IF;

  SELECT d.revision_id INTO v_revision FROM public.social_destinations d WHERE d.id = j.destination_id;
  SELECT * INTO a FROM public.social_accounts WHERE id = j.account_id;
  IF NOT coalesce(p_enabled, false)
     OR a.paused OR a.status <> 'connected' OR a.mode <> 'auto' OR a.postiz_disabled
     OR NOT EXISTS (SELECT 1 FROM public.social_approvals ap
                     WHERE ap.revision_id = v_revision AND ap.revoked_at IS NULL) THEN
    UPDATE public.social_delivery_jobs
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = p_job;
    UPDATE public.social_publish_attempts SET finished_at = p_now, outcome = 'released'
     WHERE job_id = p_job AND attempt_no = j.attempts;
    RETURN public.social_lease_lost('Publishing is paused for this job (kill switch, account or approval)');
  END IF;

  UPDATE public.social_delivery_jobs SET status = 'submitting', updated_at = p_now WHERE id = p_job;
  UPDATE public.social_publish_attempts SET submitting_at = p_now
   WHERE job_id = p_job AND attempt_no = j.attempts;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_job_submitted(
  p_job uuid, p_worker_id text, p_attempt_no integer, p_postiz_post_id text, p_postiz_group text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  j public.social_delivery_jobs%ROWTYPE;
BEGIN
  IF p_postiz_post_id IS NULL OR length(p_postiz_post_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'http', 422, 'code', 'INVALID_BODY', 'message', 'postiz_post_id is required');
  END IF;

  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'NOT_FOUND', 'message', 'No such job');
  END IF;

  -- Idempotent: the same IDs reported again for the same attempt.
  IF j.attempts = p_attempt_no AND j.postiz_post_id = p_postiz_post_id
     AND j.status IN ('submitted', 'published') THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;

  IF j.lease_owner IS DISTINCT FROM p_worker_id OR j.attempts <> p_attempt_no
     OR j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now THEN
    RETURN public.social_lease_lost();
  END IF;

  -- From submitting (normal), reconciling (reconcile found the post) and, as a
  -- protocol slip, claimed: the post exists in Postiz either way, and losing
  -- track of it is the one outcome that leads to a duplicate.
  IF j.status NOT IN ('submitting', 'reconciling', 'claimed') THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                              'message', format('Cannot mark a %s job as submitted', j.status));
  END IF;

  UPDATE public.social_delivery_jobs
     SET status = 'submitted', postiz_post_id = p_postiz_post_id, postiz_group = p_postiz_group,
         lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL,
         next_check_at = p_now + interval '30 seconds', updated_at = p_now
   WHERE id = p_job;
  UPDATE public.social_publish_attempts
     SET outcome = 'submitted',
         details = details || jsonb_build_object('postiz_post_id', p_postiz_post_id, 'postiz_group', p_postiz_group,
                                                 'from_status', j.status)
   WHERE job_id = p_job AND attempt_no = j.attempts;
  PERFORM public.social_refresh_post_status(public.social_job_post(p_job), p_now);
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_job_result(
  p_job uuid,
  p_worker_id text,
  p_attempt_no integer,
  p_outcome text,
  p_remote_url text,
  p_error_code text,
  p_error_message text,
  p_retry_after_seconds integer,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  j public.social_delivery_jobs%ROWTYPE;
  v_last_outcome text;
  v_next timestamptz;
  v_post uuid;
  v_max_attempts integer;
BEGIN
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'NOT_FOUND', 'message', 'No such job');
  END IF;

  IF j.lease_owner IS DISTINCT FROM p_worker_id OR j.attempts <> p_attempt_no
     OR j.lease_expires_at IS NULL OR j.lease_expires_at <= p_now THEN
    -- The same final result reported twice (a retried HTTP call) is not a lost lease.
    SELECT pa.outcome INTO v_last_outcome FROM public.social_publish_attempts pa
     WHERE pa.job_id = p_job AND pa.attempt_no = p_attempt_no;
    IF j.attempts = p_attempt_no AND (
         (p_outcome = 'published' AND j.status = 'published')
      OR (p_outcome = 'failed' AND j.status = 'failed' AND j.last_error_code IS NOT DISTINCT FROM p_error_code)
      OR (p_outcome = 'retry' AND v_last_outcome = 'retry')
      OR (p_outcome = 'reconciling' AND j.status = 'reconciling')
      OR (p_outcome = 'not_found' AND v_last_outcome = 'not_found')
    ) THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', j.status);
    END IF;
    RETURN public.social_lease_lost();
  END IF;

  v_post := public.social_job_post(p_job);

  IF p_outcome = 'published' THEN
    IF j.status NOT IN ('submitting', 'submitted', 'reconciling') THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                                'message', format('A %s job cannot be published', j.status));
    END IF;
    UPDATE public.social_delivery_jobs
       SET status = 'published', remote_url = p_remote_url, published_at = p_now,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL,
           last_error_code = NULL, last_error_message = NULL, updated_at = p_now
     WHERE id = p_job;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'published',
           details = details || jsonb_build_object('remote_url', p_remote_url)
     WHERE job_id = p_job AND attempt_no = j.attempts;

  ELSIF p_outcome = 'failed' THEN
    IF p_error_code IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'http', 422, 'code', 'INVALID_BODY', 'message', 'error_code is required');
    END IF;
    IF j.status NOT IN ('claimed', 'submitting', 'submitted', 'reconciling') THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                                'message', format('A %s job cannot fail', j.status));
    END IF;
    UPDATE public.social_delivery_jobs
       SET status = 'failed', last_error_code = p_error_code, last_error_message = p_error_message,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
     WHERE id = p_job;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'failed', error_code = p_error_code,
           details = details || jsonb_build_object('error_message', p_error_message)
     WHERE job_id = p_job AND attempt_no = j.attempts;
    -- PRD 10.7 side effects.
    IF p_error_code = 'AUTH_EXPIRED' THEN
      UPDATE public.social_accounts SET status = 'reconnect_required', updated_at = p_now
       WHERE id = j.account_id AND status <> 'reconnect_required';
      IF FOUND THEN
        PERFORM public.social_emit('account_reconnect_required',
          jsonb_build_object('account_id', j.account_id, 'reason', 'AUTH_EXPIRED', 'job_id', p_job), p_now);
      END IF;
    ELSIF p_error_code = 'PERMISSION_DENIED' THEN
      UPDATE public.social_accounts SET status = 'developer_setup_required', updated_at = p_now
       WHERE id = j.account_id;
    END IF;
    PERFORM public.social_emit('delivery_failed', public.social_job_context(p_job), p_now);

  ELSIF p_outcome = 'retry' THEN
    IF j.status NOT IN ('claimed', 'submitting', 'submitted') THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                                'message', format('A %s job cannot be retried', j.status));
    END IF;
    -- 3 attempts in all; a media fetch failure gets one fresh claim only.
    v_max_attempts := CASE WHEN p_error_code = 'MEDIA_FETCH_FAILED' THEN 2 ELSE 3 END;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'retry', error_code = p_error_code,
           details = details || jsonb_build_object('error_message', p_error_message,
                                                   'retry_after_seconds', p_retry_after_seconds)
     WHERE job_id = p_job AND attempt_no = j.attempts;
    IF j.attempts >= v_max_attempts THEN
      UPDATE public.social_delivery_jobs
         SET status = 'failed', last_error_code = coalesce(p_error_code, 'TRANSIENT'),
             last_error_message = coalesce(p_error_message, 'Retries exhausted'),
             lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
       WHERE id = p_job;
      PERFORM public.social_emit('delivery_failed', public.social_job_context(p_job), p_now);
    ELSE
      -- Backoff 1 / 5 / 15 minutes (PRD 6.4), or what the platform asked for.
      v_next := p_now + CASE
        WHEN p_retry_after_seconds IS NOT NULL AND p_retry_after_seconds > 0
          THEN make_interval(secs => least(p_retry_after_seconds, 3600))
        WHEN j.attempts <= 1 THEN interval '1 minute'
        WHEN j.attempts = 2 THEN interval '5 minutes'
        ELSE interval '15 minutes' END;
      UPDATE public.social_delivery_jobs
         SET status = 'queued', next_attempt_at = v_next,
             last_error_code = p_error_code, last_error_message = p_error_message,
             postiz_post_id = NULL, postiz_group = NULL,
             lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
       WHERE id = p_job;
    END IF;

  ELSIF p_outcome = 'reconciling' THEN
    IF j.status NOT IN ('submitting', 'submitted') THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                                'message', format('A %s job cannot go to reconciling', j.status));
    END IF;
    UPDATE public.social_delivery_jobs
       SET status = 'reconciling', last_error_code = coalesce(p_error_code, 'UNKNOWN_RESULT'),
           last_error_message = p_error_message,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = p_now, updated_at = p_now
     WHERE id = p_job;
    UPDATE public.social_publish_attempts
       SET outcome = 'reconciling', error_code = coalesce(p_error_code, 'UNKNOWN_RESULT')
     WHERE job_id = p_job AND attempt_no = j.attempts;

  ELSIF p_outcome = 'not_found' THEN
    IF j.status <> 'reconciling' THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'INVALID_TRANSITION',
                                'message', format('not_found only applies to a reconciling job, not %s', j.status));
    END IF;
    UPDATE public.social_publish_attempts
       SET finished_at = p_now, outcome = 'not_found'
     WHERE job_id = p_job AND attempt_no = j.attempts;
    IF j.reconcile_misses = 0 THEN
      -- First miss: confirmed absent, so it may go out again (once).
      UPDATE public.social_delivery_jobs
         SET status = 'queued', reconcile_misses = 1, next_attempt_at = p_now,
             postiz_post_id = NULL, postiz_group = NULL,
             lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
       WHERE id = p_job;
    ELSE
      UPDATE public.social_delivery_jobs
         SET status = 'failed', reconcile_misses = reconcile_misses + 1, last_error_code = 'RECONCILE_MISS',
             last_error_message = 'Not found in Postiz a second time; a person decides',
             lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
       WHERE id = p_job;
      PERFORM public.social_emit('delivery_failed', public.social_job_context(p_job), p_now);
    END IF;

  ELSE
    RETURN jsonb_build_object('ok', false, 'http', 422, 'code', 'INVALID_BODY',
                              'message', format('Unknown outcome %s', p_outcome));
  END IF;

  PERFORM public.social_refresh_post_status(v_post, p_now);
  SELECT * INTO j FROM public.social_delivery_jobs WHERE id = p_job;
  RETURN jsonb_build_object('ok', true, 'status', j.status);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Generation requests (PRD 10.3 /generation/*)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.social_claim_generation(
  p_worker_id text, p_limit integer, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 5);
  v_lease timestamptz := p_now + interval '10 minutes';
  v_out jsonb := '[]'::jsonb;
  r record;
BEGIN
  PERFORM public.social_sweep(p_now);
  FOR r IN
    SELECT g.id FROM public.social_generation_requests g
     WHERE g.status = 'queued'
     ORDER BY g.created_at, g.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.social_generation_requests
       SET status = 'running', attempts = attempts + 1, lease_owner = p_worker_id,
           lease_expires_at = v_lease, updated_at = p_now
     WHERE id = r.id;
    v_out := v_out || (
      SELECT jsonb_build_object('request_id', g.id, 'brand_id', g.brand_id, 'brand', b.slug, 'brand_name', b.name,
                                'input', g.input, 'lease_expires_at', v_lease)
        FROM public.social_generation_requests g JOIN public.social_brands b ON b.id = g.brand_id
       WHERE g.id = r.id);
  END LOOP;
  RETURN jsonb_build_object('requests', v_out);
END;
$$;

-- 'ok' (lease held), 'done' (already finished: re-delivery), 'lost', 'not_found', 'failed'.
CREATE OR REPLACE FUNCTION public.social_generation_lease_state(
  p_request uuid, p_worker_id text, p_now timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT coalesce((
    SELECT CASE
      WHEN g.status = 'done' THEN 'done'
      WHEN g.status = 'failed' THEN 'failed'
      WHEN g.status = 'running' AND g.lease_owner = p_worker_id AND g.lease_expires_at > p_now THEN 'ok'
      ELSE 'lost' END
    FROM public.social_generation_requests g WHERE g.id = p_request), 'not_found')
$$;

CREATE OR REPLACE FUNCTION public.social_generation_finish(
  p_request uuid, p_worker_id text, p_created integer, p_skipped integer, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  g public.social_generation_requests%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.social_generation_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'NOT_FOUND', 'message', 'No such request');
  END IF;
  IF g.status = 'done' THEN
    UPDATE public.social_generation_requests
       SET drafts_created = drafts_created + coalesce(p_created, 0), updated_at = p_now
     WHERE id = p_request;
    IF coalesce(p_created, 0) > 0 THEN
      PERFORM public.social_emit('drafts_ready',
        jsonb_build_object('request_id', p_request, 'brand_id', g.brand_id, 'created', p_created, 'skipped', p_skipped), p_now);
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;
  IF g.status <> 'running' OR g.lease_owner IS DISTINCT FROM p_worker_id OR g.lease_expires_at <= p_now THEN
    RETURN public.social_lease_lost();
  END IF;
  UPDATE public.social_generation_requests
     SET status = 'done', drafts_created = drafts_created + coalesce(p_created, 0),
         drafts_skipped = drafts_skipped + coalesce(p_skipped, 0),
         lease_owner = NULL, lease_expires_at = NULL, finished_at = p_now, updated_at = p_now
   WHERE id = p_request;
  PERFORM public.social_emit('drafts_ready',
    jsonb_build_object('request_id', p_request, 'brand_id', g.brand_id, 'created', p_created, 'skipped', p_skipped), p_now);
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_generation_fail(
  p_request uuid, p_worker_id text, p_error_code text, p_error_message text, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  g public.social_generation_requests%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.social_generation_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'NOT_FOUND', 'message', 'No such request');
  END IF;
  IF g.status = 'failed' AND g.error_code IS NOT DISTINCT FROM p_error_code THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;
  IF g.status <> 'running' OR g.lease_owner IS DISTINCT FROM p_worker_id OR g.lease_expires_at <= p_now THEN
    RETURN public.social_lease_lost();
  END IF;
  UPDATE public.social_generation_requests
     SET status = 'failed', error_code = p_error_code, error_message = p_error_message,
         lease_owner = NULL, lease_expires_at = NULL, finished_at = p_now, updated_at = p_now
   WHERE id = p_request;
  PERFORM public.social_emit('generation_failed',
    jsonb_build_object('request_id', p_request, 'brand_id', g.brand_id, 'error_code', p_error_code,
                       'error_message', p_error_message), p_now);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Posts and revisions
-- ---------------------------------------------------------------------------
-- p_revision:     {canonical_text, body_markdown, article, launch, card_spec,
--                  figures, variants, notes, generator_errors}
-- p_destinations: [{account_id, text, settings, scheduled_at, scheduled_tz,
--                   figures, contains_figures, validation,
--                   media: [{media_id, position, alt_text}]}]

CREATE OR REPLACE FUNCTION public.social_insert_revision(
  p_post uuid, p_actor uuid, p_revision jsonb, p_destinations jsonb, p_now timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_brand uuid;
  v_number integer;
  v_revision uuid;
  v_destination uuid;
  v_account public.social_accounts%ROWTYPE;
  d jsonb;
  m jsonb;
BEGIN
  SELECT brand_id INTO v_brand FROM public.social_posts WHERE id = p_post;
  SELECT coalesce(max(number), 0) + 1 INTO v_number FROM public.social_post_revisions WHERE post_id = p_post;

  INSERT INTO public.social_post_revisions
    (post_id, number, canonical_text, body_markdown, article, launch, card_spec, figures, variants, notes,
     generator_errors, created_by, created_at)
  VALUES (
    p_post, v_number,
    coalesce(p_revision->>'canonical_text', ''),
    p_revision->>'body_markdown',
    nullif(p_revision->'article', 'null'::jsonb),
    nullif(p_revision->'launch', 'null'::jsonb),
    nullif(p_revision->'card_spec', 'null'::jsonb),
    coalesce(nullif(p_revision->'figures', 'null'::jsonb), '[]'::jsonb),
    coalesce(nullif(p_revision->'variants', 'null'::jsonb), '[]'::jsonb),
    p_revision->>'notes',
    coalesce(nullif(p_revision->'generator_errors', 'null'::jsonb), '[]'::jsonb),
    p_actor, p_now)
  RETURNING id INTO v_revision;

  FOR d IN SELECT * FROM jsonb_array_elements(coalesce(p_destinations, '[]'::jsonb))
  LOOP
    SELECT * INTO v_account FROM public.social_accounts WHERE id = (d->>'account_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND' USING DETAIL = d->>'account_id';
    END IF;
    IF v_account.brand_id IS DISTINCT FROM v_brand THEN
      RAISE EXCEPTION 'SOCIAL_ACCOUNT_OTHER_BRAND'
        USING DETAIL = format('account %s is not assigned to the brand of post %s', v_account.id, p_post);
    END IF;

    INSERT INTO public.social_destinations
      (revision_id, account_id, platform, text, settings, scheduled_at, scheduled_tz, contains_figures,
       figures, validation, created_at)
    VALUES (
      v_revision, v_account.id, v_account.platform,
      coalesce(d->>'text', ''),
      coalesce(nullif(d->'settings', 'null'::jsonb), '{}'::jsonb),
      nullif(d->>'scheduled_at', '')::timestamptz,
      coalesce(nullif(d->>'scheduled_tz', ''), 'Europe/Bucharest'),
      coalesce((d->>'contains_figures')::boolean, false),
      coalesce(nullif(d->'figures', 'null'::jsonb), '[]'::jsonb),
      coalesce(nullif(d->'validation', 'null'::jsonb), '{}'::jsonb),
      p_now)
    RETURNING id INTO v_destination;

    FOR m IN SELECT * FROM jsonb_array_elements(coalesce(d->'media', '[]'::jsonb))
    LOOP
      INSERT INTO public.social_destination_media (destination_id, media_id, position, alt_text)
      VALUES (v_destination, (m->>'media_id')::uuid, (m->>'position')::integer, coalesce(m->>'alt_text', ''));
    END LOOP;
  END LOOP;

  UPDATE public.social_posts SET current_revision_id = v_revision, updated_at = p_now WHERE id = p_post;
  RETURN v_revision;
END;
$$;

-- New post with its first revision. Returns the post id, or NULL when a post
-- with the same generation_ref exists (re-delivered draft: skipped).
CREATE OR REPLACE FUNCTION public.social_create_post(
  p_post jsonb, p_revision jsonb, p_destinations jsonb, p_now timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_post uuid;
  v_actor uuid := nullif(p_post->>'created_by', '')::uuid;
BEGIN
  INSERT INTO public.social_posts
    (brand_id, kind, title, source_url, generation_request_id, generation_ref, created_by, status,
     created_at, updated_at)
  VALUES (
    (p_post->>'brand_id')::uuid,
    coalesce(p_post->>'kind', 'social'),
    p_post->>'title',
    p_post->>'source_url',
    nullif(p_post->>'generation_request_id', '')::uuid,
    p_post->>'generation_ref',
    v_actor, 'draft', p_now, p_now)
  ON CONFLICT (generation_ref) DO NOTHING
  RETURNING id INTO v_post;

  IF v_post IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM public.social_insert_revision(v_post, v_actor, p_revision, p_destinations, p_now);
  RETURN v_post;
END;
$$;

-- Saving an edit (or a reschedule) = a new revision (F4, F5). When the current
-- revision is approved, its approval is revoked and its unsubmitted jobs are
-- cancelled in the same transaction. A destination whose job has already left
-- (submitting or later) cannot be carried into a new revision.
CREATE OR REPLACE FUNCTION public.social_save_revision(
  p_post uuid,
  p_base_revision uuid,
  p_actor uuid,
  p_revision jsonb,
  p_destinations jsonb,
  p_reason text,
  p_now timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_post public.social_posts%ROWTYPE;
  v_title text;
  v_blocked uuid;
  v_new uuid;
BEGIN
  SELECT * INTO v_post FROM public.social_posts WHERE id = p_post FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND';
  END IF;
  IF v_post.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'SOCIAL_POST_CANCELLED';
  END IF;
  IF v_post.current_revision_id IS DISTINCT FROM p_base_revision THEN
    RAISE EXCEPTION 'SOCIAL_STALE_REVISION'
      USING DETAIL = format('current revision is %s', v_post.current_revision_id);
  END IF;

  SELECT j.account_id INTO v_blocked
    FROM public.social_delivery_jobs j
    JOIN public.social_destinations d ON d.id = j.destination_id
   WHERE d.revision_id = v_post.current_revision_id
     AND j.status IN ('submitting', 'submitted', 'reconciling', 'published', 'manual_done')
     AND j.account_id IN (SELECT (x->>'account_id')::uuid FROM jsonb_array_elements(coalesce(p_destinations, '[]'::jsonb)) x)
   LIMIT 1;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION 'SOCIAL_DESTINATION_IN_FLIGHT'
      USING DETAIL = format('account %s already has a submitted or published job in this post', v_blocked);
  END IF;

  IF v_post.current_revision_id IS NOT NULL THEN
    UPDATE public.social_approvals
       SET revoked_at = p_now, revoked_reason = coalesce(p_reason, 'new revision')
     WHERE revision_id = v_post.current_revision_id AND revoked_at IS NULL;
    UPDATE public.social_delivery_jobs j
       SET status = 'cancelled', cancelled_at = p_now, cancelled_by = p_actor,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
      FROM public.social_destinations d
     WHERE d.id = j.destination_id
       AND d.revision_id = v_post.current_revision_id
       AND j.status IN ('queued', 'claimed', 'manual_pending');
  END IF;

  v_new := public.social_insert_revision(p_post, p_actor, p_revision, p_destinations, p_now);

  v_title := p_revision->>'title';
  UPDATE public.social_posts
     SET title = coalesce(v_title, title), updated_at = p_now
   WHERE id = p_post;
  PERFORM public.social_refresh_post_status(p_post, p_now);
  RETURN v_new;
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. Approval (F5): checks, hashes, approval row and jobs in one transaction
-- ---------------------------------------------------------------------------
-- p_destinations: [{id, destination_hash, validation, contains_figures}] for
-- EVERY destination of the revision, computed by the server (JCS + sha256,
-- PRD 10.6). The content rules run in the server first; the checks repeated
-- here are the ones the database can enforce on its own.

CREATE OR REPLACE FUNCTION public.social_approve_revision(
  p_post uuid,
  p_revision uuid,
  p_actor uuid,
  p_actor_email text,
  p_approval_hash text,
  p_figures_checked boolean,
  p_destinations jsonb,
  p_now timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_post public.social_posts%ROWTYPE;
  v_count integer;
  v_given integer;
  v_approval uuid;
  v_used integer;
  r record;
  d jsonb;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED';
  END IF;

  SELECT * INTO v_post FROM public.social_posts WHERE id = p_post FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND';
  END IF;
  IF v_post.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'SOCIAL_POST_CANCELLED';
  END IF;
  IF v_post.current_revision_id IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'SOCIAL_STALE_REVISION'
      USING DETAIL = format('current revision is %s', v_post.current_revision_id);
  END IF;
  IF public.social_revision_frozen(p_revision) THEN
    RAISE EXCEPTION 'SOCIAL_ALREADY_APPROVED';
  END IF;

  SELECT count(*) INTO v_count FROM public.social_destinations WHERE revision_id = p_revision;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'SOCIAL_NO_DESTINATIONS';
  END IF;
  SELECT count(DISTINCT x->>'id') INTO v_given
    FROM jsonb_array_elements(coalesce(p_destinations, '[]'::jsonb)) x
   WHERE (x->>'id')::uuid IN (SELECT id FROM public.social_destinations WHERE revision_id = p_revision)
     AND (x->>'destination_hash') ~ '^[0-9a-f]{64}$';
  IF v_given <> v_count THEN
    RAISE EXCEPTION 'SOCIAL_HASHES_INCOMPLETE'
      USING DETAIL = format('%s destinations, %s hashed', v_count, v_given);
  END IF;

  IF EXISTS (SELECT 1 FROM public.social_destinations WHERE revision_id = p_revision AND scheduled_at IS NULL) THEN
    RAISE EXCEPTION 'SOCIAL_MISSING_TIME';
  END IF;

  -- Figures (PRD 8.2): "figures checked" for any destination with figures, and
  -- no unverified figure at all.
  IF NOT coalesce(p_figures_checked, false) AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_destinations) x WHERE (x->>'contains_figures')::boolean) THEN
    RAISE EXCEPTION 'SOCIAL_FIGURES_NOT_CHECKED';
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.social_destinations sd, jsonb_array_elements(sd.figures) f
        WHERE sd.revision_id = p_revision AND f->>'source' = 'unverified') THEN
    RAISE EXCEPTION 'SOCIAL_UNVERIFIED_FIGURE';
  END IF;

  -- Daily cap (PRD 5), under a lock on each account involved, in id order so
  -- two approvals cannot deadlock.
  PERFORM 1 FROM public.social_accounts a
   WHERE a.id IN (SELECT account_id FROM public.social_destinations WHERE revision_id = p_revision)
   ORDER BY a.id
   FOR UPDATE;
  FOR r IN
    SELECT sd.account_id, a.display_name, a.daily_cap, public.social_bucharest_day(sd.scheduled_at) AS day,
           count(*)::integer AS n
      FROM public.social_destinations sd
      JOIN public.social_accounts a ON a.id = sd.account_id
     WHERE sd.revision_id = p_revision
     GROUP BY sd.account_id, a.display_name, a.daily_cap, public.social_bucharest_day(sd.scheduled_at)
  LOOP
    v_used := public.social_cap_usage(r.account_id, r.day);
    IF v_used + r.n > r.daily_cap THEN
      RAISE EXCEPTION 'SOCIAL_DAILY_CAP'
        USING DETAIL = jsonb_build_object('account_id', r.account_id, 'account', r.display_name, 'day', r.day,
                                          'used', v_used, 'adding', r.n, 'cap', r.daily_cap)::text;
    END IF;
  END LOOP;

  -- Derived columns, written before the approval row exists (afterwards the
  -- revision is frozen).
  FOR d IN SELECT * FROM jsonb_array_elements(p_destinations)
  LOOP
    UPDATE public.social_destinations
       SET destination_hash = d->>'destination_hash',
           validation = coalesce(nullif(d->'validation', 'null'::jsonb), validation),
           contains_figures = coalesce((d->>'contains_figures')::boolean, contains_figures)
     WHERE id = (d->>'id')::uuid AND revision_id = p_revision;
  END LOOP;

  INSERT INTO public.social_approvals
    (revision_id, approved_by, approved_by_email, approved_at, approval_hash, figures_checked)
  VALUES (p_revision, p_actor, p_actor_email, p_now, p_approval_hash, coalesce(p_figures_checked, false))
  RETURNING id INTO v_approval;

  INSERT INTO public.social_delivery_jobs (destination_id, account_id, status, run_at, created_at, updated_at)
  SELECT sd.id, sd.account_id,
         CASE WHEN a.mode = 'manual' THEN 'manual_pending' ELSE 'queued' END,
         sd.scheduled_at, p_now, p_now
    FROM public.social_destinations sd
    JOIN public.social_accounts a ON a.id = sd.account_id
   WHERE sd.revision_id = p_revision;

  PERFORM public.social_refresh_post_status(p_post, p_now);
  RETURN v_approval;
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. Admin actions on jobs: cancel, retry failed only, manual done
-- ---------------------------------------------------------------------------

-- p_job given: cancel that destination. Otherwise the whole post: every
-- unsubmitted job of the current revision; a post where nothing has gone out
-- is cancelled as a whole.
CREATE OR REPLACE FUNCTION public.social_cancel(
  p_post uuid, p_job uuid, p_actor uuid, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_post public.social_posts%ROWTYPE;
  v_job public.social_delivery_jobs%ROWTYPE;
  v_cancelled integer := 0;
BEGIN
  SELECT * INTO v_post FROM public.social_posts WHERE id = p_post FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND';
  END IF;

  IF p_job IS NOT NULL THEN
    SELECT * INTO v_job FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
    IF NOT FOUND OR public.social_job_post(p_job) IS DISTINCT FROM p_post THEN
      RAISE EXCEPTION 'SOCIAL_JOB_NOT_FOUND';
    END IF;
    IF v_job.status NOT IN ('queued', 'claimed', 'manual_pending') THEN
      RAISE EXCEPTION 'SOCIAL_NOT_CANCELLABLE' USING DETAIL = v_job.status;
    END IF;
    UPDATE public.social_delivery_jobs
       SET status = 'cancelled', cancelled_at = p_now, cancelled_by = p_actor,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
     WHERE id = p_job;
    v_cancelled := 1;
  ELSE
    WITH c AS (
      UPDATE public.social_delivery_jobs j
         SET status = 'cancelled', cancelled_at = p_now, cancelled_by = p_actor,
             lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, updated_at = p_now
        FROM public.social_destinations d
       WHERE d.id = j.destination_id
         AND d.revision_id = v_post.current_revision_id
         AND j.status IN ('queued', 'claimed', 'manual_pending')
      RETURNING j.id)
    SELECT count(*) INTO v_cancelled FROM c;

    IF NOT EXISTS (
         SELECT 1 FROM public.social_delivery_jobs j
           JOIN public.social_destinations d ON d.id = j.destination_id
           JOIN public.social_post_revisions r ON r.id = d.revision_id
          WHERE r.post_id = p_post
            AND j.status IN ('submitting', 'submitted', 'reconciling', 'published', 'manual_done')) THEN
      UPDATE public.social_posts SET cancelled_at = p_now, cancelled_by = p_actor, updated_at = p_now
       WHERE id = p_post AND cancelled_at IS NULL;
    END IF;
  END IF;

  PERFORM public.social_refresh_post_status(p_post, p_now);
  RETURN jsonb_build_object('cancelled', v_cancelled);
END;
$$;

-- "Retry failed destinations only" (F5): same approved content, a new attempt.
-- Not for a job past its stale window (that needs a reschedule, i.e. a new
-- approval), and RECONCILE_MISS only after a person confirmed the post is
-- not on the platform.
CREATE OR REPLACE FUNCTION public.social_retry_failed(
  p_post uuid, p_actor uuid, p_confirm_reconcile_miss boolean, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_post public.social_posts%ROWTYPE;
  v_retried integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_used integer;
  r record;
BEGIN
  SELECT * INTO v_post FROM public.social_posts WHERE id = p_post FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.social_approvals a
                  WHERE a.revision_id = v_post.current_revision_id AND a.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'SOCIAL_NOT_APPROVED';
  END IF;

  FOR r IN
    SELECT j.*, a.daily_cap FROM public.social_delivery_jobs j
      JOIN public.social_destinations d ON d.id = j.destination_id
      JOIN public.social_accounts a ON a.id = j.account_id
     WHERE d.revision_id = v_post.current_revision_id AND j.status = 'failed'
     ORDER BY j.run_at, j.id
     FOR UPDATE OF j
  LOOP
    IF r.run_at + r.stale_after <= p_now THEN
      v_skipped := v_skipped || jsonb_build_object('job_id', r.id, 'reason', 'STALE_WINDOW');
      CONTINUE;
    END IF;
    IF r.last_error_code = 'RECONCILE_MISS' AND NOT coalesce(p_confirm_reconcile_miss, false) THEN
      v_skipped := v_skipped || jsonb_build_object('job_id', r.id, 'reason', 'NEEDS_CONFIRMATION');
      CONTINUE;
    END IF;
    v_used := public.social_cap_usage(r.account_id, public.social_bucharest_day(r.run_at), r.id);
    IF v_used >= r.daily_cap THEN
      v_skipped := v_skipped || jsonb_build_object('job_id', r.id, 'reason', 'DAILY_CAP');
      CONTINUE;
    END IF;
    UPDATE public.social_delivery_jobs
       SET status = 'queued', next_attempt_at = p_now,
           reconcile_misses = CASE WHEN r.last_error_code = 'RECONCILE_MISS' THEN 0 ELSE reconcile_misses END,
           postiz_post_id = NULL, postiz_group = NULL,
           lease_owner = NULL, lease_expires_at = NULL, lease_kind = NULL, next_check_at = NULL, updated_at = p_now
     WHERE id = r.id;
    v_retried := v_retried + 1;
  END LOOP;

  PERFORM public.social_refresh_post_status(p_post, p_now);
  RETURN jsonb_build_object('retried', v_retried, 'skipped', v_skipped);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_mark_manual_done(
  p_job uuid, p_actor uuid, p_url text, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_job public.social_delivery_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.social_delivery_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_JOB_NOT_FOUND';
  END IF;
  IF v_job.status = 'manual_done' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;
  IF v_job.status <> 'manual_pending' THEN
    RAISE EXCEPTION 'SOCIAL_NOT_MANUAL_PENDING' USING DETAIL = v_job.status;
  END IF;
  IF p_url IS NULL OR p_url !~ '^https?://' THEN
    RAISE EXCEPTION 'SOCIAL_URL_REQUIRED';
  END IF;
  UPDATE public.social_delivery_jobs
     SET status = 'manual_done', remote_url = p_url, published_at = p_now,
         manual_done_by = p_actor, manual_done_at = p_now, updated_at = p_now
   WHERE id = p_job;
  PERFORM public.social_refresh_post_status(public.social_job_post(p_job), p_now);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 12. Function privileges: service role only
-- ---------------------------------------------------------------------------
-- Supabase grants EXECUTE on every new function in `public` to anon and
-- authenticated, which would put each of these on PostgREST's /rpc for the
-- public key. None of them is for the browser.

DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'social\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 13. Storage: private bucket for cards and uploads
-- ---------------------------------------------------------------------------
-- No storage.objects policies: only the service role and URLs it signs reach
-- these files (uploads go browser -> Storage through a signed upload URL).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('social-media', 'social-media', false, 8388608, ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 14. Seed: the three brands (PRD 5)
-- ---------------------------------------------------------------------------

INSERT INTO public.social_brands (slug, name) VALUES
  ('taxes-support', 'Taxes Support'),
  ('the-crypto-support', 'The Crypto Support'),
  ('comets-of-web3', 'Comets of Web3')
ON CONFLICT (slug) DO NOTHING;

COMMENT ON TABLE public.social_posts IS
  'Social publishing (0001). Status derived from the current revision''s delivery jobs; see social_refresh_post_status.';
COMMENT ON TABLE public.social_delivery_jobs IS
  'One job per approved destination (0001). State machine: PRD 10.2; transitions only through the social_* functions.';
COMMENT ON TABLE public.social_events IS
  'Outbox (0001). Shown on /admin/social with "mark as seen"; n8n polls it once the automation API exists.';
