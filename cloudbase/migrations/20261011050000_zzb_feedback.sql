-- Scope: new public.zzb_feedback_* objects only. Do not reuse existing tables.
-- Apply only through the CloudBase versioned PG migration workflow, after
-- checking object-name collisions and verifying existing-package billing.
BEGIN;

CREATE TABLE public.zzb_feedback_reports (
  report_id uuid PRIMARY KEY,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  delete_token_hash text NOT NULL CHECK (delete_token_hash ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz NOT NULL,
  retained_until timestamptz NOT NULL,
  retry_until timestamptz NOT NULL,
  CHECK (retained_until = accepted_at + interval '2160 hours')
);
CREATE INDEX zzb_feedback_reports_retention ON public.zzb_feedback_reports (retained_until);
CREATE TABLE public.zzb_feedback_tombstones (
  report_id uuid PRIMARY KEY,
  delete_token_hash text NOT NULL CHECK (delete_token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX zzb_feedback_tombstones_expiry ON public.zzb_feedback_tombstones (expires_at);
CREATE TABLE public.zzb_feedback_counters (
  bucket text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  used integer NOT NULL CHECK (used >= 0)
);
ALTER TABLE public.zzb_feedback_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zzb_feedback_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zzb_feedback_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zzb_feedback_reports, public.zzb_feedback_tombstones, public.zzb_feedback_counters FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zzb_feedback_reports, public.zzb_feedback_tombstones, public.zzb_feedback_counters TO service_role;

CREATE FUNCTION public.zzb_feedback_take_quota(p_action text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_day timestamptz := date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_minute timestamptz := date_trunc('minute', v_now);
  v_day_key text;
  v_minute_key text;
  v_daily integer;
  v_minutely integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_action NOT IN ('submit', 'submit_new', 'delete') OR p_action IS NULL THEN RETURN false; END IF;
  -- Submission admission counts all attempts per minute. Only an actual new
  -- report consumes the UTC daily report budget, after deduplication.
  IF p_action = 'submit' THEN
    v_minute_key := 'submit:minute:' || extract(epoch FROM v_minute)::bigint::text;
    INSERT INTO public.zzb_feedback_counters(bucket, started_at, used) VALUES (v_minute_key, v_minute, 0) ON CONFLICT DO NOTHING;
    SELECT used INTO v_minutely FROM public.zzb_feedback_counters WHERE bucket = v_minute_key FOR UPDATE;
    IF v_minutely >= 30 THEN RETURN false; END IF;
    UPDATE public.zzb_feedback_counters SET used = used + 1 WHERE bucket = v_minute_key;
    RETURN true;
  END IF;
  IF p_action = 'submit_new' THEN
    v_day_key := 'submit:day:' || extract(epoch FROM v_day)::bigint::text;
    INSERT INTO public.zzb_feedback_counters(bucket, started_at, used) VALUES (v_day_key, v_day, 0) ON CONFLICT DO NOTHING;
    SELECT used INTO v_daily FROM public.zzb_feedback_counters WHERE bucket = v_day_key FOR UPDATE;
    IF v_daily >= 500 THEN RETURN false; END IF;
    UPDATE public.zzb_feedback_counters SET used = used + 1 WHERE bucket = v_day_key;
    RETURN true;
  END IF;
  v_day_key := p_action || ':day:' || extract(epoch FROM v_day)::bigint::text;
  v_minute_key := p_action || ':minute:' || extract(epoch FROM v_minute)::bigint::text;
  INSERT INTO public.zzb_feedback_counters(bucket, started_at, used) VALUES (v_day_key, v_day, 0) ON CONFLICT DO NOTHING;
  INSERT INTO public.zzb_feedback_counters(bucket, started_at, used) VALUES (v_minute_key, v_minute, 0) ON CONFLICT DO NOTHING;
  -- Consistent lock order makes quota atomic across all function instances.
  SELECT used INTO v_daily FROM public.zzb_feedback_counters WHERE bucket = v_day_key FOR UPDATE;
  SELECT used INTO v_minutely FROM public.zzb_feedback_counters WHERE bucket = v_minute_key FOR UPDATE;
  IF v_daily >= 500 OR v_minutely >= 30 THEN RETURN false; END IF;
  UPDATE public.zzb_feedback_counters SET used = used + 1 WHERE bucket IN (v_day_key, v_minute_key);
  RETURN true;
END $$;

CREATE FUNCTION public.zzb_feedback_submit(p_report_id uuid, p_payload jsonb, p_payload_hash text, p_delete_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_created timestamptz;
  v_retry timestamptz;
  v_existing public.zzb_feedback_reports%ROWTYPE;
  v_tombstone public.zzb_feedback_tombstones%ROWTYPE;
BEGIN
  -- CloudBase RPC currently does not enforce GRANT EXECUTE. Keep this guard
  -- inside EVERY function; NULL/no JWT must fail, too.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_report_id IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
    OR p_payload_hash IS NULL OR p_payload_hash !~ '^[a-f0-9]{64}$'
    OR p_delete_token_hash IS NULL OR p_delete_token_hash !~ '^[a-f0-9]{64}$'
    OR octet_length(p_payload::text) > 65536
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '1'
    OR p_payload->>'reportId' IS DISTINCT FROM p_report_id::text
    OR p_payload->>'deleteTokenHash' IS DISTINCT FROM p_delete_token_hash THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  BEGIN
    v_created := (p_payload->>'createdAt')::timestamptz;
    v_retry := (p_payload->>'retryUntil')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN jsonb_build_object('status', 'invalid');
  END;
  IF v_created IS NULL OR v_retry IS NULL OR v_retry <> v_created + interval '24 hours' OR v_created > v_now + interval '5 minutes' THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  IF v_retry <= v_now THEN RETURN jsonb_build_object('status', 'expired'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_report_id::text, 0));
  IF NOT public.zzb_feedback_take_quota('submit') THEN RETURN jsonb_build_object('status', 'rate_limited'); END IF;
  SELECT * INTO v_tombstone FROM public.zzb_feedback_tombstones WHERE report_id = p_report_id;
  IF FOUND AND v_tombstone.expires_at > v_now THEN RETURN jsonb_build_object('status', 'expired'); END IF;
  SELECT * INTO v_existing FROM public.zzb_feedback_reports WHERE report_id = p_report_id;
  IF FOUND THEN
    IF v_existing.payload_hash <> p_payload_hash OR v_existing.payload <> p_payload OR v_existing.delete_token_hash <> p_delete_token_hash THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    RETURN jsonb_build_object('status', 'duplicate', 'receipt', jsonb_build_object('schemaVersion', 1, 'reportId', p_report_id, 'acceptedAt', v_existing.accepted_at, 'retainedUntil', v_existing.retained_until));
  END IF;
  IF NOT public.zzb_feedback_take_quota('submit_new') THEN RETURN jsonb_build_object('status', 'rate_limited'); END IF;
  INSERT INTO public.zzb_feedback_reports(report_id, payload, payload_hash, delete_token_hash, accepted_at, retained_until, retry_until)
    VALUES (p_report_id, p_payload, p_payload_hash, p_delete_token_hash, v_now, v_now + interval '2160 hours', v_retry);
  RETURN jsonb_build_object('status', 'accepted', 'receipt', jsonb_build_object('schemaVersion', 1, 'reportId', p_report_id, 'acceptedAt', v_now, 'retainedUntil', v_now + interval '2160 hours'));
END $$;

CREATE FUNCTION public.zzb_feedback_delete(p_report_id uuid, p_delete_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_hash text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_report_id IS NULL OR p_delete_token_hash IS NULL OR p_delete_token_hash !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status', 'invalid'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_report_id::text, 0));
  IF NOT public.zzb_feedback_take_quota('delete') THEN RETURN jsonb_build_object('status', 'rate_limited'); END IF;
  SELECT delete_token_hash INTO v_hash FROM public.zzb_feedback_reports WHERE report_id = p_report_id;
  IF FOUND AND v_hash <> p_delete_token_hash THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;
  SELECT delete_token_hash INTO v_hash FROM public.zzb_feedback_tombstones WHERE report_id = p_report_id AND expires_at > v_now;
  IF FOUND AND v_hash <> p_delete_token_hash THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;
  DELETE FROM public.zzb_feedback_reports WHERE report_id = p_report_id;
  INSERT INTO public.zzb_feedback_tombstones(report_id, delete_token_hash, expires_at)
    VALUES (p_report_id, p_delete_token_hash, v_now + interval '25 hours')
    ON CONFLICT (report_id) DO UPDATE SET delete_token_hash = EXCLUDED.delete_token_hash, expires_at = EXCLUDED.expires_at
      WHERE public.zzb_feedback_tombstones.expires_at <= v_now;
  RETURN jsonb_build_object('status', 'deleted');
END $$;

CREATE FUNCTION public.zzb_feedback_cleanup() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_reports integer; v_tombstones integer; v_counters integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.zzb_feedback_reports WHERE retained_until <= clock_timestamp();
  GET DIAGNOSTICS v_reports = ROW_COUNT;
  DELETE FROM public.zzb_feedback_tombstones WHERE expires_at <= clock_timestamp();
  GET DIAGNOSTICS v_tombstones = ROW_COUNT;
  DELETE FROM public.zzb_feedback_counters WHERE started_at < clock_timestamp() - interval '48 hours';
  GET DIAGNOSTICS v_counters = ROW_COUNT;
  RETURN jsonb_build_object('reportsDeleted', v_reports, 'tombstonesDeleted', v_tombstones, 'countersDeleted', v_counters);
END $$;

REVOKE ALL ON FUNCTION public.zzb_feedback_take_quota(text), public.zzb_feedback_submit(uuid,jsonb,text,text), public.zzb_feedback_delete(uuid,text), public.zzb_feedback_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zzb_feedback_take_quota(text), public.zzb_feedback_submit(uuid,jsonb,text,text), public.zzb_feedback_delete(uuid,text), public.zzb_feedback_cleanup() TO service_role;
COMMIT;
