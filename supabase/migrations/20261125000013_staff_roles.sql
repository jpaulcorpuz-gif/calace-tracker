-- Allow the roles used by the Staff & permissions page (the original list was staff, lead, admin).
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check check (role in ('admin', 'office', 'instructor', 'viewer', 'staff', 'lead'));
