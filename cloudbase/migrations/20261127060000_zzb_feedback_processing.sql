-- Private maintainer triage. Receipt identity and retry comparison use the original payload.
BEGIN;

ALTER TABLE public.zzb_feedback_reports
  ADD COLUMN processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'in_progress', 'resolved'));

CREATE INDEX zzb_feedback_reports_inbox_order
  ON public.zzb_feedback_reports (accepted_at DESC, report_id DESC);

COMMIT;
