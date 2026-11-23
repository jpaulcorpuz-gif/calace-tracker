-- Let the tracker hear teammates' changes live. Row level security still applies to every event.
alter publication supabase_realtime add table public.students, public.payments, public.activity_log;
