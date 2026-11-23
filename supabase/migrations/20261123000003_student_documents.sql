-- Private storage for student documents (Live Scan, signed 283B, physical exam, TB test and later others).
-- Files are never public: staff open them through short-lived signed links.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-files', 'student-files', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'])
on conflict (id) do nothing;

create policy "staff read student files" on storage.objects
  for select to authenticated using (bucket_id = 'student-files' and (select private.is_staff()));
create policy "staff upload student files" on storage.objects
  for insert to authenticated with check (bucket_id = 'student-files' and (select private.is_staff()));
create policy "staff delete student files" on storage.objects
  for delete to authenticated using (bucket_id = 'student-files' and (select private.is_staff()));

alter table public.student_files add column if not exists file_name text;
alter table public.student_files add column if not exists size_bytes bigint;

-- Log uploads and removals like every other change.
create or replace function private.log_file_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r public.student_files;
  s_name text;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  select last_name || ', ' || first_name into s_name from public.students where id = r.student_id;
  insert into public.activity_log (user_email, action, student_id, student_name, field, new_value, details)
  values (private.actor(), case tg_op when 'INSERT' then 'File uploaded' else 'File removed' end,
          r.student_id, s_name, 'file:' || r.kind, r.file_name, r.storage_path);
  return r;
end $$;

create trigger student_files_log after insert or delete on public.student_files
  for each row execute function private.log_file_change();

alter publication supabase_realtime add table public.student_files;
