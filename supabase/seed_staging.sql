-- Loads Project1 STAGING (synthetic data only) into the step 1 tables.
-- Source: Class Config and Students tabs, read 2026-11-23. Every student is fake (@example.com, CNA-T####).

begin;

alter table public.students disable trigger students_log;
alter table public.payments disable trigger payments_log;

insert into public.settings (key, value) values
  ('seat_cap', '13'),
  ('waitlist_cap', '2'),
  ('pay_plans', '{
     "standard":  {"label": "Standard",   "registration": 200, "first_partial": 800, "final": 798},
     "promo_50":  {"label": "Promo $50",  "registration": 50, "reg_balance": 150, "first_partial": 800, "final": 798},
     "in_person": {"label": "In-Person",  "registration": 50, "reg_balance": 150, "first_partial": 800, "final": 798}
   }'),
  ('notices', '[{"site": "Waitlist - Pending Clinical", "version": "v20261019-1640",
     "text": "You may begin theory classes while clinical placement remains pending. A new group may open when at least 7 students enroll and a facility is confirmed. Otherwise, clinical training may be scheduled with a subsequent cohort."}]');

insert into public.sites (name, short_name, city, schedules, kind, sort_order) values
  ('Group Canyon Springs Post Acute - San Jose',  'Canyon Springs', 'San Jose',   'both',    'clinical', 1),
  ('Group Herman Health Care Center - San Jose',  'Herman',         'San Jose',   'weekend', 'clinical', 2),
  ('Group Redwood Grove Post Acute - Santa Cruz', 'Redwood Grove',  'Santa Cruz', 'weekend', 'clinical', 3),
  ('Group Cedarwood Post Acute - Sacramento',     'Cedarwood',      'Sacramento', 'weekend', 'clinical', 4),
  ('Group Idylwood Care Center - Sunnyvale',      'Idylwood',       'Sunnyvale',  'both',    'clinical', 5),
  ('Waitlist - Pending Clinical',                 'Pending clinical', null,       'both',    'waitlist', 6),
  ('In-Person Rotation - San Jose',               'In-Person',      'San Jose',   'weekday', 'in_person', 7);

insert into public.cohorts (program, start_date, weekday_end, weekend_end, open) values
  ('hybrid', '2026-11-30', '2026-12-19', null,         false),  -- stray row, every site off
  ('hybrid', '2026-12-07', '2027-01-17', '2027-01-26', true),
  ('hybrid', '2027-01-04', '2027-02-13', '2027-03-02', true),
  ('hybrid', '2027-02-16', '2027-03-26', '2027-04-06', true),
  ('hybrid', '2027-03-22', '2027-04-30', '2027-05-11', true),
  ('hybrid', '2027-04-26', '2027-06-04', '2027-06-15', true),
  ('hybrid', '2027-05-31', '2027-07-10', '2027-07-21', true),
  ('hybrid', '2027-07-05', '2027-08-13', '2027-08-24', true),
  ('hybrid', '2027-08-09', '2027-09-17', '2027-09-28', true);   -- Sheet had "September 28,. 2027"

insert into public.cohorts (program, start_date, weekday_end, seats, waitlist_seats, open) values
  ('in_person', '2026-11-30', '2026-12-18', 15, 2, true),
  ('in_person', '2027-01-04', '2027-01-23', 15, 2, true);

-- Which site is open for which Hybrid cohort (Class Config "cohortsite" rows).
insert into public.cohort_sites (cohort_id, site_id, availability)
select c.id, s.id, v.availability
from (values
  ('2026-12-07','Canyon Springs','both'), ('2026-12-07','Herman','weekend'), ('2026-12-07','Redwood Grove','weekend'),
  ('2026-12-07','Cedarwood','weekend'), ('2026-12-07','Idylwood','weekday'), ('2026-12-07','Pending clinical','off'),
  ('2027-01-04','Canyon Springs','both'), ('2027-01-04','Herman','off'), ('2027-01-04','Redwood Grove','weekend'),
  ('2027-01-04','Cedarwood','weekend'), ('2027-01-04','Idylwood','weekday'), ('2027-01-04','Pending clinical','off'),
  ('2027-02-16','Canyon Springs','both'), ('2027-02-16','Herman','off'), ('2027-02-16','Redwood Grove','weekend'),
  ('2027-02-16','Cedarwood','weekend'), ('2027-02-16','Idylwood','off'), ('2027-02-16','Pending clinical','off'),
  ('2027-03-22','Canyon Springs','both'), ('2027-03-22','Herman','off'), ('2027-03-22','Redwood Grove','weekend'),
  ('2027-03-22','Cedarwood','weekend'), ('2027-03-22','Idylwood','off'), ('2027-03-22','Pending clinical','off'),
  ('2027-04-26','Canyon Springs','both'), ('2027-04-26','Herman','off'), ('2027-04-26','Redwood Grove','weekend'),
  ('2027-04-26','Cedarwood','weekend'), ('2027-04-26','Idylwood','off'), ('2027-04-26','Pending clinical','off'),
  ('2027-05-31','Canyon Springs','both'), ('2027-05-31','Herman','off'), ('2027-05-31','Redwood Grove','weekend'),
  ('2027-05-31','Cedarwood','weekend'), ('2027-05-31','Idylwood','off'), ('2027-05-31','Pending clinical','off'),
  ('2027-07-05','Canyon Springs','both'), ('2027-07-05','Herman','off'), ('2027-07-05','Redwood Grove','weekend'),
  ('2027-07-05','Cedarwood','weekend'), ('2027-07-05','Idylwood','off'), ('2027-07-05','Pending clinical','off'),
  ('2027-08-09','Canyon Springs','both'), ('2027-08-09','Herman','off'), ('2027-08-09','Redwood Grove','weekend'),
  ('2027-08-09','Cedarwood','weekend'), ('2027-08-09','Idylwood','off'), ('2027-08-09','Pending clinical','off'),
  ('2026-11-30','Canyon Springs','off'), ('2026-11-30','Herman','off'), ('2026-11-30','Redwood Grove','off'),
  ('2026-11-30','Cedarwood','off'), ('2026-11-30','Idylwood','off'), ('2026-11-30','Pending clinical','off')
) as v(start_date, site, availability)
join public.cohorts c on c.program = 'hybrid' and c.start_date = v.start_date::date
join public.sites s on s.short_name = v.site;

-- Students. flags = Waiver, Registration, 1st Partial, 2nd Partial, 283b, Live Scan, TB, Physical (columns D-K).
-- sched D = Weekday, E = Weekend. reg = amount in the Registration Comment (blank when none).
create temporary table raw_students (
  n int, last_name text, first_name text, flags text, sched text, start_date date, site text,
  withdrawn bool, dropped bool, waitlist bool, dob date, gender text, program text, promo bool, reg int
) on commit drop;

insert into raw_students values
 (1,'Testa','Ava','00001111','D','2026-12-07','Canyon Springs',false,false,false,'1975-01-10','Female','hybrid',false,null),
 (2,'Sampleton','Ben','00000000','E','2027-01-04','Redwood Grove',false,false,false,'1976-02-11','Female','hybrid',false,null),
 (3,'Fakely','Cara','01001000','D','2027-02-16','Idylwood',false,false,false,'1977-03-12','Female','hybrid',false,200),
 (4,'Demo','Dan','01000100','E','2026-12-07','Redwood Grove',false,false,false,'1978-04-13','Female','hybrid',false,200),
 (5,'Mockford','Ella','01001010','D','2027-01-04','Canyon Springs',false,false,false,'1979-05-14','Female','hybrid',false,200),
 (6,'Trialson','Finn','01100001','E','2027-02-16','Redwood Grove',false,false,false,'1980-06-15','Male','hybrid',true,50),
 (7,'Placeholder','Gia','01001100','D','2026-12-07','Canyon Springs',false,false,false,'1981-07-16','Male','hybrid',false,200),
 (8,'Dummy','Hugo','11110000','E','2027-01-04','Redwood Grove',false,false,false,'2009-03-14','Female','hybrid',false,200),
 (9,'Synthetic','Ivy','00001010','D','2027-02-16','Idylwood',false,false,false,'1983-09-18','Male','hybrid',false,null),
 (10,'Staging','Jon','01000100','E','2026-12-07','Cedarwood',false,false,false,'1984-01-10','Female','hybrid',true,50),
 (11,'Testa','Kai','00001001','D','2027-01-04','Idylwood',false,false,false,'1985-02-11','Male','hybrid',false,null),
 (12,'Sampleton','Lia','01000000','E','2027-02-16','Redwood Grove',false,false,false,'1986-03-12','Male','hybrid',false,200),
 (13,'Fakely','Max','01101110','D','2026-12-07','Canyon Springs',false,false,true,'1987-04-13','Female','hybrid',false,200),
 (14,'Demo','Nia','01100000','E','2027-01-04','Cedarwood',false,false,false,'1988-05-14','Female','hybrid',true,50),
 (15,'Mockford','Owen','01001000','D','2027-02-16','Idylwood',false,false,false,'1989-06-15','Female','hybrid',false,200),
 (16,'Trialson','Pia','01110101','E','2026-12-07','Cedarwood',false,false,false,'1990-07-16','Male','hybrid',false,200),
 (17,'Placeholder','Quin','00001010','D','2027-01-04','Idylwood',false,false,false,'1991-08-17','Male','hybrid',false,null),
 (18,'Dummy','Rae','01110000','E','2027-02-16','Cedarwood',false,false,false,'1992-09-18','Male','hybrid',true,50),
 (19,'Synthetic','Sam','00001100','D','2026-12-07','Idylwood',false,false,false,'1993-01-10','Female','hybrid',false,null),
 (20,'Staging','Tia','01000000','E','2027-01-04','Redwood Grove',false,false,false,'1994-02-11','Female','hybrid',false,200),
 (21,'Testa','Uma','01111011','D','2027-02-16','Canyon Springs',true,false,false,'1995-03-12','Female','hybrid',false,200),
 (22,'Sampleton','Vic','01000100','E','2026-12-07','Cedarwood',false,false,false,'1996-04-13','Female','hybrid',true,50),
 (23,'Fakely','Wes','00001000','D','2027-01-04','Idylwood',false,false,false,'1997-05-14','Male','hybrid',false,null),
 (24,'Demo','Xia','01100000','E','2027-02-16','Redwood Grove',false,false,false,'1998-06-15','Female','hybrid',false,200),
 (25,'Mockford','Yara','00001110','D','2026-12-07','Idylwood',false,false,false,'1999-07-16','Male','hybrid',false,null),
 (26,'Trialson','Zed','01000001','E','2027-01-04','Redwood Grove',false,false,false,'2000-08-17','Female','hybrid',true,50),
 (27,'Placeholder2','Ava','01101000','D','2027-02-16','Canyon Springs',false,false,false,'2001-09-18','Female','hybrid',false,200),
 (28,'Dummy2','Ben','00000100','E','2026-12-07','Cedarwood',false,false,false,'2002-01-10','Male','hybrid',false,null),
 (29,'Synthetic2','Cara','01101010','D','2027-01-04','Idylwood',false,false,false,'2003-02-11','Male','hybrid',false,200),
 (30,'Staging2','Dan','00000000','E','2027-02-16','Canyon Springs',false,false,false,'2004-03-12','Female','hybrid',false,null),
 (31,'Testa2','Ella','01111101','D','2026-12-07','Canyon Springs',false,false,true,'1975-04-13','Female','hybrid',false,200),
 (32,'Sampleton2','Finn','00000000','E','2027-01-04','Redwood Grove',false,false,false,'1976-05-14','Female','hybrid',false,null),
 (33,'Fakely2','Gia','00001010','D','2027-02-16','Idylwood',false,false,false,'1977-06-15','Female','hybrid',false,null),
 (34,'Demo2','Hugo','01110100','E','2026-12-07','Redwood Grove',false,true,false,'1978-07-16','Female','hybrid',true,50),
 (35,'Mockford2','Ivy','01001000','D','2027-01-04','Canyon Springs',false,false,false,'1979-08-17','Male','hybrid',false,200),
 (36,'Trialson2','Jon','01100001','E','2027-02-16','Redwood Grove',false,false,false,'1980-09-18','Female','hybrid',false,200),
 (37,'Placeholder2','Kai','01001110','D','2026-12-07','Idylwood',false,false,false,'1981-01-10','Female','hybrid',false,200),
 (38,'Dummy2','Lia','01000000','E','2027-01-04','Canyon Springs',false,false,false,'1982-02-11','Female','hybrid',true,50),
 (39,'Synthetic2','Max','01001000','D','2027-02-16','Canyon Springs',false,false,false,'1983-03-12','Female','hybrid',false,200),
 (40,'Staging2','Nia','01100100','E','2026-12-07','Redwood Grove',false,false,false,'1984-04-13','Female','hybrid',false,200),
 (41,'Testa2','Owen','00001011','D','2027-01-04','Canyon Springs',false,false,false,'1985-05-14','Male','hybrid',false,null),
 (42,'Sampleton2','Pia','01100000','E','2027-02-16','Cedarwood',false,false,false,'1986-06-15','Female','hybrid',true,50),
 (43,'Fakely2','Quin','01101100','D','2026-12-07','Idylwood',false,false,false,'1987-07-16','Male','hybrid',false,200),
 (44,'Demo2','Rae','00000000','E','2027-01-04','Redwood Grove',false,false,false,'1988-08-17','Male','hybrid',false,null),
 (45,'Mockford2','Sam','01001010','D','2027-02-16','Idylwood',false,false,false,'1989-09-18','Male','hybrid',false,200),
 (46,'Trialson2','Tia','01000101','E','2026-12-07','Cedarwood',false,false,false,'1990-01-10','Male','hybrid',true,50),
 (47,'Placeholder2','Uma','00001000','D','2027-01-04','Idylwood',false,false,false,'1991-02-11','Male','hybrid',false,null),
 (48,'Dummy2','Vic','01000000','E','2027-02-16','Redwood Grove',false,false,false,'1992-03-12','Male','hybrid',false,200),
 (49,'Synthetic2','Wes','01001110','D','2026-12-07','Canyon Springs',false,false,false,'1993-04-13','Female','hybrid',false,200),
 (50,'Staging2','Xia','01000000','E','2027-01-04','Canyon Springs',false,false,false,'1994-05-14','Male','hybrid',true,50),
 (51,'Testa2','Yara','00001001','D','2027-02-16','Canyon Springs',false,false,false,'1995-06-15','Female','hybrid',false,null),
 (52,'Sampleton2','Zed','01000100','E','2026-12-07','Canyon Springs',false,false,false,'1996-07-16','Female','hybrid',false,200),
 (53,'Fakely3','Ava','00001010','D','2027-01-04','Canyon Springs',false,false,false,'1997-08-17','Male','hybrid',false,null),
 (54,'Demo3','Ben','01100000','E','2027-02-16','Redwood Grove',false,false,false,'1998-09-18','Female','hybrid',true,50),
 (55,'Mockford3','Cara','00001100','D','2026-12-07','Idylwood',false,false,false,'1999-01-10','Male','hybrid',false,null),
 (56,'Trialson3','Dan','01110001','E','2027-01-04','Redwood Grove',false,false,false,'2000-02-11','Male','hybrid',false,200),
 (57,'Placeholder3','Ella','00001010','D','2026-11-30','In-Person',false,false,false,'2001-03-12','Male','in_person',false,null),
 (58,'Dummy3','Finn','01000100','D','2026-11-30','In-Person',false,false,false,'2002-04-13','Male','in_person',false,200),
 (59,'Synthetic3','Gia','00001000','D','2026-11-30','In-Person',false,false,false,'2003-05-14','Female','in_person',false,null),
 (60,'Staging3','Hugo','01000000','D','2026-11-30','In-Person',false,false,false,'2004-06-15','Female','in_person',false,200),
 (61,'Testa3','Ivy','01001111','D','2026-11-30','In-Person',false,false,false,'1975-07-16','Female','in_person',false,200),
 (62,'Sampleton3','Jon','00000000','D','2027-01-04','In-Person',false,false,false,'1976-08-17','Female','in_person',false,null),
 (63,'Fakely3','Kai','01111000','D','2027-01-04','In-Person',false,false,false,'1977-09-18','Male','in_person',false,200),
 (64,'Demo3','Lia','00000100','D','2027-01-04','In-Person',false,false,false,'1978-01-10','Female','in_person',false,null),
 (65,'Mockford3','Max','00001010','D','2027-01-04','In-Person',false,false,false,'1979-02-11','Female','in_person',false,null),
 (66,'Trialson3','Nia','00000001','D','2027-01-04','In-Person',false,false,false,'1980-03-12','Male','in_person',false,null);

insert into public.students (
  student_code, program, pay_plan, first_name, last_name, email, phone, address, date_of_birth, gender,
  emergency_name, emergency_phone, cohort_id, schedule, site_id, end_date, waitlist, withdrawn, dropped,
  waiver_minor, form_283b, live_scan, tb_test, physical_exam, notes
)
select
  'CNA-T' || lpad(r.n::text, 4, '0'),
  r.program,
  case when r.program = 'in_person' then 'in_person' when r.promo then 'promo_50' else 'standard' end,
  r.first_name, r.last_name,
  lower(r.first_name || '.' || r.last_name) || '@example.com',
  (4085550999 + r.n)::text,
  (99 + r.n)::text || ' Test St, San Jose, CA 95112',
  r.dob, r.gender, 'Test Contact', '4085550000',
  c.id,
  case r.sched when 'E' then 'weekend' else 'weekday' end,
  s.id,
  case when r.sched = 'E' then c.weekend_end else c.weekday_end end,
  r.waitlist, r.withdrawn, r.dropped,
  substr(r.flags, 1, 1) = '1', substr(r.flags, 5, 1) = '1', substr(r.flags, 6, 1) = '1',
  substr(r.flags, 7, 1) = '1', substr(r.flags, 8, 1) = '1',
  'SYNTHETIC TEST STUDENT'
from raw_students r
join public.cohorts c on c.program = r.program and c.start_date = r.start_date
join public.sites s on s.short_name = r.site
order by r.n;

-- Payments from the ticked boxes. Registration date and amount come from its comment; the others had no comment.
insert into public.payments (student_id, stage, amount, method, paid_on, note, source, created_by)
select st.id, p.stage, p.amount, p.method, p.paid_on, p.note, 'import', 'import'
from raw_students r
join public.students st on st.student_code = 'CNA-T' || lpad(r.n::text, 4, '0')
cross join lateral (
  -- registration: In-Person and promo plans owe $50 here, so a $200 payment covers the $150 balance too
  select 'registration' as stage,
         case when st.pay_plan = 'standard' then coalesce(r.reg, 200) else 50 end::numeric as amount,
         case when r.reg is not null then 'stripe' end as method,
         case when r.reg = 50 then date '2026-11-16' when r.reg is not null then date '2026-11-10' end as paid_on,
         case when r.reg is not null then 'Stripe-' || case when r.reg = 50 then '11/16/2026' else '11/10/2026' end
              || '-$' || r.reg || ' (TEST)' else 'Imported from Sheet tick box' end as note
  where substr(r.flags, 2, 1) = '1'
  union all
  select 'reg_balance', 150, 'stripe', date '2026-11-10', 'Split from the $200 registration payment (TEST)'
  where substr(r.flags, 2, 1) = '1' and st.pay_plan <> 'standard' and r.reg = 200
  union all
  select 'first_partial', 800, null, null, 'Imported from Sheet tick box' where substr(r.flags, 3, 1) = '1'
  union all
  select 'final', 798, null, null, 'Imported from Sheet tick box' where substr(r.flags, 4, 1) = '1'
) p;

alter table public.students enable trigger students_log;
alter table public.payments enable trigger payments_log;

insert into public.activity_log (user_email, action, details)
values ('system', 'Data imported', 'Loaded 66 synthetic students and Class Config from Project1 STAGING');

commit;

-- First admin (run once, with the real address):
-- insert into public.staff (email, full_name, role) values ('you@example.com', 'Your Name', 'admin');
