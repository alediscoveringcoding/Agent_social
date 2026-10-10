-- ============================================================================
-- 0012: verified sources and the automation API (amendment 07).
--
--   * NEW social_post_sources: the web pages behind a draft (found by the
--     research step), one row per post and URL, each with a "Verificat" tick
--     a person sets. Written only by the functions below.
--   * approve (replaces 0011's): refuses SOCIAL_SOURCES_NOT_VERIFIED while any
--     source of the post is unticked. Everything else is 0011 verbatim.
--   * Sources freeze with the approval: while the post's current revision has
--     an active approval, ticking is refused (SOCIAL_SOURCES_FROZEN) and
--     nothing is added. An edit makes a new revision, which revokes the
--     approval (social_save_revision) and thaws the sources.
--   * Automation API (PRD 10.4): social_automation_create_request is
--     idempotent on the existing (workflow, event_id) columns of
--     social_generation_requests; social_automation_log_run upserts into
--     social_automation_runs (a table of 0001 that nothing wrote to yet).
--     Neither can approve or publish anything.
--
-- Nothing already deployed is edited. This file runs on a database that
-- already holds real rows: tables and columns are created only when missing,
-- the one new constraint on existing data is skipped with a NOTICE if the rows
-- would violate it, and every function is CREATE OR REPLACE.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Sources
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.social_post_sources (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid        NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  position        integer     NOT NULL DEFAULT 0 CHECK (position >= 0),
  url             text        NOT NULL CHECK (url ~* '^https?://[^[:space:]]+$' AND length(url) <= 2048),
  title           text        NOT NULL DEFAULT '' CHECK (length(title) <= 300),
  publisher       text        CHECK (publisher IS NULL OR length(publisher) <= 200),
  -- The date as the page gave it ("12 octombrie 2026"), not parsed.
  published_at    text        CHECK (published_at IS NULL OR length(published_at) <= 40),
  -- What the source supports in the draft.
  note            text        CHECK (note IS NULL OR length(note) <= 500),
  -- true: the URL came back from the web search. false: added another way.
  found_in_search boolean     NOT NULL DEFAULT false,
  verified_at     timestamptz,
  verified_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_post_sources_post_url UNIQUE (post_id, url),
  CONSTRAINT social_post_sources_verified_pair CHECK (verified_at IS NOT NULL OR verified_by IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_social_post_sources_post ON public.social_post_sources (post_id, position);

-- RLS on, no policies, no rights for the browser roles (same rule as 0001 section 2).
ALTER TABLE public.social_post_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.social_post_sources FROM anon, authenticated;
GRANT ALL ON TABLE public.social_post_sources TO service_role;

COMMENT ON TABLE public.social_post_sources IS
  'Web sources of a draft (0012, amendment 07). Approval is refused while one is unverified; frozen with the approval.';

-- Is the post's current revision approved right now? (A revoked approval does
-- not count: the edit that revoked it made a new, unapproved revision.)
CREATE OR REPLACE FUNCTION public.social_post_sources_frozen(p_post uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.social_posts p
      JOIN public.social_approvals a ON a.revision_id = p.current_revision_id AND a.revoked_at IS NULL
     WHERE p.id = p_post)
$$;

-- Adds the sources of one draft: [{url, title, publisher, published_at, note,
-- found_in_search}]. Idempotent on (post_id, url): a re-delivered draft adds
-- nothing. Entries without an http(s) URL are skipped. New sources are
-- unverified. A post whose current revision is approved is not touched
-- (returns 0). Returns the number of sources added.
CREATE OR REPLACE FUNCTION public.social_add_post_sources(
  p_post uuid, p_sources jsonb, p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_sources jsonb := coalesce(p_sources, '[]'::jsonb);
  v_base integer;
  v_added integer := 0;
BEGIN
  IF jsonb_typeof(v_sources) <> 'array' THEN
    RAISE EXCEPTION 'SOCIAL_BAD_SOURCES' USING DETAIL = 'sources must be a JSON array';
  END IF;

  -- The post lock is the one approval takes, so a source cannot slip in
  -- between the approval's check and its commit.
  PERFORM 1 FROM public.social_posts WHERE id = p_post FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND';
  END IF;
  IF public.social_post_sources_frozen(p_post) THEN
    RETURN 0;
  END IF;

  SELECT coalesce(max(s.position) + 1, 0) INTO v_base FROM public.social_post_sources s WHERE s.post_id = p_post;

  INSERT INTO public.social_post_sources
    (post_id, position, url, title, publisher, published_at, note, found_in_search, created_at)
  SELECT p_post,
         v_base + (t.ord - 1)::integer,
         btrim(t.x->>'url'),
         left(btrim(coalesce(t.x->>'title', '')), 300),
         nullif(left(btrim(coalesce(t.x->>'publisher', '')), 200), ''),
         nullif(left(btrim(coalesce(t.x->>'published_at', '')), 40), ''),
         nullif(left(btrim(coalesce(t.x->>'note', '')), 500), ''),
         CASE WHEN jsonb_typeof(t.x->'found_in_search') = 'boolean' THEN (t.x->>'found_in_search')::boolean ELSE false END,
         p_now
    FROM jsonb_array_elements(v_sources) WITH ORDINALITY AS t(x, ord)
   WHERE jsonb_typeof(t.x) = 'object'
     AND btrim(coalesce(t.x->>'url', '')) ~* '^https?://[^[:space:]]+$'
     AND length(btrim(t.x->>'url')) <= 2048
  ON CONFLICT (post_id, url) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  IF v_added > 0 THEN
    PERFORM public.social_log_system('social.sources_added', p_post, NULL, NULL,
      jsonb_build_object('count', v_added), p_now);
  END IF;
  RETURN v_added;
END;
$$;

-- A person ticks (or unticks) "Verificat" on one source. Refused while the
-- post's current revision is approved. Idempotent: asking for the state the
-- source is already in changes and logs nothing.
CREATE OR REPLACE FUNCTION public.social_set_source_verified(
  p_source uuid, p_user uuid, p_verified boolean, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_post uuid;
  s public.social_post_sources%ROWTYPE;
  v_verify boolean := coalesce(p_verified, false);
  v_email text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED';
  END IF;

  SELECT post_id INTO v_post FROM public.social_post_sources WHERE id = p_source;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_SOURCE_NOT_FOUND';
  END IF;
  -- Same lock order as approval and add: the post first, then the source.
  PERFORM 1 FROM public.social_posts WHERE id = v_post FOR UPDATE;
  SELECT * INTO s FROM public.social_post_sources WHERE id = p_source FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_SOURCE_NOT_FOUND';
  END IF;

  IF public.social_post_sources_frozen(v_post) THEN
    RAISE EXCEPTION 'SOCIAL_SOURCES_FROZEN'
      USING DETAIL = 'the current revision of the post is approved; sources change with a new revision';
  END IF;

  IF (s.verified_at IS NOT NULL) = v_verify THEN
    RETURN jsonb_build_object('changed', false, 'source_id', s.id, 'post_id', s.post_id,
                              'verified', v_verify, 'verified_at', s.verified_at, 'verified_by', s.verified_by);
  END IF;

  UPDATE public.social_post_sources
     SET verified_at = CASE WHEN v_verify THEN p_now END,
         verified_by = CASE WHEN v_verify THEN p_user END
   WHERE id = p_source
   RETURNING * INTO s;

  -- The e-mail is only for reading the log; a role that cannot see auth.users
  -- still gets the row, with the actor id.
  BEGIN
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_user;
  EXCEPTION WHEN OTHERS THEN
    v_email := NULL;
  END;
  INSERT INTO public.social_activity_log (actor_id, actor_email, action, status, post_id, details, created_at)
  VALUES (p_user, v_email,
          CASE WHEN v_verify THEN 'social.source_verified' ELSE 'social.source_unverified' END,
          'success', s.post_id,
          jsonb_build_object('source_id', s.id, 'url', s.url), p_now);

  RETURN jsonb_build_object('changed', true, 'source_id', s.id, 'post_id', s.post_id,
                            'verified', v_verify, 'verified_at', s.verified_at, 'verified_by', s.verified_by);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Approval: every source verified (0011's function, plus one check)
-- ---------------------------------------------------------------------------

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
  v_unverified integer;
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

  -- Every destination account belongs to the post's brand. The composer only
  -- offers the brand's accounts, but an account can change brand after a
  -- draft was saved, and the database does not take the form's word for it.
  IF EXISTS (SELECT 1 FROM public.social_destinations sd
               JOIN public.social_accounts a ON a.id = sd.account_id
              WHERE sd.revision_id = p_revision AND a.brand_id IS DISTINCT FROM v_post.brand_id) THEN
    RAISE EXCEPTION 'SOCIAL_BRAND_MISMATCH'
      USING DETAIL = 'a destination account does not belong to the brand of the post';
  END IF;

  -- A slot already past its stale window (2 hours, like social_delivery_jobs.
  -- stale_after) would be approved only to fail as STALE at the first sweep.
  -- Manual destinations never go stale (they wait for a person).
  IF EXISTS (SELECT 1 FROM public.social_destinations sd
               JOIN public.social_accounts a ON a.id = sd.account_id
              WHERE sd.revision_id = p_revision AND a.mode <> 'manual'
                AND sd.scheduled_at + interval '2 hours' <= p_now) THEN
    RAISE EXCEPTION 'SOCIAL_SCHEDULE_STALE'
      USING DETAIL = 'a scheduled time is more than 2 hours in the past; reschedule it';
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

  -- Sources (amendment 07): a person ticked every link as verified. The post
  -- row is locked above, and ticking takes the same lock, so none can be
  -- unticked between this check and the approval below.
  SELECT count(*)::integer INTO v_unverified
    FROM public.social_post_sources s WHERE s.post_id = p_post AND s.verified_at IS NULL;
  IF v_unverified > 0 THEN
    RAISE EXCEPTION 'SOCIAL_SOURCES_NOT_VERIFIED'
      USING DETAIL = jsonb_build_object('unverified', v_unverified)::text;
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
-- 3. Automation runs (the table is 0001's; it only gains what the API needs)
-- ---------------------------------------------------------------------------

-- A run is logged once per (workflow, event_id) and updated when n8n reports
-- again; created_at stays the first report, updated_at is the last.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'social_automation_runs' AND column_name = 'updated_at') THEN
    ALTER TABLE public.social_automation_runs ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    UPDATE public.social_automation_runs SET updated_at = created_at;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_social_automation_runs_updated ON public.social_automation_runs (updated_at DESC);

DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_automation_runs_status_check') THEN
    SELECT count(*) INTO n FROM public.social_automation_runs WHERE status NOT IN ('ok', 'error', 'skipped');
    IF n > 0 THEN
      RAISE NOTICE '0012: % automation run(s) have a status outside ok / error / skipped; check constraint not created', n;
    ELSE
      ALTER TABLE public.social_automation_runs
        ADD CONSTRAINT social_automation_runs_status_check CHECK (status IN ('ok', 'error', 'skipped'));
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Automation functions (PRD 10.4)
-- ---------------------------------------------------------------------------

-- n8n asks for a generation request. Idempotent on (workflow, event_id): the
-- same event again returns the request it made the first time, created = false.
-- requested_by stays NULL (nobody clicked); the activity actor is 'automation'.
-- An unknown brand slug is refused with SOCIAL_BRAND_NOT_FOUND.
CREATE OR REPLACE FUNCTION public.social_automation_create_request(
  p_workflow text, p_event_id text, p_brand text, p_input jsonb, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_brand uuid;
  v_id uuid;
BEGIN
  IF p_workflow IS NULL OR p_workflow !~ '^[a-z0-9-]{1,64}$' THEN
    RAISE EXCEPTION 'SOCIAL_BAD_WORKFLOW';
  END IF;
  IF p_event_id IS NULL OR btrim(p_event_id) = '' OR length(p_event_id) > 200 THEN
    RAISE EXCEPTION 'SOCIAL_BAD_EVENT_ID';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'SOCIAL_BAD_INPUT';
  END IF;

  SELECT b.id INTO v_brand FROM public.social_brands b WHERE b.slug = p_brand;
  IF v_brand IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_BRAND_NOT_FOUND';
  END IF;

  INSERT INTO public.social_generation_requests (brand_id, input, requested_by, workflow, event_id, created_at, updated_at)
  VALUES (v_brand, p_input, NULL, p_workflow, p_event_id, p_now, p_now)
  ON CONFLICT (workflow, event_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT g.id INTO v_id FROM public.social_generation_requests g
     WHERE g.workflow = p_workflow AND g.event_id = p_event_id;
    RETURN jsonb_build_object('request_id', v_id, 'created', false);
  END IF;

  INSERT INTO public.social_activity_log (actor_id, actor_email, action, status, details, created_at)
  VALUES (NULL, 'automation', 'social.generation_requested', 'success',
          jsonb_build_object('request_id', v_id, 'brand', p_brand, 'workflow', p_workflow, 'event_id', p_event_id,
                             'source', p_input->'source'->>'type', 'count', p_input->'count',
                             'research', coalesce(p_input->'research', 'false'::jsonb)),
          p_now);
  RETURN jsonb_build_object('request_id', v_id, 'created', true);
END;
$$;

-- n8n reports what a workflow did for one event. An upsert on
-- (workflow, event_id): the second report replaces status and details. The
-- activity log gets a row when the run is new or its status changed, so a
-- workflow that reports the same thing again does not fill it. Returns the
-- run's id (uuid, like the table's key).
CREATE OR REPLACE FUNCTION public.social_automation_log_run(
  p_workflow text, p_event_id text, p_status text, p_details jsonb, p_now timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
  v_old text;
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
BEGIN
  IF p_workflow IS NULL OR p_workflow !~ '^[a-z0-9-]{1,64}$' THEN
    RAISE EXCEPTION 'SOCIAL_BAD_WORKFLOW';
  END IF;
  IF p_event_id IS NULL OR btrim(p_event_id) = '' OR length(p_event_id) > 200 THEN
    RAISE EXCEPTION 'SOCIAL_BAD_EVENT_ID';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('ok', 'error', 'skipped') THEN
    RAISE EXCEPTION 'SOCIAL_BAD_AUTOMATION_STATUS';
  END IF;
  IF jsonb_typeof(v_details) <> 'object' THEN
    RAISE EXCEPTION 'SOCIAL_BAD_INPUT' USING DETAIL = 'details must be a JSON object';
  END IF;

  INSERT INTO public.social_automation_runs (workflow, event_id, status, details, created_at, updated_at)
  VALUES (p_workflow, p_event_id, p_status, v_details, p_now, p_now)
  ON CONFLICT (workflow, event_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT r.id, r.status INTO v_id, v_old FROM public.social_automation_runs r
     WHERE r.workflow = p_workflow AND r.event_id = p_event_id FOR UPDATE;
    UPDATE public.social_automation_runs
       SET status = p_status, details = v_details, updated_at = p_now
     WHERE id = v_id;
    IF v_old IS NOT DISTINCT FROM p_status THEN
      RETURN v_id;
    END IF;
  END IF;

  INSERT INTO public.social_activity_log (actor_id, actor_email, action, status, details, created_at)
  VALUES (NULL, 'automation', 'social.automation_run',
          CASE WHEN p_status = 'error' THEN 'error' ELSE 'success' END,
          jsonb_build_object('workflow', p_workflow, 'event_id', p_event_id, 'run_status', p_status, 'previous', v_old),
          p_now);
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Function privileges: service role only (same rule as 0001 section 12)
-- ---------------------------------------------------------------------------

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
