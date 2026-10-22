ALTER TABLE public.social_media DROP CONSTRAINT social_media_kind_check,
  DROP CONSTRAINT social_media_mime_check, DROP CONSTRAINT social_media_bytes_check;
ALTER TABLE public.social_media ADD COLUMN duration_seconds double precision;
ALTER TABLE public.social_media ADD CONSTRAINT social_media_kind_check CHECK(kind IN ('image','video')),
  ADD CONSTRAINT social_media_mime_check CHECK(mime IN ('image/png','image/jpeg','image/webp','video/mp4')),
  ADD CONSTRAINT social_media_bytes_check CHECK(bytes > 0 AND bytes <= CASE WHEN kind='video' THEN 134217728 ELSE 8388608 END),
  ADD CONSTRAINT social_media_video_check CHECK(
    (kind='image' AND mime LIKE 'image/%' AND duration_seconds IS NULL) OR
    (kind='video' AND mime='video/mp4' AND duration_seconds IS NOT NULL AND duration_seconds>0 AND duration_seconds<=43200 AND card_spec IS NULL)
  );
ALTER TABLE public.social_upload_tickets DROP CONSTRAINT social_upload_tickets_mime_check;
ALTER TABLE public.social_upload_tickets ADD CONSTRAINT social_upload_tickets_mime_check CHECK(mime IN ('image/jpeg','image/png','image/webp','video/mp4'));
UPDATE storage.buckets SET file_size_limit=134217728,
  allowed_mime_types=ARRAY['image/png','image/jpeg','image/webp','video/mp4'] WHERE id='social-media';

-- Duration is immutable wherever the existing attachment immutability guard is
-- active. Old deployed hash vectors are unchanged: media hashes cover the bytes.
CREATE OR REPLACE FUNCTION public.social_video_metadata_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'SOCIAL_MEDIA_IMMUTABLE';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER social_video_metadata_immutable BEFORE UPDATE ON public.social_media
  FOR EACH ROW EXECUTE FUNCTION public.social_video_metadata_immutable();

-- Historical YouTube rows stay manual. Native YouTube supports an approved
-- video, so automatic eligibility is determined per account rather than by the
-- platform alone. Preserve all old function logic except this explicit gate.
ALTER TABLE public.social_accounts DROP CONSTRAINT social_accounts_manual_only_platforms;
ALTER TABLE public.social_accounts ADD CONSTRAINT social_accounts_manual_only_platforms
  CHECK(platform<>ALL(public.social_manual_only_platforms()) OR mode='manual' OR (platform='youtube' AND publishing_backend='native'));
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_functiondef('public.social_native_connect(text,text,text,text,text,text,uuid,text,jsonb,timestamp with time zone,uuid,timestamp with time zone)'::regprocedure) INTO definition;
  definition := replace(definition,'v_manual := p_platform = ANY(public.social_manual_only_platforms());',
    'v_manual := p_platform = ANY(public.social_manual_only_platforms()) AND p_platform <> ''youtube'';');
  -- Native rules make video/privacy validation visible in both composer and server.
  definition := replace(definition,'RETURN v_account;',
    'UPDATE public.social_accounts SET rules = rules || jsonb_build_object(''native'',true) || CASE WHEN p_platform = ''tiktok'' THEN jsonb_build_object(''privacy_level_options'',p_metadata->''privacyLevelOptions'') ELSE ''{}''::jsonb END WHERE id=v_account; RETURN v_account;');
  EXECUTE definition;
END; $$;
CREATE OR REPLACE FUNCTION public.social_guard_manual_only_platform()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.mode='auto' AND NEW.platform=ANY(public.social_manual_only_platforms()) AND
    NOT(NEW.platform='youtube' AND NEW.publishing_backend='native') THEN
    RAISE EXCEPTION 'SOCIAL_MANUAL_ONLY_PLATFORM' USING DETAIL=NEW.platform;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.social_video_metadata_immutable() FROM PUBLIC,anon,authenticated;
