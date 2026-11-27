-- Destructive rollback: ONLY these newly created feedback objects.
-- Export any wanted feedback first. No CASCADE; unexpected dependencies block.
BEGIN;
DO $$
BEGIN
  IF to_regnamespace('zzb_feedback_private') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles u ON u.oid = m.member
      WHERE m.roleid IN ('zzb_feedback_intake'::regrole,'zzb_feedback_retention'::regrole,'zzb_feedback_executor'::regrole)
        AND u.rolname <> current_user
    ) THEN RAISE EXCEPTION 'Unbind the feedback database logins before rollback'; END IF;
    GRANT zzb_feedback_executor TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    DROP FUNCTION zzb_feedback_private.zzb_feedback_cleanup();
    DROP FUNCTION zzb_feedback_private.zzb_feedback_delete(uuid,text);
    DROP FUNCTION zzb_feedback_private.zzb_feedback_submit(uuid,jsonb,text,text);
    DROP FUNCTION zzb_feedback_private.zzb_feedback_take_quota(text);
    DROP FUNCTION zzb_feedback_private.require_login(regrole);
    DROP SCHEMA zzb_feedback_private RESTRICT;
    DROP POLICY zzb_feedback_internal ON public.zzb_feedback_reports;
    DROP POLICY zzb_feedback_internal ON public.zzb_feedback_tombstones;
    DROP POLICY zzb_feedback_internal ON public.zzb_feedback_counters;
    REVOKE ALL ON public.zzb_feedback_reports, public.zzb_feedback_tombstones, public.zzb_feedback_counters FROM zzb_feedback_executor;
    REVOKE USAGE ON SCHEMA public FROM zzb_feedback_executor;
    DROP ROLE zzb_feedback_intake, zzb_feedback_retention, zzb_feedback_executor;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.zzb_feedback_cleanup();
DROP FUNCTION IF EXISTS public.zzb_feedback_delete(uuid,text);
DROP FUNCTION IF EXISTS public.zzb_feedback_submit(uuid,jsonb,text,text);
DROP FUNCTION IF EXISTS public.zzb_feedback_take_quota(text);
DROP TABLE public.zzb_feedback_counters;
DROP TABLE public.zzb_feedback_tombstones;
DROP TABLE public.zzb_feedback_reports;
COMMIT;
