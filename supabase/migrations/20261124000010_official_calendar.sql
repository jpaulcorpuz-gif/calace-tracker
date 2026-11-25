-- Match start and end dates to the official calendar (calacenursingacademy.com/calendar, checked 2026-11-24).

-- Hybrid, Nov 2 2026: ends Dec 13 (weekday) and Dec 22 (weekend); still running, so not archived.
update public.cohorts set weekday_end = '2026-12-13', weekend_end = '2026-12-22', archived = false where id = 36;
-- Hybrid, Jan 4 2027: weekday ends Feb 12.
update public.cohorts set weekday_end = '2027-02-12' where id = 24;
-- Hybrid, February cohort starts Feb 15 2027 (not Feb 16).
update public.cohorts set start_date = '2027-02-15' where id = 25;
-- In-Person, Nov 30 2026: ends Dec 19.
update public.cohorts set weekday_end = '2026-12-19' where id = 32;
-- Hybrid "Nov 30 2026" is not on the calendar (that date is the In-Person cohort) and has no students: hide it.
update public.cohorts set open = false, archived = true where id = 31;

-- Hybrid cohorts on the calendar that were missing.
insert into public.cohorts (program, start_date, weekday_end, weekend_end, open, archived)
select 'hybrid', v.s::date, v.wd::date, v.we::date, true, false
from (values ('2027-09-13', '2027-10-22', '2027-11-02'),
             ('2027-10-18', '2027-11-28', '2027-12-07'),
             ('2027-11-22', '2027-12-31', '2028-01-18'),
             ('2027-12-13', '2028-01-21', '2028-02-22')) as v(s, wd, we)
where not exists (select 1 from public.cohorts c where c.program = 'hybrid' and c.start_date = v.s::date);

-- New cohorts get the same clinical sites as the latest one (Aug 9 2027).
insert into public.cohort_sites (cohort_id, site_id, availability)
select c.id, cs.site_id, cs.availability
from public.cohorts c
join public.cohort_sites cs on cs.cohort_id = (select id from public.cohorts where program = 'hybrid' and start_date = '2027-08-09')
where c.program = 'hybrid' and c.start_date > '2027-08-09'
  and not exists (select 1 from public.cohort_sites x where x.cohort_id = c.id and x.site_id = cs.site_id);

-- Students whose end date still carried the old, wrong value (these changes are logged).
update public.students set end_date = '2027-02-12' where cohort_id = 24 and schedule = 'weekday' and end_date = '2027-02-13';
update public.students set end_date = '2026-12-22' where cohort_id = 36 and schedule = 'weekend' and end_date = '2027-10-13';
update public.students set end_date = '2026-12-19' where cohort_id = 32 and end_date = '2026-12-18';
