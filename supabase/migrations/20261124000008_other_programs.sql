-- RNA/HHA, BLS and CEU records: log every change and send live updates, like CNA students.

create or replace function private.log_record_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  k text;
  o jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else old.data end;
  n jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else new.data end;
  label text := case tg_table_name when 'rna_hha_registrations' then coalesce(case when tg_op = 'DELETE' then old.data else new.data end ->> 'Program', 'RNA/HHA')
                                   when 'bls_registrations' then 'BLS' else 'CEU' end;
  who_name text := case when tg_op = 'DELETE' then old.full_name else new.full_name end;
begin
  if tg_op = 'INSERT' then
    insert into public.activity_log (user_email, action, student_name, details)
    values (private.actor(), label || ' sign-up added', who_name, null);
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.activity_log (user_email, action, student_name, details)
    values (private.actor(), label || ' sign-up deleted', who_name, old.email);
    return old;
  end if;
  for k in select key from jsonb_object_keys(o || n) as key loop
    if (o -> k) is distinct from (n -> k) then
      insert into public.activity_log (user_email, action, student_name, field, old_value, new_value)
      values (private.actor(), 'Field changed', who_name, label || ': ' || k, o ->> k, n ->> k);
    end if;
  end loop;
  return new;
end $$;

create trigger rna_hha_log after insert or update or delete on public.rna_hha_registrations
  for each row execute function private.log_record_change();
create trigger bls_log after insert or update or delete on public.bls_registrations
  for each row execute function private.log_record_change();
create trigger ceu_log after insert or update or delete on public.ceu_registrations
  for each row execute function private.log_record_change();

alter publication supabase_realtime add table public.rna_hha_registrations, public.bls_registrations, public.ceu_registrations;

-- The CEU form's "Name" column is its submission time; the person's name is First Name + Last Name.
alter table public.ceu_registrations disable trigger ceu_log;
update public.ceu_registrations
set full_name = nullif(btrim(concat_ws(' ', btrim(data ->> 'First Name'), btrim(data ->> 'Last Name'))), '')
where true;
alter table public.ceu_registrations enable trigger ceu_log;
