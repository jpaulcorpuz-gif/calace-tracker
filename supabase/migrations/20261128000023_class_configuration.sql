-- Class Configuration page (admins only).
-- 1. Seats per facility for each CNA start date (empty = the default seat count, 13).
alter table public.cohort_sites add column if not exists seats integer check (seats is null or seats between 1 and 200);

-- 2. Official class list for RNA, HHA, BLS and CEU. Sign-ups still come from the forms; this list drives date filters and the Schedule.
create table if not exists public.program_classes (
  id bigint generated always as identity primary key,
  program text not null check (program in ('rna', 'hha', 'bls', 'ceu')),
  title text,                                   -- e.g. a CEU topic; optional for the others
  day date not null,                            -- start / class date
  end_day date,
  start_time time,
  end_time time,
  site_id bigint references public.sites(id) on delete set null,
  location text,                                -- free text when it isn't one of the clinical facilities
  instructor text,
  seats integer check (seats is null or seats between 1 and 500),
  notes text,
  archived boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_day is null or end_day >= day)
);
create index if not exists program_classes_day on public.program_classes (program, day);
alter table public.program_classes enable row level security;
create policy "read classes" on public.program_classes for select to authenticated using ((select private.is_staff()));
create policy "manage classes" on public.program_classes for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- 3. Start dates, facilities and facility schedules: only admins change them now.
alter policy "manage start dates" on public.cohorts using ((select private.is_admin())) with check ((select private.is_admin()));
alter policy "manage sites" on public.sites using ((select private.is_admin())) with check ((select private.is_admin()));
alter policy "manage site schedule" on public.cohort_sites using ((select private.is_admin())) with check ((select private.is_admin()));

-- 4. Log changes to the class setup.
create or replace function private.log_class_setup() returns trigger
language plpgsql security definer set search_path = '' as $$
declare what text; label text; r record;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if tg_table_name = 'cohorts' then
    label := case r.program when 'in_person' then 'CNA In-Person' else 'CNA Hybrid' end || ' start ' || to_char(r.start_date, 'Mon DD, YYYY');
  elsif tg_table_name = 'sites' then
    label := 'Facility ' || r.name;
  else
    label := upper(r.program) || ' class ' || to_char(r.day, 'Mon DD, YYYY') || coalesce(' (' || r.title || ')', '');
  end if;
  what := case tg_op when 'INSERT' then 'Class setup added' when 'DELETE' then 'Class setup removed' else 'Class setup changed' end;
  if tg_table_name = 'program_classes' then
    if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, private.actor()); end if;
    if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  end if;
  insert into public.activity_log (user_email, action, student_name, details) values (private.actor(), what, label, null);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger cohorts_log_setup after insert or update or delete on public.cohorts for each row execute function private.log_class_setup();
create trigger sites_log_setup after insert or update or delete on public.sites for each row execute function private.log_class_setup();
create trigger program_classes_log_setup before insert or update or delete on public.program_classes for each row execute function private.log_class_setup();
