-- The official CAL ACE Program Calendars sheet (Cohorts + Cells tabs) is the source of truth for class dates.
-- The "calendar" Edge Function reads it every hour: end dates, new start dates and class days are applied by
-- themselves; anything that would move or remove enrolled students waits in calendar_changes for an admin.

-- Every class day from the Cells tab: theory, makeup, clin (clinical), cmk (clinical make-up), hol (holiday).
create table if not exists public.class_days (
  cohort_id bigint not null references public.cohorts(id) on delete cascade,
  track text not null check (track in ('weekday', 'weekend', 'in_person')),
  day date not null,
  kind text not null,
  label text,
  detail text,
  primary key (cohort_id, track, day)
);
alter table public.class_days enable row level security;
create policy "read class days" on public.class_days for select to authenticated using ((select private.is_staff()));

-- The calendar's title and notes for each start date (e.g. holiday adjustments).
alter table public.cohorts add column if not exists calendar_title text, add column if not exists calendar_note text;

-- Changes from the calendar that need an admin, because enrolled students would be moved or lose their class.
create table if not exists public.calendar_changes (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('move_start', 'remove')),
  cohort_id bigint references public.cohorts(id) on delete cascade,
  program text not null,
  from_start date,
  to_start date,
  students integer not null default 0,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
create unique index if not exists calendar_changes_open on public.calendar_changes (kind, cohort_id, coalesce(to_start, '1900-01-01'::date)) where status = 'pending';
alter table public.calendar_changes enable row level security;
create policy "read calendar changes" on public.calendar_changes for select to authenticated using ((select private.is_staff()));

-- Hourly sync (run in the SQL editor / via MCP; shown here for the record):
-- select cron.schedule('calace-official-calendar', '7 * * * *', $$
--   select net.http_post(url := 'https://gtltpewsxxycrmnnhqum.supabase.co/functions/v1/calendar/sync',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select value from private.app_secrets where name = 'cron')),
--     body := '{}'::jsonb) $$);
