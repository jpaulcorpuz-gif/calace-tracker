-- Packet: a Minor Waiver item, filled in by the tracker only for students under 18 on their start date.
update public.email_templates
set body_html = replace(body_html, '<div style="background:#FDE6E1', '{minor_waiver_section}
<div style="background:#FDE6E1')
where auto_key = 'packet' and position('{minor_waiver_section}' in body_html) = 0;
