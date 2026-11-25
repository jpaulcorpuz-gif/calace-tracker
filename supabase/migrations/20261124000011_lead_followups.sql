-- Leads page: when each follow-up email was sent (null = not sent yet). The existing student log trigger records every change.
alter table public.students
  add column if not exists followup_1_at timestamptz,
  add column if not exists followup_2_at timestamptz,
  add column if not exists followup_3_at timestamptz;
