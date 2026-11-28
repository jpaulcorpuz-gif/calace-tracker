/* CAL ACE Student Tracker — staff app on Supabase.
   Every change goes straight to the database; triggers there write the Activity Log. */
(function () {
"use strict";

const CFG = window.CALACE_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

/* ---------------- Configuration ---------------- */
const PROGRAMS = [["hybrid", "CNA Hybrid"], ["in_person", "CNA In-Person"]];
const STAGES = [["registration", "Registration", "Reg"], ["reg_balance", "Reg balance", "Bal"], ["first_partial", "1st partial", "1st"], ["final", "Final payment", "Final"]];
const METHODS = [["stripe", "Stripe", "S"], ["zelle", "Zelle", "Z"], ["cash", "Cash", "C"], ["terminal", "Terminal", "T"], ["check", "Check", "CH"]];
const REQS = [["form_283b", "283B form", "283B"], ["live_scan", "Live Scan", "Live Scan"], ["tb_test", "TB test", "TB test"], ["physical_exam", "Physical exam", "Physical"], ["onboarding", "Onboarding letter", "Onboarding"], ["valid_id", "Valid ID", "Valid ID"], ["skills_checklist", "Skills checklist", "Skills"]];
const CLINICAL_REQS = ["form_283b", "live_scan", "tb_test", "physical_exam", "onboarding", "valid_id"];
const ATT = [["theory_attendance", "Theory attendance", "Theory"], ["clinical_attendance", "Clinical attendance", "Clinical"]];
const EXAMS = [["quizzes", "Quizzes 1–17", "Quizzes"], ["final_exam", "Final exam", "Final exam"]];
const OASYS = ["", "Not started", "Submitted", "Approved"];
const DOCS = [["live_scan", "Live Scan"], ["283b_signed", "Signed 283B"], ["physical_exam", "Physical exam"], ["tb_test", "TB test"], ["valid_id", "Valid ID"]];
const DOC_REQ = { live_scan: "live_scan", "283b_signed": "form_283b", physical_exam: "physical_exam", tb_test: "tb_test", valid_id: "valid_id" };   // the database ticks these on upload
const DRIVE_FN = CFG.supabaseUrl + "/functions/v1/drive/";
const DOC_MAX_BYTES = 10 * 1024 * 1024;
const DOC_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"];
const PLAN_NAMES = { standard: "Standard", promo_50: "Promo $50", in_person: "In-Person" };
const VIEWS = [["all", "All active"], ["owe", "Balance due"], ["hold", "On hold"], ["ready", "Ready for state exam"], ["waitlist", "Waitlist"], ["out", "Withdrawn or dropped"]];
const FIELD_LABELS = {
  first_name: "First name", last_name: "Last name", email: "Email", phone: "Phone", address: "Address", date_of_birth: "Date of birth",
  gender: "Gender", emergency_name: "Emergency contact", emergency_phone: "Emergency phone", student_code: "Student ID",
  program: "Program", pay_plan: "Pay plan", cohort_id: "Start date", schedule: "Schedule", site_id: "Clinical site", end_date: "End date",
  waitlist: "Waitlist", withdrawn: "Withdrawn", dropped: "Dropped", waiver_minor: "Minor waiver", orientation: "Attended orientation",
  oasys_status: "OASYS", english_score: "English assessment", notes: "Notes", notes_by: "Notes by", portal_invite: "Portal invite", evaluation: "Evaluation"
};
[...REQS, ...ATT, ...EXAMS].forEach(([k, l]) => FIELD_LABELS[k] = l);
// Leads: three follow-up emails. Each is due this many days after the previous step (sign-up for the first).
const FOLLOWUPS = [["followup_1_at", "Follow-up 1", 1], ["followup_2_at", "Follow-up 2", 3], ["followup_3_at", "Follow-up 3", 7]];
FOLLOWUPS.forEach(([k, l]) => FIELD_LABELS[k] = l + " email");
/* Staff access. Areas are 0 none, 1 view, 2 edit; admins have everything. The database enforces the same rules
   (private.perm), so these checks only decide what to show. */
const AREAS = [
  ["cna", "CNA students", "Roster, profiles, requirements, documents, start dates"],
  ["training", "Attendance & exams", "Theory and clinical attendance, quizzes, final exam, skills checklist"],
  ["payments", "Payments", "Record and remove payments"],
  ["programs", "RNA, HHA, BLS, CEU", "Sign-ups for the other programs"],
  ["leads", "Leads & follow-ups", "Unpaid students and follow-up emails"],
  ["overview", "Business Overview", "Money collected and enrollment charts"],
  ["logs", "Logs", "The full change history"],
  ["schedule", "Schedule", "Calendar of classes, clinicals and events"],
  ["templates", "Email templates", "Compose emails, edit templates, turn automatic emails on or off"],
  ["staff", "Staff & permissions", "This page: add staff and change their access"]
];
const ROLES = [["admin", "Admin"], ["office", "Office staff"], ["instructor", "Instructor"], ["viewer", "View only"]];
const ROLE_PRESETS = {
  office: { cna: 2, training: 2, payments: 2, programs: 2, leads: 2, overview: 0, logs: 1, templates: 2, schedule: 2, staff: 0, delete: false, export: true },
  instructor: { cna: 1, training: 2, payments: 0, programs: 1, leads: 0, overview: 0, logs: 0, templates: 0, schedule: 1, staff: 0, delete: false, export: false },
  viewer: { cna: 1, training: 1, payments: 1, programs: 1, leads: 1, overview: 1, logs: 1, templates: 1, schedule: 1, staff: 0, delete: false, export: false }
};
const TRAINING_KEYS = ["theory_attendance", "clinical_attendance", "quizzes", "final_exam", "skills_checklist", "evaluation"];
function isAdmin() { return !!(S.me && S.me.role === "admin"); }
function can(area, level = 1) { if (!S.me) return false; if (isAdmin()) return true; return num((S.me.permissions || {})[area]) >= level; }
function canFlag(f) { return isAdmin() || !!(S.me && (S.me.permissions || {})[f]); }
function pageAllowed(p) {
  if (p === "home") return can("cna") || can("training") || can("leads");
  if (p === "schedule") return can("schedule");
  if (p === "students") return can("cna") || can("training");
  if (p === "other") return can("programs");
  if (p === "leads") return can("leads");
  if (p === "overview") return can("overview");
  if (p === "log") return can("logs");
  if (p === "staff") return can("staff");
  if (p === "templates") return can("templates");
  if (p === "export") return canFlag("export");
  if (p === "drive") return isAdmin();
  return false;
}
function viewOnly(what) { toast(`You can view ${what} but not change it. Ask an admin for edit access.`); }
const LEAD_VIEWS = [["all", "All leads"], ["due", "Follow-up due"], ["new", "Not contacted"], ["done", "All 3 sent"]];

const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const ISO_TODAY = iso(TODAY);
const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

/* ---------------- State ---------------- */
const S = {
  me: null, loaded: false, page: "home", program: "hybrid",
  students: [], payments: [], files: [], cohorts: [], sites: [], cohortSites: [], settings: {}, log: [],
  q: "", cohort: "", sched: "", loc: "", view: "all", logProg: "", logLimit: 300,
  localTouch: {}, seenLogId: 0, drive: null, other: "rna", status: "paid", lview: "all", lprog: "",
  sel: new Set(), selCtx: ""   // ticked students on the current list (student ids, or "r"+id for RNA/HHA/BLS/CEU sign-ups)
};

/* ---------------- Ticked students: copy their emails ---------------- */
function pick(key) { return `<input type="checkbox" class="pick" data-pick="${esc(key)}"${S.sel.has(key) ? " checked" : ""} aria-label="Select">`; }
function pickAll() { return `<input type="checkbox" class="pick pick-all" data-pickall="1" aria-label="Select everyone in this list">`; }
function selKeys() {   // everyone in the current list, with its filters and search
  if (S.page === "students") return filtered().map(s => s.id);
  if (S.page === "leads") return leadsFiltered().map(s => s.id);
  if (S.page === "other") return oFiltered().map(r => "r" + r.id);
  return [];
}
function selPeople() {
  return [...S.sel].map(k => {
    if (k[0] === "r") { const cfg = oCfg(), r = (OT.rows[cfg.table] || []).find(x => "r" + x.id === k); return r ? { key: k, name: recName(cfg, r), email: String(r.data[cfg.email] || r.email || "").trim() } : null; }
    const s = S.students.find(x => x.id === k); return s ? { name: s.first_name + " " + s.last_name, email: String(s.email || "").trim() } : null;
  }).filter(Boolean);
}
function updateSelBar() {
  const bar = $("selbar"), keys = selKeys(), keySet = new Set(keys);
  [...S.sel].forEach(k => { if (!keySet.has(k)) S.sel.delete(k); });   // drop people filtered out of view
  document.querySelectorAll(".pick-all").forEach(a => { const n = keys.filter(k => S.sel.has(k)).length; a.checked = !!n && n === keys.length; a.indeterminate = n > 0 && n < keys.length; });
  if (!S.sel.size) { bar.hidden = true; return; }
  const ppl = selPeople(), emails = [...new Set(ppl.map(p => p.email.toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
  bar.hidden = false;
  bar.innerHTML = `<span><b class="num">${S.sel.size}</b> selected · ${emails.length} ${emails.length === 1 ? "email" : "emails"}${ppl.length - emails.length > 0 ? ` <small>(${ppl.length - emails.length} without a valid email)</small>` : ""}</span>
    <button class="primary" type="button" id="sel-copy"${emails.length ? "" : " disabled"}>Copy emails</button>
    ${can("templates") || can("leads", 2) ? `<button class="ghost" type="button" id="sel-mail"${emails.length ? "" : " disabled"}>Compose email</button>` : ""}
    ${canFlag("export") ? `<button class="ghost" type="button" id="sel-export">Export CSV</button>` : ""}
    <button class="ghost" type="button" id="sel-all">Select all ${keys.length}</button>
    <button class="ghost" type="button" id="sel-clear">Clear</button>`;
  $("sel-copy").onclick = async () => {
    const text = emails.join(", ");
    try { await navigator.clipboard.writeText(text); toast(`Copied ${emails.length} ${emails.length === 1 ? "email" : "emails"}. Paste them into the To or Bcc field.`); }
    catch (e) { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast(`Copied ${emails.length} emails`); } catch (er) { toast("Couldn't copy. Try again."); } ta.remove(); }
  };
  if ($("sel-mail")) $("sel-mail").onclick = () => {
    const people = [...S.sel].map(k => { if (k[0] === "r") { const p = selPeople().find(x => x.key === k); return p || null; } const s = S.students.find(x => x.id === k); return s ? { email: s.email, student: s } : null; }).filter(Boolean);
    composeTo(people.length ? people : ppl);
  };
  if ($("sel-export")) $("sel-export").onclick = () => {
    const label = S.page === "other" ? OTHER[S.other].label : S.page === "leads" ? "Leads" : lab(PROGRAMS, S.program);
    S.exportSet = { kind: S.page === "other" ? "records" : "students", cfgKey: S.page === "other" ? S.other : null, keys: [...S.sel], label };
    closeDrawer(); S.page = "export"; render(); routeAnim();
  };
  $("sel-all").hidden = S.sel.size >= keys.length;
  $("sel-all").onclick = () => { keys.forEach(k => S.sel.add(k)); syncPicks(); };
  $("sel-clear").onclick = () => { S.sel.clear(); syncPicks(); };
}
function syncPicks() { document.querySelectorAll("[data-pick]").forEach(c => c.checked = S.sel.has(c.dataset.pick)); updateSelBar(); }
document.addEventListener("change", e => {
  const c = e.target;
  if (c.dataset && c.dataset.pick) { if (c.checked) S.sel.add(c.dataset.pick); else S.sel.delete(c.dataset.pick); updateSelBar(); }
  else if (c.dataset && c.dataset.pickall) { const keys = selKeys(); if (c.checked) keys.forEach(k => S.sel.add(k)); else keys.forEach(k => S.sel.delete(k)); syncPicks(); }
});
try { const p = localStorage.getItem("calace.program") || ""; if (PROGRAMS.some(x => x[0] === p)) { S.program = p; S.page = "students"; } else if (["home", "schedule", "leads", "overview", "staff", "templates", "export"].includes(p)) S.page = p; else if (/^o:(rna|hha|bls|ceu)$/.test(p)) { S.page = "other"; S.other = p.slice(2); }
  if (localStorage.getItem("calace.ovView") === "site") S.ovView = "site"; } catch (e) {}

/* ---------------- Helpers ---------------- */
const $ = id => document.getElementById(id);
// Line icons for the sidebar (24px grid, drawn with currentColor).
const ICONS = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19.5h20"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.8a3.2 3.2 0 0 1 0 6.2M21 20c0-2.7-1.6-5-4-5.7"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
  house: '<path d="M4 11 12 4l8 7v9H4z"/><path d="M12 17.5s-3-1.8-3-4a1.7 1.7 0 0 1 3-1 1.7 1.7 0 0 1 3 1c0 2.2-3 4-3 4z"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4 4 0 0 1 12 7.3a4 4 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
  award: '<circle cx="12" cy="9" r="5"/><path d="m8.6 13.4-1.6 7.1 5-2.6 5 2.6-1.6-7.1"/>',
  chart: '<path d="M5 20v-8M11 20V5M17 20v-5M3 20.5h18"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".9"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7.5 8 6 8-6"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  file: '<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  people: '<circle cx="9" cy="9" r="3"/><path d="M4 18c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M15.5 14.2c2.2.1 3.9 1.5 4.5 3.8"/>'
};
function icon(n, cls) { return `<svg class="${cls || "ic"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ""}</svg>`; }
function initials(name) { const p = String(name || "").replace(/[^\p{L}\s'-]/gu, " ").trim().split(/\s+/); return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase(); }
const AV_COLORS = ["#CDEFE1", "#FDE7C8", "#DDE5FB", "#F9D9D3", "#E5DBF7", "#D3EEF5", "#F4E6B8"];
function avColor(key) { let h = 0; for (const ch of String(key || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AV_COLORS[h % AV_COLORS.length]; }
function avatar(name, key) { return `<span class="av" style="--av:${avColor(key || name)}" aria-hidden="true">${esc(initials(name))}</span>`; }
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
function money(n) { return "$" + Math.round(num(n)).toLocaleString("en-US"); }
function lab(arr, k) { return (arr.find(x => x[0] === k) || [k, k])[1]; }
function fmtDate(s, withYear = true) { if (!s) return "—"; const d = new Date(s + "T00:00:00"); if (isNaN(d)) return s; return d.toLocaleDateString("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" }); }
function shortDate(s) { if (!s) return ""; const p = s.split("-"); return p.length === 3 ? (+p[1]) + "/" + (+p[2]) : s; }
function fmtTime(s) { return new Date(s).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
function dayLabel(s) { const d = new Date(s); d.setHours(0, 0, 0, 0); const diff = Math.round((TODAY - d) / 864e5); if (diff === 0) return "Today"; if (diff === 1) return "Yesterday"; return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: d.getFullYear() === TODAY.getFullYear() ? undefined : "numeric" }); }
function daysUntil(s) { if (!s) return Infinity; return Math.round((new Date(s + "T00:00:00") - TODAY) / 864e5); }
function methodName(m) { return (METHODS.find(x => x[0] === m) || [0, ""])[1]; }
function methodCode(m) { return (METHODS.find(x => x[0] === m) || [0, 0, ""])[2]; }
function fullName(s) { return (s.last_name || "") + ", " + (s.first_name || ""); }
function cohortOf(s) { return S.cohorts.find(c => c.id === s.cohort_id) || null; }
function siteOf(s) { return S.sites.find(x => x.id === s.site_id) || null; }
function startOf(s) { const c = cohortOf(s); return c ? c.start_date : ""; }
function endOf(s) { if (s.end_date) return s.end_date; const c = cohortOf(s); return c ? (s.schedule === "weekend" && c.weekend_end ? c.weekend_end : c.weekday_end) || "" : ""; }
function ageAt(dob, on) { if (!dob) return null; const b = new Date(dob + "T00:00:00"), d = new Date((on || ISO_TODAY) + "T00:00:00"); let a = d.getFullYear() - b.getFullYear(); if (d < new Date(d.getFullYear(), b.getMonth(), b.getDate())) a--; return a; }
function isMinor(s) { const a = ageAt(s.date_of_birth, startOf(s) || ISO_TODAY); return a != null && a < 18; }
function setConn(text, state) { const c = $("conn"); c.innerHTML = `<i class="dot ${state}" aria-hidden="true"></i>`; c.append(text); }
function shake(el) { if (!el) return; el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake"); setTimeout(() => el.classList.remove("shake"), 450); }
function routeAnim() { const w = $("wrap"); w.classList.remove("route"); void w.offsetWidth; w.classList.add("route"); setTimeout(() => w.classList.remove("route"), 320); }
function errText(e) {
  const m = (e && (e.message || e.error_description)) || "";
  if (/row-level security|permission/i.test(m)) return "You don't have permission to change this. Ask an admin to add you to the staff list.";
  if (/duplicate key.*email/i.test(m)) return "Another student already uses this email.";
  if (/duplicate key.*student_code/i.test(m)) return "Another student already has this Student ID.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Couldn't reach the database. Check your connection and try again.";
  return m || "Something went wrong. Try again.";
}

/* ---------------- Motion switch and intro ---------------- */
const SYS_REDUCED = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
let motionPref = null; try { motionPref = localStorage.getItem("calace.motion"); } catch (e) {}
function motionOn() { return motionPref ? motionPref === "on" : !SYS_REDUCED; }
function applyMotion() {
  document.documentElement.dataset.motion = motionOn() ? "on" : "off";
  const b = $("motion-toggle");
  b.setAttribute("aria-pressed", motionOn());
  b.textContent = motionOn() ? "Animations: on" : "Animations: off" + (!motionPref && SYS_REDUCED ? " (your computer reduces motion)" : "");
}
function playIntro() {
  if (!motionOn() || document.querySelector(".intro")) return;
  const el = document.createElement("div"); el.className = "intro"; el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<div class="intro__box"><svg class="intro__ring" viewBox="0 0 120 120"><circle cx="60" cy="60" r="54"/></svg>
    <div class="intro__mark logo-tile"><img src="assets/brand/emblem.png" alt=""></div>
    <div class="intro__word">CAL ACE</div><div class="intro__tag">Student Tracker</div></div>`;
  document.body.appendChild(el);
  const leave = () => { if (el.classList.contains("leaving")) return; el.classList.add("leaving"); setTimeout(() => el.remove(), 480); };
  el.addEventListener("click", leave); setTimeout(leave, 1300);
}
applyMotion();
$("motion-toggle").addEventListener("click", () => {
  motionPref = motionOn() ? "off" : "on"; try { localStorage.setItem("calace.motion", motionPref); } catch (e) {}
  applyMotion(); if (motionOn()) playIntro();
});

/* ---------------- Money and standing ---------------- */
function plan(s) { return (S.settings.pay_plans || {})[s.pay_plan] || {}; }
function paidFor(s, stage) { return S.payments.filter(p => p.student_id === s.id && p.stage === stage).reduce((t, p) => t + num(p.amount), 0); }
function lastPay(s, stage) { const r = S.payments.filter(p => p.student_id === s.id && p.stage === stage); return r[r.length - 1] || null; }
function moneyOf(s) {
  const pl = plan(s); let due = 0, paid = 0;
  STAGES.forEach(([k]) => { due += num(pl[k]); paid += paidFor(s, k); });
  return { due, paid, balance: Math.max(0, due - paid) };
}
function assess(s) {
  const m = moneyOf(s);
  const missing = CLINICAL_REQS.filter(k => !s[k]).map(k => (REQS.find(r => r[0] === k) || [0, 0, k])[2]);
  if (!s.orientation) missing.push("Orientation");
  if (isMinor(s) && !s.waiver_minor) missing.push("Minor waiver");
  const trainingDone = s.theory_attendance && s.clinical_attendance && s.quizzes && s.final_exam && s.skills_checklist;
  const oasysDone = ["Submitted", "Approved"].includes(s.oasys_status);
  const examHolds = [];
  if (!oasysDone) examHolds.push("OASYS");
  if (m.balance > 0) examHolds.push(money(m.balance) + " balance");
  let tone, text, why = "";
  if (s.withdrawn) { tone = "off"; text = "Withdrawn"; }
  else if (s.dropped) { tone = "off"; text = "Dropped"; }
  else if (missing.length) { tone = "hold"; text = "Hold for clinicals"; why = "Missing " + missing.join(", "); }
  else if (trainingDone && !examHolds.length) { tone = "ok"; text = "Ready for state exam"; }
  else if (trainingDone) { tone = "due"; text = "Exam hold"; why = examHolds.join(", "); }
  else { tone = "go"; text = "Cleared for clinicals"; why = m.balance > 0 ? money(m.balance) + " still due" : "Paid in full"; }
  return { m, tone, text, why, ready: tone === "ok", out: s.withdrawn || s.dropped };
}

/* ---------------- Loading and live updates ---------------- */
async function loadAll() {
  const res = await Promise.all([
    sb.from("students").select("*"),
    sb.from("payments").select("*").order("id"),
    sb.from("cohorts").select("*").order("start_date"),
    sb.from("sites").select("*").order("sort_order"),
    sb.from("cohort_sites").select("*"),
    sb.from("settings").select("*"),
    sb.from("activity_log").select("*").order("at", { ascending: false }).order("id", { ascending: false }).limit(1000),
    sb.from("student_files").select("*").order("id"),
    sb.from("email_templates").select("*").order("id"),
    sb.from("schedule_events").select("*").order("day").order("start_time"),
    sb.from("classrooms").select("*")
  ]);
  const bad = res.find(r => r.error); if (bad) throw bad.error;
  [S.students, S.payments, S.cohorts, S.sites, S.cohortSites] = res.slice(0, 5).map(r => r.data);
  S.settings = Object.fromEntries(res[5].data.map(r => [r.key, r.value]));
  S.log = res[6].data;
  S.files = res[7].data;
  S.templates = res[8].data;
  S.events = res[9].data;
  S.classrooms = res[10].data;
  let seen = null; try { seen = localStorage.getItem("calace.seenLog"); } catch (e) {}
  S.seenLogId = seen ? +seen : maxLogId();   // first visit: nothing counts as new
  S.loaded = true;
}
function byNewest(a, b) { return String(b.at).localeCompare(String(a.at)) || b.id - a.id; }
function maxLogId() { return S.log.reduce((m, x) => Math.max(m, x.id), 0); }
function upsertLocal(arr, row) { const i = arr.findIndex(x => x.id === row.id); if (i >= 0) arr[i] = row; else arr.push(row); }
function removeLocal(arr, id) { const i = arr.findIndex(x => x.id === id); if (i >= 0) arr.splice(i, 1); }
function subscribe() {
  sb.channel("tracker")
    .on("postgres_changes", { event: "*", schema: "public", table: "students" }, p => {
      if (p.eventType === "DELETE") removeLocal(S.students, p.old.id); else upsertLocal(S.students, p.new);
      render(); if (draftId === (p.new && p.new.id)) renderHistory();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, p => {
      if (p.eventType === "DELETE") removeLocal(S.payments, p.old.id); else upsertLocal(S.payments, p.new);
      render(); refreshLedger();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "student_files" }, p => {
      if (p.eventType === "DELETE") removeLocal(S.files, p.old.id); else upsertLocal(S.files, p.new);
      refreshDocs();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "schedule_events" }, p => {
      S.events = S.events || [];
      if (p.eventType === "DELETE") removeLocal(S.events, p.old.id); else upsertLocal(S.events, p.new);
      renderRail(); if (S.page === "schedule" && !$("layer").innerHTML) renderSchedule();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "email_templates" }, p => {
      S.templates = S.templates || [];
      if (p.eventType === "DELETE") removeLocal(S.templates, p.old.id); else upsertLocal(S.templates, p.new);
      if (S.page === "templates" && !$("layer").innerHTML) renderTemplates();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "staff" }, p => {
      const row = p.new && p.new.email ? p.new : null;
      if (row && S.me && row.email === S.me.email) { Object.assign(S.me, row); render(); }   // my access changed
      if (S.page === "staff") loadStaff();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "rna_hha_registrations" }, p => onRecordChange("rna_hha_registrations", p))
    .on("postgres_changes", { event: "*", schema: "public", table: "bls_registrations" }, p => onRecordChange("bls_registrations", p))
    .on("postgres_changes", { event: "*", schema: "public", table: "ceu_registrations" }, p => onRecordChange("ceu_registrations", p))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_log" }, p => {
      if (!S.log.some(x => x.id === p.new.id)) { S.log.unshift(p.new); S.log.sort(byNewest); }
      renderRail(); if (S.page === "log") renderLog(); renderHistory(); renderRecHistory();
    })
    .subscribe(status => {
      if (status === "SUBSCRIBED") setConn("Live: teammates' changes show up as they happen.", "live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setConn("Live updates paused. Reload to reconnect.", "");
    });
}

/* ---------------- Filtering ---------------- */
function inProgram() { return S.students.filter(s => s.program === S.program); }
// Status dropdown. "Paid" (the default after every reload) means any payment recorded; the follow-up lists are paid students only.
// Students past their end date only appear under "Completed / past end date" (and All students).
// Unpaid students (initial sign-ups) are worked from the Leads page instead.
const STATUSES = [["paid", "Paid"], ["noassign", "No assignment"], ["incomplete", "Incomplete requirements"], ["completed", "Completed / past end date"], ["waitlist", "Waitlist"], ["out", "Withdrawn or dropped"], ["any", "All students"]];
function pastEnd(s) { const e = endOf(s); return !!e && e < ISO_TODAY; }
function paidIds() { const t = new Map(); S.payments.forEach(p => t.set(p.student_id, (t.get(p.student_id) || 0) + num(p.amount))); return new Set([...t].filter(([, v]) => v > 0).map(([k]) => k)); }
function noAssignment(s) { return !s.cohort_id || !s.site_id || !(s.schedule === "weekday" || s.schedule === "weekend"); }
function missingReqs(s) { return REQS.filter(([k]) => k !== "skills_checklist" && !s[k]); }
function statusMatch(st, s, paid) {
  if (st === "any") return true;
  if (st === "completed") return pastEnd(s);
  if (st === "out") return !!(s.withdrawn || s.dropped);
  if (pastEnd(s)) return false;
  if (st === "waitlist") return !!s.waitlist;
  if (st === "initial") return !paid.has(s.id);
  if (!paid.has(s.id)) return false;
  if (st === "noassign") return noAssignment(s);
  if (st === "incomplete") return missingReqs(s).length > 0;
  return true;
}
function inStatus() { const paid = paidIds(); return inProgram().filter(s => statusMatch(S.status, s, paid)); }
function filtered() {
  const q = S.q.trim().toLowerCase();
  return inStatus().filter(s => {
    const a = assess(s);
    if (S.status === "out" ? !a.out : a.out) return false;   // withdrawn and dropped students only appear under their own option
    if (S.cohort && String(s.cohort_id) !== S.cohort) return false;
    if (S.sched && s.schedule !== S.sched) return false;
    if (S.loc && String(s.site_id) !== S.loc) return false;
    if (q) { const hay = [s.first_name, s.last_name, s.email, s.phone, s.notes, s.student_code].join(" ").toLowerCase(); if (!hay.includes(q)) return false; }
    if (S.view === "owe" && a.m.balance <= 0) return false;
    if (S.view === "hold" && a.tone !== "hold") return false;
    if (S.view === "ready" && !a.ready) return false;
    if (S.view === "waitlist" && !s.waitlist) return false;
    return true;
  }).sort((a, b) => (a.last_name || "").localeCompare(b.last_name || "") || (a.first_name || "").localeCompare(b.first_name || ""));
}

/* ---------------- Rail and header ---------------- */
function renderRail() {
  const paid = paidIds();
  const nLeads = leadList().length;
  $("leads-ct").textContent = nLeads || ""; $("nav-leads").setAttribute("aria-current", S.page === "leads");
  $("nav-overview").setAttribute("aria-current", S.page === "overview");
  $("nav-home").setAttribute("aria-current", S.page === "home"); $("nav-home-li").hidden = !pageAllowed("home");
  $("nav-sched").setAttribute("aria-current", S.page === "schedule"); $("nav-sched-li").hidden = !pageAllowed("schedule");
  $("sched-ct").textContent = (S.events || []).filter(e => e.day === ISO_TODAY).length || "";
  document.querySelectorAll(".rail [data-icon]").forEach(b => { const s = b.querySelector("span"); if (s && !s.querySelector(".ic")) s.insertAdjacentHTML("afterbegin", icon(b.dataset.icon)); });
  $("nav-staff").setAttribute("aria-current", S.page === "staff");
  $("nav-tpl").setAttribute("aria-current", S.page === "templates"); $("nav-export").setAttribute("aria-current", S.page === "export");
  $("nav-tpl-li").hidden = !can("templates"); $("nav-export-li").hidden = !canFlag("export"); $("tools-group").hidden = !can("templates") && !canFlag("export");
  $("export-ct").textContent = S.exportSet && S.exportSet.keys.length ? S.exportSet.keys.length : "";
  $("nav-leads-li").hidden = !can("leads"); $("nav-overview-li").hidden = !can("overview"); $("nav-log-li").hidden = !can("logs"); $("nav-staff-li").hidden = !can("staff");
  const addOk = S.page === "other" ? can("programs", 2) : S.page === "leads" ? (can("cna", 2) || can("leads", 2)) : can("cna", 2);
  $("add-student").hidden = !addOk; $("export-csv").hidden = !canFlag("export");
  // What this person may change, for the stylesheet to hide edit-only controls.
  const b = document.body.dataset; b.payEdit = can("payments", 2); b.cnaEdit = can("cna", 2); b.stuSave = can("cna", 2) || can("training", 2) || can("leads", 2);
  b.canDelete = canFlag("delete"); b.progEdit = can("programs", 2); b.leadEdit = can("leads", 2);
  // One "Students" entry; the programs are a segmented control on that page.
  const nStu = S.students.filter(s => !s.withdrawn && !s.dropped && paid.has(s.id) && !pastEnd(s)).length;
  $("programs").innerHTML = pageAllowed("students") || can("programs")
    ? `<li><button type="button" data-stuhub="1" aria-current="${S.page === "students" || S.page === "other"}"><span>${icon("users")}Students</span><span class="ct">${nStu || ""}</span></button></li>` : "";
  $("add-student").textContent = S.page === "other" ? "+ Add " + OTHER[S.other].label + " sign-up" : "+ Add student";
  $("nav-log").setAttribute("aria-current", S.page === "log");
  $("nav-drive-li").hidden = !(S.me && S.me.role === "admin");
  $("nav-drive").setAttribute("aria-current", S.page === "drive");
  const fol = S.settings.drive_folders || {};
  const dct = $("drive-ct"); dct.textContent = S.drive && (!driveReady() || DOCS.some(([k]) => !(fol[k] && fol[k].id))) ? "Set up" : ""; dct.className = "ct" + (dct.textContent ? " warn" : "");
  const fresh = S.log.filter(x => x.id > S.seenLogId).length;
  $("log-ct").textContent = fresh && S.page !== "log" ? (fresh > 99 ? "99+" : fresh) + " new" : "";
}
function opts(sel, label, values, cur) {
  sel.innerHTML = `<option value="">${esc(label)}</option>` + values.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`).join("");
}
// Segmented control on the Students page: CNA Hybrid, CNA In-Person, RNA, HHA, BLS, CEU.
function renderSeg() {
  const on = S.page === "students" || S.page === "other", seg = $("seg");
  seg.hidden = !on; if (!on) return;
  const paid = paidIds();
  const items = (pageAllowed("students") ? PROGRAMS.map(([id, name]) => {
      const n = S.students.filter(s => s.program === id && !s.withdrawn && !s.dropped && paid.has(s.id) && !pastEnd(s)).length;
      return { attr: `data-prog="${id}"`, label: name, n, sel: S.page === "students" && S.program === id };
    }) : []).concat(can("programs") ? OTHER_KEYS.map(k => ({ attr: `data-oprog="${k}"`, label: OTHER[k].label, n: oCount(k), sel: S.page === "other" && S.other === k })) : []);
  seg.innerHTML = items.map(x => `<button type="button" role="tab" ${x.attr} aria-selected="${x.sel}">${esc(x.label)}${x.n ? `<span class="seg-n num">${Number(x.n).toLocaleString("en-US")}</span>` : ""}</button>`).join("");
  const cur = seg.querySelector('[aria-selected="true"]');   // on narrow screens, keep the current program in view
  if (cur && seg.scrollWidth > seg.clientWidth) seg.scrollLeft = cur.offsetLeft - (seg.clientWidth - cur.offsetWidth) / 2;
}
function renderHeader() {
  renderSeg();
  const isLog = S.page === "log", isDrive = S.page === "drive", isOther = S.page === "other", isLeads = S.page === "leads";
  ["f-status", "f-cohort", "f-sched", "f-loc"].forEach(id => $(id).hidden = isLog || isDrive || isOther || isLeads || S.page === "overview");
  $("views").hidden = !(isOther || isLeads);   // the CNA pages use the status dropdown instead of tabs
  $("f-lprog").hidden = !isLeads;
  if (S.page === "home") {
    ["f-logprog", "f-odate", "q", "views", "f-status", "f-cohort", "f-sched", "f-loc", "f-lprog"].forEach(id => $(id).hidden = true);
    const first = ((S.me && S.me.full_name) || "").split(" ")[0] || "there";
    $("prog-title").innerHTML = `<span class="hello">Hello, <b>${esc(first)}</b>!</span>`;
    $("ledger").innerHTML = `<span>${esc(TODAY.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }))}. Here's where things stand.</span>`;
    return;
  }
  const plain = { staff: ["Staff & permissions", "Who can sign in to the tracker and what each person can see and change."],
    templates: ["Email Templates", "Write emails, keep templates, and choose which emails go out automatically."],
    export: ["Export Student File", "Download the ticked students as a CSV file."],
    schedule: ["Schedule", "Classes, clinicals and events by day. Click a day to see it, or an entry to change it."] }[S.page];
  if (plain) {
    ["f-logprog", "f-odate", "q", "views", "f-status", "f-cohort", "f-sched", "f-loc"].forEach(id => $(id).hidden = true);
    $("prog-title").textContent = plain[0];
    $("ledger").innerHTML = `<span>${esc(plain[1])}</span>`;
    return;
  }
  if (S.page === "overview") {
    ["f-logprog", "f-odate", "q", "views"].forEach(id => $(id).hidden = true);
    $("prog-title").textContent = "Business Overview";
    $("ledger").innerHTML = `<span>CNA students and payments as of ${esc(fmtDate(ISO_TODAY))}. Updates live as staff record changes.</span>`;
    return;
  }
  if (isLeads) { $("f-logprog").hidden = true; $("f-odate").hidden = true; $("q").hidden = false; leadsHeader(); return; }
  $("f-logprog").hidden = !isLog;
  $("f-odate").hidden = !isOther;
  $("q").hidden = isDrive;
  if (isOther) { otherHeader(); return; }
  if (isDrive) { $("prog-title").textContent = "Google Drive"; $("ledger").innerHTML = `<span>Where student documents are saved.</span>`; return; }
  $("q").placeholder = isLog ? "Search by student, change or staff member" : "Search name, email, phone, Student ID or notes";
  if (isLog) {
    $("prog-title").textContent = "Logs";
    opts($("f-logprog"), "All programs", PROGRAMS.concat(OTHER_KEYS.map(k => ["o:" + k, OTHER[k].label])), S.logProg);
    $("ledger").innerHTML = `<span>Every change, with who made it and when. Newest first.</span>`;
    return;
  }
  $("prog-title").textContent = "Students";
  const allPaid = paidIds(), everyone = inProgram();
  $("f-status").innerHTML = STATUSES.map(([k, l]) => { const n = everyone.filter(s => (k === "out" || (!s.withdrawn && !s.dropped)) && statusMatch(k, s, allPaid)).length;
    return `<option value="${k}"${S.status === k ? " selected" : ""}>${esc(l)} (${n})</option>`; }).join("");
  const ps = inStatus();
  // Start dates follow the official calendar: running and upcoming cohorts first (soonest first), then completed ones.
  const nIn = c => ps.filter(s => s.cohort_id === c.id && !s.withdrawn && !s.dropped).length;
  const cohorts = S.cohorts.filter(c => c.program === S.program && (!c.archived || ps.some(s => s.cohort_id === c.id)));
  const ends = c => [c.weekday_end, c.weekend_end].filter(Boolean).sort().pop() || c.start_date;
  const upcoming = cohorts.filter(c => ends(c) >= ISO_TODAY).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const done = cohorts.filter(c => ends(c) < ISO_TODAY).sort((a, b) => b.start_date.localeCompare(a.start_date));
  if (S.cohort && !cohorts.some(c => String(c.id) === S.cohort)) S.cohort = "";
  const copt = c => { const n = nIn(c), st = c.start_date <= ISO_TODAY && ends(c) >= ISO_TODAY ? " (in progress)" : "";
    return `<option value="${c.id}"${String(c.id) === S.cohort ? " selected" : ""}>${esc(fmtDate(c.start_date) + st + " · " + n + (n === 1 ? " student" : " students"))}</option>`; };
  $("f-cohort").innerHTML = `<option value="">All start dates</option>` +
    (upcoming.length ? `<optgroup label="In progress and upcoming">${upcoming.map(copt).join("")}</optgroup>` : "") +
    (done.length ? `<optgroup label="Completed">${done.map(copt).join("")}</optgroup>` : "");
  opts($("f-sched"), "Weekday and weekend", [["weekday", "Weekday"], ["weekend", "Weekend"]], S.sched);
  const sites = S.sites.filter(x => ps.some(s => s.site_id === x.id));
  opts($("f-loc"), "All clinical sites", sites.map(x => [x.id, x.short_name]), S.loc);
  $("views").innerHTML = VIEWS.map(([k, l]) => `<button type="button" data-view="${k}" aria-pressed="${S.view === k}">${l}</button>`).join("");

  const active = ps.filter(s => !s.withdrawn && !s.dropped);
  const as = active.map(assess);
  const owed = as.filter(a => a.m.balance > 0);
  const held = as.filter(a => a.tone === "hold");
  const ready = as.filter(a => a.ready);
  const wl = active.filter(s => s.waitlist).length;
  $("ledger").innerHTML =
    `<button type="button" data-view="all" aria-pressed="${S.view === "all"}"><b class="num">${active.length}</b> active</button>` +
    `<button type="button" class="owed" data-view="owe" aria-pressed="${S.view === "owe"}"><b class="num">${money(owed.reduce((t, a) => t + a.m.balance, 0))}</b> owed by ${owed.length}</button>` +
    `<button type="button" class="held" data-view="hold" aria-pressed="${S.view === "hold"}"><b class="num">${held.length}</b> on hold for clinicals</button>` +
    `<button type="button" data-view="ready" aria-pressed="${S.view === "ready"}"><b class="num">${ready.length}</b> ready for state exam</button>` +
    (wl ? `<button type="button" data-view="waitlist" aria-pressed="${S.view === "waitlist"}"><b class="num">${wl}</b> on waitlist</button>` : "");
}

/* ---------------- Grid ---------------- */
function payTag(p) { if (!p) return ""; const c = methodCode(p.method), d = shortDate(p.paid_on); return c && d ? c + "-" + d : (c || d); }
function payCell(s, k, urgent) {
  const due = num(plan(s)[k]), paid = paidFor(s, k), name = lab(STAGES, k), lp = lastPay(s, k);
  if (due <= 0) return `<button class="tk na" type="button" disabled aria-label="${name}: not part of this plan">–</button>`;
  const how = lp ? [methodName(lp.method), lp.paid_on ? fmtDate(lp.paid_on) : ""].filter(Boolean).join(", ") : "";
  const tag = paid > 0 ? `<span class="pm${lp && lp.method ? "" : " miss"}" aria-hidden="true">${esc(payTag(lp) || "No method")}</span>` : "";
  if (paid >= due) return `<button class="tk amt done" type="button" data-pay="${k}" aria-label="${name}: paid ${money(paid)}${how ? ", " + esc(how) : ""}" title="Paid ${money(paid)}${how ? ", " + esc(how) : ""}">${money(paid)}</button>${tag}`;
  if (paid > 0) return `<button class="tk amt part" type="button" data-pay="${k}" aria-label="${name}: ${money(paid)} of ${money(due)} paid" title="${money(paid)} of ${money(due)} paid">${money(paid)}</button>${tag}`;
  return `<button class="tk amt ${urgent ? "due" : ""}" type="button" data-pay="${k}" aria-label="${name}: ${money(due)} due" title="${money(due)} due"></button>`;
}
function toggleCell(k, label, on, cls) {
  return `<button class="tk ${on ? "done" : cls}" type="button" data-key="${k}" aria-pressed="${!!on}" aria-label="${esc(label)}" title="${esc(label)}${on ? ": done" : ": not yet"}">${on ? CHECK : ""}</button>`;
}
function rowFlags(s) {
  let flags = "";
  if (isMinor(s)) flags += `<span class="flag">Minor${s.waiver_minor ? ", waiver in" : ", needs waiver"}</span>`;
  if (s.waitlist) flags += `<span class="flag wl">Waitlist</span>`;
  if (S.status === "noassign") { const need = [!s.cohort_id && "start date", !(s.schedule === "weekday" || s.schedule === "weekend") && "weekday or weekend", !s.site_id && "clinical site"].filter(Boolean); if (need.length) flags += `<span class="flag">Needs ${need.join(", ")}</span>`; }
  const eng = String(s.english_score || "").match(/^(\d+)\s*\/\s*(\d+)$/);
  if (eng && +eng[1] / +eng[2] < 0.7) flags += `<span class="flag">English ${esc(s.english_score)}</span>`;
  return flags;
}
// Phone view: one card per student instead of the wide table. Same buttons and data attributes, so clicks work the same.
const PHONE = window.matchMedia("(max-width: 700px)");
function card(s, i) {
  const a = assess(s), c = cohortOf(s), site = siteOf(s), start = c ? c.start_date : "";
  const started = daysUntil(start) <= 0, soon = daysUntil(start) <= 14;
  const nlog = S.log.filter(x => x.student_id === s.id).length;
  const it = (inner, label) => `<div class="mt">${inner}<span class="mt-l">${esc(label)}</span></div>`;
  const grp = (title, items) => `<div class="mg"><h4>${title}</h4><div class="mt-row">${items}</div></div>`;
  return `<article class="mc${a.out ? " inactive" : ""}" data-id="${esc(s.id)}">
    <div class="mc-head">${pick(s.id)}<span class="rn">${i + 1}</span>
      <div class="mc-who"><button class="name" type="button" data-open="1">${esc(s.last_name)}, ${esc(s.first_name)}</button>${rowFlags(s)}
        <div class="sub">${start ? fmtDate(start, false) + " – " + fmtDate(endOf(s)) : "No start date"}${s.schedule === "weekend" ? " · Weekend" : s.schedule === "weekday" ? " · Weekday" : ""}${site ? " · " + esc(site.short_name) : ""}${s.student_code ? " · " + esc(s.student_code) : ""}</div></div>
      <div class="mc-bal ${a.m.balance > 0 ? "owe" : "zero"}">${a.m.balance > 0 ? money(a.m.balance) : "Paid"}<small>of ${money(a.m.due)}</small></div></div>
    <div class="mc-state"><span class="pill ${a.tone}">${a.text}</span>${a.why ? `<span class="why">${esc(a.why)}</span>` : ""}</div>
    ${grp("Payments", STAGES.map(([k, , sh]) => it(`<span class="pw-wrap">${payCell(s, k, k === "registration" || started)}</span>`, sh)).join(""))}
    ${grp("Requirements", REQS.map(([k, l, sh]) => it(toggleCell(k, l, s[k], soon && CLINICAL_REQS.includes(k) ? "hold" : ""), sh)).join(""))}
    ${grp("Attendance and exams", [...ATT, ...EXAMS].map(([k, l, sh]) => it(toggleCell(k, l, s[k], ""), sh)).join(""))}
    ${s.notes ? `<p class="mc-note">${esc(s.notes)}</p>` : ""}
    <div class="acts"><button type="button" data-open="notes">${s.notes ? "Edit note" : "Add note"}</button><button type="button" data-open="history">History${nlog ? " (" + nlog + ")" : ""}</button></div>
  </article>`;
}
function row(s, i) {
  const a = assess(s), c = cohortOf(s), site = siteOf(s);
  const start = c ? c.start_date : "";
  const flags = rowFlags(s), nlog = S.log.filter(x => x.student_id === s.id).length;
  let cells = "";
  const started = daysUntil(start) <= 0, soon = daysUntil(start) <= 14;
  STAGES.forEach(([k], i) => { cells += `<td class="cell pc${i === 0 ? " gs" : ""}" data-ck="pay.${k}"><span class="pw-wrap">${payCell(s, k, k === "registration" || started)}</span></td>`; });
  REQS.forEach(([k, l], i) => { const need = soon && CLINICAL_REQS.includes(k); cells += `<td class="cell${i === 0 ? " gs" : ""}" data-ck="${k}">${toggleCell(k, l, s[k], need ? "hold" : "")}</td>`; });
  ATT.forEach(([k, l], i) => { cells += `<td class="cell${i === 0 ? " gs" : ""}" data-ck="${k}">${toggleCell(k, l, s[k], "")}</td>`; });
  EXAMS.forEach(([k, l], i) => { cells += `<td class="cell${i === 0 ? " gs" : ""}" data-ck="${k}">${toggleCell(k, l, s[k], "")}</td>`; });
  return `<tr data-id="${esc(s.id)}" class="${a.out ? "inactive" : ""}">
    <td class="sticky who">${pick(s.id)}<span class="rn" aria-hidden="true">${i + 1}</span><button class="name" type="button" data-open="1">${esc(s.last_name)}, ${esc(s.first_name)}</button>${flags}
      <div class="sub"><span class="d">${start ? fmtDate(start, false) + " – " + fmtDate(endOf(s)) : "No start date"}</span><span>${s.schedule === "weekend" ? "Weekend" : s.schedule === "weekday" ? "Weekday" : ""}</span></div>
      <div class="sub"><span>${esc(s.student_code || "")}</span>${site ? `<span>${esc(site.short_name)}</span>` : ""}</div></td>
    <td class="state" data-ck="state"><span class="pill ${a.tone}">${a.text}</span>${a.why ? `<div class="why">${esc(a.why)}</div>` : ""}</td>
    <td class="bal num ${a.m.balance > 0 ? "owe" : "zero"}" data-ck="bal">${a.m.balance > 0 ? money(a.m.balance) : "Paid"}<small>of ${money(a.m.due)}</small></td>
    ${cells}
    <td class="note gs">${s.notes ? `<p>${esc(s.notes)}</p>` : ""}<div class="acts"><button type="button" data-open="notes">${s.notes ? "Edit note" : "Add note"}</button><button type="button" data-open="history">History${nlog ? " (" + nlog + ")" : ""}</button></div></td>
  </tr>`;
}
function head(n) {
  const rot = (arr, pay) => arr.map(([k, l, short], i) => `<th class="rot${pay ? " pw" : ""}${i === 0 ? " gs" : ""}" scope="col"><div><span>${esc(short)}</span></div></th>`).join("");
  return `<thead>
   <tr class="g"><th class="sticky"></th><th></th><th></th>
     <th colspan="${STAGES.length}" class="gs">Payments</th><th colspan="${REQS.length}" class="gs">Requirements</th><th colspan="${ATT.length}" class="gs">Attendance</th><th colspan="${EXAMS.length}" class="gs">Exams</th><th class="gs"></th></tr>
   <tr class="c"><th class="sticky lbl who" scope="col">${pickAll()}Students <span class="cnt">${n}</span></th><th class="lbl" scope="col">Standing</th><th class="lbl" scope="col" style="text-align:right">Balance</th>
     ${rot(STAGES, true)}${rot(REQS)}${rot(ATT)}${rot(EXAMS)}
     <th class="lbl gs" scope="col">Notes</th></tr></thead>`;
}
let prevSigs = null;
function cellSigs(list) {
  const m = new Map();
  list.forEach(s => {
    STAGES.forEach(([k]) => m.set(s.id + "|pay." + k, paidFor(s, k) + "|" + payTag(lastPay(s, k))));
    [...REQS, ...ATT, ...EXAMS].forEach(([k]) => m.set(s.id + "|" + k, !!s[k]));
    const a = assess(s); m.set(s.id + "|state", a.text + "|" + a.why); m.set(s.id + "|bal", a.m.balance);
  });
  return m;
}
function markChanges(w, prev, sigs) {
  const rows = new Set();
  sigs.forEach((v, key) => {
    if (!prev.has(key) || prev.get(key) === v) return;
    const [id, ck] = key.split("|");
    const tr = w.querySelector(`tr[data-id="${CSS.escape(id)}"]`); if (!tr) return;
    const td = tr.querySelector(`td[data-ck="${ck}"]`); if (td) td.classList.add("chg");
    rows.add(id);
  });
  rows.forEach(id => {
    const t = S.localTouch[id]; if (t && Date.now() - t < 4000) return;
    const tr = w.querySelector(`tr[data-id="${CSS.escape(id)}"]`); if (tr) tr.classList.add("remote");
  });
}
function renderGrid() {
  const w = $("wrap");
  if (!S.loaded) { w.innerHTML = `<div class="skel" aria-label="Loading students"><i></i><i></i><i></i><i></i></div>`; return; }
  const list = filtered();
  if (!list.length) {
    w.innerHTML = inProgram().length
      ? `<div class="empty"><h3>No students match these filters</h3><p>Try a different start date or view, or clear the search.</p><button class="ghost" type="button" id="clear-filters">Clear filters</button></div>`
      : `<div class="empty"><h3>No ${esc(lab(PROGRAMS, S.program))} students yet</h3><p>Add a student to start tracking their payments, requirements, attendance and exams.</p><button class="primary" type="button" data-add="1">Add student</button></div>`;
    return;
  }
  if (PHONE.matches) {
    prevSigs = null;
    w.innerHTML = `<p class="mc-count">${list.length} ${list.length === 1 ? "student" : "students"}</p><div class="mlist">${list.map((s, i) => card(s, i)).join("")}</div>
      <div class="legend"><span><i class="tk done">${CHECK}</i>Done</span><span><i class="tk hold"></i>Needed before clinicals</span><span>Tap a box to change it. Every change is logged.</span></div>`;
    return;
  }
  const firstShow = !S.shownGrid; S.shownGrid = true;
  const sigs = cellSigs(list), prev = prevSigs; prevSigs = sigs;
  const keepX = w.scrollLeft, keepY = w.scrollTop;
  w.innerHTML = `<table class="grid${firstShow ? " enter" : ""}">${head(list.length)}<tbody>${list.map((s, i) => row(s, i)).join("")}</tbody></table>
   <div class="legend"><span><i class="tk done">${CHECK}</i>Done</span><span><i class="tk amt done">$800</i>Paid in full</span><span><i class="tk amt part">$400</i>Partly paid</span><span><i class="tk due"></i>Payment due now</span><span><i class="tk hold"></i>Needed before clinicals</span><span><i class="tk"></i>Not yet</span><span>Under payments: S Stripe, Z Zelle, C Cash, T Terminal, CH Check, then the date paid.</span><span>Click any box to change it. Every change is logged.</span></div>`;
  w.scrollLeft = keepX; w.scrollTop = keepY;
  if (firstShow) { w.querySelectorAll("tbody tr").forEach((tr, i) => tr.style.setProperty("--i", Math.min(i, 24))); setTimeout(() => { const g = w.querySelector(".grid"); if (g) g.classList.remove("enter"); }, 1200); }
  else if (prev) markChanges(w, prev, sigs);
  applyCrosshair();
}

/* ---------------- Logs ---------------- */
function fmtVal(field, v) {
  if (v == null || v === "") return "—";
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true" ? "Yes" : "No";
  if (field === "cohort_id") { const c = S.cohorts.find(x => String(x.id) === String(v)); return c ? fmtDate(c.start_date) : v; }
  if (field === "site_id") { const x = S.sites.find(y => String(y.id) === String(v)); return x ? x.short_name : v; }
  if (field === "pay_plan") return PLAN_NAMES[v] || v;
  if (field === "program") return lab(PROGRAMS, v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) { const d = new Date(v); if (!isNaN(d)) return "Sent " + d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  if (field && field.startsWith("payment:")) return money(v);
  return v.length > 160 ? v.slice(0, 157) + "…" : v;
}
function describeLog(e) {
  if (e.action === "Field changed") {
    const f = FIELD_LABELS[e.field] || e.field;
    return `<b>${esc(f)}</b> <span class="ft"><span class="from">${esc(fmtVal(e.field, e.old_value))}</span><span class="arrow" aria-label="changed to">→</span><span>${esc(fmtVal(e.field, e.new_value))}</span></span>`;
  }
  if (e.action.startsWith("Payment")) {
    const st = lab(STAGES, (e.field || "").replace("payment:", ""));
    const d = String(e.details || "").split(" ");
    const extra = [d[2] ? methodName(d[2]) || d[2] : "", d[3] || ""].filter(Boolean).join(", ");
    return `<b>${esc(e.action)}</b> ${esc(st)} ${esc(money(e.new_value || e.old_value))}${extra ? ` <span class="ar">(${esc(extra)})</span>` : ""}`;
  }
  if (e.action.startsWith("File")) {
    const kind = (e.field || "").replace("file:", "");
    return `<b>${esc(e.action)}</b> ${esc(lab(DOCS, kind))}${e.new_value ? ` <span class="ar">(${esc(e.new_value)})</span>` : ""}`;
  }
  return `<b>${esc(e.action)}</b>${e.details ? ` <span class="ar">${esc(e.details)}</span>` : ""}`;
}
function entryHtml(e, withStudent) {
  const s = S.students.find(x => x.id === e.student_id);
  return `<div class="entry${withStudent ? "" : " compact"}">
    <span class="t">${fmtTime(e.at)}</span>
    ${withStudent ? (s ? `<button class="stu" type="button" data-stu="${esc(s.id)}">${esc(fullName(s))}</button>` : `<span class="ar">${esc(e.student_name || "School-wide")}</span>`) : ""}
    <span class="what">${describeLog(e)}</span>
    <span class="meta">by <span class="by">${esc(e.user_email)}</span></span>
  </div>`;
}
function groupByDay(list, withStudent) {
  let html = "", last = "";
  list.forEach(e => { const d = dayLabel(e.at); if (d !== last) { html += `<h3 class="day">${esc(d)}</h3>`; last = d; } html += entryHtml(e, withStudent); });
  return html;
}
function renderLog() {
  const w = $("wrap");
  const q = S.q.trim().toLowerCase();
  const olab = S.logProg.startsWith("o:") ? OTHER[S.logProg.slice(2)].label : "";
  let list = S.log.filter(e => {
    if (!S.logProg) return true;
    if (olab) return !e.student_id && ((e.field || "").startsWith(olab + ": ") || String(e.action).startsWith(olab + " sign-up"));
    const s = S.students.find(x => x.id === e.student_id); return s && s.program === S.logProg;
  });
  if (q) list = list.filter(e => [e.student_name, e.field && FIELD_LABELS[e.field], e.action, e.old_value, e.new_value, e.user_email, e.details].join(" ").toLowerCase().includes(q));
  if (!list.length) { w.innerHTML = `<div class="log"><div class="log-empty"><h3>No changes match</h3><p>Try another search or program.</p></div></div>`; return; }
  const shown = list.slice(0, S.logLimit);
  w.innerHTML = `<div class="log">${groupByDay(shown, true)}${list.length > shown.length ? `<button class="ghost more" type="button" id="log-more">Show older changes</button>` : ""}</div>`;
  if (S.log.length) { S.seenLogId = maxLogId(); try { localStorage.setItem("calace.seenLog", S.seenLogId); } catch (e) {} renderRail(); }
}
/* ---------------- Other programs: RNA, HHA, BLS, CEU ----------------
   Each sign-up is one row whose `data` holds the Project1 columns by name; ticks are "TRUE"/"FALSE" like the Sheet.
   The database logs every change to `data` (private.log_record_change). */
const isOn = v => v === true || String(v).toUpperCase() === "TRUE";
// Document boxes count as done when the file is in Drive, until staff tick or untick them by hand.
const DOC_FILE = { "CNA License": "CNA License File", "Live Scan": "Live Scan File", "Physical Exam": "Physical Exam File", "TB Test": "TB Test File", "283D": "283D File" };
const hasFile = v => /^https?:\/\//i.test(v || "");
function tickOn(r, k) {
  if (k === "__checkin") return !!r.data["Attended At"];
  if (DOC_FILE[k] && !(k in r.data)) return hasFile(r.data[DOC_FILE[k]]);
  return isOn(r.data[k]);
}
const RNA_HHA = (prog, balance, docs, training) => ({
  label: prog, table: "rna_hha_registrations", match: r => (r.data.Program || r.program) === prog, blank: { Program: prog },
  when: "Registered", name: r => r.data["Full Name"], email: "Email", phone: "Phone",
  cols: [["Start Date", "Start date"]], dateLabel: "Start date", dateOf: r => parseMDY(r.data["Start Date"]),
  ticks: [["Registration $50", "Reg $50"], ["Paid in Full", "Balance " + balance], ...docs.map(k => [k, k]), ...training],
  note: "Comment",
  card: [
    ["Contact", [["Full Name", "Full name", "text", "w"], ["Email", "Email", "email"], ["Phone", "Phone", "tel"]]],
    ["Enrollment", [["Program", "Program", ["RNA", "HHA"]], ["Start Date", "Start date (M/D/YYYY)", "text"], ["Registered", "Signed up", "ro"], ["Added By", "Added by", "ro"]]],
    ["Payments", [["Registration $50", "Registration $50 paid", "tick"], ["Registration $50 Comment", "Registration note (e.g. Z 10/20)", "text"], ["Paid in Full", "Balance " + balance + " paid", "tick"], ["Paid in Full Comment", "Balance note", "text"]]],
    ["Documents", [...docs.map(k => [DOC_FILE[k], k + " file", "file"]), ...docs.map(k => [k, k, "tick"])]],
    ["Training", training.map(([k, l]) => [k, l, "tick"])],
    ["Notes", [["Comment", "Notes", "long"]]]
  ],
  views: [["all", "All", () => true], ["unpaid", "Balance not paid", r => !isOn(r.data["Paid in Full"])], ["paid", "Paid in full", r => isOn(r.data["Paid in Full"])], ["done", "Complete", r => isOn(r.data.Complete)]]
    .concat(training.some(t => t[0] === "Waitlist") ? [["wl", "Waitlist", r => isOn(r.data.Waitlist)]] : [])
});
const OTHER = {
  rna: RNA_HHA("RNA", "$550", ["CNA License"], [["Attendance", "Attendance"], ["Complete", "Complete"]]),
  hha: RNA_HHA("HHA", "$600", ["CNA License", "Live Scan", "Physical Exam", "TB Test", "283D"],
    [["Theory 1", "Theory 1"], ["Theory 2", "Theory 2"], ["Clinical 1", "Clinical 1"], ["Clinical 2", "Clinical 2"], ["Complete", "Complete"], ["Waitlist", "Waitlist"]]),
  bls: {
    label: "BLS", table: "bls_registrations", match: () => true, blank: {},
    when: "Timestamp", email: "Email", phone: "Phone Number",
    name: r => { const f = String(r.data["Full Name"] || "").trim(), l = String(r.data["Last Name"] || "").trim(); return l && !f.toLowerCase().includes(l.toLowerCase()) ? f + " " + l : f; },
    cols: [["BLS Dates", "BLS class"]], dateLabel: "Class date", dateOf: r => parseClassDate(r.data["BLS Dates"], r.data.Timestamp),
    ticks: [["Paid", "Paid"], ["Complete", "Complete"]],
    note: "Comment",
    card: [
      ["Contact", [["Full Name", "First name (or full name)", "text"], ["Last Name", "Last name", "text"], ["Email", "Email", "email"], ["Phone Number", "Phone", "tel"], ["Home Address with City", "Home address with city", "text", "w"]]],
      ["Class", [["BLS Dates", "BLS class date", "text", "w"], ["Timestamp", "Signed up", "ro"], ["Paid", "Paid", "tick"], ["Complete", "Complete", "tick"]]],
      ["Notes", [["Comment", "Notes", "long"]]]
    ],
    views: [["all", "All", () => true], ["unpaid", "Not paid", r => !isOn(r.data.Paid)], ["paid", "Paid", r => isOn(r.data.Paid)], ["done", "Complete", r => isOn(r.data.Complete)]]
  },
  ceu: {
    label: "CEU", table: "ceu_registrations", match: () => true, blank: {},
    when: "Name", email: "Your Email", phone: "Your Phone number",
    name: r => [r.data["First Name"], r.data["Last Name"]].map(x => String(x || "").trim()).filter(Boolean).join(" "),
    cols: [["Topics and Dates you will attend?", "Topics and dates"], ["Registration ID", "Registration ID"]], period: true,
    dateOf: r => parseClassDate(r.data["Topics and Dates you will attend?"], r.data.Name) || (whenTime(r.data.Name) ? iso(new Date(whenTime(r.data.Name))) : ""),
    ticks: [["__checkin", "Checked in"]],
    card: [
      ["Contact", [["First Name", "First name", "text"], ["Last Name", "Last name", "text"], ["Your Email", "Email", "email"], ["Your Phone number", "Phone", "tel"], ["Address", "Address", "text", "w"]]],
      ["Classes", [["Topics and Dates you will attend?", "Topics and dates", "long"], ["Name", "Signed up", "ro"], ["Registration ID", "Registration ID", "ro"], ["Email Sent", "Confirmation email sent", "ro"]]],
      ["Check-in", [["Attended At", "Attended on (M/D/YYYY)", "text"], ["Checked In By", "Checked in by", "text"]]]
    ],
    views: [["all", "All", () => true], ["in", "Checked in", r => !!r.data["Attended At"]], ["notin", "Not checked in", r => !r.data["Attended At"]]]
  }
};
const OTHER_KEYS = Object.keys(OTHER);
const OT = { rows: {}, loading: {}, counts: {}, limit: 300, view: {}, date: {}, prev: null };
function oCfg() { return OTHER[S.other]; }
function recName(cfg, r) { return (cfg.name(r) || "").trim() || "(no name)"; }
function whenTime(v) { const t = Date.parse(v || ""); return isNaN(t) ? 0 : t; }
function whenShort(v) { return String(v || "").split(" ")[0]; }
function mdy(d) { return (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear(); }
function oRows(k) { const c = OTHER[k], all = OT.rows[c.table]; return all ? all.filter(c.match) : null; }
function oCount(k) { const r = oRows(k); return r ? r.length : OT.counts[k]; }
async function loadOtherCounts() {
  const q = (table, prog) => { let x = sb.from(table).select("id", { count: "exact", head: true }); return prog ? x.eq("program", prog) : x; };
  const res = await Promise.all([q("rna_hha_registrations", "RNA"), q("rna_hha_registrations", "HHA"), q("bls_registrations"), q("ceu_registrations")]);
  ["rna", "hha", "bls", "ceu"].forEach((k, i) => { if (!res[i].error) OT.counts[k] = res[i].count; });
  renderRail();
}
async function loadOtherTable(table) {
  if (OT.rows[table] || OT.loading[table]) return;
  OT.loading[table] = true;
  try {
    let all = [], from = 0;
    for (;;) {
      const { data, error } = await sb.from(table).select("*").order("id").range(from, from + 999);
      if (error) throw error;
      all = all.concat(data); if (data.length < 1000) break; from += 1000;
    }
    OT.rows[table] = all;
  } catch (e) { toast("Couldn't load sign-ups: " + errText(e)); }
  OT.loading[table] = false;
  render();
}
/* Date filter on the program pages: a start or class date for RNA, HHA and BLS; a sign-up period for CEU. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function parseMDY(v) { const m = String(v || "").match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : ""; }
// BLS class dates are free text such as "April 10, starts at 9:30am, …": take the first month and day; with no year, use the
// sign-up year (or the next year when that date was already well before the sign-up).
function parseClassDate(text, signedUp) {
  let mo, day, y = 0;
  const m = String(text || "").match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(\d{4}))?/i);
  if (m) { mo = MONTHS.indexOf(m[1].toLowerCase()); day = +m[2]; y = m[3] ? +m[3] : 0; }
  else {   // numeric, e.g. "03/21" or "3/21/25"
    const n = String(text || "").match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/);
    if (!n) return "";
    mo = +n[1] - 1; day = +n[2]; y = n[3] ? (n[3].length === 2 ? 2000 + +n[3] : +n[3]) : 0;
    if (mo < 0 || mo > 11) return "";
  }
  if (day < 1 || day > 31) return "";
  if (!y) { const t = whenTime(signedUp); if (!t) return ""; const s = new Date(t); y = s.getFullYear(); if (new Date(y, mo, day) < new Date(y, s.getMonth(), s.getDate() - 14)) y++; }
  return iso(new Date(y, mo, day));
}
// CEU: by class date — this week (last Sunday to this Saturday), then this month and each later month with classes.
// Past classes aren't listed; searching looks through every sign-up.
const WEEK_START = (() => { const d = new Date(TODAY); d.setDate(d.getDate() - d.getDay()); return d; })();
const WEEK_FROM = iso(WEEK_START), WEEK_TO = iso(new Date(WEEK_START.getFullYear(), WEEK_START.getMonth(), WEEK_START.getDate() + 6));
const THIS_MONTH = ISO_TODAY.slice(0, 7);
function monthLabel(ym) { const [y, m] = ym.split("-"); return new Date(+y, +m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }); }
function oDateMatch(cfg, r, v) {
  if (cfg.period) v = v || "week";
  if (!v) return true;
  if (cfg.period) { const d = cfg.dateOf(r); return v === "week" ? d >= WEEK_FROM && d <= WEEK_TO : d.slice(0, 7) === v.slice(2); }
  const d = cfg.dateOf(r); return v === "none" ? !d : d === v;
}
function oDated() {
  const cfg = oCfg(), v = OT.date[S.other] || "", rows = oRows(S.other) || [];
  if (cfg.period && S.q.trim()) return rows;   // CEU search covers past sign-ups too
  return rows.filter(r => oDateMatch(cfg, r, v));
}
function oDateOptions() {
  const cfg = oCfg(), rows = oRows(S.other) || [], cur = OT.date[S.other] || "";
  if (cfg.period) {
    const months = new Set([THIS_MONTH]); rows.forEach(r => { const ym = cfg.dateOf(r).slice(0, 7); if (ym > THIS_MONTH) months.add(ym); });
    const choices = [["week", `This week (${fmtDate(WEEK_FROM, false)} – ${fmtDate(WEEK_TO, false)})`]].concat([...months].sort().map(ym => ["m:" + ym, monthLabel(ym)]));
    return choices.map(([k, l]) => { const n = rows.filter(r => oDateMatch(cfg, r, k)).length; return `<option value="${k}"${(cur || "week") === k ? " selected" : ""}>${esc(l)} · ${n.toLocaleString("en-US")}</option>`; }).join("");
  }
  const counts = new Map(); let none = 0;
  rows.forEach(r => { const d = cfg.dateOf(r); if (d) counts.set(d, (counts.get(d) || 0) + 1); else none++; });
  const dates = [...counts.keys()], up = dates.filter(d => d >= ISO_TODAY).sort(), past = dates.filter(d => d < ISO_TODAY).sort().reverse();
  const opt = d => `<option value="${d}"${cur === d ? " selected" : ""}>${esc(fmtDate(d))} · ${counts.get(d)}</option>`;
  return `<option value="">All ${esc(cfg.dateLabel.toLowerCase())}s</option>` + (up.length ? `<optgroup label="Upcoming">${up.map(opt).join("")}</optgroup>` : "")
    + (past.length ? `<optgroup label="Past">${past.map(opt).join("")}</optgroup>` : "") + (none ? `<option value="none"${cur === "none" ? " selected" : ""}>No ${esc(cfg.dateLabel.toLowerCase())} · ${none}</option>` : "");
}
function oFiltered() {
  const cfg = oCfg(), rows = oDated(), q = S.q.trim().toLowerCase();
  const v = cfg.views.find(x => x[0] === (OT.view[S.other] || "all")) || cfg.views[0];
  return rows.filter(r => v[2](r) && (!q || (recName(cfg, r) + " " + Object.values(r.data).join(" ")).toLowerCase().includes(q)))
    .sort((a, b) => whenTime(b.data[cfg.when]) - whenTime(a.data[cfg.when]) || b.id - a.id);
}
const oTickOn = tickOn;
function oRow(cfg, r, i) {
  const em = r.data[cfg.email], ph = r.data[cfg.phone], note = cfg.note ? r.data[cfg.note] : "";
  const ticks = cfg.ticks.map(([k, l], i) => {
    const on = oTickOn(r, k), title = k === "__checkin" && on ? `Checked in ${r.data["Attended At"]}${r.data["Checked In By"] ? " by " + r.data["Checked In By"] : ""}` : l + (on ? ": done" : ": not yet");
    return `<td class="cell${i === 0 ? " gs" : ""}" data-ck="${esc(k)}"><button class="tk ${on ? "done" : ""}" type="button" data-rtick="${esc(k)}" aria-pressed="${on}" aria-label="${esc(l)}" title="${esc(title)}">${on ? CHECK : ""}</button></td>`;
  }).join("");
  return `<tr data-rid="${r.id}">
    <td class="sticky who">${pick("r" + r.id)}<span class="rn" aria-hidden="true">${i + 1}</span><button class="name" type="button" data-ropen="1">${esc(recName(cfg, r))}</button>${isOn(r.data.Waitlist) ? `<span class="flag wl">Waitlist</span>` : ""}
      <div class="sub">${em ? `<span>${esc(em)}</span>` : ""}${ph ? `<span>${esc(ph)}</span>` : ""}</div></td>
    <td class="txt nowrap">${esc(whenShort(r.data[cfg.when]) || "—")}</td>
    ${cfg.cols.map(([k]) => `<td class="txt">${esc(r.data[k] || "—")}</td>`).join("")}
    ${ticks}
    ${cfg.note ? `<td class="note gs">${note ? `<p>${esc(note)}</p>` : ""}<div class="acts"><button type="button" data-ropen="notes">${note ? "Edit note" : "Add note"}</button></div></td>` : `<td class="note gs"><div class="acts"><button type="button" data-ropen="1">Open</button></div></td>`}
  </tr>`;
}
function oCard(cfg, r, i) {
  const em = r.data[cfg.email], ph = r.data[cfg.phone], note = cfg.note ? r.data[cfg.note] : "";
  const ticks = cfg.ticks.map(([k, l]) => { const on = oTickOn(r, k);
    return `<div class="mt"><button class="tk ${on ? "done" : ""}" type="button" data-rtick="${esc(k)}" aria-pressed="${on}" aria-label="${esc(l)}">${on ? CHECK : ""}</button><span class="mt-l">${esc(l)}</span></div>`; }).join("");
  return `<article class="mc" data-rid="${r.id}">
    <div class="mc-head">${pick("r" + r.id)}<span class="rn">${i + 1}</span>
      <div class="mc-who"><button class="name" type="button" data-ropen="1">${esc(recName(cfg, r))}</button>${isOn(r.data.Waitlist) ? `<span class="flag wl">Waitlist</span>` : ""}
        <div class="sub">${[em, ph].filter(Boolean).map(esc).join(" · ")}</div>
        <div class="sub">Signed up ${esc(whenShort(r.data[cfg.when]) || "—")}${cfg.cols.map(([k, l]) => r.data[k] ? ` · ${esc(l)}: ${esc(r.data[k])}` : "").join("")}</div></div></div>
    <div class="mg"><div class="mt-row">${ticks}</div></div>
    ${note ? `<p class="mc-note">${esc(note)}</p>` : ""}
    <div class="acts"><button type="button" data-ropen="${cfg.note ? "notes" : "1"}">${cfg.note ? (note ? "Edit note" : "Add note") : "Open"}</button></div>
  </article>`;
}
function renderOther() {
  const w = $("wrap"), cfg = oCfg();
  if (!OT.rows[cfg.table]) { loadOtherTable(cfg.table); w.innerHTML = `<div class="skel" aria-label="Loading sign-ups"><i></i><i></i><i></i><i></i></div>`; return; }
  const list = oFiltered();
  if (!list.length) {
    w.innerHTML = (oRows(S.other) || []).length
      ? `<div class="empty"><h3>No ${esc(cfg.label)} sign-ups match</h3><p>Try another view, or clear the search.</p><button class="ghost" type="button" id="clear-filters">Clear filters</button></div>`
      : `<div class="empty"><h3>No ${esc(cfg.label)} sign-ups yet</h3><p>Add one to start tracking it.</p><button class="primary" type="button" data-add="1">Add sign-up</button></div>`;
    return;
  }
  const shown = list.slice(0, OT.limit);
  const more = list.length > shown.length ? `<button class="ghost more" type="button" id="rec-more">Show ${Math.min(300, list.length - shown.length)} more of ${list.length - shown.length}</button>` : "";
  if (PHONE.matches) { OT.prev = null; w.innerHTML = `<p class="mc-count">${list.length.toLocaleString("en-US")} ${list.length === 1 ? "sign-up" : "sign-ups"}</p><div class="mlist">${shown.map((r, i) => oCard(cfg, r, i)).join("")}</div>${more}`; return; }
  const sig = new Map(); shown.forEach(r => cfg.ticks.forEach(([k]) => sig.set(r.id + "|" + k, oTickOn(r, k))));
  const prev = OT.prev && OT.prev.page === S.other ? OT.prev.sig : null; OT.prev = { page: S.other, sig };
  const keepX = w.scrollLeft, keepY = w.scrollTop;
  w.innerHTML = `<table class="grid ogrid"><thead>
    <tr class="g"><th class="sticky"></th><th></th>${cfg.cols.map(() => "<th></th>").join("")}<th colspan="${cfg.ticks.length}" class="gs">Progress</th><th class="gs"></th></tr>
    <tr class="c"><th class="sticky lbl who" scope="col">${pickAll()}Students <span class="cnt">${list.length.toLocaleString("en-US")}</span></th><th class="lbl" scope="col">Signed up</th>${cfg.cols.map(([, l]) => `<th class="lbl" scope="col">${esc(l)}</th>`).join("")}
      ${cfg.ticks.map(([, l], i) => `<th class="rot${i === 0 ? " gs" : ""}" scope="col"><div><span>${esc(l)}</span></div></th>`).join("")}
      <th class="lbl gs" scope="col">${cfg.note ? "Notes" : ""}</th></tr></thead>
    <tbody>${shown.map((r, i) => oRow(cfg, r, i)).join("")}</tbody></table>
    ${more}
    <div class="legend"><span><i class="tk done">${CHECK}</i>Done</span><span><i class="tk"></i>Not yet</span><span>Newest sign-ups first. Click a box to change it, or a name to see everything. Every change is logged.</span></div>`;
  w.scrollLeft = keepX; w.scrollTop = keepY;
  if (prev) sig.forEach((v, key) => { if (prev.has(key) && prev.get(key) !== v) { const [id, k] = key.split("|"); const td = w.querySelector(`tr[data-rid="${id}"] td[data-ck="${CSS.escape(k)}"]`); if (td) td.classList.add("chg"); } });
  applyCrosshair();
}
function otherHeader() {
  const cfg = oCfg(), rows = oRows(S.other) ? oDated() : null, cur = OT.view[S.other] || "all";
  $("prog-title").textContent = "Students";
  $("f-odate").innerHTML = oDateOptions(); $("f-odate").setAttribute("aria-label", cfg.period ? "Signed up" : cfg.dateLabel);
  $("q").placeholder = cfg.period ? "Search all CEU sign-ups, past ones too" : "Search name, email, phone or notes";
  $("views").innerHTML = cfg.views.map(([k, l]) => `<button type="button" data-rview="${k}" aria-pressed="${cur === k}">${esc(l)}</button>`).join("");
  if (!rows) { $("ledger").innerHTML = `<span>Loading sign-ups…</span>`; return; }
  $("ledger").innerHTML = cfg.views.map(([k, l, f], i) => { const n = rows.filter(f).length; return `<button type="button" data-rview="${k}" aria-pressed="${cur === k}"><b class="num">${n.toLocaleString("en-US")}</b> ${i === 0 ? (n === 1 ? "sign-up" : "sign-ups") : esc(l.toLowerCase())}</button>`; }).join("");
}
async function saveRecord(cfg, id, data) {
  const all = OT.rows[cfg.table], r = all.find(x => x.id === id), before = { ...r };
  const draft = { ...r, data };
  const patch = { data, full_name: recName(cfg, draft) === "(no name)" ? null : recName(cfg, draft), email: (data[cfg.email] || "").trim() || null, phone: (data[cfg.phone] || "").trim() || null };
  if (cfg.table === "rna_hha_registrations") patch.program = data.Program || null;
  Object.assign(r, patch); render();
  const { data: row, error } = await sb.from(cfg.table).update(patch).eq("id", id).select().single();
  if (error) { Object.assign(r, before); render(); throw error; }
  upsertLocal(all, row); return row;
}
async function toggleRecTick(t) {
  const cfg = oCfg(), id = +t.closest("[data-rid]").dataset.rid, r = OT.rows[cfg.table].find(x => x.id === id); if (!r) return;
  const k = t.dataset.rtick, before = r.data, label = t.getAttribute("aria-label"), who = recName(cfg, r), data = { ...r.data };
  const wasOn = oTickOn(r, k);
  if (k === "__checkin") { if (wasOn) { delete data["Attended At"]; delete data["Checked In By"]; } else { data["Attended At"] = mdy(new Date()); data["Checked In By"] = (S.me.full_name || S.me.email).split(" ")[0]; } }
  else data[k] = wasOn ? "FALSE" : "TRUE";
  t.classList.add("busy");
  try {
    await saveRecord(cfg, id, data);
    toast(`${label} ${wasOn ? "unticked" : "ticked off"} for ${who}`, () => saveRecord(cfg, id, before).then(() => toast("Change undone. The undo is logged too.")).catch(err => toast(errText(err))));
  } catch (err) { t.classList.remove("busy"); shake(t); toast(errText(err)); }
}

/* Record card */
let recCtx = null;
function openRecord(id, focus) {
  const cfg = oCfg(), isNew = !id;
  const r = isNew ? { id: null, data: { ...cfg.blank } } : OT.rows[cfg.table].find(x => x.id === id);
  if (!r) return;
  recCtx = { key: S.other, id: r.id, tab: focus === "history" ? "history" : "profile" };
  const known = new Set(cfg.card.flatMap(([, f]) => f.map(x => x[0])));
  const extra = Object.keys(r.data).filter(k => !known.has(k) && r.data[k] !== "" && r.data[k] != null);
  let n = 0; const ids = {};
  const fieldHtml = ([k, label, type, cls]) => {
    const v = r.data[k], fid = "rf-" + (n++), def = type === "tick" ? tickOn(r, k) : null; ids[k] = { fid, type, def };
    if (type === "tick") return chk(fid, label, def);
    if (type === "long") return `<div class="f w"><label for="${fid}">${esc(label)}</label><textarea id="${fid}">${esc(v || "")}</textarea></div>`;
    if (type === "ro") return `<div class="f ${cls || ""}"><span class="lbl-ro">${esc(label)}</span><span class="ro">${esc(v || "—")}</span></div>`;
    if (type === "file") return `<div class="f"><span class="lbl-ro">${esc(label)}</span><span class="ro">${/^https?:\/\//i.test(v || "") ? `<a href="${esc(v)}" target="_blank" rel="noopener">Open in Drive</a>` : esc(v || "Not uploaded")}</span></div>`;
    if (Array.isArray(type)) return sel(fid, esc(label), v || type[0], type, cls);
    return field(fid, esc(label), v || "", type, cls);
  };
  const section = ([title, fields]) => {
    const ticks = fields.filter(f => f[2] === "tick"), rest = fields.filter(f => f[2] !== "tick");
    return `<section><h3>${esc(title)}</h3>${rest.length ? `<div class="fg">${rest.map(fieldHtml).join("")}</div>` : ""}${ticks.length ? `<div class="checks"${rest.length ? ' style="margin-top:10px"' : ""}>${ticks.map(fieldHtml).join("")}</div>` : ""}</section>`;
  };
  recCtx.ids = ids;
  const title = isNew ? `New ${cfg.label} sign-up` : recName(cfg, r);
  $("layer").innerHTML = `<div class="scrim" data-close="1"></div>
  <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="dh-title">
    <div class="dh"><div><h2 id="dh-title">${esc(title)}</h2>
      <p>${isNew ? "Fill in what you have now. Everything can be changed later." : `${esc(cfg.label)} · signed up ${esc(whenShort(r.data[cfg.when]) || "date unknown")}`}</p></div>
      <button class="x" type="button" data-close="1" aria-label="Close">×</button></div>
    ${isNew ? "" : `<div class="dtabs" role="tablist"><button type="button" role="tab" data-rtab="profile" aria-selected="${recCtx.tab === "profile"}">Details</button><button type="button" role="tab" data-rtab="history" aria-selected="${recCtx.tab === "history"}">History</button></div>`}
    <form class="db" id="rf" autocomplete="off"${recCtx.tab === "history" ? " hidden" : ""}>
      ${cfg.card.map(section).join("")}
      ${extra.length ? section(["Other answers from the form", extra.map(k => [k, k, /^(true|false)$/i.test(r.data[k]) ? "tick" : String(r.data[k]).length > 80 ? "long" : "text", "w"])]) : ""}
    </form>
    <div class="db" id="hist"${recCtx.tab === "history" ? "" : " hidden"}></div>
    <div class="df" id="df"${recCtx.tab === "history" ? " hidden" : ""}>
      <button class="primary" type="button" id="rsave">${isNew ? "Add sign-up" : "Save changes"}</button><button class="ghost" type="button" data-close="1">Cancel</button>
      ${isNew ? "" : `<button class="danger" type="button" id="rdel">Delete sign-up</button>`}
      <span class="err" id="save-err" hidden></span>
    </div>
  </div>`;
  $("rf").addEventListener("submit", e => e.preventDefault());
  $("rsave").onclick = saveRecordForm;
  if ($("rdel")) $("rdel").onclick = askRecDelete;
  renderRecHistory();
  if (recCtx.tab === "profile") {
    const target = focus === "notes" && cfg.note && ids[cfg.note] ? $(ids[cfg.note].fid) : $("rf").querySelector("input:not([type=checkbox]),textarea");
    setTimeout(() => { if (target) { target.scrollIntoView({ block: "center" }); target.focus(); } }, 50);
  }
}
function setRecTab(t) {
  recCtx.tab = t;
  document.querySelectorAll("[data-rtab]").forEach(b => b.setAttribute("aria-selected", b.dataset.rtab === t));
  $("rf").hidden = t !== "profile"; $("df").hidden = t !== "profile"; $("hist").hidden = t !== "history";
  renderRecHistory();
}
async function renderRecHistory() {
  if (!recCtx || recCtx.tab !== "history" || !recCtx.id) return;
  const ctx = recCtx, cfg = OTHER[ctx.key], r = OT.rows[cfg.table].find(x => x.id === ctx.id); if (!r) return;
  const name = r.full_name, labels = cfg.table === "rna_hha_registrations" ? ["RNA", "HHA"] : [cfg.label];
  const mine = e => e.student_name === name && !e.student_id && labels.some(l => (e.field || "").startsWith(l + ": ") || String(e.action).startsWith(l + " sign-up"));
  const paint = list => { if (recCtx !== ctx || !$("hist")) return; $("hist").innerHTML = list.length ? groupByDay(list, false) : `<div class="log-empty"><h3>No changes yet</h3><p>Every tick and edit for this sign-up will be listed here with who made it and when. Changes made in the Google Sheet before the move aren't included.</p></div>`; };
  paint(S.log.filter(mine));
  if (!name) return;
  const { data } = await sb.from("activity_log").select("*").eq("student_name", name).is("student_id", null).order("at", { ascending: false }).limit(300);
  if (data) paint(data.filter(mine));
}
function readRecForm(base) {
  const data = { ...base };
  Object.entries(recCtx.ids).forEach(([k, { fid, type, def }]) => {
    const el = $(fid); if (!el) return;
    if (type === "tick") { if (!(k in base) && el.checked === def) return; data[k] = el.checked ? "TRUE" : "FALSE"; return; }
    const v = el.value.trim();
    if (v) data[k] = v; else delete data[k];
  });
  return data;
}
async function saveRecordForm() {
  const cfg = OTHER[recCtx.key], err = $("save-err"), btn = $("rsave");
  const fail = msg => { err.hidden = false; err.textContent = msg; shake(btn); };
  const base = recCtx.id ? OT.rows[cfg.table].find(x => x.id === recCtx.id).data : { ...cfg.blank };
  const data = readRecForm(base);
  const draft = { data }, name = recName(cfg, draft);
  if (name === "(no name)") return fail("Add a name to save this sign-up.");
  const em = data[cfg.email]; if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return fail("That email address doesn't look right.");
  btn.disabled = true;
  try {
    if (recCtx.id) {
      if (JSON.stringify(Object.entries(base).sort()) === JSON.stringify(Object.entries(data).sort())) { closeDrawer(); toast("No changes to save"); return; }
      const n = new Set([...Object.keys(base), ...Object.keys(data)].filter(k => base[k] !== data[k])).size;
      await saveRecord(cfg, recCtx.id, data);
      closeDrawer(); toast(`Saved ${n} ${n === 1 ? "change" : "changes"} for ${name}`);
    } else {
      const now = new Date(), stamp = mdy(now) + " " + now.toTimeString().slice(0, 8);
      if (!data[cfg.when]) data[cfg.when] = stamp;
      if (cfg.table === "rna_hha_registrations" && !data["Added By"]) data["Added By"] = S.me.full_name || S.me.email;
      const row = { data, full_name: name, email: (em || "").trim() || null, phone: (data[cfg.phone] || "").trim() || null };
      if (cfg.table === "rna_hha_registrations") row.program = data.Program || null;
      const { data: saved, error } = await sb.from(cfg.table).insert(row).select().single();
      if (error) throw error;
      upsertLocal(OT.rows[cfg.table], saved);
      const k = OTHER_KEYS.find(x => OTHER[x].table === cfg.table && OTHER[x].match(saved)); if (k) S.other = k;
      closeDrawer(); render(); toast(`Added ${name} to ${cfg.label}`);
    }
  } catch (e) { btn.disabled = false; fail(errText(e)); }
}
function askRecDelete() {
  const cfg = OTHER[recCtx.key], r = OT.rows[cfg.table].find(x => x.id === recCtx.id), name = recName(cfg, r);
  $("rdel").outerHTML = `<span class="confirm" id="confirm">Delete ${esc(name)}'s sign-up for good? The log keeps the history. <button type="button" id="del-yes">Delete</button><button type="button" class="no" id="del-no">Keep</button></span>`;
  $("del-no").onclick = () => { $("confirm").outerHTML = `<button class="danger" type="button" id="rdel">Delete sign-up</button>`; $("rdel").onclick = askRecDelete; };
  $("del-yes").onclick = async () => {
    try {
      const { error } = await sb.from(cfg.table).delete().eq("id", r.id);
      if (error) throw error;
      removeLocal(OT.rows[cfg.table], r.id); closeDrawer(); render(); toast(`Deleted ${name}'s ${cfg.label} sign-up`);
    } catch (e) { const er = $("save-err"); er.hidden = false; er.textContent = errText(e); }
  };
}
function onRecordChange(table, p) {
  const all = OT.rows[table]; if (!all) { if (p.eventType !== "UPDATE") loadOtherCounts(); return; }
  if (p.eventType === "DELETE") removeLocal(all, p.old.id); else upsertLocal(all, p.new);
  if (S.page === "other" && OTHER[S.other].table === table) { renderHeader(); renderOther(); }
  renderRail();
}

/* ---------------- Leads: CNA students with no payment yet ----------------
   Recording any payment takes a student off this page and onto Paid on their CNA page. */
function leadList() { const paid = paidIds(); return S.students.filter(s => !paid.has(s.id) && !s.withdrawn && !s.dropped); }
function nextFollowup(s) {
  let base = s.created_at;
  for (const [k, l, days] of FOLLOWUPS) {
    if (!s[k]) {
      const d = base ? new Date(base) : new Date(TODAY); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days);
      const due = iso(d); return { k, l, due, overdue: due < ISO_TODAY, today: due === ISO_TODAY };
    }
    base = s[k];
  }
  return null;
}
function leadMatch(v, s) {
  const nx = nextFollowup(s);
  if (v === "due") return !!nx && nx.due <= ISO_TODAY;
  if (v === "new") return FOLLOWUPS.every(([k]) => !s[k]);
  if (v === "done") return !nx;
  return true;
}
function leadsFiltered() {
  const q = S.q.trim().toLowerCase();
  return leadList().filter(s => (!S.lprog || s.program === S.lprog) && leadMatch(S.lview, s)
    && (!q || [s.first_name, s.last_name, s.email, s.phone, s.notes, s.student_code].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => { const x = nextFollowup(a), y = nextFollowup(b); return (x ? x.due : "9999") .localeCompare(y ? y.due : "9999") || (a.last_name || "").localeCompare(b.last_name || ""); });
}
function leadsHeader() {
  $("prog-title").textContent = "Leads";
  $("q").placeholder = "Search name, email, phone or notes";
  opts($("f-lprog"), "All programs", PROGRAMS, S.lprog);
  const base = leadList().filter(s => !S.lprog || s.program === S.lprog);
  $("views").innerHTML = LEAD_VIEWS.map(([k, l]) => `<button type="button" data-lview="${k}" aria-pressed="${S.lview === k}">${esc(l)}</button>`).join("");
  $("ledger").innerHTML = LEAD_VIEWS.map(([k, l], i) => { const n = base.filter(s => leadMatch(k, s)).length;
    return `<button type="button" class="${k === "due" && n ? "held" : ""}" data-lview="${k}" aria-pressed="${S.lview === k}"><b class="num">${n}</b> ${i === 0 ? (n === 1 ? "lead" : "leads") : esc(l.toLowerCase())}</button>`; }).join("");
}
function nextStep(s) {
  const nx = nextFollowup(s);
  if (!nx) return `<span class="pill ok">All follow-ups sent</span>`;
  if (nx.overdue) return `<span class="pill hold">${nx.l} overdue</span><div class="why">Was due ${fmtDate(nx.due, false)}</div>`;
  if (nx.today) return `<span class="pill due">${nx.l} due today</span>`;
  return `<span class="pill go">${nx.l} on ${fmtDate(nx.due, false)}</span>`;
}
function fuButton(s, k, l) {
  const on = !!s[k], when = on ? new Date(s[k]).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  return `<button class="tk ${on ? "done" : ""}" type="button" data-fu="${k}" aria-pressed="${on}" aria-label="${esc(l)} email" title="${esc(l)} email${on ? ": sent " + when : ": not sent"}">${on ? CHECK : ""}</button>${on ? `<span class="pm" aria-hidden="true">${esc(when)}</span>` : ""}`;
}
function leadSub(s) {
  const c = cohortOf(s);
  return [lab(PROGRAMS, s.program), c ? "Starts " + fmtDate(c.start_date, false) : "No start date", s.schedule === "weekend" ? "Weekend" : s.schedule === "weekday" ? "Weekday" : ""].filter(Boolean).join(" · ");
}
function leadRow(s, i) {
  const nlog = S.log.filter(x => x.student_id === s.id).length;
  return `<tr data-id="${esc(s.id)}">
    <td class="sticky who">${pick(s.id)}<span class="rn" aria-hidden="true">${i + 1}</span><button class="name" type="button" data-open="1">${esc(s.last_name)}, ${esc(s.first_name)}</button>${s.waitlist ? `<span class="flag wl">Waitlist</span>` : ""}
      <div class="sub"><span class="d">${esc(leadSub(s))}</span></div>
      <div class="sub">${s.email ? `<span>${esc(s.email)}</span>` : ""}${s.phone ? `<span>${esc(s.phone)}</span>` : ""}</div></td>
    <td class="state">${nextStep(s)}</td>
    <td class="cell pc gs" data-ck="pay.registration"><span class="pw-wrap">${payCell(s, "registration", true)}</span></td>
    ${FOLLOWUPS.map(([k, l], j) => `<td class="cell${j === 0 ? " gs" : ""}"><span class="pw-wrap">${fuButton(s, k, l)}</span></td>`).join("")}
    <td class="note gs">${s.notes ? `<p>${esc(s.notes)}</p>` : ""}<div class="acts"><button type="button" data-open="notes">${s.notes ? "Edit note" : "Add note"}</button><button type="button" data-open="history">History${nlog ? " (" + nlog + ")" : ""}</button></div></td>
  </tr>`;
}
function leadCard(s, i) {
  return `<article class="mc" data-id="${esc(s.id)}">
    <div class="mc-head">${pick(s.id)}<span class="rn">${i + 1}</span>
      <div class="mc-who"><button class="name" type="button" data-open="1">${esc(s.last_name)}, ${esc(s.first_name)}</button>${s.waitlist ? `<span class="flag wl">Waitlist</span>` : ""}
        <div class="sub">${esc(leadSub(s))}</div><div class="sub">${[s.email, s.phone].filter(Boolean).map(esc).join(" · ")}</div></div></div>
    <div class="mc-state">${nextStep(s)}</div>
    <div class="mg"><div class="mt-row">
      <div class="mt"><span class="pw-wrap">${payCell(s, "registration", true)}</span><span class="mt-l">Registration</span></div>
      ${FOLLOWUPS.map(([k, l]) => `<div class="mt"><span class="pw-wrap">${fuButton(s, k, l)}</span><span class="mt-l">${esc(l.replace("Follow-up", "Email"))}</span></div>`).join("")}
    </div></div>
    ${s.notes ? `<p class="mc-note">${esc(s.notes)}</p>` : ""}
    <div class="acts"><button type="button" data-open="notes">${s.notes ? "Edit note" : "Add note"}</button><button type="button" data-open="history">History</button></div>
  </article>`;
}
/* ---------------- Email: templates, rich editor, composer ----------------
   Templates live in public.email_templates (shared by all staff). The tracker doesn't send email yet: staff copy the
   formatted email into Gmail (formatting and images survive the paste) or open a Gmail draft (plain text).
   Automatic emails are switched on or off per template; they start once a sending account is connected. */
const AUTO_EMAILS = {
  followup_1: { when: "To unpaid leads, 1 day after they sign up", field: "followup_1_at" },
  followup_2: { when: "To unpaid leads, 3 days after Follow-up 1", field: "followup_2_at" },
  followup_3: { when: "To unpaid leads, 7 days after Follow-up 2", field: "followup_3_at" },
  welcome: { when: "When a student's first payment is recorded" },
  start_reminder: { when: "Days before the student's start date", days: true },
  missing_reqs: { when: "To paid students still missing requirements, days before their start date", days: true }
};
const PROFILE_EMAILS = [["packet", "Packet"], ["welcome_letter", "Welcome Letter"]];   // buttons in the student profile
const AUTO_ORDER = ["followup_1", "followup_2", "followup_3", "welcome", "start_reminder", "missing_reqs"];
const EMAIL_FIELDS = [["first_name", "First name"], ["last_name", "Last name"], ["program", "Program"], ["start_date", "Start date"], ["schedule", "Weekday/weekend"],
  ["site", "Clinical site"], ["registration", "Registration fee"], ["balance", "Balance owed"], ["missing_requirements", "Missing requirements"], ["email", "Student email"], ["phone", "Student phone"], ["staff_name", "Your name"],
  ["full_name", "Full name"], ["clinical_preference", "Clinical schedule (Weekday/Weekend)"], ["clinical_location", "Clinical location"], ["docs_due", "Documents due (6 days after start)"], ["onboarding_link", "Onboarding link"], ["minor_waiver_section", "Minor Waiver item (only for students under 18)"], ["end_date", "End date"], ["classroom_link", "Google Classroom link (per class)"], ["class_code", "Google Classroom class code (per class)"], ["classroom_section", "Google Classroom box (link + code, per class)"]];
const FONTS = ["Arial", "Georgia", "Helvetica", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Courier New"];
const SIZES = [["1", "Tiny"], ["2", "Small"], ["3", "Normal"], ["4", "Medium"], ["5", "Large"], ["6", "Huge"]];
function clean(html) {
  if (!window.DOMPurify) return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+="[^"]*"/gi, "");
  return DOMPurify.sanitize(String(html || ""), { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button"], ADD_ATTR: ["target"] });
}
function htmlToText(html) {
  const d = document.createElement("div");
  d.innerHTML = String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<li[^>]*>/gi, "• ");
  return d.textContent.replace(/\n{3,}/g, "\n\n").trim();
}
function emailValues(s) {
  const onboarding = (S.settings.onboarding_link && S.settings.onboarding_link.url) || "";
  if (!s) return { staff_name: (S.me && S.me.full_name) || "The CAL ACE team", onboarding_link: onboarding };
  const c = cohortOf(s), reg = num(plan(s).registration), site = siteOf(s), m = moneyOf(s);
  const missing = REQS.filter(([k]) => k !== "skills_checklist" && !s[k]).map(([, l]) => l);
  return { first_name: s.first_name || "", last_name: s.last_name || "", program: lab(PROGRAMS, s.program), start_date: c ? fmtDate(c.start_date) : "soon",
    schedule: s.schedule === "weekend" ? "weekend" : s.schedule === "weekday" ? "weekday" : "", site: site ? site.short_name : "your clinical site",
    registration: reg > 0 ? money(reg) : "", balance: money(m.balance), missing_requirements: missing.length ? missing.join(", ") : "nothing — you're all set",
    email: s.email || "", phone: s.phone || "", staff_name: (S.me && S.me.full_name) || "The CAL ACE team",
    full_name: [s.first_name, s.last_name].filter(Boolean).join(" "),
    clinical_preference: s.schedule === "weekend" ? "Weekend" : s.schedule === "weekday" ? "Weekday" : "To be confirmed",
    clinical_location: site ? (site.name || site.short_name) + (site.city && !(site.name || "").includes(site.city) ? ", " + site.city : "") : "To be assigned",
    docs_due: c ? new Date(new Date(c.start_date + "T00:00:00").getTime() + 6 * 864e5).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "6 days after your start date",
    end_date: c ? fmtDate(endOf(s)) : "to be confirmed",
    classroom_link: (classroomFor(s) || {}).link || "will be shared by your instructor", class_code: (classroomFor(s) || {}).code || "will be shared by your instructor",
    onboarding_link: onboarding };
}
// Fill {fields}. In HTML, values are escaped; with no student (a group email) fields are left as written.
// {minor_waiver_section}: a whole block that appears only for students under 18 on their start date (empty for everyone else).
const MINOR_WAIVER_URL = "https://pdf.ac/wDbZB9Ak7";
const MINOR_WAIVER_HTML = `<div style="background:#FFF6DB;border-left:4px solid #E9A23B;border-radius:6px;padding:12px 16px;margin:20px 0">
<p style="margin:0 0 8px;font-weight:700;color:#8A5A00">4. Minor Waiver (students under 18)</p>
<p style="margin:0"><b>Sign the Minor Waiver form:</b> <a href="${MINOR_WAIVER_URL}"><b>${MINOR_WAIVER_URL}</b></a></p></div>`;
// {classroom_section}: the class's Google Classroom link and code, or a note that the instructor will share them.
function classroomHtml(s, html) {
  const r = classroomFor(s) || {}, link = /^https?:\/\//i.test(r.link || "") ? r.link.trim() : "", code = (r.code || "").trim();
  if (!html) return link || code ? `Google Classroom: ${link || "link to follow"}  Class code: ${code || "to follow"}` : "Your Google Classroom link and class code will be shared by your instructor.";
  const rows = link || code
    ? `<p style="margin:0">Classroom link: ${link ? `<a href="${esc(link)}"><b>${esc(link)}</b></a>` : "<b>to follow</b>"}<br>Class code: <b style="font-size:16px;letter-spacing:1px">${esc(code || "to follow")}</b></p>`
    : `<p style="margin:0">Your class's Google Classroom link and class code will be shared by your instructor before your first day.</p>`;
  return `<div style="background:#E8F0FE;border-left:4px solid #1A73E8;border-radius:6px;padding:12px 16px;margin:16px 0">
<p style="margin:0 0 8px;font-weight:700;color:#174EA6">YOUR GOOGLE CLASSROOM</p>${rows}</div>`;
}
function fillEmail(text, s, html) {
  const v = emailValues(s);
  return String(text || "").replace(/\{(\w+)\}/g, (m, k) => {
    if (k === "minor_waiver_section") return !s ? m : isMinor(s) ? (html ? MINOR_WAIVER_HTML : "Sign the Minor Waiver form: " + MINOR_WAIVER_URL) : "";
    if (k === "classroom_section") return !s ? m : classroomHtml(s, html);
    return (k in v && (s || k === "staff_name")) ? (html ? esc(v[k]) : v[k]) : m;
  }).replace(/ {2,}/g, " ");
}
function tplByKey(k) { return (S.templates || []).find(t => t.auto_key === k) || null; }

/* ---------------- Welcome Letter PDF ----------------
   assets/welcome-letter.pdf is the school's letter with {{blanks}}. The tracker covers each blank with its own background
   colour and writes the student's details in the same font, size and colour, so the design and links stay as they are. */
function classroomFor(s) {
  if (!s || !s.cohort_id || !s.site_id || !s.schedule) return null;
  return (S.classrooms || []).find(c => c.cohort_id === s.cohort_id && c.site_id === s.site_id && c.schedule === s.schedule) || null;
}
function classLabel(s) {
  const c = cohortOf(s), site = siteOf(s);
  return [c ? fmtDate(c.start_date) : "No start date", site ? site.short_name || site.name : "no clinical site", s.schedule === "weekend" ? "Weekend" : s.schedule === "weekday" ? "Weekday" : "no schedule"].join(" · ");
}
const longDay = iso => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
let pdfLibLoading = null;
function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  return pdfLibLoading || (pdfLibLoading = new Promise((ok, no) => {
    const el = document.createElement("script"); el.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
    el.onload = () => ok(window.PDFLib); el.onerror = () => { pdfLibLoading = null; no(new Error("Couldn't load the PDF tool. Check the connection and try again.")); };
    document.head.appendChild(el);
  }));
}
let letterBytes = null;
async function welcomeLetterPdf(s, room) {
  const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = await loadPdfLib();
  if (!letterBytes) { const r = await fetch("assets/welcome-letter.pdf"); if (!r.ok) throw new Error("Couldn't load the Welcome Letter file."); letterBytes = await r.arrayBuffer(); }
  const doc = await PDFDocument.load(letterBytes);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold), reg = await doc.embedFont(StandardFonts.TimesRoman);
  const hex = h => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  // Standard PDF fonts only know Western characters: drop accents rather than fail on a name like "Nguyễn".
  const safe = t => String(t || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e -ÿ–—‘’“”]/g, "");
  const pages = doc.getPages();
  const c = cohortOf(s), site = siteOf(s);
  const start = c ? longDay(c.start_date) : "To be confirmed";
  const wkEnd = c ? longDay(cohortEnd(c, "weekday")) : "", weEnd = c ? longDay(c.weekend_end || cohortEnd(c, "weekend")) : "";
  const name = safe([s.first_name, s.last_name].filter(Boolean).join(" "));
  // Cover a blank (x, baseline y, size, width of the original text) and write new text there, shrinking it to fit `max` if needed.
  const put = (p, o) => {
    const pg = pages[p - 1], f = o.bold ? bold : reg, text = safe(o.text);
    pg.drawRectangle({ x: o.x - 1.5, y: o.y - o.size * 0.28, width: (o.cover || o.w) + 3, height: o.size * 1.12, color: hex(o.bg || "#ffffff") });
    let size = o.size; const max = o.max || o.w; while (size > 7 && f.widthOfTextAtSize(text, size) > max) size -= 0.25;
    const w = f.widthOfTextAtSize(text, size), x = o.center ? o.center - w / 2 : o.x;
    pg.drawText(text, { x, y: o.y, size, font: f, color: hex(o.color || "#2a2a2a") });
    if (o.link) {
      pg.drawLine({ start: { x, y: o.y - 1.2 }, end: { x: x + w, y: o.y - 1.2 }, thickness: 0.6, color: hex(o.color) });
      const annot = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [x, o.y - 3, x + w, o.y + size], Border: [0, 0, 0],
        A: { Type: "Action", S: "URI", URI: PDFString.of(o.link) } }));
      const annots = pg.node.lookup(PDFName.of("Annots"));
      if (annots) annots.push(annot); else pg.node.set(PDFName.of("Annots"), doc.context.obj([annot]));
    }
  };
  // Page 1: cohort line, student box, greeting, first paragraph.
  put(1, { x: 115.1, y: 610.2, size: 12.5, w: 381.7, max: 500, center: 305.95, bold: true, color: "#1e6f9e", text: `${start} Cohort  |  Nurse Assistant Training Program (NATP)` });
  const cell = { size: 12, bold: true, bg: "#f6f9fb", color: "#143d63" };
  put(1, { ...cell, x: 55.6, y: 580, w: 150.3, max: 245, text: name || "Student" });
  put(1, { ...cell, x: 311.4, y: 580, w: 93.1, max: 245, text: start });
  put(1, { ...cell, x: 55.6, y: 549.1, w: 243.3, max: 245, text: c ? `${start} – ${wkEnd}` : "To be confirmed" });
  put(1, { ...cell, x: 311.4, y: 549.1, w: 213, max: 245, text: c ? `${start} – ${weEnd}` : "To be confirmed" });
  put(1, { x: 51.8, y: 503.6, size: 12, w: 128.2, max: 480, bold: true, text: `Dear ${safe(s.first_name) || "Student"},` });
  put(1, { x: 51.8, y: 454, size: 12.5, w: 487.9, max: 505, text: `we are pleased to officially welcome you to the ${start} Cohort of the Nurse Assistant` });
  // Page 2: the Google Classroom row.
  const where = site ? (site.name || site.short_name) : "Clinical site to be assigned";
  const when = s.schedule === "weekend" ? "Weekend Clinical" : s.schedule === "weekday" ? "Weekday Clinical" : "Schedule to be confirmed";
  put(2, { x: 195.9, y: 216.4, size: 12, w: 318.4, max: 350, text: `${where} – ${when}` });
  const link = room && /^https?:\/\//i.test(room.link || "") ? room.link.trim() : "";
  put(2, { x: 195.9, y: 202.6, size: 12, w: 131.1, max: 350, text: link || "Link will be shared by your instructor", color: link ? "#1155cc" : "#2a2a2a", link: link || null });
  put(2, { x: 195.9, y: 188.8, size: 12, w: 159.7, max: 350, text: `Class Code: ${(room && room.code) || "will be shared by your instructor"}` });
  // Page 8: closing line, which ran onto a second line in the original.
  const lead = "Once again, welcome to the CAL ACE CNA Program. We look forward to seeing you on";
  const one = `${lead} ${start}.`;
  if (reg.widthOfTextAtSize(one, 12.5) <= 505) { put(8, { x: 51.8, y: 399.2, size: 12.5, w: 499.8, max: 505, text: one }); put(8, { x: 51.8, y: 384.1, size: 12.5, w: 47, text: "" }); }
  else { put(8, { x: 51.8, y: 399.2, size: 12.5, w: 499.8, max: 505, text: lead }); put(8, { x: 51.8, y: 384.1, size: 12.5, w: 47, max: 505, text: `${start}.` }); }
  doc.setTitle(`Welcome Letter – ${name}`);
  return doc.save();
}
function bytesToB64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
const letterName = s => `Welcome Letter - ${[s.first_name, s.last_name].filter(Boolean).join(" ").replace(/[\\/:*?"<>|]/g, "")}.pdf`;
const canClassroom = () => can("templates", 2) || can("cna", 2);
// In the Welcome Letter email: the filled-in PDF, and this student's class Google Classroom link and code (saved for the whole class).
function letterPanel(s) {
  const room = classroomFor(s) || {}, ready = s.cohort_id && s.site_id && s.schedule, edit = canClassroom() && ready;
  return `<div class="letter-box">
    <div class="lb-file">${icon("file")}<span><b>${esc(letterName(s))}</b><small>Attached. Your Welcome Letter, filled in for ${esc(s.first_name)}.</small></span><button class="ghost" type="button" id="lb-preview">Preview PDF</button></div>
    <p class="lb-h">Google Classroom for this class <small>${esc(classLabel(s))}</small></p>
    ${ready ? `<div class="fg">
      <div class="f w"><label for="lb-link">Classroom link</label><input id="lb-link" type="url" placeholder="https://classroom.google.com/c/…" value="${esc(room.link || "")}"${edit ? "" : " disabled"}></div>
      <div class="f"><label for="lb-code">Class code</label><input id="lb-code" type="text" placeholder="abc1234" value="${esc(room.code || "")}"${edit ? "" : " disabled"}></div>
      ${edit ? `<div class="f lb-save"><button class="primary" type="button" id="lb-save">Save for this class</button></div>` : ""}
    </div><p class="small-note">Saved once for everyone with the same start date, clinical site and schedule. Until it's saved, the letter and email say the link will be shared by the instructor.</p>`
    : `<p class="warn-note">Add a start date, clinical site and weekday/weekend to ${esc(s.first_name)}'s profile first, so the right Classroom link can be used.</p>`}
  </div>`;
}
// Templates page: every current or upcoming class (start date + site + weekday/weekend that has CNA students) and its Classroom.
function classroomListHtml() {
  const groups = new Map();
  S.students.forEach(s => {
    if (s.withdrawn || s.dropped || !["hybrid", "in_person"].includes(s.program) || !s.cohort_id || !s.site_id || !s.schedule) return;
    const c = cohortOf(s); if (!c || cohortEnd(c, s.schedule) < ISO_TODAY) return;
    const k = `${s.cohort_id}|${s.site_id}|${s.schedule}`;
    if (!groups.has(k)) groups.set(k, { k, s, start: c.start_date, n: 0 }); groups.get(k).n++;
  });
  const list = [...groups.values()].sort((a, b) => a.start.localeCompare(b.start) || classLabel(a.s).localeCompare(classLabel(b.s)));
  const edit = canClassroom();
  // One flip card per start date: the front shows the date and how many classes have their Classroom set; the back has the boxes.
  const byStart = new Map(); list.forEach(g => { if (!byStart.has(g.s.cohort_id)) byStart.set(g.s.cohort_id, []); byStart.get(g.s.cohort_id).push(g); });
  const cards = [...byStart.entries()].map(([cid, gs]) => {
    const c = S.cohorts.find(x => x.id === cid), set = gs.filter(g => { const r = classroomFor(g.s); return r && r.link; }).length, n = gs.reduce((t, g) => t + g.n, 0);
    const d = new Date(c.start_date + "T00:00:00"), soon = Math.round((d - new Date(ISO_TODAY + "T00:00:00")) / 864e5);
    const tone = set === gs.length ? "ok" : set ? "part" : "none";
    return `<div class="cr-card" data-crcard="${cid}">
      <div class="cr-inner">
        <button type="button" class="cr-face cr-front" data-crflip="${cid}" aria-label="Show Google Classroom links for ${esc(fmtDate(c.start_date))}">
          <span class="cr-mon">${esc(d.toLocaleDateString("en-US", { month: "short" }))}</span>
          <span class="cr-day">${d.getDate()}</span>
          <span class="cr-yr">${d.getFullYear()} · ${soon > 0 ? `starts in ${soon} day${soon === 1 ? "" : "s"}` : "in progress"}</span>
          <span class="cr-meta">${gs.length} ${gs.length === 1 ? "class" : "classes"} · ${n} ${n === 1 ? "student" : "students"}</span>
          <span class="cr-badge ${tone}">${set === gs.length ? "All links set" : `${set} of ${gs.length} links set`}</span>
          <span class="cr-hint">Click to ${edit ? "edit" : "view"} links</span>
        </button>
        <div class="cr-face cr-back" aria-hidden="true">
          <div class="cr-back-h"><b>${esc(fmtDate(c.start_date))}</b><button class="lnk" type="button" data-crflip="${cid}">Done</button></div>
          ${gs.map(g => { const r = classroomFor(g.s) || {}, site = siteOf(g.s); return `<div class="cr-row">
            <div class="cr-lbl"><b>${esc(site ? site.short_name || site.name : "")} · ${g.s.schedule === "weekend" ? "Weekend" : "Weekday"}</b><small>${g.n} ${g.n === 1 ? "student" : "students"}${r.updated_by ? " · saved by " + esc(r.updated_by) : ""}</small></div>
            <input type="url" data-crlink placeholder="https://classroom.google.com/c/…" aria-label="Classroom link" value="${esc(r.link || "")}"${edit ? "" : " disabled"}>
            <div class="cr-code"><input type="text" data-crcode placeholder="Class code" aria-label="Class code" value="${esc(r.code || "")}"${edit ? "" : " disabled"}>
            ${edit ? `<button class="ghost" type="button" data-crsave="${g.k}">Save</button>` : ""}</div></div>`; }).join("")}
        </div>
      </div></div>`;
  });
  return `<div class="onb"><b>Google Classroom for each class</b> <span class="small-note">Used in the Welcome Letter email and its PDF. Click a start date to set the link and code for each clinical site and schedule.</span>
    ${list.length ? `<div class="cr-list">${cards.join("")}</div>`
      : `<p class="small-note">No current or upcoming classes with students yet.</p>`}</div>`;
}
async function saveClassroom(s, link, code) {
  link = String(link || "").trim(); code = String(code || "").trim();
  if (link && !/^https?:\/\/\S+$/i.test(link)) throw new Error("The Classroom link should start with https://");
  const row = { cohort_id: s.cohort_id, site_id: s.site_id, schedule: s.schedule, link, code };
  const { data, error } = await sb.from("classrooms").upsert(row).select().single();
  if (error) throw new Error(/row-level/i.test(error.message) ? "You don't have permission to change Classroom links." : error.message);
  S.classrooms = (S.classrooms || []).filter(c => !(c.cohort_id === row.cohort_id && c.site_id === row.site_id && c.schedule === row.schedule)).concat(data);
  return data;
}
function wireLetterPanel(s, onSaved) {
  $("lb-preview").onclick = async () => {
    const b = $("lb-preview"); b.disabled = true; b.textContent = "Preparing…";
    const win = window.open("", "_blank");
    try {
      const bytes = await welcomeLetterPdf(s, classroomFor(s));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      if (win) win.location.href = url; else window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (e) { if (win) win.close(); toast(e.message); }
    b.disabled = false; b.textContent = "Preview PDF";
  };
  if ($("lb-save")) $("lb-save").onclick = async () => {
    const b = $("lb-save"); b.disabled = true;
    try { await saveClassroom(s, $("lb-link").value, $("lb-code").value); onSaved(); toast("Saved for this class. The email and letter now use it."); }
    catch (e) { toast(e.message); shake(b); }
    b.disabled = false;
  };
}

/* Rich text editor: fonts, sizes, bold/italic/underline, colour, lists, links, pasted or picked images, attachments. */
function editorHtml(id, html, atts) {
  return `<div class="rte" id="${id}">
    <div class="rte-bar" role="toolbar" aria-label="Formatting">
      <select data-cmd="fontName" aria-label="Font"><option value="">Font</option>${FONTS.map(f => `<option value="${f}" style="font-family:${f}">${f}</option>`).join("")}</select>
      <select data-cmd="fontSize" aria-label="Size"><option value="">Size</option>${SIZES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
      <button type="button" data-cmd="bold" aria-label="Bold"><b>B</b></button><button type="button" data-cmd="italic" aria-label="Italic"><i>I</i></button><button type="button" data-cmd="underline" aria-label="Underline"><u>U</u></button>
      <label class="rte-color" title="Text colour"><span>A</span><input type="color" data-cmd="foreColor" value="#1e252d" aria-label="Text colour"></label>
      <button type="button" data-cmd="insertUnorderedList" aria-label="Bulleted list">• List</button><button type="button" data-cmd="insertOrderedList" aria-label="Numbered list">1. List</button>
      <button type="button" data-cmd="link" aria-label="Add link">Link</button>
      <button type="button" data-cmd="image" aria-label="Insert image">Image</button><button type="button" data-cmd="attach" aria-label="Attach file">Attach</button>
      <select data-cmd="field" aria-label="Insert a field"><option value="">Insert field</option>${EMAIL_FIELDS.map(([k, l]) => `<option value="{${k}}">${l}</option>`).join("")}</select>
      <button type="button" data-cmd="removeFormat" aria-label="Clear formatting">Clear</button>
      <input type="file" class="rte-img" accept="image/*" hidden><input type="file" class="rte-file" multiple hidden>
    </div>
    <div class="rte-body" contenteditable="true" spellcheck="true">${clean(html)}</div>
    <div class="rte-atts"></div><span class="rte-busy small-note" hidden>Uploading…</span>
  </div>`;
}
async function uploadAsset(file, folder) {
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name || "That file"} is over 10 MB.`);
  const ext = ((file.name || "").match(/\.[A-Za-z0-9]{1,6}$/) || [""])[0].toLowerCase() || (file.type === "image/png" ? ".png" : file.type === "image/jpeg" ? ".jpg" : "");
  const path = `${folder}/${crypto.randomUUID()}${ext}`;
  const { error } = await sb.storage.from("email-assets").upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw error;
  return { url: sb.storage.from("email-assets").getPublicUrl(path).data.publicUrl, path, name: file.name || "image" + ext, size: file.size };
}
// Wires an editor and returns { html(), atts() }.
function wireEditor(id, atts) {
  const root = $(id), body = root.querySelector(".rte-body"), busy = root.querySelector(".rte-busy");
  let files = (atts || []).slice(), saved = null;
  const keep = () => { const s = getSelection(); if (s.rangeCount && body.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange(); };
  const back = () => { body.focus(); if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); } };
  body.addEventListener("keyup", keep); body.addEventListener("mouseup", keep); body.addEventListener("blur", keep);
  const drawAtts = () => {
    root.querySelector(".rte-atts").innerHTML = files.map((f, i) => `<span class="rte-att"><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a> <small>${fileSize(f.size)}</small><button type="button" data-rmatt="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join("");
  };
  drawAtts();
  root.querySelector(".rte-atts").addEventListener("click", e => { const b = e.target.closest("[data-rmatt]"); if (b) { files.splice(+b.dataset.rmatt, 1); drawAtts(); } });
  const insertImages = async list => {
    busy.hidden = false;
    try { for (const f of list) { const a = await uploadAsset(f, "images"); back(); document.execCommand("insertHTML", false, `<img src="${esc(a.url)}" alt="" style="max-width:100%">`); keep(); } }
    catch (e) { toast("Couldn't add the image: " + errText(e)); }
    busy.hidden = true;
  };
  body.addEventListener("paste", e => {
    const imgs = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => /^image\//.test(f.type));
    if (imgs.length) { e.preventDefault(); keep(); insertImages(imgs); return; }
    const h = e.clipboardData && e.clipboardData.getData("text/html");
    if (h) { e.preventDefault(); document.execCommand("insertHTML", false, clean(h)); }   // keep formatting, drop anything unsafe
  });
  body.addEventListener("drop", e => { const imgs = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter(f => /^image\//.test(f.type)); if (imgs.length) { e.preventDefault(); insertImages(imgs); } });
  root.querySelector(".rte-bar").addEventListener("mousedown", e => { if (e.target.closest("button")) e.preventDefault(); });   // keep the text selected
  root.querySelector(".rte-bar").addEventListener("click", e => {
    const b = e.target.closest("button[data-cmd]"); if (!b) return;
    const cmd = b.dataset.cmd;
    if (cmd === "image") { keep(); root.querySelector(".rte-img").click(); return; }
    if (cmd === "attach") { root.querySelector(".rte-file").click(); return; }
    if (cmd === "link") { keep(); const u = prompt("Link address (https://…)"); if (u && /^(https?:|mailto:)/i.test(u.trim())) { back(); document.execCommand("createLink", false, u.trim()); } return; }
    back(); document.execCommand(cmd, false, null); keep();
  });
  root.querySelector(".rte-bar").addEventListener("change", e => {
    const el = e.target, cmd = el.dataset.cmd; if (!cmd || el.type === "file") return;
    if (cmd === "field") { if (el.value) { back(); document.execCommand("insertText", false, el.value); keep(); } el.value = ""; return; }
    if (!el.value) return;
    back(); document.execCommand("styleWithCSS", false, cmd !== "fontSize"); document.execCommand(cmd, false, el.value); keep();
    if (el.tagName === "SELECT") el.value = "";
  });
  root.querySelector(".rte-img").addEventListener("change", e => { const l = [...e.target.files]; e.target.value = ""; if (l.length) insertImages(l); });
  root.querySelector(".rte-file").addEventListener("change", async e => {
    const l = [...e.target.files]; e.target.value = ""; busy.hidden = false;
    try { for (const f of l) files.push(await uploadAsset(f, "attachments")); } catch (er) { toast("Couldn't attach: " + errText(er)); }
    busy.hidden = true; drawAtts();
  });
  return { html: () => clean(body.innerHTML), atts: () => files.slice(), set: (h, a) => { body.innerHTML = clean(h); if (a) { files = a.slice(); drawAtts(); } } };
}
async function copyRich(subject, html, atts) {
  const attHtml = (atts || []).length ? `<p>Attachments:<br>${atts.map(a => `<a href="${esc(a.url)}">${esc(a.name)}</a>`).join("<br>")}</p>` : "";
  const full = html + attHtml, text = htmlToText(full);
  try {
    if (window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([full], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    else await navigator.clipboard.writeText(text);
    toast("Email copied with its formatting. Paste it into the Gmail message, and copy the subject separately.");
  } catch (e) { toast("Couldn't copy. Select the message and copy it instead."); }
}
function gmailUrl(to, subject, html, bcc) {
  return "https://mail.google.com/mail/?view=cm&fs=1" + (to ? "&to=" + encodeURIComponent(to) : "") + (bcc ? "&bcc=" + encodeURIComponent(bcc) : "")
    + "&su=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(htmlToText(html));
}

/* Composer: used for one-off emails (to ticked students or anyone) and for the lead follow-up preview. */
let mailCtx = null;
function studentByEmail(e, o, one) {
  e = String(e || "").trim().toLowerCase(); if (!e) return null;
  const m = s => s && String(s.email || "").trim().toLowerCase() === e;
  return ((o && o.people) || []).map(p => p.student).find(m) || (m(one) ? one : null) || S.students.find(m) || null;
}
function openComposer(o) {
  // o: { title, sub, to, bcc, subject, html, atts, student, templateId, followup: {id, k}, pickTemplate }
  mailCtx = o;
  const canSend = !!(S.drive && S.drive.can_send);
  const one = o.student || null, tpls = (S.templates || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const canEditTpl = can("templates", 2) && o.templateId;
  $("layer").innerHTML = `<div class="scrim" data-close="1"></div>
  <div class="drawer mail wide" role="dialog" aria-modal="true" aria-labelledby="dh-title">
    <div class="dh"><div><h2 id="dh-title">${esc(o.title || "New email")}</h2>${o.sub ? `<p>${esc(o.sub)}</p>` : ""}</div><button class="x" type="button" data-close="1" aria-label="Close">×</button></div>
    <div class="db">
      ${o.notice ? `<p class="warn-note">${esc(o.notice)}</p>` : ""}
      ${o.followup && one && !one.email ? `<p class="warn-note">There's no email address for this student. Add one in their card, or copy the message and send it another way.</p>` : ""}
      <section><div class="fg">
        ${o.pickTemplate ? sel("m-tpl", "Start from a template", "", [["", "Blank email"]].concat(tpls.map(t => [t.id, t.name])), "w") : ""}
        <div class="f w"><label for="m-to">${o.bcc != null ? (canSend ? "To: each student gets their own copy" : "Bcc (each student only sees their own address)") : "To"}</label><textarea id="m-to" class="mail-to" rows="2">${esc(o.bcc != null ? o.bcc : o.to || "")}</textarea></div>
        ${field("m-subject", "Subject", o.subject || "", "text", "w")}
      </div>
      ${!one && !(canSend && o.bcc != null) && /\{\w+\}/.test((o.subject || "") + (o.html || "")) ? `<p class="small-note">Fields like {first_name} are filled in only when you email one student, or when you click Send for a group. Remove them before copying.</p>` : ""}
      ${o.letter && one ? letterPanel(one) : ""}
      <div class="f w" style="margin-top:10px"><label>Message</label>${editorHtml("m-ed", o.html || "", o.atts || [])}</div>
      <div class="mail-acts">${canSend ? `<button class="primary" type="button" id="m-send">Send</button><button class="ghost" type="button" id="m-test">Send test to me</button>` : ""}<button class="${canSend ? "ghost" : "primary"}" type="button" id="m-copy">Copy email</button><button class="ghost" type="button" id="m-gmail">Open in Gmail</button><button class="ghost" type="button" id="m-copyto">Copy addresses</button>
        ${canEditTpl ? `<button class="lnk" type="button" id="m-edit-tpl">Edit this template</button>` : ""}</div>
      <p class="small-note">${canSend ? `<b>Send</b> emails it from ${esc(S.drive.send_account || "the school's Gmail")} with the attachments${o.bcc != null ? "; each student gets their own copy, with fields like {first_name} filled in for them" : ""}${o.followup ? ", and marks the follow-up sent" : ""}. ` : ""}<b>Copy email</b> keeps fonts, colours and images for pasting into Gmail. <b>Open in Gmail</b> starts a plain-text draft.${canSend ? "" : " Attachments are added as links."}${o.followup && !canSend ? " After you send it, click <b>Mark as sent</b>." : ""}</p>
      <span class="err" id="m-err" hidden></span></section>
    </div>
    <div class="df">${o.followup ? `<button class="primary" type="button" id="m-sent">Mark as sent</button>` : ""}<button class="ghost" type="button" data-close="1">Close</button><span class="err" id="save-err" hidden></span></div>
  </div>`;
  const ed = wireEditor("m-ed", o.atts || []);
  if (o.letter && one) wireLetterPanel(one, () => { if (o.refill) { $("m-subject").value = o.refill.subject(); ed.set(o.refill.html()); } });
  const letterFiles = async s => o.letter && s ? [{ name: letterName(s), data: bytesToB64(await welcomeLetterPdf(s, classroomFor(s))) }] : undefined;
  const addr =() => $("m-to").value.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean).join(", ");
  if ($("m-tpl")) $("m-tpl").onchange = e => {
    const t = tpls.find(x => String(x.id) === e.target.value);
    if (!t) { $("m-subject").value = ""; ed.set("", []); return; }
    $("m-subject").value = fillEmail(t.subject, one); ed.set(fillEmail(t.body_html, one, true), t.attachments || []);
  };
  $("m-copy").onclick = () => copyRich($("m-subject").value, ed.html(), ed.atts());
  // Send test to me: one copy to the signed-in staff member, filled in with a real student's details so fields can be checked.
  if ($("m-test")) $("m-test").onclick = async () => {
    const err = $("m-err"), b = $("m-test");
    const sample = one || ((o.people || []).map(p => p.student).find(Boolean)) || S.students.find(s => s.email && s.cohort_id && !s.withdrawn) || S.students[0] || null;
    const subject = $("m-subject").value.trim(); if (!subject) { err.hidden = false; err.textContent = "Add a subject."; return; }
    b.disabled = true; b.textContent = "Sending test…"; err.hidden = true;
    try {
      const r = await mailCall("send", { messages: [{ to: S.me.email, subject: "[Test] " + fillEmail(subject, sample), html: fillEmail(ed.html(), sample, true), student_id: null, kind: "test", files: await letterFiles(sample) }], attachments: ed.atts() });
      toast(`Test sent to ${S.me.email}` + (sample ? `, filled in as ${sample.first_name} ${sample.last_name}` : "") + ` (from ${r.from})`);
    } catch (e) { err.hidden = false; err.textContent = e.message; }
    b.disabled = false; b.textContent = "Send test to me";
  };
  if ($("m-send")) $("m-send").onclick = async () => {
    const err = $("m-err"), fail = m => { err.hidden = false; err.textContent = m; shake($("m-send")); };
    const subject = $("m-subject").value.trim(), html = ed.html(), list = addr().split(", ").filter(Boolean);
    if (!list.length) return fail("Add at least one email address.");
    if (!subject) return fail("Add a subject.");
    // Fields are filled per student. An address typed in To that belongs to a student counts as that student.
    const kind = o.kind || (o.followup ? o.followup.k.replace("_at", "") : "manual");
    const hasFields = /\{\w+\}/.test(subject + html);
    const perStudent = o.bcc != null || (hasFields && list.length > 1 && list.every(e => studentByEmail(e, o, one)));
    const messages = perStudent
      ? list.map(e => { const s = studentByEmail(e, o, one); return { to: e, subject: fillEmail(subject, s), html: fillEmail(html, s, true), student_id: s ? s.id : null, kind, template_id: o.templateId || null }; })
      : (() => { const s = list.length === 1 ? studentByEmail(list[0], o, one) : one; return [{ to: list.join(", "), subject: fillEmail(subject, s), html: fillEmail(html, s, true), student_id: s ? s.id : null, kind, template_id: o.templateId || null }]; })();
    if (messages.length > 100) return fail("Send at most 100 emails at a time. Tick fewer students.");
    const left = [...new Set(messages.flatMap(m => (m.subject + m.html).match(/\{\w+\}/g) || []))];
    const btn = $("m-send");
    if (left.length && btn.dataset.sure !== "fields") {
      btn.dataset.sure = "fields"; btn.textContent = "Send anyway?";
      return fail(`${left.join(", ")} can't be filled in because ${messages.length === 1 ? "this address isn't" : "some addresses aren't"} a student in the tracker, so ${left.length === 1 ? "it" : "they"} would be sent as written. Remove ${left.length === 1 ? "it" : "them"}, use Send test to me to check the wording, or click Send anyway.`);
    }
    if (messages.length > 1 && btn.dataset.sure !== "many" && btn.dataset.sure !== "fields") { btn.dataset.sure = "many"; btn.textContent = `Send ${messages.length} emails?`; return; }
    $("m-send").disabled = true; $("m-send").textContent = "Sending…"; err.hidden = true;
    try {
      if (o.letter) {   // each student gets their own filled-in letter
        $("m-send").textContent = "Preparing the letter…";
        for (const m of messages) { const s = S.students.find(x => x.id === m.student_id); if (!s) throw new Error("The Welcome Letter can only go to a student in the tracker."); m.files = await letterFiles(s); }
        $("m-send").textContent = "Sending…";
      }
      const r = await mailCall("send", { messages, attachments: ed.atts() });
      if (o.followup && r.sent) { try { await updateStudent(o.followup.id, { [o.followup.k]: new Date().toISOString() }); } catch (e) {} }
      closeDrawer(); if (o.onSent) o.onSent();
      toast(`Sent ${r.sent} ${r.sent === 1 ? "email" : "emails"} from ${r.from}` + (r.failed && r.failed.length ? `. ${r.failed.length} didn't go: ${r.failed.map(f => f.to + " (" + f.error + ")").slice(0, 3).join(", ")}` : ""));
    } catch (e) { btn.disabled = false; btn.textContent = "Send"; delete btn.dataset.sure; fail(e.message); }
  };
  $("m-gmail").onclick = () => { const a = addr(), atts = ed.atts(); const h = ed.html() + (atts.length ? "<p>Attachments:<br>" + atts.map(x => esc(x.name) + ": " + esc(x.url)).join("<br>") + "</p>" : "");
    window.open(o.bcc != null ? gmailUrl("", $("m-subject").value, h, a) : gmailUrl(a, $("m-subject").value, h), "_blank", "noopener"); };
  $("m-copyto").onclick = async () => { try { await navigator.clipboard.writeText(addr()); toast("Addresses copied"); } catch (e) { toast("Couldn't copy the addresses."); } };
  if ($("m-edit-tpl")) $("m-edit-tpl").onclick = () => { const id = o.templateId; closeDrawer(); S.page = "templates"; render(); openTemplate(id); };
  if ($("m-sent")) $("m-sent").onclick = async () => {
    const st = S.students.find(x => x.id === o.followup.id), key = o.followup.k, l = (FOLLOWUPS.find(x => x[0] === key) || [0, "Follow-up"])[1]; if (!st) return;
    $("m-sent").disabled = true;
    try {
      await updateStudent(st.id, { [key]: new Date().toISOString() });
      closeDrawer(); toast(`${l} email marked sent for ${st.first_name} ${st.last_name}`, () => updateStudent(st.id, { [key]: null }).then(() => toast("Change undone. The undo is logged too.")).catch(err => toast(errText(err))));
    } catch (e) { $("m-sent").disabled = false; const er = $("save-err"); er.hidden = false; er.textContent = errText(e); }
  };
  setTimeout(() => ($("m-tpl") || $("m-subject")).focus(), 50);
}
// Lead follow-up preview (from the Leads page boxes).
function openEmail(s, k) {
  const key = k.replace("_at", ""), t = tplByKey(key), l = FOLLOWUPS.find(x => x[0] === k)[1], nx = nextFollowup(s);
  openComposer({
    title: l + " email", sub: `To ${s.first_name} ${s.last_name}` + (nx && nx.k === k ? (nx.overdue ? " · overdue since " + fmtDate(nx.due, false) : nx.today ? " · due today" : " · due " + fmtDate(nx.due, false)) : ""),
    to: s.email || "", subject: t ? fillEmail(t.subject, s) : "", html: t ? fillEmail(t.body_html, s, true) : "", atts: t ? t.attachments : [],
    student: s, templateId: t ? t.id : null, followup: { id: s.id, k }
  });
}
// Compose to the ticked students (from the bar) or a blank email.
function composeTo(people) {
  const emails = [...new Set(people.map(p => (p.email || "").trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
  const one = people.length === 1 && people[0].student ? people[0].student : null;
  openComposer({ title: "New email", sub: people.length ? `${people.length} ${people.length === 1 ? "person" : "people"} · ${emails.length} ${emails.length === 1 ? "address" : "addresses"}` : "",
    to: people.length > 1 ? "" : emails.join(", "), bcc: people.length > 1 ? emails.join(", ") : null, student: one, people, pickTemplate: true, subject: "", html: "" });
}

/* Email Templates page */
// Automatic emails staff add themselves: when they go out and who gets them (auto_rule).
const RULE_EVENTS = [["before_start", "days before the start date"], ["after_start", "days after the start date"], ["after_end", "days after the end date"],
  ["after_signup", "days after the student signs up"], ["first_payment", "days after the student's first payment"]];
const RULE_AUDIENCE = [["paid", "Paid students"], ["unpaid", "Unpaid students (leads)"], ["any", "All students"]];
const RULE_DEFAULT = { event: "before_start", days: 3, audience: "paid", program: "", missing_only: false };
function ruleText(r) {
  r = { ...RULE_DEFAULT, ...(r || {}) };
  const d = Math.max(0, num(r.days)), ev = lab(RULE_EVENTS, r.event);
  const when = d === 0 ? ({ before_start: "On the start date", after_start: "On the start date", after_end: "On the end date", after_signup: "Right after sign-up", first_payment: "Right after the first payment" }[r.event] || ev)
    : `${d} ${d === 1 ? ev.replace("days", "day") : ev}`;
  return [when, lab(RULE_AUDIENCE, r.audience), r.program ? lab(PROGRAMS, r.program) : "both CNA programs", r.missing_only ? "only if missing requirements" : ""].filter(Boolean).join(" · ");
}
function renderTemplates() {
  const w = $("wrap"), edit = can("templates", 2), list = S.templates || [];
  const added = list.filter(t => !t.auto_key && t.auto_rule).sort((a, b) => a.name.localeCompare(b.name));
  const autos = AUTO_ORDER.map(k => tplByKey(k)).filter(Boolean).concat(added), custom = list.filter(t => !t.auto_key && !t.auto_rule).sort((a, b) => a.name.localeCompare(b.name));
  const onCount = autos.filter(t => t.auto_on).length;
  w.innerHTML = `<div class="ov tplp">
    ${S.drive && S.drive.can_send
      ? `<div class="tpl-note ok">Emails are sent from <b>${esc(S.drive.send_account || "the school's Gmail")}</b>. Automatic emails are checked every 15 minutes; each student gets each one at most once. Lead follow-ups and the welcome email only go to students who sign up or pay <b>after</b> you switch them on. ${onCount ? `${onCount} ${onCount === 1 ? "is" : "are"} on.` : "All are off."}</div>`
      : `<div class="tpl-note"><b>Gmail sending isn't allowed yet.</b> ${isAdmin() ? `On the <button class="linkish-ink" type="button" data-page="drive">Google Drive</button> page, click <b>Allow sending from Gmail</b>.` : "Ask an admin to allow sending on the Google Drive page."} Until then, switching an email on saves your choice, and you can copy emails into Gmail. ${onCount ? `${onCount} ${onCount === 1 ? "is" : "are"} switched on.` : ""}</div>`}
    <div class="tpl-acts"><button class="primary" type="button" id="tpl-compose">Compose email</button>${edit ? `<button class="ghost" type="button" id="tpl-new">New template</button><button class="ghost" type="button" id="tpl-new-auto">Add automatic email</button>` : ""}</div>
    <section class="ov-sec"><div class="ov-head"><h2>Automatic emails</h2>${edit ? `<button class="ghost" type="button" id="tpl-new-auto2">+ Add automatic email</button>` : ""}</div><div class="tpl-list">
      ${autos.map(t => { const a = t.auto_key ? AUTO_EMAILS[t.auto_key] : { when: ruleText(t.auto_rule) }; return `<div class="tpl-row">
        <div class="tpl-main"><b>${esc(t.name)}</b>${t.auto_key ? "" : ` <span class="flag wl">Added</span>`}<span class="small-note">${esc(a.when)}${a.days ? ` · <label>send <input type="number" min="0" max="60" class="tpl-days" data-tdays="${t.id}" value="${t.auto_days ?? ""}"${edit ? "" : " disabled"}> days before</label>` : ""}</span>
          <span class="tpl-subj">${esc(t.subject)}</span></div>
        <div class="tpl-side"><button type="button" class="switch" role="switch" aria-checked="${!!t.auto_on}" data-tauto="${t.id}"${edit ? "" : " disabled"}><span></span>${t.auto_on ? "On" : "Off"}</button>
          <button class="ghost" type="button" data-topen="${t.id}">${edit ? "Edit" : "View"}</button></div></div>`; }).join("")}
    </div></section>
    <section class="ov-sec"><h2>Student profile emails</h2>
      <p class="small-note">Sent with the buttons in a student's profile. Staff see the email filled in for that student before sending.</p>
      <div class="tpl-list">${PROFILE_EMAILS.map(([k, l]) => { const t = tplByKey(k); if (!t) return "";
        const blank = !String(t.body_html || "").replace(/<[^>]+>/g, "").trim();
        return `<div class="tpl-row"><div class="tpl-main"><b>${esc(l)}</b><span class="tpl-subj">${esc(t.subject || "(no subject yet)")}</span>${blank ? `<span class="small-note warn-inline">Not written yet</span>` : ""}</div>
          <div class="tpl-side"><button class="ghost" type="button" data-topen="${t.id}">${edit ? (blank ? "Write it" : "Edit") : "View"}</button></div></div>`; }).join("")}</div>
      <div class="onb"><label for="onb-link"><b>Onboarding link</b> <span class="small-note">Used as {onboarding_link} in the Packet</span></label>
        <div class="onb-row"><input id="onb-link" type="url" placeholder="https://…" value="${esc((S.settings.onboarding_link && S.settings.onboarding_link.url) || "")}"${isAdmin() ? "" : " disabled"}>
        ${isAdmin() ? `<button class="ghost" type="button" id="onb-save">Save link</button>` : `<span class="small-note">Only admins can change it.</span>`}</div></div>
      ${classroomListHtml()}
    </section>
    <section class="ov-sec"><h2>Saved templates</h2>
      ${custom.length ? `<div class="tpl-list">${custom.map(t => `<div class="tpl-row"><div class="tpl-main"><b>${esc(t.name)}</b><span class="tpl-subj">${esc(t.subject || "(no subject)")}</span>
        <span class="small-note">${(t.attachments || []).length ? (t.attachments.length + " attachment" + (t.attachments.length === 1 ? "" : "s") + " · ") : ""}Edited ${esc(fmtDate(String(t.updated_at).slice(0, 10)))}${t.updated_by ? " by " + esc(t.updated_by) : ""}</span></div>
        <div class="tpl-side"><button class="ghost" type="button" data-tuse="${t.id}">Use</button><button class="ghost" type="button" data-topen="${t.id}">${edit ? "Edit" : "View"}</button></div></div>`).join("")}</div>`
        : `<p class="small-note">No saved templates yet.${edit ? " Click <b>New template</b> to write one you can reuse." : ""}</p>`}
    </section></div>`;
  $("tpl-compose").onclick = () => composeTo([]);
  if ($("tpl-new")) $("tpl-new").onclick = () => openTemplate(null);
  ["tpl-new-auto", "tpl-new-auto2"].forEach(b => { if ($(b)) $(b).onclick = () => openTemplate(null, { auto: true }); });
  if ($("onb-save")) $("onb-save").onclick = async () => {
    const url = $("onb-link").value.trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) { shake($("onb-link")); toast("Enter the full link, starting with https://"); return; }
    const value = { url, by: S.me.email, at: new Date().toISOString() };
    const { error } = await sb.from("settings").upsert({ key: "onboarding_link", value });
    if (error) { toast(errText(error)); return; }
    S.settings.onboarding_link = value; toast(url ? "Onboarding link saved. The Packet will use it." : "Onboarding link cleared.");
  };
  w.querySelectorAll("[data-crsave]").forEach(b => b.onclick = async () => {
    const row = b.closest(".cr-row"), [cohort_id, site_id, schedule] = b.dataset.crsave.split("|");
    b.disabled = true;
    try {
      await saveClassroom({ cohort_id: +cohort_id, site_id: +site_id, schedule }, row.querySelector("[data-crlink]").value, row.querySelector("[data-crcode]").value);
      toast("Classroom saved for this class.");
      // Update the front of the card (links set count) without re-rendering, so the card stays flipped.
      const card = b.closest(".cr-card"), rows = [...card.querySelectorAll(".cr-row")], set = rows.filter(x => x.querySelector("[data-crlink]").value.trim()).length;
      const badge = card.querySelector(".cr-badge"); badge.className = "cr-badge " + (set === rows.length ? "ok" : set ? "part" : "none");
      badge.textContent = set === rows.length ? "All links set" : `${set} of ${rows.length} links set`;
    }
    catch (e) { toast(e.message); shake(b); }
    b.disabled = false;
  });
  w.querySelectorAll("[data-crflip]").forEach(b => b.onclick = () => {
    const card = w.querySelector(`[data-crcard="${b.dataset.crflip}"]`), on = !card.classList.contains("flipped");
    card.classList.toggle("flipped", on);
    card.querySelector(".cr-back").setAttribute("aria-hidden", String(!on)); card.querySelector(".cr-front").setAttribute("aria-hidden", String(on));
    card.querySelector(".cr-front").tabIndex = on ? -1 : 0;
    if (on) setTimeout(() => { const i = card.querySelector(".cr-back input"); if (i && !i.disabled) i.focus({ preventScroll: true }); }, 350);
    else card.querySelector(".cr-front").focus({ preventScroll: true });
  });
  w.querySelectorAll("[data-topen]").forEach(b => b.onclick = () => openTemplate(+b.dataset.topen));
  w.querySelectorAll("[data-tuse]").forEach(b => b.onclick = () => { const t = list.find(x => x.id === +b.dataset.tuse); openComposer({ title: "New email", subject: t.subject, html: t.body_html, atts: t.attachments, pickTemplate: true, templateId: t.id }); });
  w.querySelectorAll("[data-tauto]").forEach(b => b.onclick = async () => {
    const t = list.find(x => x.id === +b.dataset.tauto), on = !t.auto_on;
    const { error } = await sb.from("email_templates").update({ auto_on: on }).eq("id", t.id);
    if (error) { toast(errText(error)); return; }
    t.auto_on = on; renderTemplates(); toast(`${t.name}: automatic email ${on ? (S.drive && S.drive.can_send ? "on. It goes to students who qualify from now on." : "on (it starts once Gmail sending is allowed)") : "off"}`);
  });
  w.querySelectorAll("[data-tdays]").forEach(i => i.onchange = async () => {
    const t = list.find(x => x.id === +i.dataset.tdays), v = i.value === "" ? null : Math.max(0, Math.min(60, Math.round(+i.value)));
    const { error } = await sb.from("email_templates").update({ auto_days: v }).eq("id", t.id);
    if (error) { toast(errText(error)); return; } t.auto_days = v; toast(`${t.name}: ${v ?? "no"} days before the start date`);
  });
}
function openTemplate(id, opts) {
  const t = id ? (S.templates || []).find(x => x.id === id) : { name: "", subject: "", body_html: "", attachments: [], auto_rule: opts && opts.auto ? { ...RULE_DEFAULT } : null }; if (!t) return;
  const edit = can("templates", 2), auto = t.auto_key ? AUTO_EMAILS[t.auto_key] : null, rule = !t.auto_key && t.auto_rule ? { ...RULE_DEFAULT, ...t.auto_rule } : null;
  $("layer").innerHTML = `<div class="scrim" data-close="1"></div>
  <div class="drawer mail wide" role="dialog" aria-modal="true" aria-labelledby="dh-title">
    <div class="dh"><div><h2 id="dh-title">${id ? esc(t.name) : rule ? "New automatic email" : "New template"}</h2><p>${auto ? "Automatic email · " + esc(auto.when) : rule ? "Automatic email · " + esc(ruleText(rule)) : "Saved template for composing"}</p></div><button class="x" type="button" data-close="1" aria-label="Close">×</button></div>
    <form class="db" id="tf" autocomplete="off">
      ${rule ? `<section><h3>When it's sent and who gets it</h3><div class="fg rule">
        <div class="f"><label for="r-days">Days</label><input id="r-days" type="number" min="0" max="365" value="${esc(rule.days)}"></div>
        ${sel("r-event", "After or before", rule.event, RULE_EVENTS)}
        ${sel("r-aud", "Send to", rule.audience, RULE_AUDIENCE)}
        ${sel("r-prog", "Program", rule.program, [["", "Both CNA programs"]].concat(PROGRAMS))}
      </div><div class="checks" style="margin-top:10px">${chk("r-missing", "Only students still missing requirements (283B, Live Scan, TB test, physical, onboarding letter, valid ID)", rule.missing_only)}</div>
      <p class="small-note" id="r-sum"></p>
      <p class="small-note">Checked every 15 minutes; each student gets this email at most once. Start-date and end-date emails go out on that exact day. Sign-up and payment emails only go to students who sign up or pay after you switch this email on. Withdrawn and dropped students are skipped. New automatic emails start <b>off</b>: switch them on in the list when ready.</p></section>` : ""}
      <section><div class="fg">
      ${field("t-name", "Template name", t.name, "text", "w")}${field("t-subject", "Subject", t.subject, "text", "w")}</div>
      <div class="f w" style="margin-top:10px"><label>Message</label>${editorHtml("t-ed", t.body_html, t.attachments)}</div>
      <p class="small-note">Use <b>Insert field</b> to add details that are filled in for each student, such as {first_name} or {start_date}. Paste images straight into the message, or use Image. Attachments are stored with the template.</p></section>
      <section><h3>Preview <small>with a sample student</small></h3><div class="tpl-preview" id="t-prev"></div></section>
    </form>
    <div class="df">${edit ? `<button class="primary" type="button" id="t-save">Save template</button>` : ""}<button class="ghost" type="button" data-close="1">${edit ? "Cancel" : "Close"}</button>
      ${edit && id && !t.auto_key ? `<button class="danger" type="button" id="t-del">Delete template</button>` : ""}<span class="err" id="save-err" hidden></span></div>
  </div>`;
  const ed = wireEditor("t-ed", t.attachments || []);
  const readRule = () => ({ event: $("r-event").value, days: Math.max(0, Math.min(365, Math.round(num($("r-days").value)))), audience: $("r-aud").value, program: $("r-prog").value, missing_only: $("r-missing").checked });
  if (rule) { const sum = () => { $("r-sum").innerHTML = "<b>Sends:</b> " + esc(ruleText(readRule())); }; sum(); ["r-days", "r-event", "r-aud", "r-prog", "r-missing"].forEach(i => { $(i).addEventListener("input", sum); $(i).addEventListener("change", sum); }); }
  if (!edit) $("tf").querySelectorAll("input,textarea,select,button,[contenteditable]").forEach(x => { x.disabled = true; if (x.isContentEditable) x.contentEditable = "false"; });
  const sample = S.students.find(s => s.email && s.cohort_id) || S.students[0] || null;
  const preview = () => { $("t-prev").innerHTML = `<p class="tpl-subj"><b>${esc(fillEmail($("t-subject").value, sample))}</b></p>${clean(fillEmail(ed.html(), sample, true))}`; };
  preview(); $("tf").addEventListener("input", preview); $("t-ed").addEventListener("keyup", preview);
  $("tf").addEventListener("submit", e => e.preventDefault());
  if ($("t-save")) $("t-save").onclick = async () => {
    const row = { name: $("t-name").value.trim(), subject: $("t-subject").value.trim(), body_html: ed.html(), attachments: ed.atts() };
    if (rule) row.auto_rule = readRule();
    const er = $("save-err"); if (!row.name) { er.hidden = false; er.textContent = "Give the template a name."; shake($("t-save")); return; }
    if (rule && !row.subject) { er.hidden = false; er.textContent = "Automatic emails need a subject."; shake($("t-save")); return; }
    $("t-save").disabled = true;
    const q = id ? sb.from("email_templates").update(row).eq("id", id).select().single() : sb.from("email_templates").insert(row).select().single();
    const { data, error } = await q;
    if (error) { $("t-save").disabled = false; er.hidden = false; er.textContent = errText(error); return; }
    S.templates = S.templates || []; upsertLocal(S.templates, data); closeDrawer(); renderTemplates(); toast(`Saved "${data.name}"`);
  };
  if ($("t-del")) $("t-del").onclick = () => {
    $("t-del").outerHTML = `<span class="confirm" id="confirm">Delete "${esc(t.name)}"? <button type="button" id="del-yes">Delete</button><button type="button" class="no" id="del-no">Keep</button></span>`;
    $("del-no").onclick = () => openTemplate(id);
    $("del-yes").onclick = async () => { const { error } = await sb.from("email_templates").delete().eq("id", id); if (error) { const er = $("save-err"); er.hidden = false; er.textContent = errText(error); return; }
      removeLocal(S.templates, id); closeDrawer(); renderTemplates(); toast(`Deleted "${t.name}"`); };
  };
}

/* ---------------- Export Student File: the students ticked on any list ---------------- */
const yn = b => b ? "Yes" : "No";
const STUDENT_COLS = [
  ["Student", [["Student ID", s => s.student_code], ["Last name", s => s.last_name], ["First name", s => s.first_name], ["Email", s => s.email], ["Phone", s => s.phone], ["Address", s => s.address],
    ["Date of birth", s => s.date_of_birth], ["Gender", s => s.gender], ["Emergency contact", s => s.emergency_name], ["Emergency phone", s => s.emergency_phone], ["English assessment", s => s.english_score]]],
  ["Enrollment", [["Program", s => lab(PROGRAMS, s.program)], ["Pay plan", s => PLAN_NAMES[s.pay_plan] || s.pay_plan], ["Start date", s => startOf(s)], ["End date", s => endOf(s)], ["Schedule", s => s.schedule],
    ["Clinical site", s => (siteOf(s) || {}).short_name], ["Waitlist", s => yn(s.waitlist)], ["Withdrawn", s => yn(s.withdrawn)], ["Dropped", s => yn(s.dropped)], ["Orientation", s => yn(s.orientation)], ["OASYS", s => s.oasys_status]]],
  ["Payments", STAGES.map(([k, l]) => [l + " paid", s => paidFor(s, k)]).concat([["Total paid", s => moneyOf(s).paid], ["Balance", s => moneyOf(s).balance], ["Standing", s => { const a = assess(s); return a.text + (a.why ? " (" + a.why + ")" : ""); }]])],
  ["Requirements", REQS.map(([k, l]) => [l, s => yn(s[k])]).concat([["Minor waiver", s => yn(s.waiver_minor)]])],
  ["Attendance and exams", [...ATT, ...EXAMS].map(([k, l]) => [l, s => yn(s[k])]).concat([["Course evaluation", s => yn(s.evaluation)]])],
  ["Follow-up emails", FOLLOWUPS.map(([k, l]) => [l + " sent", s => s[k] ? String(s[k]).slice(0, 10) : ""])],
  ["Notes", [["Notes", s => s.notes], ["Notes by", s => s.notes_by]]]
];
const EXPORT_DEFAULT = ["Student", "Enrollment", "Payments"];
function exportCols() {
  const x = S.exportSet; if (!x) return [];
  if (x.kind === "students") return STUDENT_COLS.flatMap(([g, cols]) => cols.map(([l, f]) => ({ g, l, f })));
  const cfg = OTHER[x.cfgKey], rows = (OT.rows[cfg.table] || []).filter(r => x.keys.includes("r" + r.id));
  const known = cfg.card.flatMap(([g, f]) => f.map(([k, l]) => ({ g, l: l, k })));
  const extra = [...new Set(rows.flatMap(r => Object.keys(r.data)))].filter(k => !known.some(c => c.k === k)).map(k => ({ g: "Other answers", l: k.length > 60 ? k.slice(0, 57) + "..." : k, k }));
  return known.concat(extra).map(c => ({ g: c.g, l: c.l, f: r => r.data[c.k] }));
}
function exportRows() {
  const x = S.exportSet; if (!x) return [];
  if (x.kind === "students") return x.keys.map(k => S.students.find(s => s.id === k)).filter(Boolean);
  const cfg = OTHER[x.cfgKey]; return x.keys.map(k => (OT.rows[cfg.table] || []).find(r => "r" + r.id === k)).filter(Boolean);
}
function renderExport() {
  const w = $("wrap"), x = S.exportSet;
  if (!x || !x.keys.length) {
    w.innerHTML = `<div class="empty"><h3>Tick the students to export</h3><p>Go to any student list (CNA, Leads, RNA, HHA, BLS or CEU), tick the students you want, then click <b>Export CSV</b> in the bar at the bottom. They'll appear here, where you choose the columns and download the file.</p></div>`;
    return;
  }
  const rows = exportRows(), cols = exportCols(), groups = [...new Set(cols.map(c => c.g))];
  let pickedG; try { pickedG = JSON.parse(localStorage.getItem("calace.exportGroups." + x.kind) || "null"); } catch (e) {}
  if (!pickedG) pickedG = x.kind === "students" ? EXPORT_DEFAULT : groups;
  const names = rows.map(r => x.kind === "students" ? r.last_name + ", " + r.first_name : recName(OTHER[x.cfgKey], r));
  w.innerHTML = `<div class="ov expp">
    <section class="ov-sec"><h2>${rows.length} ${rows.length === 1 ? "student" : "students"} from ${esc(x.label)}</h2>
      <p class="exp-names">${esc(names.slice(0, 40).join(" · "))}${names.length > 40 ? ` <span class="small-note">and ${names.length - 40} more</span>` : ""}</p>
      <button class="lnk" type="button" id="exp-clear">Clear this selection</button></section>
    <section class="ov-sec"><h2>Columns</h2><div class="exp-groups">
      ${groups.map(g => { const gc = cols.filter(c => c.g === g); return `<details class="exp-g"><summary><label><input type="checkbox" data-expg="${esc(g)}"${pickedG.includes(g) ? " checked" : ""}> <b>${esc(g)}</b></label> <small>${gc.length} columns</small></summary>
        <div class="exp-cols">${gc.map(c => `<label><input type="checkbox" data-expc="${esc(g + "|" + c.l)}"${pickedG.includes(g) ? " checked" : ""}> ${esc(c.l)}</label>`).join("")}</div></details>`; }).join("")}
    </div></section>
    <section class="ov-sec exp-go">${field("exp-name", "File name", (x.label.replace(/[^\w-]+/g, "-") + "-" + ISO_TODAY).replace(/-+/g, "-"), "text")}
      <button class="primary" type="button" id="exp-dl">Download CSV</button><span class="small-note">Opens in Excel or Google Sheets.</span></section>
  </div>`;
  w.querySelectorAll("[data-expg]").forEach(cb => cb.onchange = () => { w.querySelectorAll(`[data-expc^="${CSS.escape(cb.dataset.expg)}|"]`).forEach(c => c.checked = cb.checked); });
  w.querySelectorAll("[data-expc]").forEach(cb => cb.onchange = () => { const g = cb.dataset.expc.split("|")[0], all = [...w.querySelectorAll(`[data-expc^="${CSS.escape(g)}|"]`)];
    const gb = w.querySelector(`[data-expg="${CSS.escape(g)}"]`); gb.checked = all.every(c => c.checked); gb.indeterminate = !gb.checked && all.some(c => c.checked); });
  $("exp-clear").onclick = () => { S.exportSet = null; render(); };
  $("exp-dl").onclick = () => {
    const chosen = cols.filter(c => { const b = w.querySelector(`[data-expc="${CSS.escape(c.g + "|" + c.l)}"]`); return b && b.checked; });
    if (!chosen.length) { toast("Tick at least one column."); return; }
    try { localStorage.setItem("calace.exportGroups." + x.kind, JSON.stringify(groups.filter(g => { const b = w.querySelector(`[data-expg="${CSS.escape(g)}"]`); return b && (b.checked || b.indeterminate); }))); } catch (e) {}
    downloadCsv(chosen.map(c => c.l), rows.map(r => chosen.map(c => c.f(r))), ($("exp-name").value.trim() || "students") + ".csv");
    toast(`Exported ${rows.length} ${rows.length === 1 ? "student" : "students"} with ${chosen.length} columns`);
  };
}
function downloadCsv(cols, rows, name) {
  const q = v => { v = String(v == null ? "" : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csv = [cols].concat(rows).map(r => r.map(q).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name.endsWith(".csv") ? name : name + ".csv"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// Packet and Welcome Letter buttons in the student profile, with when each was last sent.
async function refreshProfileMail(s) {
  const box = $("pe-box"); if (!box) return;
  const draw = sent => {
    if (!$("pe-box") || draftId !== s.id) return;
    $("pe-box").innerHTML = PROFILE_EMAILS.map(([k, l]) => { const t = tplByKey(k), blank = !t || !String(t.body_html || "").replace(/<[^>]+>/g, "").trim(), last = sent[k];
      return `<button type="button" class="pe-btn" data-pe="${k}">${icon("mail")}<span><b>${esc(l)}</b><small>${blank ? "Not written yet" : last ? "Last sent " + esc(new Date(last).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })) : "Not sent yet"}</small></span></button>`; }).join("");
    $("pe-box").querySelectorAll("[data-pe]").forEach(b => b.onclick = () => profileEmail(s, b.dataset.pe));
  };
  draw({});
  const { data } = await sb.from("email_sends").select("kind, sent_at").eq("student_id", s.id).eq("status", "sent").in("kind", PROFILE_EMAILS.map(x => x[0])).order("sent_at", { ascending: false });
  const sent = {}; (data || []).forEach(r => { if (!sent[r.kind]) sent[r.kind] = r.sent_at; });
  draw(sent);
}
function profileEmail(s, key) {
  const t = tplByKey(key), label = lab(PROFILE_EMAILS, key);
  const blank = !t || !String(t.body_html || "").replace(/<[^>]+>/g, "").trim();
  if (blank) {
    toast(`The ${label} isn't written yet. Write it in Tools › Email Templates.`);
    if (t && can("templates", 2)) { closeDrawer(); S.page = "templates"; render(); openTemplate(t.id); }
    return;
  }
  if (!s.email) { toast(`${s.first_name} has no email address. Add one in the profile first.`); return; }
  const noLink = /\{onboarding_link\}/.test(t.body_html) && !(S.settings.onboarding_link && S.settings.onboarding_link.url);
  const c = cohortOf(s), site = siteOf(s);
  const gaps = [!c && "start date", !s.schedule && "weekday or weekend", !site && "clinical site"].filter(Boolean);
  const letter = key === "welcome_letter";
  openComposer({ title: label, sub: `To ${s.first_name} ${s.last_name}`, to: s.email, subject: fillEmail(t.subject, s), html: fillEmail(t.body_html, s, true),
    atts: t.attachments || [], student: s, templateId: t.id, kind: key, onSent: () => openDrawer(s.id), letter,
    refill: { subject: () => fillEmail(t.subject, s), html: () => fillEmail(t.body_html, s, true) },
    notice: [noLink ? "The onboarding link isn't set yet, so that part of the email is empty. An admin can add it in Tools › Email Templates." : "",
      gaps.length ? `This student has no ${gaps.join(", ")} yet, so the email says "To be assigned" or "To be confirmed" there.` : ""].filter(Boolean).join(" ") });
}
function renderLeads() {
  const w = $("wrap");
  if (!S.loaded) { w.innerHTML = `<div class="skel" aria-label="Loading leads"><i></i><i></i><i></i><i></i></div>`; return; }
  const list = leadsFiltered();
  if (!list.length) {
    w.innerHTML = leadList().length
      ? `<div class="empty"><h3>No leads match</h3><p>Try another view or program, or clear the search.</p><button class="ghost" type="button" id="clear-filters">Clear filters</button></div>`
      : `<div class="empty"><h3>No leads right now</h3><p>Every CNA student has a payment recorded. New sign-ups without a payment will show up here.</p></div>`;
    return;
  }
  if (PHONE.matches) { w.innerHTML = `<p class="mc-count">${list.length} ${list.length === 1 ? "lead" : "leads"}</p><div class="mlist">${list.map((s, i) => leadCard(s, i)).join("")}</div>`; return; }
  const keepX = w.scrollLeft, keepY = w.scrollTop;
  w.innerHTML = `<table class="grid lgrid"><thead>
    <tr class="g"><th class="sticky"></th><th></th><th class="gs">Payment</th><th colspan="${FOLLOWUPS.length}" class="gs">Follow-up emails</th><th class="gs"></th></tr>
    <tr class="c"><th class="sticky lbl who" scope="col">${pickAll()}Students <span class="cnt">${list.length}</span></th><th class="lbl" scope="col">Next step</th>
      <th class="rot pw gs" scope="col"><div><span>Reg</span></div></th>
      ${FOLLOWUPS.map(([, l], j) => `<th class="rot${j === 0 ? " gs" : ""}" scope="col"><div><span>${esc(l.replace("Follow-up", "Email"))}</span></div></th>`).join("")}
      <th class="lbl gs" scope="col">Notes</th></tr></thead>
    <tbody>${list.map((s, i) => leadRow(s, i)).join("")}</tbody></table>
    <div class="legend"><span><i class="tk done">${CHECK}</i>Email sent (date below)</span><span>Tick a box after you send that email. Email 1 is due a day after sign-up, Email 2 three days after Email 1, Email 3 a week after Email 2.</span><span>Record the registration payment and the student moves to Paid on their CNA page.</span></div>`;
  w.scrollLeft = keepX; w.scrollTop = keepY;
  applyCrosshair();
}

/* ---------------- Business Overview ----------------
   Money collected (by the date paid), who paid, and paid/unpaid students for each current or upcoming start date. */
function payDay(p) { return p.paid_on || String(p.created_at || "").slice(0, 10); }
function payRange(k) {
  const d = new Date(TODAY), y = new Date(TODAY); y.setDate(y.getDate() - 1);
  if (k === "today") return [ISO_TODAY, ISO_TODAY];
  if (k === "yesterday") return [iso(y), iso(y)];
  if (k === "week") return [WEEK_FROM, WEEK_TO];
  if (k === "month") return [ISO_TODAY.slice(0, 7) + "-01", ISO_TODAY.slice(0, 7) + "-31"];
  const lm = new Date(d.getFullYear(), d.getMonth() - 1, 1); const ym = iso(lm).slice(0, 7);
  return [ym + "-01", ym + "-31"];
}
function paymentsIn(k) { const [a, b] = payRange(k); return S.payments.filter(p => { const d = payDay(p); return d && d >= a && d <= b; }); }
function ovTile(k, label, sub) {
  const ps = paymentsIn(k), total = ps.reduce((t, p) => t + num(p.amount), 0);
  const by = METHODS.map(([m, l]) => [l, ps.filter(p => p.method === m).reduce((t, p) => t + num(p.amount), 0)]).filter(([, v]) => v);
  const none = ps.filter(p => !p.method).reduce((t, p) => t + num(p.amount), 0); if (none) by.push(["No method", none]);
  return `<div class="ov-tile"><div class="ov-k">${esc(label)}<small>${esc(sub)}</small></div><div class="ov-v num">${money(total)}</div>
    <div class="ov-n">${ps.length} ${ps.length === 1 ? "payment" : "payments"}</div>
    ${by.length ? `<ul class="ov-by">${by.map(([l, v]) => `<li><span>${esc(l)}</span><b class="num">${money(v)}</b></li>`).join("")}</ul>` : ""}</div>`;
}
function ovBarRow(label, list, max, paid) {
  const p = list.filter(s => paid.has(s.id)).length, u = list.length - p, w = n => max ? (n / max * 100) : 0;
  const tip = `${label}: ${p} paid, ${u} unpaid, ${list.length} total`;
  return `<div class="ovb" title="${esc(tip)}"><div class="ovb-l">${esc(label)}</div>
    <div class="ovb-track" role="img" aria-label="${esc(tip)}">${p ? `<i class="ovb-paid" style="width:${w(p)}%"></i>` : ""}${u ? `<i class="ovb-unpaid" style="width:${w(u)}%"></i>` : ""}${!list.length ? `<span class="ovb-empty">No students yet</span>` : ""}</div>
    <div class="ovb-v"><b class="num">${p}</b> paid · <b class="num">${u}</b> unpaid</div></div>`;
}
/* Cohort Enrollment: each start date's groups (clinical facility x Weekday/Weekend) with PAID students only,
   because paying is what secures a student's spot at a facility. Each group is shown against the seat limit. */
function seatCap() { const v = S.settings.seat_cap; const n = num(v && typeof v === "object" ? (v.value ?? v.seats) : v); return n > 0 ? n : 13; }
function cohortEnd(c, sched) { return (sched === "weekend" && c.weekend_end) || c.weekday_end || c.weekend_end || iso(new Date(new Date(c.start_date + "T00:00:00").getTime() + 42 * 864e5)); }
function siteLabel(x) { return x ? (x.name || x.short_name) + (x.city && !(x.name || "").includes(x.city) ? " - " + x.city : "") : "No facility yet"; }
function cohortEnrollment(active, paid) {
  const cap = seatCap(), payers = active.filter(s => paid.has(s.id) && s.cohort_id);
  const ends = c => [c.weekday_end, c.weekend_end].filter(Boolean).sort().pop() || cohortEnd(c, "weekday");
  const cohorts = S.cohorts.filter(c => !c.archived || active.some(s => s.cohort_id === c.id)).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.program.localeCompare(b.program));
  const siteById = id => S.sites.find(x => x.id === id) || null;
  const schedOf = (c, s) => c.program === "in_person" ? "in_person" : (s.schedule === "weekday" || s.schedule === "weekend") ? s.schedule : "none";
  const build = c => {
    const here = payers.filter(s => s.cohort_id === c.id), keys = new Map();
    const add = (siteId, sched) => { const k = siteId + "|" + sched; if (!keys.has(k)) keys.set(k, { siteId, sched }); };
    if (c.program === "in_person") S.sites.filter(x => x.kind === "in_person").forEach(x => add(x.id, "in_person"));
    else S.cohortSites.filter(cs => cs.cohort_id === c.id && cs.availability && cs.availability !== "off").forEach(cs => {
      if (cs.availability === "both" || cs.availability === "weekday") add(cs.site_id, "weekday");
      if (cs.availability === "both" || cs.availability === "weekend") add(cs.site_id, "weekend");
    });
    here.forEach(s => add(s.site_id || 0, schedOf(c, s)));
    const rows = [...keys.values()].map(g => {
      const site = siteById(g.siteId), n = here.filter(s => (s.site_id || 0) === g.siteId && schedOf(c, s) === g.sched).length;
      const kind = !site ? "none" : site.kind === "waitlist" ? "waitlist" : "group";
      return { ...g, site, n, kind };
    }).filter(r => r.kind === "group" || r.n > 0)
      .sort((a, b) => ({ group: 0, waitlist: 1, none: 2 }[a.kind] - { group: 0, waitlist: 1, none: 2 }[b.kind]) || a.sched.localeCompare(b.sched) || siteLabel(a.site).localeCompare(siteLabel(b.site)));
    const groups = rows.filter(r => r.kind === "group");
    return { c, rows, total: here.length, groups: groups.length, full: groups.filter(r => r.n >= cap).length,
      waitlist: rows.filter(r => r.kind === "waitlist").reduce((t, r) => t + r.n, 0), unplaced: rows.filter(r => r.kind === "none").reduce((t, r) => t + r.n, 0), past: ends(c) < ISO_TODAY };
  };
  const all = cohorts.map(build), past = all.filter(x => x.past), now = all.filter(x => !x.past);
  const nowIds = new Set(now.map(x => x.c.id)), inNow = active.filter(s => nowIds.has(s.cohort_id));
  const paidN = inNow.filter(s => paid.has(s.id)).length, unpaidN = inNow.length - paidN;
  const pref = r => r.sched === "weekday" ? "Weekday" : r.sched === "weekend" ? "Weekend" : r.sched === "in_person" ? "In-Person" : "Not chosen";
  const badge = r => r.kind !== "group" ? `<span class="ce-b muted">${r.n} ${r.n === 1 ? "student" : "students"}</span>`
    : `<span class="ce-b ${r.n > cap ? "over" : r.n >= cap ? "full" : ""}">${r.n} / ${cap}${r.n > cap ? " · over by " + (r.n - cap) : r.n === cap ? " · full" : ""}</span>`;
  const item = x => `<details class="ce" data-ce="${x.c.id}"${(S.ovOpen || new Set()).has(x.c.id) ? " open" : ""}>
      <summary><span class="ce-date">${esc(fmtDate(x.c.start_date))}${x.c.program === "in_person" ? " <small>In-Person</small>" : ""}</span>
        <span class="ce-chip ok">${x.total} ${x.total === 1 ? "student" : "students"}</span><span class="ce-chip amb">${x.groups} ${x.groups === 1 ? "group" : "groups"}</span>
        ${x.waitlist ? `<span class="ce-chip amb">${x.waitlist} waitlist</span>` : ""}${x.full ? `<span class="ce-chip red">${x.full} full</span>` : ""}${x.unplaced ? `<span class="ce-chip red">${x.unplaced} need a facility</span>` : ""}</summary>
      ${x.rows.length ? `<table class="ce-t"><thead><tr><th>Preference</th><th>Group</th><th>Enrolled</th></tr></thead><tbody>
        ${x.rows.map(r => `<tr><td>${pref(r)}</td><td>${esc(r.kind === "waitlist" ? "Waitlist (pending clinical site)" : siteLabel(r.site))}</td><td>${badge(r)}</td></tr>`).join("")}</tbody></table>`
        : `<p class="small-note ce-empty">No facilities are open for this start date yet.</p>`}
    </details>`;
  return `<div class="ce-head"><p><b class="num">${paidN}</b> paid students (${unpaidN} unpaid sign-ups not counted) · capacity ${cap} per group. Click a date to expand.</p></div>
    ${past.length ? `<button type="button" class="ce-arch" data-ovarch="1" aria-pressed="${!!S.ovArch}">Archived (${past.length})</button>` : ""}
    <div class="ce-list">${S.ovArch ? past.map(item).join("") : ""}${now.map(item).join("")}</div>`;
}
function renderOverview() {
  const w = $("wrap");
  if (!S.loaded) { w.innerHTML = `<div class="skel" aria-label="Loading"><i></i><i></i><i></i></div>`; return; }
  const range = S.ovRange || "today", paid = paidIds(), byFac = S.ovView === "site";
  // Who paid
  const recent = paymentsIn(range).slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || b.id - a.id);
  const rangeLabel = { today: "today", yesterday: "yesterday", week: "this week" }[range];
  const whoRows = recent.map(p => { const s = S.students.find(x => x.id === p.student_id);
    return `<tr><td>${s ? `<button class="doc__name" type="button" data-ovstu="${esc(s.id)}">${esc(s.first_name + " " + s.last_name)}</button>` : "Deleted student"}</td>
      <td>${esc(s ? lab(PROGRAMS, s.program) : "")}</td><td>${esc(lab(STAGES, p.stage))}</td><td class="num">${money(p.amount)}</td><td>${esc(methodName(p.method) || "—")}</td><td>${esc(fmtDate(payDay(p), false))}</td></tr>`; }).join("");
  // Students by start date: cohorts still running or upcoming, grouped by start month
  const active = S.students.filter(s => !s.withdrawn && !s.dropped);
  const ends = c => [c.weekday_end, c.weekend_end].filter(Boolean).sort().pop() || c.start_date;
  const cohorts = S.cohorts.filter(c => ends(c) >= ISO_TODAY && (!c.archived || active.some(s => s.cohort_id === c.id))).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.program.localeCompare(b.program));
  const rowsFor = c => {
    const st = active.filter(s => s.cohort_id === c.id);
    if (c.program === "in_person") return [["In-Person", st]];
    const r = [["Weekday", st.filter(s => s.schedule === "weekday")], ["Weekend", st.filter(s => s.schedule === "weekend")]];
    const other = st.filter(s => s.schedule !== "weekday" && s.schedule !== "weekend"); if (other.length) r.push(["No schedule", other]);
    return r;
  };
  const all = cohorts.map(c => ({ c, rows: rowsFor(c) }));
  const max = Math.max(1, ...all.flatMap(x => x.rows.map(([, l]) => l.length)));
  const months = [...new Set(all.map(x => x.c.start_date.slice(0, 7)))];
  const monthCards = months.map(ym => {
    const items = all.filter(x => x.c.start_date.startsWith(ym)), studs = items.flatMap(x => x.rows.flatMap(([, l]) => l));
    const p = studs.filter(s => paid.has(s.id)).length;
    return `<article class="ov-month"><header><h3>${esc(monthLabel(ym))}</h3><span><b class="num">${studs.length}</b> students · <b class="num">${p}</b> paid · <b class="num">${studs.length - p}</b> unpaid</span></header>
      ${items.map(({ c, rows }) => `<div class="ov-cohort"><h4>${esc(fmtDate(c.start_date))} start <small>${esc(c.program === "in_person" ? "CNA In-Person" : "CNA Hybrid")}</small></h4>${rows.map(([l, list]) => ovBarRow(l, list, max, paid)).join("")}</div>`).join("")}
    </article>`;
  }).join("");
  w.innerHTML = `<div class="ov">
    <section class="ov-sec"><h2>Money collected</h2>
      <div class="ov-tiles">${ovTile("today", "Today", fmtDate(ISO_TODAY, false))}${ovTile("week", "This week", fmtDate(WEEK_FROM, false) + " – " + fmtDate(WEEK_TO, false))}${ovTile("month", "This month", monthLabel(ISO_TODAY.slice(0, 7)))}${ovTile("last", "Last month", monthLabel(payRange("last")[0].slice(0, 7)))}</div>
      <p class="small-note">By the date each payment was made. Refunds recorded as negative amounts are subtracted.</p></section>
    <section class="ov-sec"><div class="ov-head"><h2>Who paid ${esc(rangeLabel)}</h2>
      <div class="tabs" role="group" aria-label="Period">${[["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"]].map(([k, l]) => `<button type="button" data-ovr="${k}" aria-pressed="${range === k}">${l}</button>`).join("")}</div></div>
      ${recent.length ? `<div class="ov-tablewrap"><table class="ledger-table ov-table"><thead><tr><th>Student</th><th>Program</th><th>Stage</th><th class="num">Amount</th><th>Method</th><th>Date</th></tr></thead><tbody>${whoRows}</tbody></table></div>`
        : `<p class="small-note">No payments recorded ${esc(rangeLabel)} yet.</p>`}</section>
    <section class="ov-sec"><div class="ov-head"><h2>${byFac ? "Cohort enrollment" : "Students by start date"}</h2>
      <div class="tabs" role="group" aria-label="Group students">${[["date", "By start date"], ["site", "Cohort enrollment"]].map(([k, l]) => `<button type="button" data-ovview="${k}" aria-pressed="${(byFac ? "site" : "date") === k}">${l}</button>`).join("")}</div>
      ${byFac ? "" : `<div class="ov-legend"><span><i class="ovb-paid"></i>Paid (any payment)</span><span><i class="ovb-unpaid"></i>Unpaid</span></div>`}</div>
      ${byFac ? cohortEnrollment(active, paid) : `<p class="small-note">In-progress and upcoming start dates. Withdrawn and dropped students aren't counted. Bars share one scale.</p>
        ${monthCards ? `<div class="ov-months">${monthCards}</div>` : `<p class="small-note">No current or upcoming start dates.</p>`}`}</section>
  </div>`;
  // Remember which start dates are expanded across live updates.
  w.querySelectorAll("details.ce").forEach(d => d.addEventListener("toggle", () => { S.ovOpen = S.ovOpen || new Set(); const id = +d.dataset.ce; if (d.open) S.ovOpen.add(id); else S.ovOpen.delete(id); }));
}

/* ---------------- Staff & permissions ---------------- */
let staffList = null, staffEditing = null;
async function loadStaff() {
  const { data, error } = await sb.from("staff").select("*").order("role").order("full_name");
  if (error) { toast(errText(error)); staffList = []; } else staffList = data;
  if (S.page === "staff") renderStaff();
}
function permsOf(m) { return m.role === "admin" ? Object.fromEntries(AREAS.map(([k]) => [k, 2]).concat([["delete", true], ["export", true]])) : { ...(ROLE_PRESETS[m.role] || {}), ...(m.permissions || {}) }; }
function accessSummary(m) {
  if (m.role === "admin") return "Everything";
  const p = permsOf(m), e = AREAS.filter(([k]) => num(p[k]) === 2).map(([, l]) => l), v = AREAS.filter(([k]) => num(p[k]) === 1).map(([, l]) => l);
  return [e.length ? "Edit: " + e.join(", ") : "", v.length ? "View: " + v.join(", ") : ""].filter(Boolean).join(" · ") || "No access";
}
function renderStaff() {
  const w = $("wrap");
  if (!staffList) { loadStaff(); w.innerHTML = `<div class="skel" aria-label="Loading staff"><i></i><i></i><i></i></div>`; return; }
  const edit = can("staff", 2);
  w.innerHTML = `<div class="ov staffp">
    ${edit ? `<section class="ov-sec"><h2>Add a staff member</h2>
      <form class="staff-add" id="staff-add" autocomplete="off">
        ${field("sa-email", "Email they sign in with", "", "email")}${field("sa-name", "Full name", "")}
        ${sel("sa-role", "Role", "office", ROLES.filter(([k]) => k !== "admin" || isAdmin()))}
        <button class="primary" type="submit" id="sa-go">Add</button><span class="err" id="sa-err" hidden></span>
      </form>
      <p class="small-note">They sign in at the tracker's address with this email; a one-time sign-in link is emailed to them. Their role sets their starting access, which you can change below.</p></section>` : ""}
    <section class="ov-sec"><h2>Staff <span class="cnt">${staffList.length}</span></h2>
      <div class="ov-tablewrap staff-wrap"><table class="ledger-table staff-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th>Status</th><th></th></tr></thead><tbody>
      ${staffList.map(m => `<tr class="${m.active ? "" : "off"}"><td><b>${esc(m.full_name || "—")}</b>${S.me && m.email === S.me.email ? ` <span class="flag wl">You</span>` : ""}</td><td>${esc(m.email)}</td>
        <td>${esc(lab(ROLES, m.role))}</td><td class="acc">${esc(accessSummary(m))}</td><td>${m.active ? "Active" : "Can't sign in"}</td>
        <td>${edit && (m.role !== "admin" || isAdmin()) ? `<button class="doc__name" type="button" data-staff="${esc(m.email)}">Change access</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="small-note">Google Drive setup and the Project1 import are for admins only. Export CSV only hides the button; anyone who can view a page can still copy what's on it.</p></section>
  </div>`;
  if ($("staff-add")) $("staff-add").addEventListener("submit", addStaff);
}
async function addStaff(e) {
  e.preventDefault();
  const email = $("sa-email").value.trim().toLowerCase(), name = $("sa-name").value.trim(), role = $("sa-role").value, err = $("sa-err");
  const fail = m => { err.hidden = false; err.textContent = m; shake($("sa-go")); };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter the email address they'll sign in with.");
  if (staffList.some(m => m.email === email)) return fail("That email is already on the staff list.");
  $("sa-go").disabled = true;
  const { error } = await sb.from("staff").insert({ email, full_name: name || null, role, active: true, permissions: role === "admin" ? {} : ROLE_PRESETS[role] });
  $("sa-go").disabled = false;
  if (error) return fail(errText(error));
  toast(`Added ${name || email} as ${lab(ROLES, role)}`); await loadStaff();
}
function openStaff(email) {
  const m = staffList.find(x => x.email === email); if (!m) return;
  staffEditing = email;
  const p = permsOf(m), self = S.me && S.me.email === m.email;
  const matrix = role => AREAS.map(([k, l, d]) => `<tr><th scope="row"><b>${esc(l)}</b><small>${esc(d)}</small></th>
    ${[0, 1, 2].map(v => `<td><label class="lvl"><input type="radio" name="p-${k}" value="${v}"${num(p[k]) === v ? " checked" : ""}${role === "admin" ? " disabled" : ""}><span>${["None", "View", "Edit"][v]}</span></label></td>`).join("")}</tr>`).join("");
  $("layer").innerHTML = `<div class="scrim" data-close="1"></div>
  <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="dh-title">
    <div class="dh"><div><h2 id="dh-title">${esc(m.full_name || m.email)}</h2><p>${esc(m.email)}</p></div><button class="x" type="button" data-close="1" aria-label="Close">×</button></div>
    <form class="db" id="stf" autocomplete="off">
      <section><div class="fg">${field("st-name", "Full name", m.full_name || "")}
        ${sel("st-role", "Role", m.role, ROLES.filter(([k]) => k !== "admin" || isAdmin()))}</div>
        <p class="small-note" id="st-rolenote">${m.role === "admin" ? "Admins can see and change everything, including this page." : "Changing the role resets the boxes below to that role's starting access."}</p></section>
      <section><h3>Access</h3><table class="perm-table"><thead><tr><th></th><th>None</th><th>View</th><th>Edit</th></tr></thead><tbody id="st-matrix">${matrix(m.role)}</tbody></table>
        <div class="checks" style="margin-top:12px">${chk("st-delete", "Can delete students and sign-ups", !!p.delete)}${chk("st-export", "Can export CSV", !!p.export)}</div></section>
      <section>${chk("st-active", "Can sign in (untick to turn off their access without removing them)", m.active)}${self ? `<p class="small-note">This is you. The tracker always keeps at least one active admin.</p>` : ""}</section>
    </form>
    <div class="df"><button class="primary" type="button" id="st-save">Save access</button><button class="ghost" type="button" data-close="1">Cancel</button>
      ${self ? "" : `<button class="danger" type="button" id="st-del">Remove from staff</button>`}<span class="err" id="save-err" hidden></span></div>
  </div>`;
  const syncAdmin = () => { const admin = $("st-role").value === "admin"; document.querySelectorAll("#st-matrix input, #st-delete, #st-export").forEach(i => i.disabled = admin); };
  $("st-role").addEventListener("change", e => {
    const r = e.target.value, pre = r === "admin" ? permsOf({ role: "admin" }) : ROLE_PRESETS[r];
    AREAS.forEach(([k]) => { const i = document.querySelector(`input[name="p-${k}"][value="${num(pre[k])}"]`); if (i) i.checked = true; });
    $("st-delete").checked = !!pre.delete; $("st-export").checked = !!pre.export;
    $("st-rolenote").textContent = r === "admin" ? "Admins can see and change everything, including this page." : "Changing the role resets the boxes below to that role's starting access.";
    syncAdmin();
  });
  syncAdmin();
  $("stf").addEventListener("submit", e => e.preventDefault());
  $("st-save").onclick = saveStaff;
  if ($("st-del")) $("st-del").onclick = () => {
    $("st-del").outerHTML = `<span class="confirm" id="confirm">Remove ${esc(m.full_name || m.email)}? They won't be able to sign in. <button type="button" id="del-yes">Remove</button><button type="button" class="no" id="del-no">Keep</button></span>`;
    $("del-no").onclick = () => openStaff(email);
    $("del-yes").onclick = async () => { const { error } = await sb.from("staff").delete().eq("email", email); if (error) { const er = $("save-err"); er.hidden = false; er.textContent = errText(error); return; } closeDrawer(); toast(`Removed ${m.full_name || m.email} from staff`); loadStaff(); };
  };
}
async function saveStaff() {
  const m = staffList.find(x => x.email === staffEditing); if (!m) return;
  const role = $("st-role").value, perms = {};
  AREAS.forEach(([k]) => { const i = document.querySelector(`input[name="p-${k}"]:checked`); perms[k] = i ? +i.value : 0; });
  perms.delete = $("st-delete").checked; perms.export = $("st-export").checked;
  const patch = { full_name: $("st-name").value.trim() || null, role, active: $("st-active").checked, permissions: role === "admin" ? {} : perms };
  $("st-save").disabled = true;
  const { error } = await sb.from("staff").update(patch).eq("email", m.email);
  if (error) { $("st-save").disabled = false; const er = $("save-err"); er.hidden = false; er.textContent = errText(error); return; }
  if (S.me && S.me.email === m.email) Object.assign(S.me, patch);
  closeDrawer(); toast(`Saved access for ${patch.full_name || m.email}`); await loadStaff(); render();
}

/* ---------------- Dashboard ----------------
   Standing ring and this week's payments up top, the next start dates as cards, recent payments as rows,
   and a right column with the newest students and the latest activity. Everything comes from data already loaded. */
const METHOD_TILE = { stripe: "#6E62E5", zelle: "#8A4FD8", cash: "#22B07D", terminal: "#E9A23B", check: "#E0533C" };
function smoothPath(pts) {
  if (!pts.length) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d;
}
function renderHome() {
  const w = $("wrap");
  if (!S.loaded) { w.innerHTML = `<div class="skel" aria-label="Loading"><i></i><i></i><i></i></div>`; return; }
  const paid = paidIds(), active = S.students.filter(s => !s.withdrawn && !s.dropped);
  // Standing ring: paid students who haven't finished
  const current = active.filter(s => paid.has(s.id) && !pastEnd(s)).map(assess);
  const good = current.filter(a => a.tone === "go" || a.tone === "ok").length, exam = current.filter(a => a.tone === "due").length, hold = current.filter(a => a.tone === "hold").length;
  const tot = Math.max(1, good + exam + hold), pct = Math.round(good / tot * 100), C = 2 * Math.PI * 52;
  const seg = (n, off, col) => `<circle cx="64" cy="64" r="52" fill="none" stroke="${col}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${Math.max(0, n / tot * C - 4)} ${C}" stroke-dashoffset="${-off / tot * C}" transform="rotate(-90 64 64)"/>`;
  const ring = `<svg viewBox="0 0 128 128" class="ring" role="img" aria-label="${pct}% of paid students in good standing">
    <circle cx="64" cy="64" r="52" fill="none" stroke="var(--line-soft)" stroke-width="14"/>
    ${seg(good, 0, "var(--accent)")}${seg(exam, good, "#EDB04A")}${seg(hold, good + exam, "var(--hold)")}</svg>`;
  // Payments this week vs last week, by day paid
  const days = [...Array(7)].map((_, i) => { const d = new Date(WEEK_START); d.setDate(d.getDate() + i); return iso(d); });
  const prevDays = days.map(x => { const d = new Date(x + "T00:00:00"); d.setDate(d.getDate() - 7); return iso(d); });
  const sumOn = day => S.payments.filter(p => payDay(p) === day).reduce((t, p) => t + num(p.amount), 0);
  const cur = days.map(sumOn), prev = prevDays.map(sumOn), mx = Math.max(100, ...cur, ...prev);
  const W = 560, H = 170, X = i => 24 + i * (W - 48) / 6, Y = v => 18 + (H - 46) * (1 - v / mx);
  const curPts = cur.map((v, i) => [X(i), Y(v)]).filter((_, i) => days[i] <= ISO_TODAY), prevPts = prev.map((v, i) => [X(i), Y(v)]);
  const peak = cur.reduce((b, v, i) => days[i] <= ISO_TODAY && v > cur[b] ? i : b, 0);
  const weekTotal = cur.reduce((a, b) => a + b, 0), lastTotal = prev.reduce((a, b) => a + b, 0);
  const change = lastTotal ? Math.round((weekTotal - lastTotal) / lastTotal * 100) : null;
  const chart = `<svg viewBox="0 0 ${W} ${H}" class="wk" role="img" aria-label="Payments this week ${money(weekTotal)}, last week ${money(lastTotal)}">
    ${[0, .5, 1].map(f => `<line x1="12" x2="${W - 12}" y1="${18 + (H - 46) * f}" y2="${18 + (H - 46) * f}" class="wk-grid"/>`).join("")}
    <path d="${smoothPath(prevPts)}" class="wk-prev"/><path d="${smoothPath(curPts)}" class="wk-cur"/>
    ${cur[peak] > 0 ? `<line x1="${X(peak)}" x2="${X(peak)}" y1="${Y(cur[peak])}" y2="${H - 26}" class="wk-peak"/><circle cx="${X(peak)}" cy="${Y(cur[peak])}" r="4.5" class="wk-dot"/>
      <g transform="translate(${Math.min(W - 70, Math.max(6, X(peak) - 32))},${Math.max(0, Y(cur[peak]) - 30)})"><rect width="64" height="20" rx="6" class="wk-tag"/><text x="32" y="14" text-anchor="middle">${esc(money(cur[peak]))}</text></g>` : ""}
    ${days.map((d, i) => `<text x="${X(i)}" y="${H - 6}" text-anchor="middle" class="wk-day${d === ISO_TODAY ? " today" : ""}">${new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" })}</text>
      <rect x="${X(i) - (W - 48) / 12}" y="0" width="${(W - 48) / 6}" height="${H - 20}" class="wk-hit"><title>${new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}: ${money(cur[i])} this week · ${money(prev[i])} the same day last week</title></rect>`).join("")}
  </svg>`;
  // Next start dates
  const ends = c => [c.weekday_end, c.weekend_end].filter(Boolean).sort().pop() || c.start_date;
  const cohorts = S.cohorts.filter(c => !c.archived && ends(c) >= ISO_TODAY).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const startCards = cohorts.slice(0, 3).map((c, i) => {
    const st = active.filter(s => s.cohort_id === c.id), p = st.filter(s => paid.has(s.id));
    const faces = p.slice(0, 3).map(s => avatar(s.first_name + " " + s.last_name, s.id)).join("");
    const started = c.start_date <= ISO_TODAY;
    return `<button type="button" class="sd${i === 0 ? " lead" : ""}" data-home="cohort" data-id="${c.id}" data-cprog="${c.program}">
      <span class="sd-ic">${icon("people")}</span>
      <span class="sd-t">${started ? "Started" : "Starts"} ${esc(fmtDate(c.start_date, false))}<small>${esc(lab(PROGRAMS, c.program))}${started ? " · in progress" : ""}</small></span>
      <span class="sd-faces">${faces}${p.length > 3 ? `<span class="av more">+${p.length - 3}</span>` : ""}${!p.length ? `<span class="sd-none">No paid students yet</span>` : ""}</span>
      <span class="sd-f">${icon("users", "sd-fi")}${p.length} paid · ${st.length - p.length} unpaid</span></button>`;
  }).join("");
  // Recent payments
  const recentPays = S.payments.filter(p => num(p.amount) > 0).slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || b.id - a.id).slice(0, 5);
  const payRows = recentPays.map(p => { const s = S.students.find(x => x.id === p.student_id);
    return `<div class="rp"><span class="rp-tile" style="--tile:${METHOD_TILE[p.method] || "#9AA7AD"}">${esc(methodCode(p.method) || "?")}</span>
      <span class="rp-name">${s ? esc(s.first_name + " " + s.last_name) : "Deleted student"}<small>${esc(lab(STAGES, p.stage))} · ${esc(methodName(p.method) || "No method")}</small></span>
      <span class="rp-amt num">${money(p.amount)}</span><span class="rp-date">${esc(payDay(p) ? fmtDate(payDay(p), false) : "—")}</span>
      ${s ? `<button type="button" class="rp-go" data-home="pay" data-id="${esc(s.id)}" aria-label="Open ${esc(s.first_name)}'s payments">${icon("arrow")}</button>` : "<span></span>"}</div>`; }).join("");
  // Right column: newest students and latest activity
  const newest = active.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, 5);
  const canMail = can("templates") || can("leads", 2);
  const people = newest.map(s => { const c = cohortOf(s);
    return `<div class="rs">${avatar(s.first_name + " " + s.last_name, s.id)}<button type="button" class="rs-name" data-home="open" data-id="${esc(s.id)}">${esc(s.first_name + " " + s.last_name)}<small>${esc(lab(PROGRAMS, s.program))}${c ? " · " + esc(fmtDate(c.start_date, false)) : ""}${paid.has(s.id) ? "" : " · unpaid"}</small></button>
      ${canMail && s.email ? `<button type="button" class="rs-mail" data-home="mail" data-id="${esc(s.id)}" aria-label="Email ${esc(s.first_name)}">${icon("mail")}</button>` : ""}</div>`; }).join("");
  const acts = S.log.slice(0, 5).map(e => `<div class="ra">${avatar(e.student_name || e.user_email, e.student_id || e.student_name)}<div class="ra-b"><b>${esc(e.student_name || "School-wide")}</b><span class="ra-t">${esc(fmtTime(e.at))}</span>
      <p>${describeLog(e)}</p></div></div>`).join("");
  w.innerHTML = `<div class="home">
    <div class="home-main">
      <div class="home-top">
        <section class="hc standing"><div class="ring-wrap">${ring}<span class="ring-pct num">${current.length ? pct + "%" : "—"}</span></div>
          <div><h2>Student standing</h2><p class="hc-sub">${current.length ? `${pct}% of ${current.length} paid students are in good standing` : "No paid students in class right now"}</p>
          <ul class="ring-key"><li><i style="background:var(--accent)"></i>Cleared or ready <b class="num">${good}</b></li><li><i style="background:#EDB04A"></i>Exam hold <b class="num">${exam}</b></li><li><i style="background:var(--hold)"></i>Hold for clinicals <b class="num">${hold}</b></li></ul></div></section>
        <section class="hc pays"><div class="hc-head"><h2>Payments this week</h2><button type="button" class="hc-go" data-home="overview" aria-label="Open Business Overview">${icon("arrow")}</button></div>
          <p class="hc-sub"><b class="num">${money(weekTotal)}</b> collected${change != null ? ` · <span class="${change >= 0 ? "up" : "down"}">${change >= 0 ? "+" : ""}${change}%</span> on last week` : ""}</p>
          ${chart}<div class="wk-key"><span><i class="cur"></i>This week</span><span><i class="prev"></i>Last week</span></div></section>
      </div>
      <section class="home-sec"><div class="home-h"><h2>Start dates <span class="badge">${cohorts.length}</span></h2>${pageAllowed("students") ? `<button type="button" class="view-all" data-home="cna">View all ${icon("arrow")}</button>` : ""}</div>
        <div class="sd-row">${startCards || `<p class="small-note">No upcoming start dates.</p>`}</div></section>
      <section class="home-sec"><div class="home-h"><h2>Recent payments <span class="badge">${S.payments.length}</span></h2>${pageAllowed("overview") ? `<button type="button" class="view-all" data-home="overview">View all ${icon("arrow")}</button>` : ""}</div>
        <div class="rp-list">${payRows || `<p class="small-note">No payments recorded yet.</p>`}</div></section>
    </div>
    <aside class="home-side">
      <div class="home-h"><div><h2>Recent students</h2><p class="hc-sub">You have <b>${active.length}</b> active students</p></div>${can("cna", 2) ? `<button type="button" class="round-add" data-home="add" aria-label="Add student">${icon("plus")}</button>` : ""}</div>
      <div class="rs-list">${people || `<p class="small-note">No students yet.</p>`}</div>
      ${pageAllowed("leads") ? `<button type="button" class="more-btn" data-home="leads">View leads</button>` : ""}
      <div class="home-h" style="margin-top:22px"><h2>Latest activity</h2></div>
      <div class="ra-list">${acts || `<p class="small-note">Nothing logged yet.</p>`}</div>
      ${pageAllowed("log") ? `<button type="button" class="more-btn" data-home="log">View all activity</button>` : ""}
    </aside>
  </div>`;
}
function homeAction(t) {
  const a = t.dataset.home, id = t.dataset.id;
  const go = (page, extra) => { closeDrawer(); Object.assign(S, extra || {}); S.page = page; try { localStorage.setItem("calace.program", page === "students" ? S.program : page); } catch (e) {} render(); routeAnim(); };
  if (a === "cohort") return go("students", { program: t.dataset.cprog, cohort: String(id), status: "paid", sched: "", loc: "", q: "" });
  if (a === "cna") return go("students");
  if (a === "overview") return go("overview");
  if (a === "leads") return go("leads");
  if (a === "log") return go("log");
  if (a === "pay") return openDrawer(id, "pay");
  if (a === "open") return openDrawer(id);
  if (a === "add") return openDrawer(null);
  if (a === "mail") { const s = S.students.find(x => x.id === id); if (s) composeTo([{ email: s.email, student: s }]); }
}

/* ---------------- Schedule ----------------
   A month calendar of classes, clinicals and events (public.schedule_events), with CNA start and end dates shown
   automatically. Click a day for its agenda; click an entry to change or remove it. Repeating entries are one row per day. */
const SCHED_KINDS = [["theory", "Theory class", "#22B07D"], ["clinical", "Clinical", "#2E86DE"], ["orientation", "Orientation", "#8E5BD8"], ["exam", "Exam / skills test", "#E9A23B"],
  ["ceu", "CEU class", "#5B6CE0"], ["bls", "BLS class", "#E0533C"], ["event", "Event / meeting", "#D6589B"], ["other", "Other", "#8A979C"]];
const SCHED_PROGRAMS = [["", "No program"], ["hybrid", "CNA Hybrid"], ["in_person", "CNA In-Person"], ["rna", "RNA"], ["hha", "HHA"], ["bls", "BLS"], ["ceu", "CEU"]];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
S.cal = { ym: ISO_TODAY.slice(0, 7), day: ISO_TODAY, site: "", inst: "", kind: "", starts: true };
const kindColor = k => (SCHED_KINDS.find(x => x[0] === k) || SCHED_KINDS[7])[2];
function t12(t) { if (!t) return ""; const [h, m] = t.split(":").map(Number); return ((h % 12) || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + (h < 12 ? " AM" : " PM"); }
function timeRange(e) { return e.start_time ? t12(e.start_time) + (e.end_time ? " – " + t12(e.end_time) : "") : "All day"; }
function calEvents(from, to) {   // saved entries plus CNA start/end markers, filtered
  const c = S.cal, list = (S.events || []).filter(e => e.day >= from && e.day <= to && (!c.site || String(e.site_id) === c.site) && (!c.inst || (e.instructor || "") === c.inst) && (!c.kind || e.kind === c.kind));
  if (c.starts && !c.site && !c.inst && (!c.kind || c.kind === "milestone")) S.cohorts.forEach(co => {
    const prog = lab(PROGRAMS, co.program);
    if (co.start_date >= from && co.start_date <= to) list.push({ id: "s" + co.id, virtual: true, kind: "milestone", day: co.start_date, title: prog + " starts", cohort_id: co.id });
    [["weekday_end", "weekday"], ["weekend_end", "weekend"]].forEach(([k, l]) => { if (co[k] && co[k] >= from && co[k] <= to) list.push({ id: "e" + co.id + k, virtual: true, kind: "milestone", day: co[k], title: `${prog} ${l} class ends`, cohort_id: co.id }); });
  });
  return list.sort((a, b) => a.day.localeCompare(b.day) || (a.virtual ? -1 : 0) - (b.virtual ? -1 : 0) || String(a.start_time || "").localeCompare(String(b.start_time || "")));
}
function evMeta(e) {
  const site = e.site_id ? S.sites.find(x => x.id === e.site_id) : null, co = e.cohort_id ? S.cohorts.find(x => x.id === e.cohort_id) : null;
  return [lab(SCHED_KINDS, e.kind) !== e.kind ? lab(SCHED_KINDS, e.kind) : "", site ? site.short_name : "", e.instructor || "", e.program ? lab(SCHED_PROGRAMS, e.program) : "", co ? "Starts " + fmtDate(co.start_date, false) : ""].filter(Boolean);
}
function renderSchedule() {
  const w = $("wrap"), c = S.cal, edit = can("schedule", 2);
  const [y, m] = c.ym.split("-").map(Number), first = new Date(y, m - 1, 1), start = new Date(first); start.setDate(1 - first.getDay());
  const cells = [...Array(42)].map((_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return iso(d); });
  const evs = calEvents(cells[0], cells[41]), byDay = d => evs.filter(e => e.day === d);
  const insts = [...new Set((S.events || []).map(e => e.instructor).filter(Boolean))].sort();
  const sites = S.sites.filter(x => x.kind !== "waitlist" && x.short_name !== "Mountain View");
  const dayList = byDay(c.day);
  const chip = e => `<button type="button" class="cal-chip${e.virtual ? " ms" : ""}" style="--k:${e.virtual ? "var(--accent-ink)" : kindColor(e.kind)}" data-ev="${e.id}" title="${esc(timeRange(e) + " · " + e.title + (evMeta(e).length ? " · " + evMeta(e).join(" · ") : ""))}">
    ${e.virtual ? "" : `<span class="t">${esc(e.start_time ? t12(e.start_time).replace(":00", "").replace(" ", "").toLowerCase() : "")}</span>`}${esc(e.title)}</button>`;
  w.innerHTML = `<div class="cal-page">
    <div class="cal-bar">
      <div class="cal-nav"><button type="button" class="cal-arrow" data-cal="prev" aria-label="Previous month">‹</button><button type="button" class="ghost" data-cal="today">Today</button><button type="button" class="cal-arrow" data-cal="next" aria-label="Next month">›</button>
        <h2>${esc(first.toLocaleDateString("en-US", { month: "long", year: "numeric" }))}</h2></div>
      <div class="cal-filters">
        <select class="sel" id="cal-site" aria-label="Facility"><option value="">All facilities</option>${sites.map(x => `<option value="${x.id}"${String(x.id) === c.site ? " selected" : ""}>${esc(x.short_name)}</option>`).join("")}</select>
        <select class="sel" id="cal-inst" aria-label="Instructor"><option value="">All instructors</option>${insts.map(i => `<option${i === c.inst ? " selected" : ""}>${esc(i)}</option>`).join("")}</select>
        <select class="sel" id="cal-kind" aria-label="Type"><option value="">All types</option>${SCHED_KINDS.map(([k, l]) => `<option value="${k}"${k === c.kind ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <label class="cal-tog"><input type="checkbox" id="cal-starts"${c.starts ? " checked" : ""}> Start and end dates</label>
        ${edit ? `<button type="button" class="primary" data-cal="add">+ Add to schedule</button>` : ""}
      </div>
    </div>
    <div class="cal-wrap">
      <div class="cal-grid" role="grid" aria-label="Calendar">
        ${WEEKDAYS.map(d => `<div class="cal-wd" role="columnheader">${d}</div>`).join("")}
        ${cells.map(d => { const list = byDay(d), out = d.slice(0, 7) !== c.ym;
          return `<div class="cal-cell${out ? " out" : ""}${d === ISO_TODAY ? " today" : ""}${d === c.day ? " sel" : ""}" role="gridcell" tabindex="0" data-calday="${d}" aria-label="${esc(new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }))}, ${list.length} ${list.length === 1 ? "entry" : "entries"}">
            <span class="cal-n">${+d.slice(8)}</span>
            <div class="cal-chips">${list.slice(0, 3).map(chip).join("")}${list.length > 3 ? `<span class="cal-more">+${list.length - 3} more</span>` : ""}</div>
            ${list.length ? `<span class="cal-dots" aria-hidden="true">${list.slice(0, 4).map(e => `<i style="background:${e.virtual ? "var(--accent-ink)" : kindColor(e.kind)}"></i>`).join("")}</span>` : ""}</div>`; }).join("")}
      </div>
      <aside class="cal-day">
        <div class="home-h"><div><h2>${esc(new Date(c.day + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }))}</h2>
          <p class="hc-sub">${dayList.length ? `${dayList.length} ${dayList.length === 1 ? "entry" : "entries"}` : "Nothing scheduled"}</p></div>
          ${edit ? `<button type="button" class="round-add" data-cal="addday" aria-label="Add to this day">${icon("plus")}</button>` : ""}</div>
        <div class="ag">${dayList.map(e => `<button type="button" class="ag-i${e.virtual ? " ms" : ""}" style="--k:${e.virtual ? "var(--accent-ink)" : kindColor(e.kind)}" data-ev="${e.id}">
          <span class="ag-time">${esc(e.virtual ? "All day" : timeRange(e))}</span><b>${esc(e.title)}</b>
          ${evMeta(e).length ? `<span class="ag-meta">${esc(evMeta(e).join(" · "))}</span>` : ""}${e.notes ? `<span class="ag-notes">${esc(e.notes)}</span>` : ""}</button>`).join("")
          || `<p class="small-note">${edit ? "Click + to add a class, clinical or event for this day." : "No classes or events this day."}</p>`}</div>
      </aside>
    </div>
    <div class="cal-key">${SCHED_KINDS.map(([, l, col]) => `<span><i style="background:${col}"></i>${esc(l)}</span>`).join("")}<span><i style="background:var(--accent-ink)"></i>CNA start or end date</span></div>
  </div>`;
  const setF = (k, v) => { S.cal[k] = v; renderSchedule(); };
  $("cal-site").onchange = e => setF("site", e.target.value); $("cal-inst").onchange = e => setF("inst", e.target.value);
  $("cal-kind").onchange = e => setF("kind", e.target.value); $("cal-starts").onchange = e => setF("starts", e.target.checked);
  w.querySelectorAll("[data-cal]").forEach(b => b.onclick = () => {
    const a = b.dataset.cal, d = new Date(y, m - 1, 1);
    if (a === "prev" || a === "next") { d.setMonth(d.getMonth() + (a === "prev" ? -1 : 1)); S.cal.ym = iso(d).slice(0, 7); S.cal.day = S.cal.ym === ISO_TODAY.slice(0, 7) ? ISO_TODAY : S.cal.ym + "-01"; renderSchedule(); }
    else if (a === "today") { S.cal.ym = ISO_TODAY.slice(0, 7); S.cal.day = ISO_TODAY; renderSchedule(); }
    else if (a === "add") openEvent(null, { day: S.cal.day });
    else if (a === "addday") openEvent(null, { day: S.cal.day });
  });
  w.querySelectorAll("[data-ev]").forEach(b => b.onclick = e => { e.stopPropagation(); const id = b.dataset.ev; const ev = evs.find(x => String(x.id) === id);
    if (ev && ev.virtual) { S.cal.day = ev.day; renderSchedule(); } else if (ev) openEvent(ev.id); });
  w.querySelectorAll("[data-calday]").forEach(cell => {
    const pick = () => { S.cal.day = cell.dataset.calday; if (S.cal.day.slice(0, 7) !== S.cal.ym) S.cal.ym = S.cal.day.slice(0, 7); renderSchedule(); };
    cell.onclick = pick; cell.ondblclick = () => { if (edit) openEvent(null, { day: cell.dataset.calday }); };
    cell.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  });
}
function openEvent(id, defaults) {
  const edit = can("schedule", 2), ev = id ? (S.events || []).find(x => x.id === id) : { title: "", kind: "theory", day: (defaults && defaults.day) || ISO_TODAY, start_time: "09:00", end_time: "15:00" };
  if (!ev) return;
  const series = ev.series_id ? (S.events || []).filter(x => x.series_id === ev.series_id) : [];
  const insts = [...new Set((S.events || []).map(e => e.instructor).filter(Boolean).concat(S.me && S.me.full_name ? [S.me.full_name] : []))].sort();
  const sites = S.sites.filter(x => x.kind !== "waitlist" && x.short_name !== "Mountain View");
  const cohorts = S.cohorts.filter(c => !c.archived || c.id === ev.cohort_id).sort((a, b) => b.start_date.localeCompare(a.start_date));
  const dow = new Date(ev.day + "T00:00:00").getDay();
  $("layer").innerHTML = `<div class="scrim" data-close="1"></div>
  <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="dh-title">
    <div class="dh"><div><h2 id="dh-title">${id ? esc(ev.title) : "Add to schedule"}</h2><p>${id ? esc(fmtDate(ev.day) + " · " + timeRange(ev)) + (series.length > 1 ? ` · repeats (${series.length} days)` : "") : "A class, clinical or event"}</p></div>
      <button class="x" type="button" data-close="1" aria-label="Close">×</button></div>
    <form class="db" id="evf" autocomplete="off"><section><div class="fg">
      ${field("ev-title", "Title", ev.title, "text", "w")}
      ${sel("ev-kind", "Type", ev.kind, SCHED_KINDS.map(([k, l]) => [k, l]))}
      ${field("ev-day", "Date", ev.day, "date")}
      ${field("ev-start", "Starts", (ev.start_time || "").slice(0, 5), "time")}${field("ev-end", "Ends", (ev.end_time || "").slice(0, 5), "time")}
      ${sel("ev-site", "Facility", ev.site_id || "", [["", "No facility"]].concat(sites.map(x => [x.id, x.short_name + (x.city ? ", " + x.city : "")])))}
      <div class="f"><label for="ev-inst">Instructor</label><input id="ev-inst" list="ev-insts" value="${esc(ev.instructor || "")}"><datalist id="ev-insts">${insts.map(i => `<option value="${esc(i)}">`).join("")}</datalist></div>
      ${sel("ev-prog", "Program", ev.program || "", SCHED_PROGRAMS)}
      ${sel("ev-co", "Start date (optional)", ev.cohort_id || "", [["", "None"]].concat(cohorts.map(co => [co.id, fmtDate(co.start_date) + " · " + lab(PROGRAMS, co.program)])))}
      <div class="f w"><label for="ev-notes">Notes</label><textarea id="ev-notes">${esc(ev.notes || "")}</textarea></div>
    </div>
    <p class="small-note">Leave both times empty for an all-day entry.</p></section>
    ${!id ? `<section><label class="chk"><input type="checkbox" id="ev-rep"> Repeats every week</label>
      <div id="ev-repbox" hidden><div class="ev-days" role="group" aria-label="Days">${WEEKDAYS.map((d, i) => `<label class="ev-dow"><input type="checkbox" value="${i}"${i === dow ? " checked" : ""}><span>${d}</span></label>`).join("")}</div>
      ${field("ev-until", "Until", iso(new Date(new Date(ev.day + "T00:00:00").getTime() + 41 * 864e5)), "date")}
      <p class="small-note" id="ev-repn"></p></div></section>`
      : series.length > 1 ? `<section><label class="chk"><input type="checkbox" id="ev-all"> Apply changes to all ${series.length} days in this series (each keeps its own date)</label></section>` : ""}
    </form>
    <div class="df">${edit ? `<button class="primary" type="button" id="ev-save">${id ? "Save changes" : "Add to schedule"}</button>` : ""}<button class="ghost" type="button" data-close="1">${edit ? "Cancel" : "Close"}</button>
      ${edit && id ? `<button class="danger" type="button" id="ev-del">Remove</button>` : ""}<span class="err" id="save-err" hidden></span></div>
  </div>`;
  if (!edit) $("evf").querySelectorAll("input,select,textarea").forEach(x => x.disabled = true);
  $("evf").addEventListener("submit", e => e.preventDefault());
  const repDays = () => { if (!$("ev-rep") || !$("ev-rep").checked) return [$("ev-day").value];
    const want = [...document.querySelectorAll("#ev-repbox .ev-dow input:checked")].map(i => +i.value), out = [], until = $("ev-until").value;
    for (let d = new Date($("ev-day").value + "T00:00:00"); iso(d) <= until && out.length < 200; d.setDate(d.getDate() + 1)) if (want.includes(d.getDay())) out.push(iso(d));
    return out; };
  const repNote = () => { if ($("ev-repn")) { const n = repDays().length; $("ev-repn").textContent = `${n} ${n === 1 ? "day" : "days"} will be added${n >= 200 ? " (the most at once)" : ""}.`; } };
  if ($("ev-rep")) { $("ev-rep").onchange = () => { $("ev-repbox").hidden = !$("ev-rep").checked; repNote(); }; $("ev-repbox").addEventListener("change", repNote); $("ev-day").addEventListener("change", repNote); }
  if ($("ev-save")) $("ev-save").onclick = async () => {
    const err = $("save-err"), fail = msg => { err.hidden = false; err.textContent = msg; shake($("ev-save")); };
    const row = { title: $("ev-title").value.trim(), kind: $("ev-kind").value, start_time: $("ev-start").value || null, end_time: $("ev-end").value || null,
      site_id: $("ev-site").value ? +$("ev-site").value : null, instructor: $("ev-inst").value.trim() || null, program: $("ev-prog").value || null,
      cohort_id: $("ev-co").value ? +$("ev-co").value : null, notes: $("ev-notes").value.trim() || null };
    if (!row.title) return fail("Give it a title, like \"Theory: Module 3\" or \"Clinical at Canyon Springs\".");
    if (!$("ev-day").value) return fail("Choose a date.");
    if (row.start_time && row.end_time && row.end_time <= row.start_time) return fail("The end time is before the start time.");
    $("ev-save").disabled = true;
    try {
      if (id) {
        const all = $("ev-all") && $("ev-all").checked;
        const q = all ? sb.from("schedule_events").update(row).eq("series_id", ev.series_id).select() : sb.from("schedule_events").update({ ...row, day: $("ev-day").value }).eq("id", id).select();
        const { data, error } = await q; if (error) throw error;
        data.forEach(r => upsertLocal(S.events, r)); closeDrawer(); renderSchedule(); toast(all ? `Updated ${data.length} days of "${row.title}"` : `Saved "${row.title}"`);
      } else {
        const days = repDays(); if (!days.length) return (($("ev-save").disabled = false), fail("None of the chosen weekdays fall between the date and Until."));
        const sid = days.length > 1 ? crypto.randomUUID() : null;
        const { data, error } = await sb.from("schedule_events").insert(days.map(d => ({ ...row, day: d, series_id: sid }))).select(); if (error) throw error;
        S.events = S.events || []; data.forEach(r => upsertLocal(S.events, r)); S.cal.day = days[0]; S.cal.ym = days[0].slice(0, 7);
        closeDrawer(); render(); toast(days.length > 1 ? `Added "${row.title}" on ${days.length} days` : `Added "${row.title}" on ${fmtDate(days[0])}`);
      }
    } catch (e) { $("ev-save").disabled = false; fail(errText(e)); }
  };
  if ($("ev-del")) $("ev-del").onclick = () => {
    $("ev-del").outerHTML = `<span class="confirm" id="confirm">Remove ${series.length > 1 ? "" : `"${esc(ev.title)}"`}? <button type="button" id="del-one">${series.length > 1 ? "This day" : "Remove"}</button>${series.length > 1 ? `<button type="button" id="del-all">All ${series.length} days</button>` : ""}<button type="button" class="no" id="del-no">Keep</button></span>`;
    $("del-no").onclick = () => openEvent(id);
    const gone = async all => {
      const { error } = all ? await sb.from("schedule_events").delete().eq("series_id", ev.series_id) : await sb.from("schedule_events").delete().eq("id", id);
      if (error) { const er = $("save-err"); er.hidden = false; er.textContent = errText(error); return; }
      S.events = (S.events || []).filter(x => all ? x.series_id !== ev.series_id : x.id !== id); closeDrawer(); render(); toast(all ? `Removed all ${series.length} days of "${ev.title}"` : `Removed "${ev.title}" on ${fmtDate(ev.day)}`);
    };
    $("del-one").onclick = () => gone(false); if ($("del-all")) $("del-all").onclick = () => gone(true);
  };
  setTimeout(() => $("ev-title").focus(), 50);
}

function renderMain() { if (S.page === "schedule") renderSchedule(); else if (S.page === "home") renderHome(); else if (S.page === "templates") renderTemplates(); else if (S.page === "export") renderExport(); else if (S.page === "staff") renderStaff(); else if (S.page === "overview") renderOverview(); else if (S.page === "leads") renderLeads(); else if (S.page === "log") renderLog(); else if (S.page === "drive") renderDrive(); else if (S.page === "other") renderOther(); else renderGrid(); updateSelBar(); }
function render() {
  if (S.me && !pageAllowed(S.page)) {   // a page this person can't open: go to the first one they can
    const first = ["home", "students", "schedule", "leads", "other", "overview", "log", "staff", "templates", "export"].find(pageAllowed);
    if (first) S.page = first; else { $("wrap").innerHTML = `<div class="empty"><h3>No pages to show yet</h3><p>Your account doesn't have access to any part of the tracker. Ask an admin to set your permissions.</p></div>`; renderRail(); return; }
  }
  const ctx = S.page + ":" + (S.page === "students" ? S.program : S.page === "other" ? S.other : "");
  if (ctx !== S.selCtx) { S.sel.clear(); S.selCtx = ctx; }   // ticks belong to one list
  if (S.page === "students" || S.page === "other") S.stuLast = S.page;
  renderRail(); renderHeader(); updateFiltBtn(); renderMain();
}

/* ---------------- Writes ---------------- */
let toastTimer = null;
function toast(msg, undo) {
  const L = $("toast-layer"); clearTimeout(toastTimer);
  L.innerHTML = `<div class="toast"><span></span>${undo ? '<button type="button" id="undo">Undo</button>' : ""}</div>`;
  L.querySelector("span").textContent = msg;
  if (undo) $("undo").onclick = () => { L.innerHTML = ""; undo(); };
  toastTimer = setTimeout(() => { L.innerHTML = ""; }, 6000);
}
async function updateStudent(id, patch) {
  S.localTouch[id] = Date.now();
  const s = S.students.find(x => x.id === id); const before = { ...s };
  Object.assign(s, patch); render();
  const { data, error } = await sb.from("students").update(patch).eq("id", id).select().single();
  if (error) { Object.assign(s, before); render(); throw error; }
  upsertLocal(S.students, data); return data;
}
async function addPayments(rows) {
  rows.forEach(r => S.localTouch[r.student_id] = Date.now());
  const { data, error } = await sb.from("payments").insert(rows).select();
  if (error) throw error;
  data.forEach(r => upsertLocal(S.payments, r)); render(); refreshLedger(); return data;
}
async function removePayments(ids) {
  const rows = S.payments.filter(p => ids.includes(p.id));
  rows.forEach(r => S.localTouch[r.student_id] = Date.now());
  const { error } = await sb.from("payments").delete().in("id", ids);
  if (error) throw error;
  ids.forEach(id => removeLocal(S.payments, id)); render(); refreshLedger(); return rows;
}
function strip(r) { const { id, created_at, created_by, ...rest } = r; return rest; }

/* ---------------- Payment popover ---------------- */
let popCtx = null;
function closePop() { $("pop-layer").innerHTML = ""; popCtx = null; }
function openPayPop(btn, s, k) {
  closePop();
  const due = num(plan(s)[k]), paid = paidFor(s, k), name = lab(STAGES, k), full = paid >= due, lp = lastPay(s, k);
  popCtx = { id: s.id, k };
  const status = full ? `Paid ${money(paid)}${lp && lp.method ? " by " + methodName(lp.method) : ""}${lp && lp.paid_on ? " on " + fmtDate(lp.paid_on) : ""}`
    : paid > 0 ? `${money(paid)} of ${money(due)} paid. Record the rest below.` : `${money(due)} due. Choose how it was paid.`;
  $("pop-layer").innerHTML = `<div class="pop" role="dialog" aria-label="${esc(name)} payment">
    <h4>${esc(name)}, ${esc(s.first_name)} ${esc(s.last_name)}</h4>
    <p>${esc(status)}</p>
    ${full ? "" : `<div class="meths" role="group" aria-label="Payment method">${METHODS.map(([m, l, c]) => `<button type="button" data-pm="${m}">${c}<small>${l}</small></button>`).join("")}</div>
    <div class="prow"><label for="pop-amt">Amount</label><input id="pop-amt" type="number" min="1" step="1" value="${Math.max(0, due - paid)}">
      <label for="pop-date">Date</label><input id="pop-date" type="date" value="${ISO_TODAY}"></div>`}
    <div class="pfoot">${full ? `<button type="button" class="lnk red" id="pop-unpaid">Mark unpaid</button>` : "<span></span>"}<button type="button" class="lnk" id="pop-details">All payments</button></div>
  </div>`;
  const pop = $("pop-layer").firstElementChild, r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.min(Math.max(16, r.left + r.width / 2 - w / 2), window.innerWidth - w - 16);
  let top = r.bottom + 8; if (top + h > window.innerHeight - 16) top = Math.max(16, r.top - h - 8);
  pop.style.left = left + "px"; pop.style.top = top + "px";
  (pop.querySelector("[data-pm]") || pop.querySelector("button")).focus();
}
async function popAction(t) {
  const s = S.students.find(x => x.id === popCtx.id), k = popCtx.k; if (!s) { closePop(); return; }
  const name = lab(STAGES, k), who = s.first_name + " " + s.last_name;
  if (t.dataset.pm) {
    const amt = num($("pop-amt").value), date = $("pop-date").value || ISO_TODAY;
    if (amt <= 0) { shake($("pop-amt")); $("pop-amt").focus(); return; }
    closePop();
    try {
      const rows = await addPayments([{ student_id: s.id, stage: k, amount: amt, method: t.dataset.pm, paid_on: date, source: "manual" }]);
      maybePromo(s, k, amt);
      toast(`${name} recorded for ${who}: ${money(amt)}, ${methodCode(t.dataset.pm)}-${shortDate(date)}`, () => removePayments(rows.map(r => r.id)).then(() => toast("Payment removed. Both changes are in the log.")).catch(e => toast(errText(e))));
    } catch (e) { toast(errText(e)); }
    return;
  }
  if (t.id === "pop-unpaid") {
    closePop();
    const ids = S.payments.filter(p => p.student_id === s.id && p.stage === k).map(p => p.id);
    try {
      const gone = await removePayments(ids);
      toast(`${name} marked unpaid for ${who}`, () => addPayments(gone.map(strip)).then(() => toast("Payment restored. Both changes are in the log.")).catch(e => toast(errText(e))));
    } catch (e) { toast(errText(e)); }
    return;
  }
  if (t.id === "pop-details") { const id = s.id; closePop(); openDrawer(id, "pay"); }
}
function maybePromo(s, stage, amt) {
  // Blueprint rule: a Hybrid student whose $50 registration is recorded moves to the Promo $50 plan.
  if (s.program === "hybrid" && s.pay_plan === "standard" && stage === "registration" && amt === 50) {
    updateStudent(s.id, { pay_plan: "promo_50" }).then(() => toast(`${s.first_name}'s pay plan changed to Promo $50 because the registration was $50.`)).catch(() => {});
  }
}

/* ---------------- Student card ---------------- */
let draftId = null, drawerTab = "profile";
function field(id, label, val, type = "text", cls = "") { return `<div class="f ${cls}"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(val)}"></div>`; }
function sel(id, label, val, options, cls = "") { return `<div class="f ${cls}"><label for="${id}">${label}</label><select id="${id}">${options.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${String(v) === String(val ?? "") ? " selected" : ""}>${esc(l)}</option>`; }).join("")}</select></div>`; }
function chk(id, label, on) { return `<label class="chk"><input type="checkbox" id="${id}"${on ? " checked" : ""}>${esc(label)}</label>`; }
function cohortOptions(program, current) {
  return S.cohorts.filter(c => c.program === program && (!c.archived || c.id === current))
    .map(c => [c.id, fmtDate(c.start_date) + (c.open ? "" : " (closed)")]);
}
function siteOptions(program, cohortId, schedule, current) {
  let list;
  if (program === "in_person") list = S.sites.filter(x => x.kind === "in_person");
  else list = S.sites.filter(x => x.kind !== "in_person" && S.cohortSites.some(cs => cs.site_id === x.id && String(cs.cohort_id) === String(cohortId) && cs.availability !== "off" && (!schedule || cs.availability === "both" || cs.availability === schedule)));
  const cur = S.sites.find(x => String(x.id) === String(current));
  if (cur && !list.includes(cur)) list = list.concat(cur);
  return [["", list.length ? "Choose a site" : "No site open for this start date and schedule"]].concat(list.map(x => [x.id, x.short_name + (x.city ? ", " + x.city : "")]));
}
function blankStudent() {
  return { program: S.program, pay_plan: S.program === "in_person" ? "in_person" : "promo_50", first_name: "", last_name: "", schedule: "weekday" };
}
function openDrawer(id, focus) {
  const s = id ? S.students.find(x => x.id === id) : blankStudent();
  if (!s) return;
  draftId = id || null; drawerTab = focus === "history" ? "history" : "profile";
  const isNew = !id, a = id ? assess(s) : null, c = id ? cohortOf(s) : null;
  $("layer").innerHTML = `<div class="scrim" data-close="1"></div>
  <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="dh-title">
    <div class="dh"><div><h2 id="dh-title">${isNew ? "New student" : esc(s.first_name + " " + s.last_name)}</h2>
      <p>${isNew ? "Fill in what you have now. Everything can be changed later." : `${esc(s.student_code || "No Student ID")} · ${esc(lab(PROGRAMS, s.program))}${c ? ", starts " + fmtDate(c.start_date) : ""} · <span class="pill ${a.tone}">${a.text}</span>`}</p></div>
      <button class="x" type="button" data-close="1" aria-label="Close">×</button></div>
    ${isNew ? "" : `<div class="dtabs" role="tablist"><button type="button" role="tab" data-dtab="profile" aria-selected="${drawerTab === "profile"}">Profile</button><button type="button" role="tab" data-dtab="history" id="hist-tab" aria-selected="${drawerTab === "history"}">History</button></div>`}
    <form class="db" id="sf" autocomplete="off"${drawerTab === "history" ? " hidden" : ""}>
      <section><h3>Student</h3><div class="fg">
        ${field("f-first", "First name", s.first_name)}${field("f-last", "Last name", s.last_name)}
        ${field("f-email", "Email (portal login)", s.email, "email", "w")}
        ${field("f-phone", "Phone", s.phone, "tel")}${field("f-dob", "Date of birth", s.date_of_birth, "date")}
        ${field("f-address", "Address", s.address, "text", "w")}
        ${sel("f-gender", "Gender", s.gender || "", ["", "Female", "Male", "Non-binary", "Prefer not to say"])}
        ${field("f-code", "Student ID", s.student_code || "")}
        ${field("f-emname", "Emergency contact", s.emergency_name)}${field("f-emphone", "Emergency phone", s.emergency_phone, "tel")}
        ${field("f-english", "English assessment (e.g. 15/15)", s.english_score || "")}
        ${sel("f-oasys", "OASYS", s.oasys_status || "", OASYS.map(o => [o, o || "Not set"]))}
      </div></section>

      <section><h3>Enrollment</h3><div class="fg">
        ${sel("f-program", "Program", s.program, PROGRAMS)}
        ${sel("f-plan", "Pay plan", s.pay_plan, Object.entries(PLAN_NAMES))}
        ${sel("c-cohort", "Start date", s.cohort_id || "", [["", "Choose a start date"]].concat(cohortOptions(s.program, s.cohort_id)))}
        ${sel("c-sched", "Schedule", s.schedule || "weekday", [["weekday", "Weekday"], ["weekend", "Weekend"]])}
        ${sel("f-site", "Clinical site", s.site_id || "", siteOptions(s.program, s.cohort_id, s.schedule, s.site_id), "w")}
      </div>
      <div class="checks" style="margin-top:10px">${chk("f-orientation", "Attended orientation", s.orientation)}${chk("f-waitlist", "On the waitlist", s.waitlist)}${chk("f-withdrawn", "Withdrawn (locks portal)", s.withdrawn)}${chk("f-dropped", "Dropped (locks portal)", s.dropped)}</div></section>

      ${isNew ? "" : `<section id="sec-pay"><h3>Payments <small>Saved as soon as you add or remove one</small></h3><div id="ledger-box"></div></section>`}

      ${isNew || !(can("templates") || can("leads", 2)) ? "" : `<section id="sec-mail"><h3>Emails <small>Opens the email filled in for this student so you can check it, then send</small></h3><div class="pe-row" id="pe-box"></div></section>`}

      ${isNew ? "" : `<section id="sec-docs"><h3>Documents <small>PDF or photo, up to 10 MB. Uploading ticks the requirement.</small></h3><div id="docs-box"></div></section>`}

      <section><h3>Requirements <small>Needed before clinicals, except skills</small></h3>
        <div class="checks">${REQS.map(([k, l]) => chk("r-" + k, l, s[k])).join("")}${chk("r-waiver_minor", "Minor waiver", s.waiver_minor)}</div></section>

      <section><h3>Attendance and exams</h3>
        <div class="checks">${[...ATT, ...EXAMS].map(([k, l]) => chk("r-" + k, l, s[k])).join("")}${chk("r-evaluation", "Course evaluation", s.evaluation)}</div></section>

      <section id="sec-notes"><h3>Notes ${s.notes_by ? `<small>Last written by ${esc(s.notes_by)}</small>` : ""}</h3>
        <div class="f"><label for="f-notes">Pickups, discounts, schedule requests, anything staff should know</label><textarea id="f-notes">${esc(s.notes || "")}</textarea></div></section>
    </form>
    <div class="db" id="hist"${drawerTab === "history" ? "" : " hidden"}></div>
    <div class="df" id="df"${drawerTab === "history" ? " hidden" : ""}>
      <button class="primary" type="button" id="save">${isNew ? "Add student" : "Save changes"}</button><button class="ghost" type="button" data-close="1">Cancel</button>
      ${isNew ? "" : `<button class="danger" type="button" id="del">Delete student</button>`}
      <span class="err" id="save-err" hidden></span>
    </div>
  </div>`;
  const refreshSites = () => {
    const prog = $("f-program").value, cur = $("f-site").value;
    $("f-site").outerHTML = `<select id="f-site">${siteOptions(prog, $("c-cohort").value, $("c-sched").value, cur).map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  };
  $("f-program").addEventListener("change", e => {
    const prog = e.target.value;
    $("c-cohort").innerHTML = [["", "Choose a start date"]].concat(cohortOptions(prog, null)).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
    if (prog === "in_person") { $("f-plan").value = "in_person"; $("c-sched").value = "weekday"; }
    else if ($("f-plan").value === "in_person") $("f-plan").value = "promo_50";
    $("f-site").value = ""; refreshSites();
  });
  $("c-cohort").addEventListener("change", refreshSites);
  $("c-sched").addEventListener("change", refreshSites);
  $("sf").addEventListener("submit", e => e.preventDefault());
  $("save").onclick = saveDraft;
  if ($("del")) $("del").onclick = askDelete;
  refreshLedger(); refreshDocs(); renderHistory(); if (id) refreshProfileMail(s);
  if (drawerTab === "history") { setTimeout(() => $("hist-tab").focus(), 50); return; }
  const target = focus === "pay" ? $("sec-pay") : focus === "notes" ? $("sec-notes") : null;
  if (target) { target.scrollIntoView({ block: "start" }); setTimeout(() => (focus === "notes" ? $("f-notes") : target.querySelector("select,input") || target).focus(), 50); }
  else setTimeout(() => $("f-first").focus(), 50);
}
function setDrawerTab(t) {
  drawerTab = t;
  document.querySelectorAll("[data-dtab]").forEach(b => b.setAttribute("aria-selected", b.dataset.dtab === t));
  $("sf").hidden = t !== "profile"; $("df").hidden = t !== "profile"; $("hist").hidden = t !== "history";
  renderHistory();
}
function refreshLedger() {
  const box = $("ledger-box"); if (!box || !draftId) return;
  const s = S.students.find(x => x.id === draftId); if (!s) return;
  const pl = plan(s), rows = S.payments.filter(p => p.student_id === s.id), m = moneyOf(s);
  const stagesInPlan = STAGES.filter(([k]) => num(pl[k]) > 0);
  const keep = box.querySelector("#ap-stage") ? { stage: $("ap-stage").value, amt: $("ap-amt").value, method: $("ap-method").value, date: $("ap-date").value, note: $("ap-note").value } : null;
  box.innerHTML = `<p class="plan-line"><span>Plan: <b>${esc(PLAN_NAMES[s.pay_plan] || s.pay_plan)}</b></span>${stagesInPlan.map(([k, l]) => `<span>${l} <b>${money(paidFor(s, k))}</b> of ${money(pl[k])}</span>`).join("")}<span>Balance <b>${m.balance > 0 ? money(m.balance) : "Paid in full"}</b></span></p>
   ${rows.length ? `<table class="ledger-table"><thead><tr><th>Stage</th><th class="num">Amount</th><th>Method</th><th>Date</th><th>Note</th><th></th></tr></thead><tbody>${rows.map(p => `<tr><td>${esc(lab(STAGES, p.stage))}</td><td class="num">${money(p.amount)}</td><td>${esc(methodName(p.method) || "—")}</td><td>${esc(p.paid_on ? fmtDate(p.paid_on) : "—")}</td><td>${esc(p.note || "")}</td><td><button class="rm" type="button" data-rmpay="${p.id}" aria-label="Remove this payment">Remove</button></td></tr>`).join("")}</tbody></table>` : `<p class="small-note">No payments recorded yet.</p>`}
   <div class="addpay">
     ${sel("ap-stage", "Stage", (keep && keep.stage) || (stagesInPlan.find(([k]) => paidFor(s, k) < num(pl[k])) || stagesInPlan[0] || ["registration"])[0], stagesInPlan.map(([k, l]) => [k, l]))}
     ${field("ap-amt", "Amount", keep ? keep.amt : "", "number")}
     ${sel("ap-method", "Method", keep ? keep.method : "stripe", METHODS.map(([v, l, c]) => [v, c + ", " + l]))}
     ${field("ap-date", "Date paid", keep ? keep.date : ISO_TODAY, "date")}
     ${field("ap-note", "Note or receipt number (optional)", keep ? keep.note : "", "text", "w")}
     <div class="actions"><button class="ghost" type="button" id="ap-add">Record payment</button><span class="err" id="ap-err" hidden></span></div>
   </div>`;
  if (!keep) { const st = $("ap-stage").value; $("ap-amt").value = Math.max(0, num(pl[st]) - paidFor(s, st)) || ""; }
  $("ap-stage").onchange = () => { const st = $("ap-stage").value; $("ap-amt").value = Math.max(0, num(pl[st]) - paidFor(s, st)) || ""; };
  $("ap-add").onclick = async () => {
    const amt = num($("ap-amt").value), err = $("ap-err");
    if (amt === 0) { err.hidden = false; err.textContent = "Enter the amount received. Use a negative amount for a refund."; shake($("ap-amt")); return; }
    $("ap-add").disabled = true;
    try {
      await addPayments([{ student_id: s.id, stage: $("ap-stage").value, amount: amt, method: $("ap-method").value, paid_on: $("ap-date").value || null, note: $("ap-note").value.trim() || null, source: "manual" }]);
      maybePromo(s, $("ap-stage").value, amt);
      $("ap-note").value = ""; toast(`Recorded ${money(amt)} for ${s.first_name} ${s.last_name}`);
    } catch (e) { err.hidden = false; err.textContent = errText(e); }
    finally { const b = $("ap-add"); if (b) b.disabled = false; }
  };
  box.querySelectorAll("[data-rmpay]").forEach(b => b.onclick = async () => {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Click again to remove"; return; }
    try { const gone = await removePayments([+b.dataset.rmpay]); toast("Payment removed", () => addPayments(gone.map(strip)).catch(e => toast(errText(e)))); }
    catch (e) { toast(errText(e)); }
  });
}
/* ---------------- Documents (stored in Google Drive through the "drive" Edge Function) ---------------- */
function fileSize(n) { n = num(n); return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
function currentDoc(studentId, kind) { const r = S.files.filter(f => f.student_id === studentId && f.kind === kind && (f.drive_file_id || f.url)); return r[r.length - 1] || null; }
async function mailCall(path, body) {   // the mail function: Gmail sending
  const { data } = await sb.auth.getSession();
  const res = await fetch(CFG.supabaseUrl + "/functions/v1/mail/" + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + (data.session && data.session.access_token), apikey: CFG.supabaseKey }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(j.error || "The email helper didn't answer (" + res.status + ").");
  return j;
}
async function driveCall(path, init = {}) {
  const { data } = await sb.auth.getSession();
  const token = data.session && data.session.access_token;
  const res = await fetch(DRIVE_FN + path, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + token, apikey: CFG.supabaseKey } });
  if (!res.ok) {
    let msg = "The Drive helper didn't answer (" + res.status + ").";
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  return res;
}
async function loadDriveStatus() {
  try { S.drive = await (await driveCall("status")).json(); }
  catch (e) { S.drive = { configured: false, connected: false, error: e.message }; }
  refreshDocs(); if (S.page === "drive") renderDrive(); if (S.page === "templates" && !$("layer").innerHTML) renderTemplates();
}
function driveReady() { return S.drive && S.drive.connected && S.settings.drive_access && S.settings.drive_access.granted_at; }
function refreshDocs() {
  const box = $("docs-box"); if (!box || !draftId) return;
  const s = S.students.find(x => x.id === draftId); if (!s) return;
  const ready = driveReady();
  const note = !S.drive ? `<p class="small-note">Checking the Google Drive connection…</p>`
    : ready ? "" : `<p class="small-note warn-note">Uploads are paused until Google Drive is set up. ${S.me.role === "admin" ? `Finish the steps on the <button type="button" class="linkish-ink" data-page="drive">Google Drive page</button>.` : "Ask an admin to finish the Google Drive page."}</p>`;
  const folders = S.settings.drive_folders || {};
  box.innerHTML = note + DOCS.map(([kind, label]) => {
    const f = currentDoc(s.id, kind);
    const busy = docBusy[s.id + "|" + kind];
    const hasFolder = !!(folders[kind] && folders[kind].id), ok = ready && hasFolder;
    const empty = hasFolder || !ready ? "No file yet"
      : S.me.role === "admin" ? `No Drive folder chosen yet. <button type="button" class="linkish-ink" data-page="drive">Choose one</button>` : "No Drive folder chosen yet. Ask an admin.";
    return `<div class="doc" data-doc="${kind}">
      <div class="doc__main"><b>${esc(label)}</b>
        ${busy ? `<span class="doc__meta">${esc(busy)}</span>` : f
          ? `<span class="doc__meta"><button type="button" class="doc__name" data-docview="${f.id}" title="Open in a new tab">${esc(f.file_name || "File")}</button> ${f.size_bytes ? fileSize(f.size_bytes) + ", " : ""}uploaded ${esc(fmtDate(String(f.uploaded_at).slice(0, 10)))} by ${esc(f.uploaded_by)}</span>`
          : `<span class="doc__meta">${empty}</span>`}
      </div>
      <div class="doc__acts">
        <input type="file" id="doc-in-${kind}" accept=".pdf,image/*" hidden>
        ${busy ? "" : f
          ? `<button type="button" class="ghost doc__btn" data-docpick="${kind}"${ok ? "" : " disabled"}>Replace</button><button type="button" class="rm" data-docrm="${f.id}"${ready ? "" : " disabled"}>Remove</button>`
          : `<button type="button" class="ghost doc__btn" data-docpick="${kind}"${ok ? "" : " disabled"}>Upload</button>`}
      </div>
    </div>`;
  }).join("") + `<span class="err" id="doc-err" hidden></span>`;
  DOCS.forEach(([kind]) => { const inp = $("doc-in-" + kind); if (inp) inp.onchange = () => { const file = inp.files[0]; inp.value = ""; if (file) uploadDoc(s, kind, file); }; });
  box.querySelectorAll("[data-docpick]").forEach(b => b.onclick = () => $("doc-in-" + b.dataset.docpick).click());
  box.querySelectorAll("[data-docview]").forEach(b => b.onclick = () => viewDoc(+b.dataset.docview));
  box.querySelectorAll("[data-docrm]").forEach(b => b.onclick = async () => {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Click again to remove"; return; }
    await removeDoc(+b.dataset.docrm);
  });
}
const docBusy = {};
function docError(msg) { const e = $("doc-err"); if (e) { e.hidden = false; e.textContent = msg; } toast(msg); }
function driveName(s, file) {
  const c = cohortOf(s);
  const start = c ? new Date(c.start_date + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "No start date";
  const ext = (file.name.match(/\.[A-Za-z0-9]{1,5}$/) || [""])[0].toLowerCase();
  return `${s.first_name} ${s.last_name} - ${start}${ext}`;
}
async function uploadDoc(s, kind, file) {
  const label = lab(DOCS, kind);
  if (file.size > DOC_MAX_BYTES) { docError(`${file.name} is ${fileSize(file.size)}. Files can be up to 10 MB. Try a smaller scan or photo.`); return; }
  if (file.type && !DOC_TYPES.includes(file.type)) { docError(`${file.name} isn't a PDF or photo. Upload a PDF, JPG, PNG or HEIC file.`); return; }
  const had = currentDoc(s.id, kind);
  docBusy[s.id + "|" + kind] = `Saving to Google Drive as "${driveName(s, file)}"…`; refreshDocs();
  try {
    const fd = new FormData(); fd.append("student_id", s.id); fd.append("kind", kind); fd.append("file", file);
    const out = await (await driveCall("upload", { method: "POST", body: fd })).json();
    S.files = S.files.filter(f => !(f.student_id === s.id && f.kind === kind));
    upsertLocal(S.files, out.file);
    // Mirror the database's auto-tick so the grid and card update without waiting for the live feed.
    const req = DOC_REQ[kind], ticked = req && !s[req];
    if (ticked) { S.localTouch[s.id] = Date.now(); s[req] = true; const cb = $("r-" + req); if (cb) cb.checked = true; render(); }
    toast(`${label} ${had ? "replaced" : "saved to Google Drive"} for ${s.first_name} ${s.last_name}${ticked ? `. ${lab(REQS, req)} is now ticked.` : "."}`);
  } catch (e) { docError(`Couldn't upload the ${label}: ${e.message}`); }
  finally { delete docBusy[s.id + "|" + kind]; refreshDocs(); }
}
async function viewDoc(id) {
  const f = S.files.find(x => x.id === id); if (!f) return;
  // Files carried over from Project1 are plain Drive links the tracker can't read itself: open them in Drive.
  if (!f.drive_file_id && f.url) { const w = window.open(f.url, "_blank", "noopener"); if (!w) location.assign(f.url); return; }
  const win = window.open("", "_blank");   // opened inside the click so pop-up blockers allow it
  if (win) win.document.write("<p style='font:14px system-ui;padding:24px'>Opening " + esc(f.file_name || "file") + " from Google Drive…</p>");
  try {
    const blob = await (await driveCall("file?id=" + id)).blob();
    const url = URL.createObjectURL(blob);
    if (win) { win.opener = null; win.location = url; } else location.assign(url);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { if (win) win.close(); docError("Couldn't open the file: " + e.message); }
}
async function removeDoc(id) {
  const f = S.files.find(x => x.id === id); if (!f) return;
  try {
    await driveCall("remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    removeLocal(S.files, id);
    toast(`${lab(DOCS, f.kind)} removed. It's in Google Drive's trash for 30 days.`);
  } catch (e) { docError("Couldn't remove the file: " + e.message); }
  refreshDocs();
}

/* ---------------- Google Drive page (admins) ---------------- */
function loadScript(src) {
  return new Promise((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const el = document.createElement("script"); el.src = src; el.async = true; el.onload = ok; el.onerror = () => fail(new Error("Couldn't load " + src)); document.head.appendChild(el);
  });
}
function renderDrive() {
  const w = $("wrap"), g = CFG.google || {}, d = S.drive, folders = S.settings.drive_folders || {}, access = S.settings.drive_access;
  const cfgReady = g.clientId && g.apiKey && g.appId;
  const step = (n, done, title, body) => `<li class="dstep${done ? " done" : ""}"><span class="dstep__n">${done ? CHECK : n}</span><div><h3>${title}</h3>${body}</div></li>`;
  const canPick = d && d.connected && cfgReady;
  const folderRows = DOCS.map(([k, l]) => { const f = folders[k]; return `<li><b>${esc(l)}</b> → ${f ? `<a href="https://drive.google.com/drive/folders/${esc(f.id)}" target="_blank" rel="noopener">${esc(f.name)}</a> <button class="linkish-ink" type="button" data-pickfor="${k}"${canPick ? "" : " disabled"}>Change</button>` : `<span class="warn-inline">no folder yet</span> <button class="ghost doc__btn" type="button" data-pickfor="${k}"${canPick ? "" : " disabled"}>Choose folder</button>`}</li>`; }).join("");
  const allFolders = DOCS.every(([k]) => folders[k] && folders[k].id);
  if (S.me.role !== "admin") { w.innerHTML = `<div class="log"><div class="log-empty"><h3>Admins only</h3><p>Ask an admin to set up Google Drive.</p></div></div>`; return; }
  w.innerHTML = `<div class="log drive-page">
    <p class="small-note">Uploads are saved into your Drive folders and named "{Student full name} - {Start date}", for example "Ava Testa - December 7, 2026.pdf". The tracker can only see files it uploads and the folders you pick below.</p>
    <ol class="dsteps">
      ${step(1, !!(d && d.configured) && cfgReady, "Set up the Google Cloud project",
        d && d.configured && cfgReady ? `<p>Done.</p>` : `<p>${!cfgReady ? "The tracker is still missing the Google client ID, API key or project number. " : ""}${d && !d.configured ? "Supabase is still missing the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets." : ""}</p>`)}
      ${step(2, !!(d && d.connected), "Connect the account that owns the document folders",
        d && d.connected ? `<p>Connected as <b>${esc(d.account_email || "your Google account")}</b> on ${esc(fmtDate(String(d.connected_at).slice(0, 10)))}. <button class="linkish-ink" type="button" id="drive-connect">Reconnect or change the folder account</button></p>`
          : `<p>Sign in with the Google account that owns the document folders, for example <b>staff@calace.training</b>, and allow access.</p><button class="primary" type="button" id="drive-connect"${d && d.configured ? "" : " disabled"}>Connect Google Drive</button>`)}
      ${step(3, !!(access && access.granted_at) && allFolders, "Choose a folder for each document",
        `<ul class="dfolders">${folderRows}</ul>` + (access && access.granted_at ? `<p>Folder access last given by ${esc(access.by)} on ${esc(fmtDate(String(access.granted_at).slice(0, 10)))}. ${allFolders ? "" : "Choose a folder for each document marked “no folder yet”. Create it in Drive first if it doesn't exist."}</p>`
          : `<p>Google opens your Drive. Select the Live Scan, Physical Exam, Signed 283b and TB Test folders, then click <b>Select</b>.</p><button class="primary" type="button" id="drive-pick"${canPick ? "" : " disabled"}>Choose the four folders</button>`))}
      ${step(4, !!(d && d.can_send), "Connect the account emails are sent from",
        d && d.send_separate ? `<p>Emails, including automatic ones, are sent from <b>${esc(d.send_account || "the sending account")}</b> and appear in its Sent folder. Connected ${esc(fmtDate(String(d.send_connected_at).slice(0, 10)))}${d.send_connected_by ? " by " + esc(d.send_connected_by) : ""}.</p>
             <button class="ghost" type="button" id="drive-send">Change sending account</button> <button class="linkish-ink" type="button" id="drive-send-off">Disconnect it</button>`
        : `<p>${d && d.can_send ? `Emails are sent from the folder account <b>${esc(d.send_account)}</b> for now. ` : ""}Sign in with the Gmail account emails should come from, for example <b>calace@cna.school</b>. It can be different from the folder account. Google asks you to allow <b>Send email on your behalf</b>; if it says the app isn't verified, click <b>Advanced</b>, then <b>Go to … (unsafe)</b>.</p>
             <button class="primary" type="button" id="drive-send"${d && d.configured ? "" : " disabled"}>Connect sending account</button>`)}
    </ol>
    ${importSection(canPick)}
    <span class="err" id="drive-err" hidden></span>
  </div>`;
  const ps = $("imp-pick"); if (ps) ps.onclick = pickSheet;
  const run = $("imp-run"); if (run) run.onclick = runImport;
  const rl = $("imp-reload"); if (rl) rl.onclick = () => location.reload();
  const c = $("drive-connect"); if (c) c.onclick = () => connectDrive("drive");
  const ds = $("drive-send"); if (ds) ds.onclick = () => connectDrive("mail");   // a separate Google sign-in just for sending
  const dso = $("drive-send-off"); if (dso) dso.onclick = async () => {
    try { await driveCall("disconnect-mail", { method: "POST" }); toast("Sending account disconnected."); loadDriveStatus(); } catch (e) { driveError(e.message); }
  };
  const p = $("drive-pick"); if (p) p.onclick = () => pickFolders();
  w.querySelectorAll("[data-pickfor]").forEach(b => b.onclick = () => pickFolders(b.dataset.pickfor));
}
function driveError(msg) { const e = $("drive-err"); if (e) { e.hidden = false; e.textContent = msg; } toast(msg); }

/* ---------------- Import from Project1 (admins) ---------------- */
let importState = null;   // null | "running" | result object
function importSummary(r) {
  const n = v => Number(v || 0).toLocaleString("en-US");
  const rows = [
    ["Students", `${n(r.students)} of ${n(r.sheet_student_rows)} rows with a name (${n(r.hybrid)} Hybrid, ${n(r.in_person)} In-Person; ${n(r.active)} not withdrawn or dropped)`],
    ["Payments", `${n(r.payments)} payments, ${money(r.payments_total)} in tuition. ${n(r.payments_no_method)} have no method and ${n(r.payments_no_date)} no date in their Project1 note.`],
    ["Activity Log", `${n(r.activity_log)} of ${n(r.sheet_activity_rows)} entries`],
    ["Documents", `${n(r.files)} Drive links kept`],
    ["Emails sent", `${n(r.email_sends)} send dates`],
    ["Cohorts", `${n(r.cohorts)} (${n(r.cohorts_from_students_only)} only appear on students, added as closed or archived)`],
    ["Clinical sites", `${n(r.sites)}${(r.sites_from_students_only || []).length ? `; added from students and kept inactive: ${r.sites_from_students_only.join(", ")}` : ""}`],
    ["Check these", `${n(r.no_start_date)} students without a readable start date, ${n(r.no_site)} whose site couldn't be matched, ${n(r.duplicate_emails_cleared)} duplicate emails and ${n(r.duplicate_ids_cleared)} duplicate Student IDs cleared (each noted on the student), ${n(r.unreadable_birth_dates)} unreadable birth dates`],
    ["Other tabs", `${n(r.leads)} leads, ${n(r.rna_hha)} RNA/HHA, ${n(r.ceu)} CEU, ${n(r.bls)} BLS, ${n(r.removed_students)} removed-student emails`]
  ];
  return `<dl class="isum">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}
function importSection(canPick) {
  const src = S.settings.import_source, last = S.settings.last_import;
  let body;
  if (importState === "running") body = `<p class="imp-running"><i class="dot busy" aria-hidden="true"></i>Importing from ${esc(src ? src.name : "Project1")}… This can take a minute or two. Keep this tab open.</p>`;
  else if (importState && typeof importState === "object") body = `<p><b>Import finished.</b> Reload the tracker to see the students.</p>${importSummary(importState)}<button class="primary" type="button" id="imp-reload">Reload the tracker</button>`;
  else body = `
    <p>Replaces <b>everything</b> in the tracker (students, payments, documents list, cohorts, sites and the activity log) with the Project1 Sheet.
    Your Google Drive connection and folders stay. Project1 itself is only read, never changed.</p>
    <p>${src ? `Sheet: <b>${esc(src.name)}</b> <button class="linkish-ink" type="button" id="imp-pick"${canPick ? "" : " disabled"}>Choose another</button>`
             : `<button class="ghost" type="button" id="imp-pick"${canPick ? "" : " disabled"}>Choose the Project1 Sheet</button>`}</p>
    ${src ? `<div class="imp-confirm"><label for="imp-confirm">Type <b>REPLACE</b> to confirm</label><input id="imp-confirm" type="text" autocomplete="off" spellcheck="false"><button class="danger-solid" type="button" id="imp-run">Import from Project1</button></div>` : ""}
    ${last ? `<p class="small-note">Last import: ${esc(fmtDate(String(last.at).slice(0, 10)))} by ${esc(last.by)}.</p>${importSummary(last.summary || {})}` : ""}`;
  return `<section class="imp"><h3>Import from Project1</h3>${body}</section>`;
}
/* Google's picker must run as the connected folder account (it's what the tracker uses to reach the files), not
   whichever Google account the browser happens to be signed in to. login_hint makes Google sign in as that account. */
async function withPicker(onToken) {
  const g = CFG.google || {}, acct = S.drive && S.drive.account_email;
  try {
    await loadScript("https://accounts.google.com/gsi/client");
    await loadScript("https://apis.google.com/js/api.js");
    await new Promise(r => window.gapi.load("picker", r));
  } catch (e) { driveError("Couldn't load Google's file picker. Check your connection and try again."); return; }
  if (acct) toast(`Google will ask you to use ${acct}, the account that owns the folders.`);
  const cfg = { client_id: g.clientId, scope: "https://www.googleapis.com/auth/drive.file",
    callback: resp => { if (resp.error) { driveError("Google didn't allow access: " + resp.error); return; } onToken(resp.access_token, g, window.google.picker); },
    error_callback: err => driveError("The Google sign-in was closed before it finished" + (err && err.type ? " (" + err.type + ")" : "") + ".") };
  if (acct) cfg.login_hint = acct;
  window.google.accounts.oauth2.initTokenClient(cfg).requestAccessToken(acct ? { prompt: "", login_hint: acct } : { prompt: "select_account" });
}
// Folder views: the account's own folders, folders shared with it, and shared drives.
function folderViews(P) {
  const FOLDER = "application/vnd.google-apps.folder";
  return [
    new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(FOLDER).setOwnedByMe(true),
    new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(FOLDER).setOwnedByMe(false),
    new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(FOLDER).setEnableDrives(true)
  ];
}
async function pickSheet() {
  withPicker((token, g, P) => {
    {
      new P.PickerBuilder().setAppId(g.appId).setOAuthToken(token).setDeveloperKey(g.apiKey)
        .addView(new P.DocsView(P.ViewId.SPREADSHEETS).setOwnedByMe(false))
        .addView(new P.DocsView(P.ViewId.SPREADSHEETS).setOwnedByMe(true))
        .setTitle("Select the Project1 Sheet")
        .setCallback(async data => {
          if (data[P.Response.ACTION] !== P.Action.PICKED) return;
          const doc = data[P.Response.DOCUMENTS][0];
          const value = { id: doc[P.Document.ID], name: doc[P.Document.NAME] || "Project1" };
          const { error } = await sb.from("settings").upsert({ key: "import_source", value });
          if (error) { driveError(errText(error)); return; }
          S.settings.import_source = value; renderDrive();
          toast(value.name === "Project1" ? "Project1 chosen. Type REPLACE and click Import when you're ready." : `"${value.name}" chosen. Check it's the right Sheet before importing.`);
        }).build().setVisible(true);
    }
  });
}
async function runImport() {
  const src = S.settings.import_source, inp = $("imp-confirm");
  if (!src) return;
  if (inp.value.trim() !== "REPLACE") { shake(inp); inp.focus(); driveError("Type REPLACE in capitals to confirm."); return; }
  importState = "running"; renderDrive();
  // Stop live updates while thousands of rows change; the page reloads afterwards.
  try { await sb.removeAllChannels(); } catch (e) {}
  try {
    const out = await (await driveCall("import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spreadsheet_id: src.id, confirm: "REPLACE" }) })).json();
    importState = out;
    try { localStorage.removeItem("calace.seenLog"); } catch (e) {}
    renderDrive(); toast("Import finished. Reload the tracker to see the students.");
  } catch (e) {
    importState = null; renderDrive(); driveError("Import didn't finish: " + e.message); subscribe();
  }
}
async function connectDrive(purpose) {
  try {
    const out = await (await driveCall("connect-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ return_to: location.origin + location.pathname, purpose: purpose === "mail" ? "mail" : "drive" }) })).json();
    location.assign(out.url);
  } catch (e) { driveError(e.message); }
}
// kind given: pick one folder for that document type. No kind: pick the original four together.
async function pickFolders(kind) {
  const g = CFG.google || {}, folders = S.settings.drive_folders || {};
  if (kind) return pickOneFolder(kind, g, folders);
  const want = DOCS.map(([k]) => folders[k] && folders[k].id).filter(Boolean);
  withPicker((token, g2, P) => {
    {
      const b = new P.PickerBuilder().setAppId(g.appId).setOAuthToken(token).setDeveloperKey(g.apiKey).enableFeature(P.Feature.SUPPORT_DRIVES);
      folderViews(P).forEach(v => b.addView(v));
      b.enableFeature(P.Feature.MULTISELECT_ENABLED).setTitle("Select the document folders")
        .setCallback(async data => {
          if (data[P.Response.ACTION] !== P.Action.PICKED) return;
          const picked = data[P.Response.DOCUMENTS].map(x => x[P.Document.ID]);
          const missing = DOCS.filter(([k]) => folders[k] && !picked.includes(folders[k].id)).map(([k]) => folders[k].name);
          if (missing.length) { driveError("These folders weren't among the ones you selected: " + missing.join(", ") + ". Select them too, or use Change next to each document to choose a different folder."); return; }
          const value = { granted_at: new Date().toISOString(), by: S.me.email };
          const { error } = await sb.from("settings").upsert({ key: "drive_access", value });
          if (error) { driveError(errText(error)); return; }
          S.settings.drive_access = value; renderDrive(); toast("Folder access given. Uploads now go to Google Drive.");
        }).build().setVisible(true);
    }
  });
  if (!want.length) driveError("No folders are set yet. Use Choose folder next to each document.");
}
async function pickOneFolder(kind, g, folders) {
  const label = lab(DOCS, kind);
  withPicker((token, g2, P) => {
    {
      const b = new P.PickerBuilder().setAppId(g.appId).setOAuthToken(token).setDeveloperKey(g.apiKey).enableFeature(P.Feature.SUPPORT_DRIVES);
      folderViews(P).forEach(v => b.addView(v));
      b.setTitle(`Select the folder for ${label}`)
        .setCallback(async data => {
          if (data[P.Response.ACTION] !== P.Action.PICKED) return;
          const doc = data[P.Response.DOCUMENTS][0];
          const next = { ...(S.settings.drive_folders || {}), [kind]: { id: doc[P.Document.ID], name: doc[P.Document.NAME] || label } };
          const access = S.settings.drive_access && S.settings.drive_access.granted_at ? S.settings.drive_access : { granted_at: new Date().toISOString(), by: S.me.email };
          const { error } = await sb.from("settings").upsert([{ key: "drive_folders", value: next }, { key: "drive_access", value: access }]);
          if (error) { driveError(errText(error)); return; }
          S.settings.drive_folders = next; S.settings.drive_access = access;
          renderDrive(); renderRail(); toast(`${label} uploads now go to the "${next[kind].name}" folder.`);
        }).build().setVisible(true);
    }
  });
}

async function renderHistory() {
  const h = $("hist"); if (!h || !draftId || drawerTab !== "history") return;
  const s = S.students.find(x => x.id === draftId); if (!s) return;
  const paint = () => {
    if (!$("hist") || draftId !== s.id) return;
    const list = S.log.filter(e => e.student_id === s.id);
    $("hist").innerHTML = list.length ? groupByDay(list, false)
      : `<div class="log-empty"><h3>No changes yet</h3><p>Every tick, payment and profile edit for ${esc(s.first_name)} will be listed here with who made it and when.</p></div>`;
  };
  paint();
  if (fetchedHistory.has(s.id)) return;
  fetchedHistory.add(s.id);   // older entries than the 1,000 loaded at start
  const { data } = await sb.from("activity_log").select("*").eq("student_id", s.id).order("at", { ascending: false }).limit(500);
  if (data && data.length) { data.forEach(e => { if (!S.log.some(x => x.id === e.id)) S.log.push(e); }); S.log.sort(byNewest); paint(); }
}
const fetchedHistory = new Set();
function closeDrawer() { $("layer").innerHTML = ""; draftId = null; recCtx = null; mailCtx = null; }
function readForm() {
  const v = id => $(id).value.trim(), c = id => $(id).checked, nul = x => x === "" ? null : x;
  const o = {
    first_name: v("f-first"), last_name: v("f-last"), email: nul(v("f-email").toLowerCase()), phone: nul(v("f-phone")),
    date_of_birth: nul(v("f-dob")), address: nul(v("f-address")), gender: nul(v("f-gender")), student_code: nul(v("f-code")),
    emergency_name: nul(v("f-emname")), emergency_phone: nul(v("f-emphone")), english_score: nul(v("f-english")), oasys_status: nul(v("f-oasys")),
    program: v("f-program"), pay_plan: v("f-plan"), cohort_id: v("c-cohort") ? +v("c-cohort") : null, schedule: v("c-sched"),
    site_id: v("f-site") ? +v("f-site") : null, orientation: c("f-orientation"), waitlist: c("f-waitlist"), withdrawn: c("f-withdrawn"), dropped: c("f-dropped"),
    waiver_minor: c("r-waiver_minor"), evaluation: c("r-evaluation"), notes: nul($("f-notes").value)
  };
  [...REQS, ...ATT, ...EXAMS].forEach(([k]) => o[k] = c("r-" + k));
  const co = S.cohorts.find(x => x.id === o.cohort_id);
  o.end_date = co ? (o.schedule === "weekend" && co.weekend_end ? co.weekend_end : co.weekday_end) : null;
  return o;
}
async function saveDraft() {
  const err = $("save-err"), o = readForm();
  const fail = msg => { err.hidden = false; err.textContent = msg; shake($("save")); };
  if (!o.first_name || !o.last_name) return fail("Add a first and last name to save this student.");
  if (o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) return fail("That email address doesn't look right.");
  const btn = $("save"); btn.disabled = true;
  try {
    if (draftId) {
      const s = S.students.find(x => x.id === draftId);
      const patch = {};
      Object.keys(o).forEach(k => { if ((s[k] ?? null) !== (o[k] ?? null)) patch[k] = o[k]; });
      if ("notes" in patch) patch.notes_by = S.me.email;
      if (!Object.keys(patch).length) { closeDrawer(); toast("No changes to save"); return; }
      await updateStudent(draftId, patch);
      const n = Object.keys(patch).filter(k => k !== "notes_by" && k !== "end_date").length || 1;
      closeDrawer(); toast(`Saved ${n} ${n === 1 ? "change" : "changes"} for ${o.first_name} ${o.last_name}`);
    } else {
      if (o.notes) o.notes_by = S.me.email;
      const { data, error } = await sb.from("students").insert(o).select().single();
      if (error) throw error;
      upsertLocal(S.students, data);
      if (data.program !== S.program) { S.program = data.program; try { localStorage.setItem("calace.program", S.program); } catch (e) {} }
      closeDrawer(); render(); toast(`Added ${o.first_name} ${o.last_name}`);
    }
  } catch (e) { btn.disabled = false; fail(errText(e)); }
}
function askDelete() {
  const s = S.students.find(x => x.id === draftId);
  $("del").outerHTML = `<span class="confirm" id="confirm">Delete ${esc(s.first_name)} for good? Payments go too; the log keeps the history. <button type="button" id="del-yes">Delete</button><button type="button" class="no" id="del-no">Keep</button></span>`;
  $("del-no").onclick = () => { $("confirm").outerHTML = `<button class="danger" type="button" id="del">Delete student</button>`; $("del").onclick = askDelete; };
  $("del-yes").onclick = async () => {
    try {
      if (s.email) { const r = await sb.from("removed_students").upsert({ email: s.email.toLowerCase() }); if (r.error) throw r.error; }
      const { error } = await sb.from("students").delete().eq("id", s.id);
      if (error) throw error;
      removeLocal(S.students, s.id); S.payments = S.payments.filter(p => p.student_id !== s.id);
      closeDrawer(); render(); toast(`Deleted ${s.first_name} ${s.last_name}`);
    } catch (e) { const er = $("save-err"); er.hidden = false; er.textContent = errText(e); }
  };
}

/* ---------------- Crosshair ---------------- */
const xh = document.createElement("style"); document.head.appendChild(xh);
let xcol = -1;
function applyCrosshair() {
  xh.textContent = xcol < 0 ? "" :
    `.grid tbody td:nth-child(${xcol}){background:var(--xcol)}
     .grid tbody tr:hover td:nth-child(${xcol}){background:var(--xhit)}
     .grid thead tr.c th:nth-child(${xcol}){box-shadow:inset 0 -3px 0 var(--ceil)}
     .grid thead tr.c th:nth-child(${xcol}) span{color:var(--ceil);font-weight:700}`;
}
$("wrap").addEventListener("mouseover", e => {
  const td = e.target.closest(".grid tbody td.cell, .grid thead tr.c th.rot");
  const col = td ? td.cellIndex + 1 : -1;
  if (col !== xcol) { xcol = col; applyCrosshair(); }
});
$("wrap").addEventListener("mouseleave", () => { xcol = -1; applyCrosshair(); });

/* ---------------- Events ---------------- */
document.addEventListener("click", async e => {
  if (popCtx) {
    if (e.target.closest(".pop")) { const b = e.target.closest("button"); if (b) popAction(b); return; }
    const pb = e.target.closest("[data-pay]"), tr = pb && pb.closest("[data-id]");
    const same = tr && tr.dataset.id === popCtx.id && pb.dataset.pay === popCtx.k;
    closePop(); if (same) return;
  }
  const t = e.target.closest("button,[data-close]"); if (!t || !S.me) return;
  if (t.dataset.close) { closeDrawer(); return; }
  if (t.dataset.dtab) { setDrawerTab(t.dataset.dtab); return; }
  if (t.dataset.rtab) { setRecTab(t.dataset.rtab); return; }
  if (t.dataset.page === "templates" || t.dataset.page === "export") { closeDrawer(); S.page = t.dataset.page; try { localStorage.setItem("calace.program", S.page); } catch (err) {} render(); routeAnim(); return; }
  if (t.dataset.page === "staff") { closeDrawer(); S.page = "staff"; staffList = null; try { localStorage.setItem("calace.program", "staff"); } catch (err) {} render(); routeAnim(); return; }
  if (t.dataset.staff) { openStaff(t.dataset.staff); return; }
  if (t.dataset.page === "schedule") { closeDrawer(); S.page = "schedule"; try { localStorage.setItem("calace.program", "schedule"); } catch (err) {} render(); routeAnim(); return; }
  if (t.dataset.page === "home") { closeDrawer(); S.page = "home"; try { localStorage.setItem("calace.program", "home"); } catch (err) {} render(); routeAnim(); return; }
  if (t.dataset.home) { homeAction(t); return; }
  if (t.dataset.page === "overview") { closeDrawer(); S.page = "overview"; try { localStorage.setItem("calace.program", "overview"); } catch (err) {} render(); routeAnim(); return; }
  if (t.dataset.ovr) { S.ovRange = t.dataset.ovr; renderOverview(); return; }
  if (t.dataset.ovarch) { S.ovArch = !S.ovArch; renderOverview(); return; }
  if (t.dataset.ovview) { S.ovView = t.dataset.ovview; try { localStorage.setItem("calace.ovView", S.ovView); } catch (err) {} renderOverview(); return; }
  if (t.dataset.ovstu) { openDrawer(t.dataset.ovstu, "pay"); return; }
  if (t.dataset.page === "leads") { closeDrawer(); S.page = "leads"; S.q = ""; $("q").value = ""; try { localStorage.setItem("calace.program", "leads"); } catch (err) {} render(); routeAnim(); return; }
  if (t.dataset.lview) { S.lview = (S.lview === t.dataset.lview && t.closest("#ledger")) ? "all" : t.dataset.lview; render(); routeAnim(); return; }
  if (S.page === "leads" && t.id === "clear-filters") { S.q = ""; $("q").value = ""; S.lview = "all"; S.lprog = ""; render(); return; }
  if (t.dataset.stuhub) { closeDrawer(); S.page = S.stuLast || (pageAllowed("students") ? "students" : "other"); S.q = ""; $("q").value = ""; try { localStorage.setItem("calace.program", S.page === "other" ? "o:" + S.other : S.program); } catch (err) {} render(); routeAnim(); return; }
  if (t.dataset.oprog) { closeDrawer(); S.page = "other"; S.other = t.dataset.oprog; S.q = ""; $("q").value = ""; OT.limit = 300; try { localStorage.setItem("calace.program", "o:" + S.other); } catch (err) {} render(); routeAnim(); return; }
  if (t.dataset.rview) { const cur = OT.view[S.other] || "all"; OT.view[S.other] = (cur === t.dataset.rview && t.closest("#ledger")) ? "all" : t.dataset.rview; OT.limit = 300; render(); routeAnim(); return; }
  if (t.id === "rec-more") { OT.limit += 300; renderOther(); return; }
  if (S.page === "other" && (t.id === "add-student" || t.dataset.add)) { openRecord(null); return; }
  if (S.page === "other" && t.id === "clear-filters") { S.q = ""; $("q").value = ""; OT.view[S.other] = "all"; OT.date[S.other] = ""; render(); return; }
  if (t.dataset.rtick) { if (!can("programs", 2)) { viewOnly("these sign-ups"); return; } toggleRecTick(t); return; }
  if (t.dataset.ropen) { openRecord(+t.closest("[data-rid]").dataset.rid, t.dataset.ropen === "notes" ? "notes" : null); return; }
  if (t.dataset.prog) { S.page = "students"; S.program = t.dataset.prog; S.cohort = ""; S.loc = ""; S.q = ""; $("q").value = ""; try { localStorage.setItem("calace.program", S.program); } catch (err) {} render(); routeAnim(); return; }
  if (t.dataset.page === "log") { S.page = "log"; S.q = ""; $("q").value = ""; S.logLimit = 300; render(); routeAnim(); return; }
  if (t.dataset.page === "drive") { closeDrawer(); S.page = "drive"; render(); routeAnim(); return; }
  if (t.dataset.stu) { openDrawer(t.dataset.stu, "history"); return; }
  if (t.dataset.view) { S.view = (S.view === t.dataset.view && t.closest("#ledger")) ? "all" : t.dataset.view; render(); routeAnim(); return; }
  if (t.id === "add-student" || t.dataset.add) { openDrawer(null); return; }
  if (t.id === "clear-filters") { S.q = ""; $("q").value = ""; S.status = "paid"; S.cohort = ""; S.sched = ""; S.loc = ""; S.view = "all"; render(); return; }
  if (t.id === "export-csv") { exportCsv(); return; }
  if (t.id === "sign-out") { await sb.auth.signOut(); location.reload(); return; }
  if (t.id === "log-more") { S.logLimit += 300; renderLog(); return; }
  const tr = t.closest("[data-id]"); if (!tr) return;
  const s = S.students.find(x => x.id === tr.dataset.id); if (!s) return;
  if (t.dataset.open) { openDrawer(s.id, t.dataset.open === "notes" ? "notes" : t.dataset.open === "history" ? "history" : null); return; }
  if (t.dataset.pay) { if (!can("payments", 2)) { viewOnly("payments"); return; } openPayPop(t, s, t.dataset.pay); return; }
  if (t.dataset.fu && !can("leads", 2)) { viewOnly("follow-ups"); return; }
  if (t.dataset.key && !(can("cna", 2) || (TRAINING_KEYS.includes(t.dataset.key) && can("training", 2)))) { viewOnly("this"); return; }
  if (t.dataset.fu && !s[t.dataset.fu]) { openEmail(s, t.dataset.fu); return; }   // not sent yet: preview the email first
  if (t.dataset.fu) {
    const k = t.dataset.fu, before = s[k] || null, label = (FIELD_LABELS[k] || k), who = s.first_name + " " + s.last_name;
    t.classList.add("busy");
    try {
      await updateStudent(s.id, { [k]: before ? null : new Date().toISOString() });
      toast(`${label} ${before ? "unmarked" : "marked sent"} for ${who}`, () => updateStudent(s.id, { [k]: before }).then(() => toast("Change undone. The undo is logged too.")).catch(err => toast(errText(err))));
    } catch (err) { t.classList.remove("busy"); shake(t); toast(errText(err)); }
    return;
  }
  if (t.dataset.key) {
    const k = t.dataset.key, before = !!s[k], label = t.getAttribute("aria-label"), who = s.first_name + " " + s.last_name;
    t.classList.add("busy");
    try {
      await updateStudent(s.id, { [k]: !before });
      toast(`${label} ${before ? "unticked" : "ticked off"} for ${who}`, () => updateStudent(s.id, { [k]: before }).then(() => toast("Change undone. The undo is logged too.")).catch(err => toast(errText(err))));
    } catch (err) { t.classList.remove("busy"); shake(t); toast(errText(err)); }
  }
});
document.addEventListener("keydown", e => { if (e.key !== "Escape") return; if (document.body.classList.contains("nav-open")) { setNav(false); return; } if (popCtx) { closePop(); return; } if ($("layer").innerHTML) closeDrawer(); });

/* Small screens: the sidebar slides in from the left, and the dropdown filters fold behind a button on phones. */
function setNav(open) {
  document.body.classList.toggle("nav-open", open);
  $("nav-open").setAttribute("aria-expanded", open);
  if (open) setTimeout(() => $("nav-close").focus(), 50);
}
$("nav-open").addEventListener("click", () => setNav(true));
$("nav-close").addEventListener("click", () => setNav(false));
$("nav-scrim").addEventListener("click", () => setNav(false));
document.addEventListener("click", e => { const b = e.target.closest(".rail button"); if (b && b.id !== "motion-toggle" && document.body.classList.contains("nav-open")) setNav(false); }, true);   // capture: runs before the menu redraws
$("filt-toggle").addEventListener("click", () => { const open = !document.body.classList.contains("filters-open"); document.body.classList.toggle("filters-open", open); $("filt-toggle").setAttribute("aria-expanded", open); });
function updateFiltBtn() {
  const n = S.page === "log" ? (S.logProg ? 1 : 0) : S.page === "students" ? [S.status !== "paid", S.cohort, S.sched, S.loc].filter(Boolean).length : S.page === "other" ? (OT.date[S.other] && !(oCfg().period && OT.date[S.other] === "week") ? 1 : 0) : S.page === "leads" ? (S.lprog ? 1 : 0) : 0;
  $("filt-toggle").textContent = n ? `Filters (${n})` : "Filters";
  $("filt-toggle").hidden = !(S.page === "students" || S.page === "log" || S.page === "other" || S.page === "leads");
}
document.querySelector(".filters").addEventListener("change", () => setTimeout(updateFiltBtn));
let wasPhone = PHONE.matches;
PHONE.addEventListener("change", () => { if (PHONE.matches !== wasPhone) { wasPhone = PHONE.matches; S.shownGrid = false; if (S.me) renderMain(); } });
$("wrap").addEventListener("scroll", () => { if (popCtx) closePop(); }, { passive: true });
window.addEventListener("resize", () => { if (popCtx) closePop(); });
let qT; $("q").addEventListener("input", e => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value; if (S.page === "other") render(); else renderMain(); }, 120); });
$("f-status").addEventListener("change", e => { S.status = e.target.value; render(); routeAnim(); });
$("f-lprog").addEventListener("change", e => { S.lprog = e.target.value; render(); routeAnim(); });
$("f-odate").addEventListener("change", e => { OT.date[S.other] = e.target.value; OT.limit = 300; render(); routeAnim(); });
$("f-cohort").addEventListener("change", e => { S.cohort = e.target.value; renderMain(); });
$("f-sched").addEventListener("change", e => { S.sched = e.target.value; renderMain(); });
$("f-loc").addEventListener("change", e => { S.loc = e.target.value; renderMain(); });
$("f-logprog").addEventListener("change", e => { S.logProg = e.target.value; renderLog(); });

/* ---------------- CSV export ---------------- */
function exportCsv() {
  const yn = b => b ? "Yes" : "No";
  const q = v => { v = String(v == null ? "" : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  let cols, rows, name;
  if (S.page === "leads") {
    cols = ["Last Name", "First Name", "Email", "Phone", "Program", "Start Date", "Schedule", "Added", ...FOLLOWUPS.map(([, l]) => l + " Email Sent"), "Next Step", "Notes"];
    rows = leadsFiltered().map(s => { const nx = nextFollowup(s); return [s.last_name, s.first_name, s.email, s.phone, lab(PROGRAMS, s.program), startOf(s), s.schedule, String(s.created_at || "").slice(0, 10),
      ...FOLLOWUPS.map(([k]) => s[k] ? String(s[k]).slice(0, 10) : ""), nx ? nx.l + " due " + nx.due : "All sent", s.notes]; });
    name = `Leads-${ISO_TODAY}.csv`;
  } else if (S.page === "other") {
    const cfg = oCfg(), list = oFiltered(), known = cfg.card.flatMap(([, f]) => f.map(x => x[0]));
    cols = known.concat([...new Set(list.flatMap(r => Object.keys(r.data)))].filter(k => !known.includes(k)));
    rows = list.map(r => cols.map(k => r.data[k]));
    cols = cols.map(k => k.length > 60 ? k.slice(0, 57) + "..." : k);
    name = `${cfg.label}-${ISO_TODAY}.csv`;
  } else if (S.page === "log") {
    cols = ["Timestamp", "User", "Action", "Student", "Field", "Old", "New", "Details"];
    rows = S.log.map(e => [e.at, e.user_email, e.action, e.student_name, FIELD_LABELS[e.field] || e.field, fmtVal(e.field, e.old_value), fmtVal(e.field, e.new_value), e.details]);
    name = `calace-logs-${ISO_TODAY}.csv`;
  } else {
    cols = ["Student ID", "Last Name", "First Name", "Email", "Phone", "Program", "Pay Plan", "Start Date", "End Date", "Schedule", "Clinical Site", "Waitlist", "Withdrawn", "Dropped",
      ...STAGES.map(([, l]) => l + " Paid"), "Balance", ...REQS.map(([, l]) => l), "Minor Waiver", "Orientation", ...ATT.map(([, l]) => l), ...EXAMS.map(([, l]) => l), "OASYS", "English", "Standing", "Notes"];
    rows = filtered().map(s => { const a = assess(s); return [s.student_code, s.last_name, s.first_name, s.email, s.phone, lab(PROGRAMS, s.program), PLAN_NAMES[s.pay_plan], startOf(s), endOf(s), s.schedule, (siteOf(s) || {}).name, yn(s.waitlist), yn(s.withdrawn), yn(s.dropped),
      ...STAGES.map(([k]) => paidFor(s, k)), a.m.balance, ...REQS.map(([k]) => yn(s[k])), yn(s.waiver_minor), yn(s.orientation), ...ATT.map(([k]) => yn(s[k])), ...EXAMS.map(([k]) => yn(s[k])), s.oasys_status, s.english_score, a.text + (a.why ? " (" + a.why + ")" : ""), s.notes]; });
    name = `${lab(PROGRAMS, S.program).replace(/\s+/g, "-")}-${ISO_TODAY}.csv`;
  }
  const csv = [cols].concat(rows).map(r => r.map(q).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Exported ${rows.length} rows`);
}

/* ---------------- Sign-in ---------------- */
function showGate(html) { $("app").hidden = true; $("gate").hidden = false; $("gate-body").innerHTML = html; }
function gateSignIn(msg) {
  showGate(`<h1>Sign in to the tracker</h1><p>Enter your staff email. We'll send you a one-time sign-in link.</p>
    <form id="gate-form"><div class="f"><label for="gate-email">Email</label><input id="gate-email" type="email" autocomplete="email" required></div>
    <button class="primary" type="submit" id="gate-send">Send sign-in link</button><span class="err" id="gate-err"${msg ? "" : " hidden"}>${esc(msg || "")}</span></form>`);
  $("gate-form").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("gate-email").value.trim().toLowerCase(), btn = $("gate-send");
    btn.disabled = true; btn.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) {
      btn.disabled = false; btn.textContent = "Send sign-in link";
      const er = $("gate-err"); er.hidden = false;
      er.textContent = /rate limit|seconds/i.test(error.message) ? "Too many sign-in emails were sent recently. Wait a few minutes, then try again." : errText(error);
      return;
    }
    $("gate-body").innerHTML = `<h1>Check your email</h1><div class="sent">We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device. It works once and expires in an hour.</div>
      <p style="margin-top:14px"><button class="ghost" type="button" id="gate-again">Use a different email</button></p>`;
    $("gate-again").onclick = () => gateSignIn();
  });
  setTimeout(() => $("gate-email") && $("gate-email").focus(), 50);
}
function gateNotStaff(email) {
  showGate(`<h1>You're not on the staff list yet</h1><p>You're signed in as <b>${esc(email)}</b>, but this address can't open the tracker. Ask an admin to add it, then sign in again.</p>
    <button class="ghost" type="button" id="gate-out">Sign out</button>`);
  $("gate-out").onclick = async () => { await sb.auth.signOut(); gateSignIn(); };
}
async function start(session) {
  const email = (session.user.email || "").toLowerCase();
  const { data: staff, error } = await sb.from("staff").select("*").eq("email", email).maybeSingle();
  if (error || !staff || !staff.active) { gateNotStaff(email); return; }
  S.me = staff;
  $("gate").hidden = true; $("app").hidden = false;
  $("me").textContent = staff.full_name || email; $("me-av").textContent = initials(staff.full_name || email); $("me-av").style.setProperty("--av", avColor(email));
  $("env").textContent = CFG.environment ? CFG.environment + " data" : ""; $("env").hidden = !CFG.environment;
  playIntro(); render();
  // Coming back from Google's sign-in for Drive: ?code=…&state=… (or ?error=…) on the tracker's own address.
  const qs = new URLSearchParams(location.search);
  const google = qs.get("state") && (qs.get("code") || qs.get("error")) ? { code: qs.get("code"), state: qs.get("state"), error: qs.get("error") } : null;
  if (google) { S.page = "drive"; history.replaceState(null, "", location.pathname); }
  try {
    await loadAll(); render(); subscribe(); loadOtherCounts();
    if (google && google.code) {
      toast("Finishing the Google Drive connection…");
      try { const r = await (await driveCall("exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: google.code, state: google.state }) })).json(); toast(r.purpose === "mail" ? `Emails will now be sent from ${r.account_email}.` : `Google Drive is connected as ${r.account_email}. If this is a new account, choose the folders in step 3.`); }
      catch (e) { toast("Google Drive didn't connect: " + e.message); }
    } else if (google) toast(google.error === "access_denied" ? "Google Drive connection was cancelled." : "Google Drive didn't connect: " + google.error);
    loadDriveStatus();
  }
  catch (e) { setConn("Couldn't load the roster: " + errText(e), ""); $("wrap").innerHTML = `<div class="empty"><h3>Couldn't load students</h3><p>${esc(errText(e))}</p><button class="ghost" type="button" onclick="location.reload()">Try again</button></div>`; }
}
// Local testing only: lets a developer render sample rows without signing in. Writes still need a real session.
if (location.hostname === "localhost") window.__calaceDebug = { S, OT, render, openRecord, setStaff(l) { staffList = l; }, openStaff: e => openStaff(e), welcomeLetterPdf, profileEmail, openComposer, fillEmail, renderTemplates, show() { $("gate").hidden = true; $("app").hidden = false; } };

let started = false;
sb.auth.onAuthStateChange((event, session) => {
  if (session && !started) { started = true; start(session); }
  if (!session && event === "SIGNED_OUT") { started = false; gateSignIn(); }
});
sb.auth.getSession().then(({ data }) => {
  if (data.session) { if (!started) { started = true; start(data.session); } }
  else {
    const hash = new URLSearchParams(location.hash.slice(1));
    gateSignIn(hash.get("error_description") ? "That sign-in link has expired or was already used. Send a new one." : "");
  }
});
})();
