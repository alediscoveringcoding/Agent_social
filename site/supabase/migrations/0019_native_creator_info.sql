CREATE OR REPLACE FUNCTION public.social_native_creator_info(p_account uuid,p_actor uuid,p_info jsonb,p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACTOR_REQUIRED'; END IF;
  IF jsonb_typeof(p_info)<>'object' OR jsonb_typeof(p_info->'privacyLevelOptions')<>'array' OR octet_length(p_info::text)>8192 THEN RAISE EXCEPTION 'SOCIAL_BAD_PATCH'; END IF;
  PERFORM 1 FROM public.social_accounts WHERE id=p_account AND platform='tiktok' AND publishing_backend='native' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND'; END IF;
  UPDATE public.social_native_credentials SET metadata=metadata||p_info,updated_at=p_now WHERE account_id=p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOCIAL_NATIVE_CREDENTIALS_REQUIRED'; END IF;
  UPDATE public.social_accounts SET rules=rules||jsonb_build_object('privacy_level_options',p_info->'privacyLevelOptions'),last_synced_at=p_now,updated_at=p_now WHERE id=p_account;
  INSERT INTO public.social_activity_log(actor_id,action,account_id,created_at) VALUES(p_actor,'social.native_creator_refreshed',p_account,p_now);
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.social_native_creator_info(uuid,uuid,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.social_native_creator_info(uuid,uuid,jsonb,timestamptz) TO service_role;
