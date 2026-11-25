-- The BLS form's "Full Name" usually holds only the first name; the last name is a separate answer.
-- Store the whole name in full_name so the roster, search and the Activity Log show it.
alter table public.bls_registrations disable trigger bls_log;
update public.bls_registrations
set full_name = case
  when coalesce(btrim(data ->> 'Last Name'), '') = '' then nullif(btrim(data ->> 'Full Name'), '')
  when position(lower(btrim(data ->> 'Last Name')) in lower(coalesce(data ->> 'Full Name', ''))) > 0 then nullif(btrim(data ->> 'Full Name'), '')
  else btrim(concat_ws(' ', btrim(data ->> 'Full Name'), btrim(data ->> 'Last Name')))
end
where true;
alter table public.bls_registrations enable trigger bls_log;
