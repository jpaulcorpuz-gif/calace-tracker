-- Import from the live Project1 Google Sheet.
-- The "drive" Edge Function reads the Sheet (Sheets API, the admin-picked file) and hands the rows to
-- public.import_project1 and public.import_activity_log, which replace the tracker's data in one go.
-- Both functions are callable only by the server (service role).

-- ---------------------------------------------------------------- new columns and tables
alter table public.students add column if not exists lead_stage text;
alter table public.students add column if not exists lead_follow_up text;
alter table public.students add column if not exists source_row integer;
comment on column public.students.source_row is 'Row number in the Project1 Students tab this student was imported from.';
alter table public.email_sends alter column sent_at drop not null;
create index if not exists students_name_key on public.students (lower(last_name || ', ' || first_name));

create table if not exists public.leads (
  id bigint generated always as identity primary key, source_row integer, created text,
  full_name text, email text, phone text, stage text, next_follow_up text,
  data jsonb not null, imported_at timestamptz not null default now()
);
create table if not exists public.rna_hha_registrations (
  id bigint generated always as identity primary key, source_row integer, program text,
  full_name text, email text, phone text, data jsonb not null, imported_at timestamptz not null default now()
);
create table if not exists public.ceu_registrations (
  id bigint generated always as identity primary key, source_row integer,
  full_name text, email text, phone text, data jsonb not null, imported_at timestamptz not null default now()
);
create table if not exists public.bls_registrations (
  id bigint generated always as identity primary key, source_row integer,
  full_name text, email text, phone text, data jsonb not null, imported_at timestamptz not null default now()
);
do $$
declare t text;
begin
  foreach t in array array['leads', 'rna_hha_registrations', 'ceu_registrations', 'bls_registrations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "staff full access" on public.%I for all to authenticated
                      using ((select private.is_staff())) with check ((select private.is_staff()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- parsing helpers
create or replace function private.v(j jsonb, k text) returns text
language sql immutable set search_path = '' as $$ select nullif(btrim(j ->> k), '') $$;

create or replace function private.b(j jsonb, k text) returns boolean
language sql immutable set search_path = '' as $$ select upper(btrim(coalesce(j ->> k, ''))) in ('TRUE', 'YES', 'Y', '✓', 'X') $$;

-- "January 4, 2027", "July 6" (no year), "01/10/1975", "5/27", "2027-01-04", "September 28,. 2027"
create or replace function private.parse_sheet_date(t text, default_year integer default null) returns date
language plpgsql immutable set search_path = '' as $$
declare
  s text := btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g'));
  m text[];
  months text[] := array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
begin
  if s = '' then return null; end if;
  s := regexp_replace(s, ',\s*\.', ',', 'g');
  m := regexp_match(s, '^(\d{4})-(\d{1,2})-(\d{1,2})');
  if m is not null then return make_date(m[1]::int, m[2]::int, m[3]::int); end if;
  m := regexp_match(s, '^(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?');
  if m is not null then
    return make_date(case when m[3] is null then coalesce(default_year, 2026)
                          when length(m[3]) = 2 then 2000 + m[3]::int else m[3]::int end,
                     m[1]::int, m[2]::int);
  end if;
  m := regexp_match(lower(s), '^([a-z]+)\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?');
  if m is not null then
    return make_date(coalesce(m[3]::int, default_year, 2026), array_position(months, left(m[1], 3)), m[2]::int);
  end if;
  return null;
exception when others then return null;
end $$;

-- "7/7/2026 13:39:29" in Los Angeles time
create or replace function private.parse_sheet_ts(t text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if t is null or btrim(t) = '' then return null; end if;
  return (to_timestamp(btrim(t), 'FMMM/FMDD/YYYY FMHH24:MI:SS')::timestamp) at time zone 'America/Los_Angeles';
exception when others then return null;
end $$;

-- Payment note shorthand: "S 5/27 $206", "Stripe-08/24/2026-$800", "Z …", "Ch …", "T …", "… ca", "… st", "… t"
create or replace function private.parse_pay_method(c text) returns text
language sql immutable set search_path = '' as $$
  select case
    when c is null or btrim(c) = '' then null
    when c ~* 'stripe' or c ~* '^\s*s[\s\-$]' or c ~* '\sst\s*$' then 'stripe'
    when c ~* 'zelle' or c ~* '^\s*z[\s\-$]' then 'zelle'
    when c ~* '(^|[^a-z])(check|chk|ch)([^a-z]|$)' then 'check'
    when c ~* 'terminal' or c ~* '^\s*t[\s\-$]' or c ~* '\st\s*$' then 'terminal'
    when c ~* 'cash' or c ~* '^\s*c[\s\-$]' or c ~* '\sca\s*$' then 'cash'
    else null end
$$;

-- First date in the note; a year-less date is placed next to the cohort start.
create or replace function private.parse_pay_date(c text, start_date date) returns date
language plpgsql immutable set search_path = '' as $$
declare d date;
begin
  d := private.parse_sheet_date((regexp_match(coalesce(c, ''), '(\d{1,2}/\d{1,2}(?:/\d{2,4})?)'))[1],
                                coalesce(extract(year from start_date)::int, 2026));
  if d is null or start_date is null then return d; end if;
  if d > start_date + 150 then return (d - interval '1 year')::date; end if;
  if d < start_date - 300 then return (d + interval '1 year')::date; end if;
  return d;
end $$;

-- "Group A Canyon Springs" and "Group Canyon Springs Post Acute - San Jose" both mean Canyon Springs.
create or replace function private.site_short(name text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(split_part(regexp_replace(regexp_replace(btrim(coalesce(name, '')), '^Group\s+', '', 'i'),
                                                        '^[A-Za-z]\s+', ''), ' - ', 1),
                              '\s+(Post Acute|Health Care Center|Healthcare Center|Care Center|Nursing.*)$', '', 'i'))
$$;
create or replace function private.site_key(name text) returns text
language sql immutable set search_path = '' as $$
  select lower(array_to_string((regexp_split_to_array(private.site_short(name), '\s+'))[1:2], ' '))
$$;

-- ---------------------------------------------------------------- main import
create or replace function public.import_project1(payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'America/Los_Angeles')::date;
  plans jsonb;
  who text := coalesce(payload ->> 'imported_by', 'import');
  out jsonb;
begin
  alter table public.students disable trigger students_log;
  alter table public.payments disable trigger payments_log;
  alter table public.student_files disable trigger student_files_log;
  alter table public.student_files disable trigger student_files_tick;

  delete from public.student_files; delete from public.payments; delete from public.email_sends;
  delete from public.students; delete from public.activity_log;
  delete from public.cohort_sites; delete from public.cohorts; delete from public.sites;
  delete from public.leads; delete from public.rna_hha_registrations;
  delete from public.ceu_registrations; delete from public.bls_registrations;
  delete from public.removed_students;

  -- Class Config (raw rows; the first row is the header)
  create temp table cc on commit drop as
  select lower(btrim(r ->> 0)) as typ, nullif(btrim(r ->> 1), '') as name, nullif(btrim(r ->> 2), '') as e1,
         nullif(btrim(r ->> 3), '') as e2, nullif(btrim(r ->> 4), '') as e3, nullif(btrim(r ->> 5), '') as e4,
         nullif(btrim(r ->> 6), '') as e5, i
  from jsonb_array_elements(coalesce(payload -> 'class_config', '[]')) with ordinality x(r, i)
  where i > 1;

  insert into public.settings (key, value)
  select name, to_jsonb(e1::int) from cc where typ = 'setting' and name in ('seat_cap', 'waitlist_cap') and e1 ~ '^\d+$'
  on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into public.settings (key, value)
  select 'notices', coalesce(jsonb_agg(jsonb_build_object('site', name, 'version', e3, 'text', e4) order by i), '[]')
  from cc where typ = 'notice'
  on conflict (key) do update set value = excluded.value, updated_at = now();

  insert into public.sites (name, short_name, city, schedules, kind, sort_order)
  select name, private.site_short(name), nullif(btrim(split_part(name, ' - ', 2)), ''),
         case when lower(e1) in ('weekday', 'weekend', 'both') then lower(e1) else 'both' end,
         case when name ilike 'waitlist%' then 'waitlist' else 'clinical' end,
         row_number() over (order by i)
  from cc where typ = 'site' and name is not null
  on conflict (name) do nothing;

  insert into public.cohorts (program, start_date, weekday_end, weekend_end, open)
  select 'hybrid', d, private.parse_sheet_date(e1, extract(year from d)::int), private.parse_sheet_date(e2, extract(year from d)::int),
         exists (select 1 from cc c2 where c2.typ = 'cohortsite' and private.parse_sheet_date(c2.name) = d and coalesce(c2.e2, 'off') <> 'off')
  from (select *, private.parse_sheet_date(name) as d from cc where typ = 'start') s
  where d is not null
  on conflict (program, start_date) do nothing;

  insert into public.cohorts (program, start_date, weekday_end, seats, waitlist_seats, open, closes_on)
  select 'in_person', d, private.parse_sheet_date(e1, extract(year from d)::int),
         case when e2 ~ '^\d+$' then e2::int end, case when e3 ~ '^\d+$' then e3::int end,
         upper(coalesce(e4, 'TRUE')) = 'TRUE', private.parse_sheet_date(e5, extract(year from d)::int)
  from (select *, private.parse_sheet_date(name) as d from cc where typ = 'inperson') s
  where d is not null
  on conflict (program, start_date) do nothing;

  insert into public.cohort_sites (cohort_id, site_id, availability)
  select c.id, s.id, case when lower(cc.e2) in ('off', 'weekday', 'weekend', 'both') then lower(cc.e2) else 'off' end
  from cc
  join public.cohorts c on c.program = 'hybrid' and c.start_date = private.parse_sheet_date(cc.name)
  join public.sites s on s.name = cc.e1
  where cc.typ = 'cohortsite'
  on conflict do nothing;

  -- Students (objects keyed by header; n is the Sheet row number)
  create temp table st on commit drop as
  select (o ->> '_row')::int as n, o as s,
         case when private.v(o, 'Program') ilike 'in%person%' then 'in_person' else 'hybrid' end as program,
         private.parse_sheet_date(private.v(o, 'Start Date'), 2026) as start_date,
         case lower(coalesce(private.v(o, 'Clinical Preference'), '')) when 'weekend' then 'weekend' when 'weekday' then 'weekday' end as sched,
         private.v(o, 'Clinical Location') as site_raw,
         lower(private.v(o, 'Email')) as email,
         private.v(o, 'Student ID') as code
  from jsonb_array_elements(coalesce(payload -> 'students', '[]')) o
  where coalesce(private.v(o, 'Last Name'), private.v(o, 'First Name')) is not null;

  alter table st add column end_date date;
  update st set end_date = case when e < start_date then (e + interval '1 year')::date else e end
  from (select n as n2, private.parse_sheet_date(private.v(s, 'End Date'), coalesce(extract(year from start_date)::int, 2026)) as e from st) z
  where z.n2 = st.n;

  -- Cohorts that only appear on students (older classes) are added closed, and archived once past.
  insert into public.cohorts (program, start_date, weekday_end, weekend_end, open, archived)
  select program, start_date,
         max(end_date) filter (where sched is distinct from 'weekend'), max(end_date) filter (where sched = 'weekend'),
         false, start_date < today
  from st where start_date is not null
  group by program, start_date
  on conflict (program, start_date) do nothing;

  -- Sites that only appear on students are added as inactive.
  insert into public.sites (name, short_name, city, schedules, kind, active, sort_order)
  select distinct on (private.site_key(site_raw)) site_raw, private.site_short(site_raw),
         nullif(btrim(split_part(site_raw, ' - ', 2)), ''), 'both',
         case when site_raw ~* 'in.?person' then 'in_person' when site_raw ilike 'waitlist%' then 'waitlist' else 'clinical' end,
         false, 100
  from st
  where site_raw is not null
    and not exists (select 1 from public.sites x where x.name = st.site_raw or private.site_key(x.name) = private.site_key(st.site_raw))
  order by private.site_key(site_raw), length(site_raw) desc
  on conflict (name) do nothing;

  alter table st add column email_dup boolean, add column code_dup boolean;
  update st set email_dup = z.rn > 1 from (select n as n2, row_number() over (partition by email order by n) as rn from st where email is not null) z where z.n2 = st.n;
  update st set code_dup = z.rn > 1 from (select n as n2, row_number() over (partition by code order by n) as rn from st where code is not null) z where z.n2 = st.n;

  select value into plans from public.settings where key = 'pay_plans';

  insert into public.students (
    source_row, student_code, program, pay_plan, first_name, last_name, email, phone, address, date_of_birth, gender,
    emergency_name, emergency_phone, cohort_id, schedule, site_id, end_date, waitlist, withdrawn, dropped,
    waiver_minor, form_283b, live_scan, tb_test, physical_exam, onboarding, valid_id, orientation, skills_checklist,
    theory_attendance, clinical_attendance, quizzes, final_exam, evaluation,
    oasys_status, english_score, notes, notes_by, portal_invite, lead_stage, lead_follow_up)
  select
    st.n,
    case when coalesce(st.code_dup, false) then null else st.code end,
    st.program,
    case when st.program = 'in_person' then 'in_person'
         when private.v(s, 'Pay Plan') ilike '%promo%' or coalesce(private.v(s, 'Registration Comment'), '') ~ '\$\s*5[01](\.\d+)?\M' then 'promo_50'
         else 'standard' end,
    coalesce(private.v(s, 'First Name'), ''), coalesce(private.v(s, 'Last Name'), ''),
    case when coalesce(st.email_dup, false) then null else st.email end,
    private.v(s, 'Contact Number'), private.v(s, 'Address'),
    private.parse_sheet_date(private.v(s, 'Date of Birth')),
    private.v(s, 'Gender'), private.v(s, 'Emergency Contact Name'), private.v(s, 'Emergency Contact Number'),
    (select c.id from public.cohorts c where c.program = st.program and c.start_date = st.start_date),
    st.sched,
    (select x.id from public.sites x
      where x.name = st.site_raw or private.site_key(x.name) = private.site_key(st.site_raw)
      order by (x.name = st.site_raw) desc, x.active desc, x.id limit 1),
    st.end_date,
    private.b(s, 'Waitlist'), private.b(s, 'Withdrawn'), private.b(s, 'Dropped'),
    private.b(s, 'WAIVER (FOR MINORS)'), private.b(s, '283b Form'), private.b(s, 'Live Scan'), private.b(s, 'TB Test'),
    private.b(s, 'Physical Exam'), private.b(s, 'Onboarding'), private.v(s, 'Valid ID File') is not null,
    private.b(s, 'Attended Orientation'), private.b(s, 'Skills Checklist'),
    private.b(s, 'Theory Attendance'), private.b(s, 'Clinical Attendance'), private.b(s, 'Quizzes'), private.b(s, 'Final Exam'),
    private.b(s, 'Evaluation'),
    case upper(coalesce(private.v(s, 'OASYS'), '')) when 'TRUE' then 'Submitted' when 'FALSE' then 'Not started' when '' then null else private.v(s, 'OASYS') end,
    private.v(s, 'English Assessment'),
    nullif(concat_ws(E'\n',
      private.v(s, 'Notes'),
      case when coalesce(st.email_dup, false) then 'Project1: email ' || st.email || ' is also on an earlier row, so it was left off this record.' end,
      case when coalesce(st.code_dup, false) then 'Project1: Student ID ' || st.code || ' is also on an earlier row, so it was left off this record.' end,
      case when not private.b(s, 'Registration $200') and private.v(s, 'Registration Comment') is not null then 'Project1 registration note (box not ticked): ' || private.v(s, 'Registration Comment') end,
      case when not private.b(s, '1st Partial') and private.v(s, '1st Partial Comment') is not null then 'Project1 1st partial note (box not ticked): ' || private.v(s, '1st Partial Comment') end,
      case when not private.b(s, '2nd Partial') and private.v(s, '2nd Partial Comment') is not null then 'Project1 final payment note (box not ticked): ' || private.v(s, '2nd Partial Comment') end
    ), ''),
    private.v(s, 'Notes By'),
    nullif(nullif(private.v(s, 'Portal Invite'), 'FALSE'), 'TRUE'),
    private.v(s, 'Lead Stage'), private.v(s, 'Lead Follow-up')
  from st;

  -- Payments: each ticked box becomes one payment for that stage's plan amount (card fees are not tuition).
  insert into public.payments (student_id, stage, amount, method, paid_on, note, source, created_by)
  select x.id, t.stage, (plans -> x.pay_plan ->> t.stage)::numeric,
         private.parse_pay_method(t.cmt), private.parse_pay_date(t.cmt, c.start_date),
         left(coalesce(t.cmt, 'Ticked in Project1'), 500), 'import', 'Project1'
  from public.students x
  join st on st.n = x.source_row
  left join public.cohorts c on c.id = x.cohort_id
  cross join lateral (values
    ('registration',  private.b(st.s, 'Registration $200'), private.v(st.s, 'Registration Comment')),
    ('reg_balance',   private.b(st.s, 'Reg Balance $150'),  private.v(st.s, '1st Partial Comment')),
    ('first_partial', private.b(st.s, '1st Partial'),       private.v(st.s, '1st Partial Comment')),
    ('final',         private.b(st.s, '2nd Partial'),       private.v(st.s, '2nd Partial Comment'))
  ) as t(stage, ticked, cmt)
  where t.ticked and coalesce((plans -> x.pay_plan ->> t.stage)::numeric, 0) > 0;

  -- Dates emails went out
  insert into public.email_sends (student_id, kind, sent_at, sent_by)
  select x.id, k.kind,
         (private.parse_sheet_date(private.v(st.s, k.col), coalesce(extract(year from c.start_date)::int, 2026))::timestamp) at time zone 'America/Los_Angeles',
         'Project1'
  from public.students x
  join st on st.n = x.source_row
  left join public.cohorts c on c.id = x.cohort_id
  cross join lateral (values
    ('283b_office', '283b Office Sent'), ('283b_student', '283b Student Sent'), ('live_scan_office', 'Live Scan Office Sent'),
    ('welcome', 'Welcome Sent'), ('welcome_letter', 'Welcome Letter Sent'),
    ('theory_certificate', 'Theory Certificate Sent'), ('cna_completion', 'CNA Completion Sent')
  ) as k(kind, col)
  where private.v(st.s, k.col) is not null and upper(private.v(st.s, k.col)) <> 'FALSE';

  -- Existing Drive links stay attached; they open in Drive.
  insert into public.student_files (student_id, kind, url, file_name, uploaded_by)
  select x.id, k.kind, (regexp_match(private.v(st.s, k.col), 'https?://\S+'))[1], k.label || ' (from Project1)', 'Project1'
  from public.students x
  join st on st.n = x.source_row
  cross join lateral (values
    ('283b_signed', '283b Signed File', 'Signed 283B'), ('live_scan', 'Live Scan File', 'Live Scan'),
    ('283b_unsigned', '283b Unsigned File', 'Blank 283B'), ('photo', 'Student Photo', 'Photo'),
    ('tb_test', 'TB Test File', 'TB test'), ('physical_exam', 'Physical Exam File', 'Physical exam'),
    ('valid_id', 'Valid ID File', 'Valid ID'), ('theory_certificate', 'Theory Certificate File', 'Theory certificate'),
    ('cna_completion', 'CNA Completion File', 'CNA completion')
  ) as k(kind, col, label)
  where private.v(st.s, k.col) ~ 'https?://';

  -- Removed students (any cell that is an email address)
  insert into public.removed_students (email, removed_by)
  select distinct lower(btrim(e)), 'Project1'
  from jsonb_array_elements(coalesce(payload -> 'removed', '[]')) r
  cross join lateral jsonb_array_elements_text(r) e
  where btrim(e) ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  on conflict do nothing;

  -- Other programs, stored whole for their screens later
  insert into public.leads (source_row, created, full_name, email, phone, stage, next_follow_up, data)
  select (o ->> '_row')::int, private.v(o, 'Created'), private.v(o, 'Name'), lower(private.v(o, 'Email')), private.v(o, 'Phone'),
         private.v(o, 'Stage'), private.v(o, 'Next Follow-up'), o - '_row'
  from jsonb_array_elements(coalesce(payload -> 'leads', '[]')) o
  where coalesce(private.v(o, 'Name'), private.v(o, 'Email'), private.v(o, 'Phone')) is not null;

  insert into public.rna_hha_registrations (source_row, program, full_name, email, phone, data)
  select (o ->> '_row')::int, private.v(o, 'Program'), private.v(o, 'Full Name'), lower(private.v(o, 'Email')), private.v(o, 'Phone'), o - '_row'
  from jsonb_array_elements(coalesce(payload -> 'rna_hha', '[]')) o
  where coalesce(private.v(o, 'Full Name'), private.v(o, 'Email')) is not null;

  insert into public.ceu_registrations (source_row, full_name, email, phone, data)
  select (o ->> '_row')::int,
         coalesce(private.v(o, 'Name'), nullif(concat_ws(' ', private.v(o, 'First Name'), private.v(o, 'Last Name')), '')),
         lower(private.v(o, 'Your Email')), private.v(o, 'Your Phone number'), o - '_row'
  from jsonb_array_elements(coalesce(payload -> 'ceu', '[]')) o
  where coalesce(private.v(o, 'Name'), private.v(o, 'Last Name'), private.v(o, 'Your Email')) is not null;

  insert into public.bls_registrations (source_row, full_name, email, phone, data)
  select (o ->> '_row')::int, private.v(o, 'Full Name'), lower(private.v(o, 'Email')), private.v(o, 'Phone Number'), o - '_row'
  from jsonb_array_elements(coalesce(payload -> 'bls', '[]')) o
  where coalesce(private.v(o, 'Full Name'), private.v(o, 'Email')) is not null;

  alter table public.students enable trigger students_log;
  alter table public.payments enable trigger payments_log;
  alter table public.student_files enable trigger student_files_log;
  alter table public.student_files enable trigger student_files_tick;

  select jsonb_build_object(
    'sheet_student_rows', (select count(*) from st),
    'students', (select count(*) from public.students),
    'hybrid', (select count(*) from public.students where program = 'hybrid'),
    'in_person', (select count(*) from public.students where program = 'in_person'),
    'active', (select count(*) from public.students where not withdrawn and not dropped),
    'payments', (select count(*) from public.payments),
    'payments_total', (select coalesce(sum(amount), 0) from public.payments),
    'payments_no_method', (select count(*) from public.payments where method is null),
    'payments_no_date', (select count(*) from public.payments where paid_on is null),
    'files', (select count(*) from public.student_files),
    'email_sends', (select count(*) from public.email_sends),
    'cohorts', (select count(*) from public.cohorts),
    'cohorts_from_students_only', (select count(*) from public.cohorts c where not exists (select 1 from cc where typ in ('start', 'inperson') and private.parse_sheet_date(cc.name) = c.start_date)),
    'sites', (select count(*) from public.sites),
    'sites_from_students_only', (select coalesce(jsonb_agg(name order by name), '[]') from public.sites where not active),
    'no_start_date', (select count(*) from public.students where cohort_id is null),
    'no_site', (select count(*) from st where site_raw is not null and not exists (select 1 from public.students x where x.source_row = st.n and x.site_id is not null)),
    'duplicate_emails_cleared', (select count(*) from st where email_dup),
    'duplicate_ids_cleared', (select count(*) from st where code_dup),
    'unreadable_birth_dates', (select count(*) from st where private.v(s, 'Date of Birth') is not null and private.parse_sheet_date(private.v(s, 'Date of Birth')) is null),
    'leads', (select count(*) from public.leads),
    'rna_hha', (select count(*) from public.rna_hha_registrations),
    'ceu', (select count(*) from public.ceu_registrations),
    'bls', (select count(*) from public.bls_registrations),
    'removed_students', (select count(*) from public.removed_students)
  ) into out;

  insert into public.activity_log (user_email, action, details)
  values (who, 'Imported from Project1', out::text);
  return out;
end $$;

-- Activity Log rows: [Timestamp, User, Action, Student, Details]. Students are matched by "Last, First" when unique.
create or replace function public.import_activity_log(rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.activity_log (at, user_email, action, student_id, student_name, details)
  select coalesce(private.parse_sheet_ts(r ->> 0), now()),
         coalesce(nullif(btrim(r ->> 1), ''), 'unknown'),
         coalesce(nullif(btrim(r ->> 2), ''), 'Change'),
         (select case when count(*) = 1 then min(s.id::text)::uuid end
            from public.students s where lower(s.last_name || ', ' || s.first_name) = lower(btrim(r ->> 3))),
         nullif(btrim(r ->> 3), ''),
         nullif(r ->> 4, '')
  from jsonb_array_elements(rows) with ordinality x(r, i)
  where coalesce(nullif(btrim(r ->> 0), ''), nullif(btrim(r ->> 2), '')) is not null
  order by i;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.import_project1(jsonb) from public, anon, authenticated;
revoke all on function public.import_activity_log(jsonb) from public, anon, authenticated;
grant execute on function public.import_project1(jsonb) to service_role;
grant execute on function public.import_activity_log(jsonb) to service_role;
