-- Student documents now live in Google Drive folders owned by the school's Google account.
-- The "drive" Edge Function uploads with that account's offline access; these tables hold its connection.
-- Neither table has a policy, so only the server (service role) can read or write them.

create table public.drive_connection (
  id            integer primary key default 1 check (id = 1),
  refresh_token text not null,
  account_email text,
  connected_by  text not null,
  connected_at  timestamptz not null default now()
);
alter table public.drive_connection enable row level security;
revoke all on public.drive_connection from anon, authenticated;
comment on table public.drive_connection is 'Google Drive offline access for uploads. Server only.';

create table public.drive_oauth_states (
  state      text primary key,
  created_by text not null,
  return_to  text not null,
  created_at timestamptz not null default now()
);
alter table public.drive_oauth_states enable row level security;
revoke all on public.drive_oauth_states from anon, authenticated;

alter table public.student_files add column if not exists drive_file_id text;

-- Which Drive folder each document type goes into. parent is the folder that holds all four.
insert into public.settings (key, value) values ('drive_folders', '{
  "parent": "1maBG5waKgi7OX3Xamo3QxJ6-dK8tUp_r",
  "live_scan":     {"id": "1AYabKXys8HPsB6u9F2fc4uYgzXvy4DQI", "name": "Live Scan"},
  "physical_exam": {"id": "13XZXEvfJNem9IfgnyEGxVIqxfGDKZKCk", "name": "Physical Exam"},
  "283b_signed":   {"id": "1V_AymCWCPf0mdQk8T2RzwRsD5ib98KrY", "name": "Signed 283b"},
  "tb_test":       {"id": "1ZoVQHbgzI-eCnktUwDtrk-ic6EgaLx1n", "name": "TB Test"}
}')
on conflict (key) do update set value = excluded.value, updated_at = now();
