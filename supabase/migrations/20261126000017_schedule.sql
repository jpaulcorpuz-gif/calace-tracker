-- Schedule: classes, clinicals and events on a calendar. Repeating entries share a series_id, one row per day.
create table if not exists public.schedule_events (
  id bigint generated always as identity primary key,
  title text not null,
  kind text not null default 'other',          -- theory, clinical, orientation, exam, ceu, bls, event, other
  day date not null,
  start_time time,
  end_time time,
  site_id bigint references public.sites(id) on delete set null,
  instructor text,
  program text,                                 -- hybrid, in_person, rna, hha, bls, ceu (optional)
  cohort_id bigint references public.cohorts(id) on delete set null,
  notes text,
  series_id uuid,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists schedule_events_day on public.schedule_events (day);
create index if not exists schedule_events_series on public.schedule_events (series_id);
alter table public.schedule_events enable row level security;

create policy "read schedule" on public.schedule_events for select to authenticated using ((select private.perm('schedule')) >= 1);
create policy "add schedule" on public.schedule_events for insert to authenticated with check ((select private.perm('schedule')) = 2);
create policy "change schedule" on public.schedule_events for update to authenticated
  using ((select private.perm('schedule')) = 2) with check ((select private.perm('schedule')) = 2);
create policy "remove schedule" on public.schedule_events for delete to authenticated using ((select private.perm('schedule')) = 2);

create or replace function private.log_schedule_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.schedule_events; label text;
begin
  r := coalesce(new, old);
  label := r.title || ' on ' || to_char(r.day, 'Mon DD, YYYY') || coalesce(' at ' || to_char(r.start_time, 'HH12:MI AM'), '');
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, private.actor());
    insert into public.activity_log (user_email, action, student_name, details) values (private.actor(), 'Schedule added', label, r.instructor);
  elsif tg_op = 'DELETE' then
    insert into public.activity_log (user_email, action, student_name, details) values (private.actor(), 'Schedule removed', label, r.instructor);
  else
    new.updated_at := now();
    if (to_jsonb(old) - 'updated_at') is distinct from (to_jsonb(new) - 'updated_at') then
      insert into public.activity_log (user_email, action, student_name, details) values (private.actor(), 'Schedule changed', label, r.instructor);
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger schedule_events_log before insert or update or delete on public.schedule_events
  for each row execute function private.log_schedule_change();

alter publication supabase_realtime add table public.schedule_events;
