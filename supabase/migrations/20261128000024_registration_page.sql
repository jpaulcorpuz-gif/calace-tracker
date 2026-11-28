-- New CNA Registration page (register.html -> the "register" Edge Function). It saves sign-ups straight into students.
alter table public.students
  add column if not exists referral_source text,
  add column if not exists has_ssn boolean,
  add column if not exists guardian_name text,
  add column if not exists guardian_relationship text,
  add column if not exists guardian_phone text,
  add column if not exists guardian_email text,
  add column if not exists signup_source text,          -- 'Registration page' for online sign-ups
  add column if not exists auth_user_id uuid;           -- the student's own sign-in (portal password), for the future student portal

-- Sign-up attempts per IP (hashed), to slow down spam. RLS on with no policies: only the Edge Function (service role) uses it.
create table if not exists public.registration_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  ok boolean not null default false,
  at timestamptz not null default now()
);
create index if not exists registration_attempts_ip on public.registration_attempts (ip_hash, at);
alter table public.registration_attempts enable row level security;
