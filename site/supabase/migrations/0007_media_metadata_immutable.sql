-- Approval rechecks the painted copy from the attached image's card_spec.
-- Keep that evidence, its brand, and the object's identity immutable alongside
-- the bytes/hash. created_by remains nullable for auth.users ON DELETE SET NULL;
-- alt_text remains the mutable library suggestion, not the frozen attachment.
CREATE OR REPLACE FUNCTION public.social_guard_media()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.mime IS DISTINCT FROM OLD.mime
     OR NEW.width IS DISTINCT FROM OLD.width
     OR NEW.height IS DISTINCT FROM OLD.height
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.card_spec IS DISTINCT FROM OLD.card_spec
     OR NEW.format IS DISTINCT FROM OLD.format
     OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'SOCIAL_MEDIA_IMMUTABLE'
      USING DETAIL = 'media bytes and metadata are immutable; upload or render a new image instead';
  END IF;
  RETURN NEW;
END;
$$;
