-- Uploading a requirement document ticks that requirement. Removing the file leaves the tick alone.
-- Runs in the database so it also applies to uploads from the student portal later.
create or replace function private.tick_requirement_on_upload()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'live_scan' then
    update public.students set live_scan = true where id = new.student_id and not live_scan;
  elsif new.kind = '283b_signed' then
    update public.students set form_283b = true where id = new.student_id and not form_283b;
  elsif new.kind = 'physical_exam' then
    update public.students set physical_exam = true where id = new.student_id and not physical_exam;
  elsif new.kind = 'tb_test' then
    update public.students set tb_test = true where id = new.student_id and not tb_test;
  elsif new.kind = 'valid_id' then
    update public.students set valid_id = true where id = new.student_id and not valid_id;
  end if;
  return new;
end $$;

create trigger student_files_tick after insert on public.student_files
  for each row execute function private.tick_requirement_on_upload();
