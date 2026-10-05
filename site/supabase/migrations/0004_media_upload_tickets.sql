-- Durable phase claims prevent upload-ticket replay and racing finalizers.
CREATE TABLE public.social_upload_tickets (
  path text PRIMARY KEY CHECK (path ~ '^staging/[0-9a-f-]{36}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mime text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  expires_at timestamptz NOT NULL,
  phase text NOT NULL DEFAULT 'issued' CHECK (phase IN ('issued', 'uploaded', 'consumed'))
);
ALTER TABLE public.social_upload_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_upload_tickets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.social_upload_tickets TO service_role;

CREATE FUNCTION public.social_take_upload_ticket(p_path text, p_user uuid, p_mime text, p_phase text, p_next text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT ((p_phase = 'issued' AND p_next IN ('uploaded','consumed')) OR (p_phase = 'uploaded' AND p_next = 'consumed')) THEN
    RAISE EXCEPTION 'SOCIAL_BAD_TICKET_PHASE';
  END IF;
  UPDATE social_upload_tickets SET phase = p_next
   WHERE path = p_path AND user_id = p_user AND mime = p_mime AND phase = p_phase AND expires_at > now();
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.social_take_upload_ticket(text,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_take_upload_ticket(text,uuid,text,text,text) TO service_role;
