-- Automatic emails that staff add themselves: when to send and who gets it.
-- auto_rule = { event: before_start | after_start | after_end | after_signup | first_payment,
--               days: 0..365, audience: paid | unpaid | any, program: "" | hybrid | in_person, missing_only: bool }
alter table public.email_templates add column if not exists auto_rule jsonb;
