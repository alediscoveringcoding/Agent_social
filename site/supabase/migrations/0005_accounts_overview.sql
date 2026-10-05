-- ============================================================================
-- 0005: accounts screen and overview feed (amendment 03, workstream W3).
--
-- What lives here:
--   * account changes from /admin/social/conturi as functions, so each change
--     is checked against the account's jobs under a row lock and applied in
--     one transaction (PRD F1, flow 6.3): brand, mode, status, daily cap,
--     pause, "Open editor" URL, and the name / profile link of a manual-only
--     account;
--   * manual-only accounts (Substack, Product Hunt, any platform): create, and
--     delete while nothing uses them;
--   * "mark as seen" for the social_events feed on the Overview (A10).
--
-- Nothing in 0001 / 0002 changes. Manual handoff uses social_mark_manual_done
-- (0001); duplicating a post uses social_create_post (0001).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Account changes
-- ---------------------------------------------------------------------------
-- p_patch: any of {brand_id, mode, status, daily_cap, paused, open_editor_url,
-- display_name, profile_url}. Only fields that actually change are checked:
--   * mode auto needs a Postiz channel; Substack and Product Hunt stay manual;
--   * status must fit the mode (auto: connected / reconnect_required /
--     developer_setup_required / approval_pending; manual: manual /
--     approval_pending). A mode change without a status picks connected or
--     manual;
--   * auto -> manual is refused while jobs wait for the worker (they would
--     only go stale); manual_pending jobs stay manual after manual -> auto;
--   * a brand change is refused while the account has jobs not yet out;
--   * no brand = paused; unpausing needs a brand;
--   * the cap cannot drop below what is already scheduled on a coming
--     Bucharest day (the claim would hold those jobs back until stale);
--   * name and profile link belong to Postiz for a synced account.
-- Returns {changed: [...], before: {...}, after: {...}} for the activity log.

CREATE OR REPLACE FUNCTION public.social_admin_update_account(
  p_account uuid, p_patch jsonb, p_actor uuid, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_old public.social_accounts%ROWTYPE;
  v_new public.social_accounts%ROWTYPE;
  v_bad text;
  v_open integer;
  v_cap numeric;
  r record;
  v_before jsonb;
  v_after jsonb;
  v_changed jsonb;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED';
  END IF;
  IF jsonb_typeof(v_patch) <> 'object' THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PATCH';
  END IF;
  SELECT k INTO v_bad FROM jsonb_object_keys(v_patch) k
   WHERE k NOT IN ('brand_id', 'mode', 'status', 'daily_cap', 'paused', 'open_editor_url', 'display_name', 'profile_url')
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PATCH' USING DETAIL = format('unknown field %s', v_bad);
  END IF;

  SELECT * INTO v_old FROM public.social_accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND';
  END IF;
  v_new := v_old;

  IF v_patch ? 'brand_id' THEN
    v_new.brand_id := nullif(v_patch->>'brand_id', '')::uuid;
    IF v_new.brand_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.social_brands WHERE id = v_new.brand_id) THEN
      RAISE EXCEPTION 'SOCIAL_BRAND_NOT_FOUND';
    END IF;
  END IF;

  IF v_patch ? 'mode' THEN
    v_new.mode := v_patch->>'mode';
    IF v_new.mode IS NULL OR v_new.mode NOT IN ('auto', 'manual') THEN
      RAISE EXCEPTION 'SOCIAL_BAD_MODE';
    END IF;
  END IF;

  IF v_patch ? 'status' THEN
    v_new.status := v_patch->>'status';
    IF v_new.status IS NULL OR v_new.status NOT IN
       ('connected', 'reconnect_required', 'developer_setup_required', 'approval_pending', 'manual') THEN
      RAISE EXCEPTION 'SOCIAL_BAD_STATUS';
    END IF;
  ELSIF v_new.mode IS DISTINCT FROM v_old.mode THEN
    v_new.status := CASE WHEN v_new.mode = 'manual' THEN 'manual' ELSE 'connected' END;
  END IF;

  IF v_patch ? 'daily_cap' THEN
    IF jsonb_typeof(v_patch->'daily_cap') <> 'number' THEN
      RAISE EXCEPTION 'SOCIAL_CAP_RANGE';
    END IF;
    v_cap := (v_patch->>'daily_cap')::numeric;
    IF v_cap <> trunc(v_cap) OR v_cap < 1 OR v_cap > 5 THEN
      RAISE EXCEPTION 'SOCIAL_CAP_RANGE';
    END IF;
    v_new.daily_cap := v_cap::integer;
  END IF;

  IF v_patch ? 'paused' THEN
    IF jsonb_typeof(v_patch->'paused') <> 'boolean' THEN
      RAISE EXCEPTION 'SOCIAL_BAD_PATCH' USING DETAIL = 'paused must be a boolean';
    END IF;
    v_new.paused := (v_patch->>'paused')::boolean;
  END IF;

  IF v_patch ? 'open_editor_url' THEN
    v_new.open_editor_url := nullif(btrim(coalesce(v_patch->>'open_editor_url', '')), '');
    IF v_new.open_editor_url IS NOT NULL
       AND (v_new.open_editor_url !~* '^https?://[^[:space:]]+$' OR length(v_new.open_editor_url) > 2048) THEN
      RAISE EXCEPTION 'SOCIAL_BAD_URL' USING DETAIL = 'open_editor_url';
    END IF;
  END IF;

  IF v_patch ? 'display_name' THEN
    v_new.display_name := btrim(coalesce(v_patch->>'display_name', ''));
    IF v_new.display_name = '' OR length(v_new.display_name) > 120 THEN
      RAISE EXCEPTION 'SOCIAL_NAME_REQUIRED';
    END IF;
  END IF;

  IF v_patch ? 'profile_url' THEN
    v_new.profile_url := nullif(btrim(coalesce(v_patch->>'profile_url', '')), '');
    IF v_new.profile_url IS NOT NULL
       AND (v_new.profile_url !~* '^https?://[^[:space:]]+$' OR length(v_new.profile_url) > 2048) THEN
      RAISE EXCEPTION 'SOCIAL_BAD_URL' USING DETAIL = 'profile_url';
    END IF;
  END IF;

  -- No brand, no publishing.
  IF v_new.brand_id IS NULL THEN
    IF v_patch ? 'paused' AND NOT v_new.paused THEN
      RAISE EXCEPTION 'SOCIAL_ACCOUNT_NO_BRAND';
    END IF;
    v_new.paused := true;
  END IF;

  -- Fields Postiz owns.
  IF v_old.postiz_integration_id IS NOT NULL
     AND (v_new.display_name IS DISTINCT FROM v_old.display_name OR v_new.profile_url IS DISTINCT FROM v_old.profile_url) THEN
    RAISE EXCEPTION 'SOCIAL_SYNCED_FIELD';
  END IF;

  IF v_new.mode IS DISTINCT FROM v_old.mode THEN
    IF v_new.mode = 'auto' AND v_new.postiz_integration_id IS NULL THEN
      RAISE EXCEPTION 'SOCIAL_AUTO_NEEDS_POSTIZ';
    END IF;
    IF v_new.mode = 'auto' AND v_new.platform IN ('substack', 'producthunt') THEN
      RAISE EXCEPTION 'SOCIAL_MANUAL_ONLY_PLATFORM';
    END IF;
    IF v_new.mode = 'manual' THEN
      SELECT count(*)::integer INTO v_open FROM public.social_delivery_jobs
       WHERE account_id = p_account AND status IN ('queued', 'claimed');
      IF v_open > 0 THEN
        RAISE EXCEPTION 'SOCIAL_ACCOUNT_HAS_OPEN_JOBS' USING DETAIL = jsonb_build_object('jobs', v_open)::text;
      END IF;
    END IF;
  END IF;

  IF v_new.status IS DISTINCT FROM v_old.status OR v_new.mode IS DISTINCT FROM v_old.mode THEN
    IF (v_new.mode = 'manual' AND v_new.status NOT IN ('manual', 'approval_pending'))
       OR (v_new.mode = 'auto' AND v_new.status = 'manual') THEN
      RAISE EXCEPTION 'SOCIAL_STATUS_FOR_MODE' USING DETAIL = format('%s / %s', v_new.mode, v_new.status);
    END IF;
  END IF;

  IF v_old.brand_id IS NOT NULL AND v_new.brand_id IS DISTINCT FROM v_old.brand_id THEN
    SELECT count(*)::integer INTO v_open FROM public.social_delivery_jobs
     WHERE account_id = p_account
       AND status IN ('queued', 'claimed', 'submitting', 'submitted', 'reconciling', 'manual_pending');
    IF v_open > 0 THEN
      RAISE EXCEPTION 'SOCIAL_ACCOUNT_HAS_OPEN_JOBS' USING DETAIL = jsonb_build_object('jobs', v_open)::text;
    END IF;
  END IF;

  IF v_new.daily_cap < v_old.daily_cap THEN
    FOR r IN
      SELECT public.social_bucharest_day(j.run_at) AS day
        FROM public.social_delivery_jobs j
       WHERE j.account_id = p_account
         AND j.run_at >= (public.social_bucharest_day(p_now)::timestamp AT TIME ZONE 'Europe/Bucharest')
       GROUP BY 1
       ORDER BY 1
    LOOP
      IF public.social_cap_usage(p_account, r.day) > v_new.daily_cap THEN
        RAISE EXCEPTION 'SOCIAL_CAP_BELOW_SCHEDULED'
          USING DETAIL = jsonb_build_object('day', r.day, 'used', public.social_cap_usage(p_account, r.day),
                                            'cap', v_new.daily_cap)::text;
      END IF;
    END LOOP;
  END IF;

  SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb),
         coalesce(jsonb_object_agg(k, to_jsonb(v_old) -> k), '{}'::jsonb),
         coalesce(jsonb_object_agg(k, to_jsonb(v_new) -> k), '{}'::jsonb)
    INTO v_changed, v_before, v_after
    FROM unnest(ARRAY['brand_id', 'mode', 'status', 'daily_cap', 'paused', 'open_editor_url',
                      'display_name', 'profile_url']) AS k
   WHERE (to_jsonb(v_old) -> k) IS DISTINCT FROM (to_jsonb(v_new) -> k);

  IF jsonb_array_length(v_changed) > 0 THEN
    UPDATE public.social_accounts
       SET brand_id = v_new.brand_id, mode = v_new.mode, status = v_new.status, daily_cap = v_new.daily_cap,
           paused = v_new.paused, open_editor_url = v_new.open_editor_url, display_name = v_new.display_name,
           profile_url = v_new.profile_url, updated_at = p_now
     WHERE id = p_account;
  END IF;

  RETURN jsonb_build_object('changed', v_changed, 'before', v_before, 'after', v_after);
END;
$$;

-- A manual-only account (PRD F1): no Postiz channel, mode manual, status
-- manual, not paused (it never publishes by itself). p_fields: {platform,
-- brand_id, display_name, open_editor_url, profile_url, daily_cap}.
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
  IF v_platform IS NULL OR v_platform NOT IN
     ('facebook', 'instagram', 'linkedin-page', 'x', 'devto', 'hashnode', 'substack', 'producthunt') THEN
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

-- Delete a manual-only account that no destination uses (a mistake, a test).
-- A synced account would only come back at the next sync, and one in use is
-- part of the record of what was approved.
CREATE OR REPLACE FUNCTION public.social_admin_delete_account(p_account uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_acc public.social_accounts%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED';
  END IF;
  SELECT * INTO v_acc FROM public.social_accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND';
  END IF;
  IF v_acc.postiz_integration_id IS NOT NULL THEN
    RAISE EXCEPTION 'SOCIAL_ACCOUNT_SYNCED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.social_destinations WHERE account_id = p_account)
     OR EXISTS (SELECT 1 FROM public.social_delivery_jobs WHERE account_id = p_account) THEN
    RAISE EXCEPTION 'SOCIAL_ACCOUNT_IN_USE';
  END IF;
  DELETE FROM public.social_accounts WHERE id = p_account;
  RETURN jsonb_build_object('platform', v_acc.platform, 'display_name', v_acc.display_name, 'brand_id', v_acc.brand_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Event feed: mark as seen (A10)
-- ---------------------------------------------------------------------------
-- p_ids: a JSON array of event ids, or p_up_to: every unseen event up to that
-- id (what the page showed, so an event that arrives meanwhile stays unseen).
-- Returns how many were marked.

CREATE OR REPLACE FUNCTION public.social_mark_events_seen(
  p_actor uuid, p_ids jsonb DEFAULT NULL, p_up_to bigint DEFAULT NULL, p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED';
  END IF;
  IF p_ids IS NULL AND p_up_to IS NULL THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PATCH' USING DETAIL = 'ids or up_to';
  END IF;
  IF p_ids IS NOT NULL AND jsonb_typeof(p_ids) <> 'array' THEN
    RAISE EXCEPTION 'SOCIAL_BAD_PATCH' USING DETAIL = 'ids must be an array';
  END IF;
  WITH s AS (
    UPDATE public.social_events e
       SET seen_at = p_now, seen_by = p_actor
     WHERE e.seen_at IS NULL
       AND (p_up_to IS NULL OR e.id <= p_up_to)
       AND (p_ids IS NULL OR e.id IN (SELECT x::bigint FROM jsonb_array_elements_text(p_ids) x))
    RETURNING 1)
  SELECT count(*)::integer INTO v_count FROM s;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Function privileges: service role only (as in 0001, section 12)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('social_admin_update_account', 'social_admin_create_account',
                         'social_admin_delete_account', 'social_mark_events_seen')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
