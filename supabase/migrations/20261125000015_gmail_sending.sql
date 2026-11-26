-- Gmail sending: a send log that stops duplicates, the "switched on since" time for automatic emails, the Google scopes
-- granted, and a 15-minute schedule that runs the automatic emails through the mail function.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

alter table public.drive_connection add column if not exists scopes text;

alter table public.email_templates add column if not exists auto_on_since timestamptz;
update public.email_templates set auto_on_since = now() where auto_on and auto_on_since is null;
-- Record when an automatic email is switched on: lead follow-ups and welcome emails only go to students from then on.
create or replace function private.template_on_since() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.auto_on and (tg_op = 'INSERT' or not old.auto_on) then new.auto_on_since := now(); end if;
  if not new.auto_on then new.auto_on_since := null; end if;
  return new;
end $$;
drop trigger if exists email_templates_on_since on public.email_templates;
create trigger email_templates_on_since before insert or update on public.email_templates for each row execute function private.template_on_since();

alter table public.email_sends
  add column if not exists to_email text,
  add column if not exists template_id bigint,
  add column if not exists status text not null default 'sent',
  add column if not exists error text,
  add column if not exists auto boolean not null default false;
-- Each automatic email goes to a student at most once.
create unique index if not exists email_sends_auto_once on public.email_sends (student_id, kind) where auto and status = 'sent';

-- Key the scheduler uses to call the mail function; only the server can check it.
create table if not exists private.app_secrets (name text primary key, value text not null);
insert into private.app_secrets (name, value) values ('cron', encode(extensions.gen_random_bytes(24), 'hex')) on conflict (name) do nothing;
create or replace function public.check_cron_key(k text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.app_secrets where name = 'cron' and value = k)
$$;
revoke all on function public.check_cron_key(text) from public, anon, authenticated;
grant execute on function public.check_cron_key(text) to service_role;

select cron.schedule('calace-auto-emails', '*/15 * * * *', $cron$
  select net.http_post(
    url := 'https://gtltpewsxxycrmnnhqum.supabase.co/functions/v1/mail/auto',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select value from private.app_secrets where name = 'cron')),
    body := '{}'::jsonb)
$cron$);
