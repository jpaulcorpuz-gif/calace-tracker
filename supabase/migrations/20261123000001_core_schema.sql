-- CAL ACE Student Tracker: step 1 schema.
-- Replaces the Project1 Students tab and Class Config with real tables.
-- Every table is locked to signed-in staff listed in public.staff.

create schema if not exists private;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Staff list and access helpers
-- ---------------------------------------------------------------------------
create table public.staff (
  email      text primary key check (email = lower(email)),
  full_name  text,
  role       text not null default 'staff' check (role in ('staff', 'lead', 'admin')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table public.staff is 'People allowed to sign in to the tracker.';

create or replace function private.current_email()
returns text language sql stable set search_path = '' as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function private.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.active and s.email = private.current_email()
  )
$$;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.active and s.role = 'admin' and s.email = private.current_email()
  )
$$;

grant execute on function private.current_email(), private.is_staff(), private.is_admin() to authenticated;

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Class configuration
-- ---------------------------------------------------------------------------
create table public.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table public.settings is 'seat_cap, waitlist_cap, pay_plans, notices and other school-wide settings.';

create table public.sites (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  short_name text not null,
  city       text,
  schedules  text not null default 'both' check (schedules in ('weekday', 'weekend', 'both')),
  kind       text not null default 'clinical' check (kind in ('clinical', 'waitlist', 'in_person')),
  active     boolean not null default true,
  sort_order integer not null default 0
);

create table public.cohorts (
  id             bigint generated always as identity primary key,
  program        text not null check (program in ('hybrid', 'in_person')),
  start_date     date not null,
  weekday_end    date,
  weekend_end    date,
  seats          integer,
  waitlist_seats integer,
  closes_on      date,
  open           boolean not null default true,
  archived       boolean not null default false,
  unique (program, start_date)
);
comment on column public.cohorts.seats is 'In-Person classes only; Hybrid uses settings.seat_cap per site and schedule.';

create table public.cohort_sites (
  cohort_id    bigint not null references public.cohorts (id) on delete cascade,
  site_id      bigint not null references public.sites (id) on delete cascade,
  availability text not null check (availability in ('off', 'weekday', 'weekend', 'both')),
  primary key (cohort_id, site_id)
);
create index cohort_sites_site_id_idx on public.cohort_sites (site_id);

-- ---------------------------------------------------------------------------
-- Students
-- ---------------------------------------------------------------------------
create table public.students (
  id                  uuid primary key default gen_random_uuid(),
  student_code        text unique,
  program             text not null default 'hybrid' check (program in ('hybrid', 'in_person')),
  pay_plan            text not null default 'standard' check (pay_plan in ('standard', 'promo_50', 'in_person')),
  first_name          text not null,
  last_name           text not null,
  email               text,
  phone               text,
  address             text,
  date_of_birth       date,
  gender              text,
  emergency_name      text,
  emergency_phone     text,
  cohort_id           bigint references public.cohorts (id) on delete set null,
  schedule            text check (schedule in ('weekday', 'weekend')),
  site_id             bigint references public.sites (id) on delete set null,
  end_date            date,
  waitlist            boolean not null default false,
  withdrawn           boolean not null default false,
  dropped             boolean not null default false,
  -- requirements and training
  waiver_minor        boolean not null default false,
  form_283b           boolean not null default false,
  live_scan           boolean not null default false,
  tb_test             boolean not null default false,
  physical_exam       boolean not null default false,
  onboarding          boolean not null default false,
  valid_id            boolean not null default false,
  orientation         boolean not null default false,
  skills_checklist    boolean not null default false,
  theory_attendance   boolean not null default false,
  clinical_attendance boolean not null default false,
  quizzes             boolean not null default false,
  final_exam          boolean not null default false,
  evaluation          boolean not null default false,
  oasys_status        text,
  english_score       text,
  notes               text,
  notes_by            text,
  portal_invite       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index students_email_key on public.students (lower(email)) where email is not null;
create index students_cohort_id_idx on public.students (cohort_id);
create index students_site_id_idx on public.students (site_id);
create trigger students_touch before update on public.students
  for each row execute function private.touch_updated_at();

-- One row per amount received. A stage is paid when its rows add up to the plan amount.
create table public.payments (
  id              bigint generated always as identity primary key,
  student_id      uuid not null references public.students (id) on delete cascade,
  stage           text not null check (stage in ('registration', 'reg_balance', 'first_partial', 'final')),
  amount          numeric(10, 2) not null check (amount <> 0),
  method          text check (method in ('stripe', 'zelle', 'cash', 'terminal', 'check')),
  paid_on         date,
  note            text,
  source          text not null default 'manual' check (source in ('manual', 'stripe', 'import')),
  stripe_event_id text unique,
  created_by      text not null default private.current_email(),
  created_at      timestamptz not null default now()
);
create index payments_student_id_idx on public.payments (student_id);

create table public.student_files (
  id           bigint generated always as identity primary key,
  student_id   uuid not null references public.students (id) on delete cascade,
  kind         text not null check (kind in ('283b_signed', '283b_unsigned', 'live_scan', 'tb_test', 'physical_exam',
                                             'valid_id', 'photo', 'theory_certificate', 'cna_completion', 'waiver', 'other')),
  url          text,
  storage_path text,
  uploaded_by  text not null default private.current_email(),
  uploaded_at  timestamptz not null default now(),
  check (url is not null or storage_path is not null)
);
create index student_files_student_id_idx on public.student_files (student_id);

create table public.email_sends (
  id         bigint generated always as identity primary key,
  student_id uuid not null references public.students (id) on delete cascade,
  kind       text not null,
  subject    text,
  sent_at    timestamptz not null default now(),
  sent_by    text not null default private.current_email()
);
create index email_sends_student_id_idx on public.email_sends (student_id);

create table public.removed_students (
  email      text primary key check (email = lower(email)),
  removed_at timestamptz not null default now(),
  removed_by text not null default private.current_email()
);
comment on table public.removed_students is 'Deleted students, so the portal never re-adds them.';

-- ---------------------------------------------------------------------------
-- Activity log, written by triggers so no change can skip it
-- ---------------------------------------------------------------------------
create table public.activity_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  user_email   text not null,
  action       text not null,
  student_id   uuid,
  student_name text,
  field        text,
  old_value    text,
  new_value    text,
  details      text
);
create index activity_log_at_idx on public.activity_log (at desc);
create index activity_log_student_idx on public.activity_log (student_id, at desc);

create or replace function private.actor()
returns text language sql stable set search_path = '' as $$
  select coalesce(nullif(private.current_email(), ''), 'system')
$$;

create or replace function private.log_student_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  k text;
  o jsonb;
  n jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.activity_log (user_email, action, student_id, student_name, details)
    values (private.actor(), 'Student added', new.id, new.last_name || ', ' || new.first_name, new.program);
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.activity_log (user_email, action, student_id, student_name, details)
    values (private.actor(), 'Student deleted', old.id, old.last_name || ', ' || old.first_name, old.email);
    return old;
  end if;

  o := to_jsonb(old);
  n := to_jsonb(new);
  for k in select jsonb_object_keys(n) loop
    continue when k in ('updated_at', 'created_at');
    if (o -> k) is distinct from (n -> k) then
      insert into public.activity_log (user_email, action, student_id, student_name, field, old_value, new_value)
      values (private.actor(), 'Field changed', new.id, new.last_name || ', ' || new.first_name, k, o ->> k, n ->> k);
    end if;
  end loop;
  return new;
end $$;

create trigger students_log after insert or update or delete on public.students
  for each row execute function private.log_student_change();

create or replace function private.log_payment_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r public.payments;
  s_name text;
  label text;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  select last_name || ', ' || first_name into s_name from public.students where id = r.student_id;
  label := r.stage || ' $' || r.amount::text
           || coalesce(' ' || r.method, '')
           || coalesce(' ' || to_char(r.paid_on, 'MM/DD/YYYY'), '');
  insert into public.activity_log (user_email, action, student_id, student_name, field, old_value, new_value, details)
  values (
    private.actor(),
    case tg_op when 'INSERT' then 'Payment recorded' when 'DELETE' then 'Payment removed' else 'Payment edited' end,
    r.student_id, s_name, 'payment:' || r.stage,
    case when tg_op <> 'INSERT' then old.amount::text end,
    case when tg_op <> 'DELETE' then new.amount::text end,
    label
  );
  return r;
end $$;

create trigger payments_log after insert or update or delete on public.payments
  for each row execute function private.log_payment_change();

-- ---------------------------------------------------------------------------
-- Row level security: staff only
-- ---------------------------------------------------------------------------
alter table public.staff            enable row level security;
alter table public.settings         enable row level security;
alter table public.sites            enable row level security;
alter table public.cohorts          enable row level security;
alter table public.cohort_sites     enable row level security;
alter table public.students         enable row level security;
alter table public.payments         enable row level security;
alter table public.student_files    enable row level security;
alter table public.email_sends      enable row level security;
alter table public.removed_students enable row level security;
alter table public.activity_log     enable row level security;

create policy "staff read staff list" on public.staff
  for select to authenticated using ((select private.is_staff()));
create policy "admins manage staff list" on public.staff
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

do $$
declare t text;
begin
  foreach t in array array['settings', 'sites', 'cohorts', 'cohort_sites', 'students',
                           'payments', 'student_files', 'email_sends'] loop
    execute format(
      'create policy "staff full access" on public.%I for all to authenticated
         using ((select private.is_staff())) with check ((select private.is_staff()))', t);
  end loop;
end $$;

create policy "staff read removed" on public.removed_students
  for select to authenticated using ((select private.is_staff()));
create policy "staff add removed" on public.removed_students
  for insert to authenticated with check ((select private.is_staff()));

create policy "staff read log" on public.activity_log
  for select to authenticated using ((select private.is_staff()));
create policy "staff add own log entries" on public.activity_log
  for insert to authenticated
  with check ((select private.is_staff()) and user_email = (select private.current_email()));
