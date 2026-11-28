-- Welcome Letter email. The tracker attaches the Welcome Letter PDF, filled in for the student, when it's sent.
-- Only fills it in if it hasn't been written yet, so staff edits are kept.
update public.email_templates
set subject = 'Welcome to CAL ACE Nursing Academy: Your Welcome Letter and Formal Enrollment Certification',
body_html = $html$<p>Dear {full_name},</p>
<p><b>Welcome to CAL ACE Nursing Academy!</b> On behalf of our leadership team, instructors, and staff, we are pleased to welcome you to the <b>{start_date} Cohort</b> of our <b>Nurse Assistant Training Program (NATP)</b>.</p>
<p>Attached to this email is your official <b>Welcome Letter and Formal Enrollment Certification</b>. This document confirms your enrollment and contains important information about your program, including your schedule, requirements, policies, and student resources.</p>
<div style="background:#E3F7EF;border-left:4px solid #2CC990;border-radius:6px;padding:12px 16px;margin:16px 0">
<p style="margin:0 0 8px;font-weight:700;color:#164E45">YOUR ENROLLMENT AT A GLANCE</p>
<p style="margin:0">Program Start Date: <b>{start_date}</b><br>Expected Completion: <b>{end_date}</b><br>Clinical Schedule: <b>{clinical_preference}</b><br>Clinical Location: <b>{clinical_location}</b></p>
</div>
<p style="margin:20px 0 8px;font-weight:700;color:#164E45">WHAT'S INSIDE YOUR WELCOME LETTER</p>
<ul>
<li>Program structure and schedule: online theory via Zoom during the first three weeks, followed by in-person clinical training</li>
<li>Quiz, passing, and final exam standards</li>
<li>Important links, including the Orientation Video, Zoom, Google Classroom, onboarding forms, and the Student Handbook</li>
<li>Clinical site information, attendance policy, and clinical conduct expectations</li>
<li>Tuition, payment schedule, technology requirements, and instructor contacts</li>
</ul>
{classroom_section}
<div style="background:#FDE6E1;border-left:4px solid #E0533C;border-radius:6px;padding:12px 16px;margin:20px 0">
<p style="margin:0 0 8px;font-weight:700;color:#B03A26">BEFORE YOUR FIRST DAY</p>
<p style="margin:0">Please <b>read your Welcome Letter carefully and in full</b>. Watch the required Orientation Video, join Google Classroom, and complete all onboarding forms and requirements <b>by the deadlines stated in the letter</b>. Incomplete requirements may affect your participation in clinical training.</p>
</div>
<p>If you have any questions or need assistance, simply reply to this email or call our office at <b>(408) 256-0763</b>. Our team is happy to help.</p>
<p>Thank you for choosing CAL ACE Nursing Academy. We look forward to seeing you in class on <b>{start_date}</b>!</p>
<p>Warm regards,</p>
<p><b>Admissions and Administration Department</b><br>CAL ACE Nursing Academy<br>1535 Landess Avenue, Unit 103, Milpitas, CA 95035<br><a href="mailto:calace@cna.school">calace@cna.school</a> | (408) 256-0763<br><a href="https://calacenursingacademy.com/">https://calacenursingacademy.com/</a></p>$html$
where auto_key = 'welcome_letter' and coalesce(trim(body_html), '') = '';
