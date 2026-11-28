-- Google Classroom link and class code for each class group: start date + clinical site + weekday/weekend.
-- The Welcome Letter (email and the attached PDF) uses the one that matches the student.
create table if not exists public.classrooms (
  cohort_id bigint not null references public.cohorts(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  schedule text not null check (schedule in ('weekday', 'weekend')),
  link text not null default '',
  code text not null default '',
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (cohort_id, site_id, schedule)
);
alter table public.classrooms enable row level security;

create policy "read classrooms" on public.classrooms for select to authenticated using ((select private.is_staff()));
create policy "add classrooms" on public.classrooms for insert to authenticated
  with check ((select private.perm('templates')) = 2 or (select private.perm('cna')) = 2);
create policy "change classrooms" on public.classrooms for update to authenticated
  using ((select private.perm('templates')) = 2 or (select private.perm('cna')) = 2)
  with check ((select private.perm('templates')) = 2 or (select private.perm('cna')) = 2);
create policy "remove classrooms" on public.classrooms for delete to authenticated
  using ((select private.perm('templates')) = 2 or (select private.perm('cna')) = 2);

create or replace function private.stamp_classroom() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_by := private.actor();
  new.updated_at := now();
  return new;
end $$;
create trigger classrooms_stamp before insert or update on public.classrooms for each row execute function private.stamp_classroom();
