-- Tools › Email Templates: saved emails (rich text), their attachments, and the switches for automatic emails.
-- Nothing sends automatically yet: auto_on records the choice; a sender will read these rows once one is connected.

create table if not exists public.email_templates (
  id bigint generated always as identity primary key,
  name text not null,
  subject text not null default '',
  body_html text not null default '',
  attachments jsonb not null default '[]'::jsonb,     -- [{ name, url, path, size }]
  auto_key text unique,                                -- followup_1..3, welcome, start_reminder, missing_reqs
  auto_on boolean not null default false,
  auto_days integer,                                   -- days before the start date (reminders)
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.email_templates enable row level security;

create policy "read templates" on public.email_templates for select to authenticated using ((select private.is_staff()));
create policy "add templates" on public.email_templates for insert to authenticated with check ((select private.perm('templates')) = 2);
create policy "change templates" on public.email_templates for update to authenticated
  using ((select private.perm('templates')) = 2) with check ((select private.perm('templates')) = 2);
create policy "delete templates" on public.email_templates for delete to authenticated
  using ((select private.perm('templates')) = 2 and auto_key is null);

create or replace function private.log_template_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activity_log (user_email, action, student_name, details) values (private.actor(), 'Email template added', new.name, null);
  elsif tg_op = 'DELETE' then
    insert into public.activity_log (user_email, action, student_name, details) values (private.actor(), 'Email template deleted', old.name, null);
  else
    if old.auto_on is distinct from new.auto_on then
      insert into public.activity_log (user_email, action, student_name, details)
      values (private.actor(), case when new.auto_on then 'Automatic email turned on' else 'Automatic email turned off' end, new.name, null);
    end if;
    if (old.subject, old.body_html, old.attachments, old.name, old.auto_days) is distinct from (new.subject, new.body_html, new.attachments, new.name, new.auto_days) then
      insert into public.activity_log (user_email, action, student_name, details) values (private.actor(), 'Email template edited', new.name, null);
    end if;
    new.updated_at := now(); new.updated_by := private.actor();
  end if;
  return coalesce(new, old);
end $$;
create trigger email_templates_log before insert or update or delete on public.email_templates
  for each row execute function private.log_template_change();

alter publication supabase_realtime add table public.email_templates;

-- Pasted images and attachments. Public so images show in the recipient's inbox; file names are random.
insert into storage.buckets (id, name, public, file_size_limit)
values ('email-assets', 'email-assets', true, 10485760)
on conflict (id) do nothing;
create policy "upload email assets" on storage.objects for insert to authenticated
  with check (bucket_id = 'email-assets' and ((select private.perm('templates')) = 2 or (select private.perm('leads')) = 2));
create policy "remove email assets" on storage.objects for delete to authenticated
  using (bucket_id = 'email-assets' and (select private.perm('templates')) = 2);

-- Starting templates: the three lead follow-ups (same wording as before) and the other automatic emails.
insert into public.email_templates (name, subject, body_html, auto_key, auto_on, auto_days) values
('Lead follow-up 1', 'Your CAL ACE {program} registration',
 '<p>Hi {first_name},</p><p>Thank you for signing up for the {program} program at CAL ACE Nursing Academy. Your class starts {start_date}.</p><p>To hold your seat, please complete your {registration} registration payment. If you have any questions, reply to this email or call or text us at (408) 256-0763.</p><p>Best,<br>{staff_name}<br>CAL ACE Nursing Academy</p>',
 'followup_1', false, null),
('Lead follow-up 2', 'Reminder: save your seat in {program}',
 '<p>Hi {first_name},</p><p>Just a reminder that your seat in the {program} class starting {start_date} isn''t confirmed until your {registration} registration payment is in. Seats fill up quickly, so we''d love to get you set.</p><p>Questions? Reply here or call or text (408) 256-0763.</p><p>Best,<br>{staff_name}<br>CAL ACE Nursing Academy</p>',
 'followup_2', false, null),
('Lead follow-up 3', 'Last reminder about your {program} registration',
 '<p>Hi {first_name},</p><p>This is our last reminder about your registration for the {program} class starting {start_date}. If you''d still like to join, please complete your {registration} registration payment so we can hold your seat.</p><p>If your plans have changed, just let us know and we''ll update our records.</p><p>Best,<br>{staff_name}<br>CAL ACE Nursing Academy</p>',
 'followup_3', false, null),
('Welcome after first payment', 'Welcome to CAL ACE, {first_name}!',
 '<p>Hi {first_name},</p><p>Thank you for your payment. Your seat in the {program} class starting {start_date} is confirmed.</p><p>Next, please complete your clinical requirements: Signed 283B, Live Scan, TB test, physical exam and a valid ID. We''ll send details about your clinical site and schedule before your start date.</p><p>Welcome aboard!<br>{staff_name}<br>CAL ACE Nursing Academy</p>',
 'welcome', false, null),
('Start-date reminder', 'Your {program} class starts {start_date}',
 '<p>Hi {first_name},</p><p>This is a reminder that your {program} class starts on {start_date}. Please make sure you''re ready to log in and that your requirements are complete.</p><p>Questions? Reply here or call or text (408) 256-0763.</p><p>See you soon,<br>{staff_name}<br>CAL ACE Nursing Academy</p>',
 'start_reminder', false, 3),
('Missing requirements reminder', 'Action needed before clinicals: {missing_requirements}',
 '<p>Hi {first_name},</p><p>We still need the following before your clinicals can start: <b>{missing_requirements}</b>.</p><p>Please send or upload them as soon as possible so you can stay on track for your {program} class starting {start_date}.</p><p>Thank you,<br>{staff_name}<br>CAL ACE Nursing Academy</p>',
 'missing_reqs', false, 7)
on conflict (auto_key) do nothing;
