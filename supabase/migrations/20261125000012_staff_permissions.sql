-- Staff access and permissions.
-- Each staff member has a role (admin, office, instructor, viewer) and a permissions object:
--   areas (0 none, 1 view, 2 edit): cna, training, payments, programs, leads, overview, logs, staff
--   flags: delete (can delete students and sign-ups), export (can export CSV; enforced in the tracker only)
-- Admins always have everything. Google Drive setup and the Project1 import stay admin-only (checked in the drive function).

alter table public.staff add column if not exists permissions jsonb not null default '{}'::jsonb;
update public.staff set role = 'office' where role = 'staff';
update public.staff set permissions =
  '{"cna":2,"training":2,"payments":2,"programs":2,"leads":2,"overview":0,"logs":1,"staff":0,"delete":false,"export":true}'::jsonb
where role = 'office' and permissions = '{}'::jsonb;

create or replace function private.perm(area text) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when s.role = 'admin' then 2 else coalesce((s.permissions ->> area)::int, 0) end
    from public.staff s where s.active and s.email = private.current_email()
  ), 0)
$$;
create or replace function private.can_delete() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select s.role = 'admin' or coalesce((s.permissions ->> 'delete')::boolean, false)
    from public.staff s where s.active and s.email = private.current_email()
  ), false)
$$;

-- Students -------------------------------------------------------------------------------------------
drop policy if exists "staff full access" on public.students;
create policy "read students" on public.students for select to authenticated
  using ((select private.perm('cna')) >= 1 or (select private.perm('training')) >= 1 or (select private.perm('leads')) >= 1 or (select private.perm('overview')) >= 1);
create policy "add students" on public.students for insert to authenticated
  with check ((select private.perm('cna')) = 2 or (select private.perm('leads')) = 2);
create policy "change students" on public.students for update to authenticated
  using ((select private.perm('cna')) = 2 or (select private.perm('training')) = 2 or (select private.perm('leads')) = 2 or (select private.perm('payments')) = 2)
  with check ((select private.perm('cna')) = 2 or (select private.perm('training')) = 2 or (select private.perm('leads')) = 2 or (select private.perm('payments')) = 2);
create policy "delete students" on public.students for delete to authenticated
  using ((select private.perm('cna')) = 2 and (select private.can_delete()));

-- Without full student edit access, only some fields may change.
create or replace function private.guard_student_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  k text; o jsonb := to_jsonb(old); n jsonb := to_jsonb(new); allowed text[] := array['updated_at'];
begin
  if coalesce(private.current_email(), '') = '' or private.perm('cna') = 2 then return new; end if;   -- system jobs and full editors
  if private.perm('training') = 2 then allowed := allowed || array['theory_attendance','clinical_attendance','quizzes','final_exam','skills_checklist','evaluation']; end if;
  if private.perm('leads') = 2 then allowed := allowed || array['followup_1_at','followup_2_at','followup_3_at','notes','notes_by']; end if;
  if private.perm('payments') = 2 then allowed := allowed || array['pay_plan']; end if;
  for k in select jsonb_object_keys(n) loop
    if (o -> k) is distinct from (n -> k) and not (k = any(allowed)) then
      raise exception 'You don''t have permission to change % for students. Ask an admin for access.', replace(k, '_', ' ') using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists students_guard on public.students;
create trigger students_guard before update on public.students for each row execute function private.guard_student_update();

-- Payments, documents -------------------------------------------------------------------------------
drop policy if exists "staff full access" on public.payments;
create policy "read payments" on public.payments for select to authenticated
  using ((select private.perm('payments')) >= 1 or (select private.perm('cna')) >= 1 or (select private.perm('leads')) >= 1 or (select private.perm('overview')) >= 1);
create policy "add payments" on public.payments for insert to authenticated with check ((select private.perm('payments')) = 2);
create policy "change payments" on public.payments for update to authenticated using ((select private.perm('payments')) = 2) with check ((select private.perm('payments')) = 2);
create policy "remove payments" on public.payments for delete to authenticated using ((select private.perm('payments')) = 2);

drop policy if exists "staff full access" on public.student_files;
create policy "read documents" on public.student_files for select to authenticated using ((select private.perm('cna')) >= 1);
create policy "add documents" on public.student_files for insert to authenticated with check ((select private.perm('cna')) = 2);
create policy "change documents" on public.student_files for update to authenticated using ((select private.perm('cna')) = 2) with check ((select private.perm('cna')) = 2);
create policy "remove documents" on public.student_files for delete to authenticated using ((select private.perm('cna')) = 2);

-- Start dates and clinical sites ---------------------------------------------------------------------
drop policy if exists "staff full access" on public.cohorts;
create policy "read start dates" on public.cohorts for select to authenticated using ((select private.is_staff()));
create policy "manage start dates" on public.cohorts for all to authenticated using ((select private.perm('cna')) = 2) with check ((select private.perm('cna')) = 2);
drop policy if exists "staff full access" on public.sites;
create policy "read sites" on public.sites for select to authenticated using ((select private.is_staff()));
create policy "manage sites" on public.sites for all to authenticated using ((select private.perm('cna')) = 2) with check ((select private.perm('cna')) = 2);
drop policy if exists "staff full access" on public.cohort_sites;
create policy "read site schedule" on public.cohort_sites for select to authenticated using ((select private.is_staff()));
create policy "manage site schedule" on public.cohort_sites for all to authenticated using ((select private.perm('cna')) = 2) with check ((select private.perm('cna')) = 2);

-- RNA, HHA, BLS and CEU ------------------------------------------------------------------------------
drop policy if exists "staff full access" on public.rna_hha_registrations;
create policy "read sign-ups" on public.rna_hha_registrations for select to authenticated using ((select private.perm('programs')) >= 1);
create policy "add sign-ups" on public.rna_hha_registrations for insert to authenticated with check ((select private.perm('programs')) = 2);
create policy "change sign-ups" on public.rna_hha_registrations for update to authenticated using ((select private.perm('programs')) = 2) with check ((select private.perm('programs')) = 2);
create policy "delete sign-ups" on public.rna_hha_registrations for delete to authenticated using ((select private.perm('programs')) = 2 and (select private.can_delete()));
drop policy if exists "staff full access" on public.bls_registrations;
create policy "read sign-ups" on public.bls_registrations for select to authenticated using ((select private.perm('programs')) >= 1);
create policy "add sign-ups" on public.bls_registrations for insert to authenticated with check ((select private.perm('programs')) = 2);
create policy "change sign-ups" on public.bls_registrations for update to authenticated using ((select private.perm('programs')) = 2) with check ((select private.perm('programs')) = 2);
create policy "delete sign-ups" on public.bls_registrations for delete to authenticated using ((select private.perm('programs')) = 2 and (select private.can_delete()));
drop policy if exists "staff full access" on public.ceu_registrations;
create policy "read sign-ups" on public.ceu_registrations for select to authenticated using ((select private.perm('programs')) >= 1);
create policy "add sign-ups" on public.ceu_registrations for insert to authenticated with check ((select private.perm('programs')) = 2);
create policy "change sign-ups" on public.ceu_registrations for update to authenticated using ((select private.perm('programs')) = 2) with check ((select private.perm('programs')) = 2);
create policy "delete sign-ups" on public.ceu_registrations for delete to authenticated using ((select private.perm('programs')) = 2 and (select private.can_delete()));

-- Settings: everyone reads; admins change, and Leads editors may change the follow-up email templates ----
drop policy if exists "staff full access" on public.settings;
create policy "read settings" on public.settings for select to authenticated using ((select private.is_staff()));
create policy "add settings" on public.settings for insert to authenticated
  with check ((select private.is_admin()) or (key = 'lead_emails' and (select private.perm('leads')) = 2));
create policy "change settings" on public.settings for update to authenticated
  using ((select private.is_admin()) or (key = 'lead_emails' and (select private.perm('leads')) = 2))
  with check ((select private.is_admin()) or (key = 'lead_emails' and (select private.perm('leads')) = 2));
create policy "remove settings" on public.settings for delete to authenticated using ((select private.is_admin()));

-- Staff list: people see their own row; the Staff page needs the staff area. Only admins can create or change admins.
drop policy if exists "admins manage staff list" on public.staff;
drop policy if exists "staff read staff list" on public.staff;
create policy "read staff" on public.staff for select to authenticated
  using (email = (select private.current_email()) or (select private.perm('staff')) >= 1);
create policy "add staff" on public.staff for insert to authenticated
  with check ((select private.perm('staff')) = 2 and (role <> 'admin' or (select private.is_admin())));
create policy "change staff" on public.staff for update to authenticated
  using ((select private.perm('staff')) = 2 and (role <> 'admin' or (select private.is_admin())))
  with check ((select private.perm('staff')) = 2 and (role <> 'admin' or (select private.is_admin())));
create policy "remove staff" on public.staff for delete to authenticated
  using ((select private.perm('staff')) = 2 and (role <> 'admin' or (select private.is_admin())));

-- Never leave the tracker without an active admin.
create or replace function private.keep_an_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.staff where active and role = 'admin') then
    raise exception 'The tracker needs at least one active admin. Make someone else an admin first.' using errcode = '42501';
  end if;
  return null;
end $$;
drop trigger if exists staff_keep_admin on public.staff;
create constraint trigger staff_keep_admin after update or delete on public.staff
  deferrable initially immediate for each row execute function private.keep_an_admin();

-- Log changes to the staff list.
create or replace function private.log_staff_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activity_log (user_email, action, student_name, details) values (private.actor(), 'Staff added', new.email, new.role);
  elsif tg_op = 'DELETE' then
    insert into public.activity_log (user_email, action, student_name, details) values (private.actor(), 'Staff removed', old.email, old.role);
  elsif (to_jsonb(old) - 'created_at') is distinct from (to_jsonb(new) - 'created_at') then
    insert into public.activity_log (user_email, action, student_name, field, old_value, new_value)
    values (private.actor(), 'Staff access changed', new.email, 'access',
            old.role || case when old.active then '' else ' (inactive)' end || ' ' || old.permissions::text,
            new.role || case when new.active then '' else ' (inactive)' end || ' ' || new.permissions::text);
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists staff_log on public.staff;
create trigger staff_log after insert or update or delete on public.staff for each row execute function private.log_staff_change();

alter publication supabase_realtime add table public.staff;
