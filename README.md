# CAL ACE Student Tracker

Staff tracker for CAL ACE Nursing Academy: CNA rosters, payments, requirements, attendance, exams and an activity log.

- **Screens:** plain HTML, CSS and JavaScript in this folder, hosted on GitHub Pages. No build step.
- **Data, sign-in and access rules:** Supabase. Row level security lets only people on the `staff` table read or change anything.
- **Activity log:** written by database triggers, so every change to a student or payment is recorded with who made it.

This repository holds code only. Student data lives in Supabase and never goes in here.

## Folders

| Path | What it is |
|---|---|
| `index.html`, `assets/` | The tracker |
| `assets/config.js` | Supabase address and its public key (safe to publish; never add secret keys) |
| `supabase/migrations/` | Database tables, access rules and log triggers, in order |
| `supabase/seed_staging.sql` | Loads the synthetic staging students and Class Config |
| `tools/serve.ps1` | Serves the folder at http://localhost:5173 for local testing |

## Adding a staff member

In Supabase, open Table Editor › `staff` and add a row with their email (lowercase) and role `staff`, `lead` or `admin`. They can then sign in with an emailed link.
