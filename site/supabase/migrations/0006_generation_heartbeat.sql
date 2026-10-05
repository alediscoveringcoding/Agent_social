-- W4: generation keeps its lease across the generation and repair passes.
CREATE OR REPLACE FUNCTION public.social_generation_heartbeat(
  p_request uuid, p_worker_id text, p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  g public.social_generation_requests%ROWTYPE;
  v_expires timestamptz := p_now + interval '10 minutes';
BEGIN
  SELECT * INTO g FROM public.social_generation_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'NOT_FOUND', 'message', 'No such request');
  END IF;
  IF g.status <> 'running' OR g.lease_owner IS DISTINCT FROM p_worker_id
     OR g.lease_expires_at IS NULL OR g.lease_expires_at <= p_now THEN
    RETURN public.social_lease_lost();
  END IF;
  UPDATE public.social_generation_requests
     SET lease_expires_at = v_expires, updated_at = p_now
   WHERE id = p_request;
  RETURN jsonb_build_object('ok', true, 'lease_expires_at', v_expires);
END;
$$;

REVOKE ALL ON FUNCTION public.social_generation_heartbeat(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_generation_heartbeat(uuid, text, timestamptz) TO service_role;
