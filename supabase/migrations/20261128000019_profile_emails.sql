-- Emails sent from a student's profile: the enrollment Packet, and a Welcome Letter to be written later.
-- They use auto_key so they can't be deleted, but they are never automatic (auto_on stays false).
insert into public.email_templates (name, subject, body_html, auto_key, auto_on) values
('Packet', 'CNA Program Enrollment Confirmation and Mandatory Requirements',
$html$<p>Dear {full_name},</p>
<p>Congratulations! We are pleased to officially confirm your enrollment in the <b>Certified Nursing Assistant (CNA) Program</b> at CAL ACE Nursing Academy.</p>
<div style="background:#E3F7EF;border-left:4px solid #2CC990;border-radius:6px;padding:12px 16px;margin:16px 0">
<p style="margin:0 0 8px;font-weight:700;color:#164E45">CONFIRMED ENROLLMENT DETAILS</p>
<p style="margin:0">Program Start Date: <b>{start_date}</b><br>Clinical Schedule: <b>{clinical_preference}</b><br>Clinical Location: <b>{clinical_location}</b></p>
</div>
<p style="margin:20px 0 8px;font-weight:700;color:#164E45">MANDATORY PROGRAM REQUIREMENTS</p>
<p>To ensure compliance with the program's enrollment and clinical training requirements, all students must complete and submit the following documents <b style="background:#FFF1C2;padding:1px 4px">no later than {docs_due}</b>.</p>
<p style="margin:16px 0 4px"><b>1. Health Clearance and Background Screening</b></p>
<ul><li>Live Scan Fingerprinting</li><li>Tuberculosis (TB) Test</li><li>Physical Examination</li></ul>
<p>Required forms and instructions are available at:<br><a href="https://calacenursingacademy.com/forms/">https://calacenursingacademy.com/forms/</a></p>
<p>Please submit clear, legible copies of your completed documents to <a href="mailto:docs@cna.school"><b>docs@cna.school</b></a>.</p>
<p style="margin:16px 0 4px"><b>2. CDPH 283B Application Form</b></p>
<p>Complete the Certified Nurse Assistant Initial Application (CDPH 283B). Please ensure that all personal information is accurate and that all required fields are properly completed.</p>
<p>Complete the form here:<br><a href="https://pdf.ac/mWRl_3np"><b>https://pdf.ac/mWRl_3np</b></a></p>
<p style="margin:16px 0 4px"><b>3. Detailed Student Onboarding</b></p>
<p>Carefully read, review, and <b>sign all required pages</b> of the Detailed Student Onboarding document. This document outlines important program policies, academic expectations, attendance requirements, and student responsibilities.</p>
<p>Access your onboarding document here:<br><a href="{onboarding_link}"><b>{onboarding_link}</b></a></p>
<div style="background:#FDE6E1;border-left:4px solid #E0533C;border-radius:6px;padding:12px 16px;margin:20px 0">
<p style="margin:0 0 8px;font-weight:700;color:#B03A26">IMPORTANT REMINDERS</p>
<p style="margin:0">Students are responsible for ensuring that all required documents are <b>complete, accurate, and submitted by the specified deadline</b>. <b>Incomplete or late submissions may affect your eligibility to participate in clinical training</b> and your ability to progress through the program.</p>
</div>
<p>We strongly encourage you to complete these requirements as early as possible to avoid unnecessary delays.</p>
<p>Should you have any questions or require assistance, please contact our administrative office.</p>
<p>Welcome to CAL ACE Nursing Academy! We look forward to supporting you throughout your training and helping you achieve your goal of becoming a Certified Nursing Assistant.</p>
<p>Warm regards,</p>
<p><b>Admissions and Administration Department</b><br>CAL ACE Nursing Academy<br><a href="https://calacenursingacademy.com/">https://calacenursingacademy.com/</a></p>$html$,
 'packet', false),
('Welcome Letter', '', '', 'welcome_letter', false)
on conflict (auto_key) do nothing;
