-- A second Google connection just for sending email: row 1 = the account that owns the Drive folders,
-- row 2 = the account emails are sent from. Without row 2, emails go from row 1 (if it allowed sending).
alter table public.drive_connection drop constraint if exists drive_connection_id_check;
alter table public.drive_connection add constraint drive_connection_id_check check (id in (1, 2));
alter table public.drive_oauth_states add column if not exists purpose text not null default 'drive';
