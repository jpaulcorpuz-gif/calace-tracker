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
const DOCS = [["live_scan", "Live Scan"], ["283b_signed", "Signed 283B"], ["physical_exam", "Physical exam"], ["tb_test", "TB test"]];
const DOC_REQ = { live_scan: "live_scan", "283b_signed": "form_283b", physical_exam: "physical_exam", tb_test: "tb_test" };   // the database ticks these on upload
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

const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const ISO_TODAY = iso(TODAY);
const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

/* ---------------- State ---------------- */
const S = {
  me: null, loaded: false, page: "students", program: "hybrid",
  students: [], payments: [], files: [], cohorts: [], sites: [], cohortSites: [], settings: {}, log: [],
  q: "", cohort: "", sched: "", loc: "", view: "all", logProg: "", logLimit: 300,
  localTouch: {}, seenLogId: 0, drive: null
};
try { const p = localStorage.getItem("calace.program"); if (PROGRAMS.some(x => x[0] === p)) S.program = p; } catch (e) {}

/* ---------------- Helpers ---------------- */
const $ = id => document.getElementById(id);
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
    <div class="intro__mark"><svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M10 3v14M3 10h14"/></svg></div>
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
    sb.from("activity_log").select("*").order("id", { ascending: false }).limit(1000),
    sb.from("student_files").select("*").order("id")
  ]);
  const bad = res.find(r => r.error); if (bad) throw bad.error;
  [S.students, S.payments, S.cohorts, S.sites, S.cohortSites] = res.slice(0, 5).map(r => r.data);
  S.settings = Object.fromEntries(res[5].data.map(r => [r.key, r.value]));
  S.log = res[6].data;
  S.files = res[7].data;
  let seen = null; try { seen = localStorage.getItem("calace.seenLog"); } catch (e) {}
  S.seenLogId = seen ? +seen : (S.log[0] ? S.log[0].id : 0);   // first visit: nothing counts as new
  S.loaded = true;
}
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
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_log" }, p => {
      if (!S.log.some(x => x.id === p.new.id)) S.log.unshift(p.new);
      renderRail(); if (S.page === "log") renderLog(); renderHistory();
    })
    .subscribe(status => {
      if (status === "SUBSCRIBED") setConn("Live: teammates' changes show up as they happen.", "live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setConn("Live updates paused. Reload to reconnect.", "");
    });
}

/* ---------------- Filtering ---------------- */
function inProgram() { return S.students.filter(s => s.program === S.program); }
function filtered() {
  const q = S.q.trim().toLowerCase();
  return inProgram().filter(s => {
    const a = assess(s);
    if (S.view === "out" ? !a.out : a.out) return false;
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
  $("programs").innerHTML = PROGRAMS.map(([id, name]) => {
    const n = S.students.filter(s => s.program === id && !s.withdrawn && !s.dropped).length;
    return `<li><button type="button" data-prog="${id}" aria-current="${S.page === "students" && id === S.program}"><span>${esc(name)}</span><span class="ct">${n || ""}</span></button></li>`;
  }).join("");
  $("nav-log").setAttribute("aria-current", S.page === "log");
  $("nav-drive-li").hidden = !(S.me && S.me.role === "admin");
  $("nav-drive").setAttribute("aria-current", S.page === "drive");
  const dct = $("drive-ct"); dct.textContent = S.drive && !driveReady() ? "Set up" : ""; dct.className = "ct" + (dct.textContent ? " warn" : "");
  const fresh = S.log.filter(x => x.id > S.seenLogId).length;
  $("log-ct").textContent = fresh && S.page !== "log" ? (fresh > 99 ? "99+" : fresh) + " new" : "";
}
function opts(sel, label, values, cur) {
  sel.innerHTML = `<option value="">${esc(label)}</option>` + values.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`).join("");
}
function renderHeader() {
  const isLog = S.page === "log", isDrive = S.page === "drive";
  ["f-cohort", "f-sched", "f-loc", "views"].forEach(id => $(id).hidden = isLog || isDrive);
  $("f-logprog").hidden = !isLog;
  $("q").hidden = isDrive;
  if (isDrive) { $("prog-title").textContent = "Google Drive"; $("ledger").innerHTML = `<span>Where student documents are saved.</span>`; return; }
  $("q").placeholder = isLog ? "Search by student, change or staff member" : "Search name, email, phone, Student ID or notes";
  if (isLog) {
    $("prog-title").textContent = "Logs";
    opts($("f-logprog"), "All programs", PROGRAMS, S.logProg);
    $("ledger").innerHTML = `<span>Every change, with who made it and when. Newest first.</span>`;
    return;
  }
  $("prog-title").textContent = lab(PROGRAMS, S.program);
  const ps = inProgram();
  const cohorts = S.cohorts.filter(c => c.program === S.program && ps.some(s => s.cohort_id === c.id)).sort((a, b) => b.start_date.localeCompare(a.start_date));
  if (S.cohort && !cohorts.some(c => String(c.id) === S.cohort)) S.cohort = "";
  opts($("f-cohort"), "All start dates", cohorts.map(c => [c.id, "Starts " + fmtDate(c.start_date)]), S.cohort);
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
function row(s) {
  const a = assess(s), c = cohortOf(s), site = siteOf(s);
  const start = c ? c.start_date : "";
  const started = daysUntil(start) <= 0, soon = daysUntil(start) <= 14;
  let cells = "";
  STAGES.forEach(([k], i) => { cells += `<td class="cell pc${i === 0 ? " gs" : ""}" data-ck="pay.${k}"><span class="pw-wrap">${payCell(s, k, k === "registration" || started)}</span></td>`; });
  REQS.forEach(([k, l], i) => { const need = soon && CLINICAL_REQS.includes(k); cells += `<td class="cell${i === 0 ? " gs" : ""}" data-ck="${k}">${toggleCell(k, l, s[k], need ? "hold" : "")}</td>`; });
  ATT.forEach(([k, l], i) => { cells += `<td class="cell${i === 0 ? " gs" : ""}" data-ck="${k}">${toggleCell(k, l, s[k], "")}</td>`; });
  EXAMS.forEach(([k, l], i) => { cells += `<td class="cell${i === 0 ? " gs" : ""}" data-ck="${k}">${toggleCell(k, l, s[k], "")}</td>`; });
  let flags = "";
  if (isMinor(s)) flags += `<span class="flag">Minor${s.waiver_minor ? ", waiver in" : ", needs waiver"}</span>`;
  if (s.waitlist) flags += `<span class="flag wl">Waitlist</span>`;
  const eng = String(s.english_score || "").match(/^(\d+)\s*\/\s*(\d+)$/);
  if (eng && +eng[1] / +eng[2] < 0.7) flags += `<span class="flag">English ${esc(s.english_score)}</span>`;
  const nlog = S.log.filter(x => x.student_id === s.id).length;
  return `<tr data-id="${esc(s.id)}" class="${a.out ? "inactive" : ""}">
    <td class="sticky who"><button class="name" type="button" data-open="1">${esc(s.last_name)}, ${esc(s.first_name)}</button>${flags}
      <div class="sub"><span class="d">${start ? fmtDate(start, false) + " – " + fmtDate(s.end_date) : "No start date"}</span><span>${s.schedule === "weekend" ? "Weekend" : s.schedule === "weekday" ? "Weekday" : ""}</span></div>
      <div class="sub"><span>${esc(s.student_code || "")}</span>${site ? `<span>${esc(site.short_name)}</span>` : ""}</div></td>
    <td class="state" data-ck="state"><span class="pill ${a.tone}">${a.text}</span>${a.why ? `<div class="why">${esc(a.why)}</div>` : ""}</td>
    <td class="bal num ${a.m.balance > 0 ? "owe" : "zero"}" data-ck="bal">${a.m.balance > 0 ? money(a.m.balance) : "Paid"}<small>of ${money(a.m.due)}</small></td>
    ${cells}
    <td class="note gs">${s.notes ? `<p>${esc(s.notes)}</p>` : ""}<div class="acts"><button type="button" data-open="notes">${s.notes ? "Edit note" : "Add note"}</button><button type="button" data-open="history">History${nlog ? " (" + nlog + ")" : ""}</button></div></td>
  </tr>`;
}
function head() {
  const rot = (arr, pay) => arr.map(([k, l, short], i) => `<th class="rot${pay ? " pw" : ""}${i === 0 ? " gs" : ""}" scope="col"><div><span>${esc(short)}</span></div></th>`).join("");
  return `<thead>
   <tr class="g"><th class="sticky"></th><th></th><th></th>
     <th colspan="${STAGES.length}" class="gs">Payments</th><th colspan="${REQS.length}" class="gs">Requirements</th><th colspan="${ATT.length}" class="gs">Attendance</th><th colspan="${EXAMS.length}" class="gs">Exams</th><th class="gs"></th></tr>
   <tr class="c"><th class="sticky lbl who" scope="col">Student</th><th class="lbl" scope="col">Standing</th><th class="lbl" scope="col" style="text-align:right">Balance</th>
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
  const firstShow = !S.shownGrid; S.shownGrid = true;
  const sigs = cellSigs(list), prev = prevSigs; prevSigs = sigs;
  const keepX = w.scrollLeft, keepY = w.scrollTop;
  w.innerHTML = `<table class="grid${firstShow ? " enter" : ""}">${head()}<tbody>${list.map(row).join("")}</tbody></table>
   <div class="legend"><span><i class="tk done">${CHECK}</i>Done</span><span><i class="tk amt done">$800</i>Paid in full</span><span><i class="tk amt part">$400</i>Partly paid</span><span><i class="tk due"></i>Payment due now</span><span><i class="tk hold"></i>Needed before clinicals</span><span><i class="tk"></i>Not yet</span><span>Under payments: S Stripe, Z Zelle, C Cash, T Terminal, CH Check, then the date paid.</span><span>Click any box to change it. Every change is logged.</span></div>`;
  w.scrollLeft = keepX; w.scrollTop = keepY;
  if (firstShow) { w.querySelectorAll("tbody tr").forEach((tr, i) => tr.style.setProperty("--i", Math.min(i, 24))); setTimeout(() => { const g = w.querySelector(".grid"); if (g) g.classList.remove("enter"); }, 1200); }
  else if (prev) markChanges(w, prev, sigs);
  applyCrosshair();
}

/* ---------------- Logs ---------------- */
function fmtVal(field, v) {
  if (v == null || v === "") return "—";
  if (v === "true" || v === "false") return v === "true" ? "Yes" : "No";
  if (field === "cohort_id") { const c = S.cohorts.find(x => String(x.id) === String(v)); return c ? fmtDate(c.start_date) : v; }
  if (field === "site_id") { const x = S.sites.find(y => String(y.id) === String(v)); return x ? x.short_name : v; }
  if (field === "pay_plan") return PLAN_NAMES[v] || v;
  if (field === "program") return lab(PROGRAMS, v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
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
  let list = S.log.filter(e => { if (!S.logProg) return true; const s = S.students.find(x => x.id === e.student_id); return s && s.program === S.logProg; });
  if (q) list = list.filter(e => [e.student_name, e.field && FIELD_LABELS[e.field], e.action, e.old_value, e.new_value, e.user_email, e.details].join(" ").toLowerCase().includes(q));
  if (!list.length) { w.innerHTML = `<div class="log"><div class="log-empty"><h3>No changes match</h3><p>Try another search or program.</p></div></div>`; return; }
  const shown = list.slice(0, S.logLimit);
  w.innerHTML = `<div class="log">${groupByDay(shown, true)}${list.length > shown.length ? `<button class="ghost more" type="button" id="log-more">Show older changes</button>` : ""}</div>`;
  if (S.log.length) { S.seenLogId = S.log[0].id; try { localStorage.setItem("calace.seenLog", S.seenLogId); } catch (e) {} renderRail(); }
}
function renderMain() { if (S.page === "log") renderLog(); else if (S.page === "drive") renderDrive(); else renderGrid(); }
function render() { renderRail(); renderHeader(); renderMain(); }

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
  refreshLedger(); refreshDocs(); renderHistory();
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
function currentDoc(studentId, kind) { const r = S.files.filter(f => f.student_id === studentId && f.kind === kind && f.drive_file_id); return r[r.length - 1] || null; }
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
  refreshDocs(); if (S.page === "drive") renderDrive();
}
function driveReady() { return S.drive && S.drive.connected && S.settings.drive_access && S.settings.drive_access.granted_at; }
function refreshDocs() {
  const box = $("docs-box"); if (!box || !draftId) return;
  const s = S.students.find(x => x.id === draftId); if (!s) return;
  const ready = driveReady();
  const note = !S.drive ? `<p class="small-note">Checking the Google Drive connection…</p>`
    : ready ? "" : `<p class="small-note warn-note">Uploads are paused until Google Drive is set up. ${S.me.role === "admin" ? `Finish the steps on the <button type="button" class="linkish-ink" data-page="drive">Google Drive page</button>.` : "Ask an admin to finish the Google Drive page."}</p>`;
  box.innerHTML = note + DOCS.map(([kind, label]) => {
    const f = currentDoc(s.id, kind);
    const busy = docBusy[s.id + "|" + kind];
    return `<div class="doc" data-doc="${kind}">
      <div class="doc__main"><b>${esc(label)}</b>
        ${busy ? `<span class="doc__meta">${esc(busy)}</span>` : f
          ? `<span class="doc__meta"><button type="button" class="doc__name" data-docview="${f.id}" title="Open in a new tab">${esc(f.file_name || "File")}</button> ${f.size_bytes ? fileSize(f.size_bytes) + ", " : ""}uploaded ${esc(fmtDate(String(f.uploaded_at).slice(0, 10)))} by ${esc(f.uploaded_by)}</span>`
          : `<span class="doc__meta">No file yet</span>`}
      </div>
      <div class="doc__acts">
        <input type="file" id="doc-in-${kind}" accept=".pdf,image/*" hidden>
        ${busy ? "" : f
          ? `<button type="button" class="ghost doc__btn" data-docpick="${kind}"${ready ? "" : " disabled"}>Replace</button><button type="button" class="rm" data-docrm="${f.id}"${ready ? "" : " disabled"}>Remove</button>`
          : `<button type="button" class="ghost doc__btn" data-docpick="${kind}"${ready ? "" : " disabled"}>Upload</button>`}
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
  const folderRows = DOCS.map(([k, l]) => { const f = folders[k]; return `<li><b>${esc(l)}</b> → ${f ? `<a href="https://drive.google.com/drive/folders/${esc(f.id)}" target="_blank" rel="noopener">${esc(f.name)}</a>` : "not set"}</li>`; }).join("");
  if (S.me.role !== "admin") { w.innerHTML = `<div class="log"><div class="log-empty"><h3>Admins only</h3><p>Ask an admin to set up Google Drive.</p></div></div>`; return; }
  w.innerHTML = `<div class="log drive-page">
    <p class="small-note">Uploads are saved into your Drive folders and named "{Student full name} - {Start date}", for example "Ava Testa - December 7, 2026.pdf". The tracker can only see files it uploads and the folders you pick below.</p>
    <ol class="dsteps">
      ${step(1, !!(d && d.configured) && cfgReady, "Set up the Google Cloud project",
        d && d.configured && cfgReady ? `<p>Done.</p>` : `<p>${!cfgReady ? "The tracker is still missing the Google client ID, API key or project number. " : ""}${d && !d.configured ? "Supabase is still missing the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets." : ""}</p>`)}
      ${step(2, !!(d && d.connected), "Connect the Google account that owns the folders",
        d && d.connected ? `<p>Connected as <b>${esc(d.account_email || "your Google account")}</b> on ${esc(fmtDate(String(d.connected_at).slice(0, 10)))}. <button class="linkish-ink" type="button" id="drive-connect">Reconnect</button></p>`
          : `<p>Sign in with the Google account that owns the four folders (jpaul.corpuz@gmail.com) and allow access.</p><button class="primary" type="button" id="drive-connect"${d && d.configured ? "" : " disabled"}>Connect Google Drive</button>`)}
      ${step(3, !!(access && access.granted_at), "Give the tracker access to the four folders",
        `<ul class="dfolders">${folderRows}</ul>` + (access && access.granted_at ? `<p>Access given by ${esc(access.by)} on ${esc(fmtDate(String(access.granted_at).slice(0, 10)))}. <button class="linkish-ink" type="button" id="drive-pick">Pick again</button></p>`
          : `<p>Google opens your Drive. Select all four folders, then click <b>Select</b>.</p><button class="primary" type="button" id="drive-pick"${d && d.connected && cfgReady ? "" : " disabled"}>Choose the four folders</button>`))}
    </ol>
    <span class="err" id="drive-err" hidden></span>
  </div>`;
  const c = $("drive-connect"); if (c) c.onclick = connectDrive;
  const p = $("drive-pick"); if (p) p.onclick = pickFolders;
}
function driveError(msg) { const e = $("drive-err"); if (e) { e.hidden = false; e.textContent = msg; } toast(msg); }
async function connectDrive() {
  try {
    const out = await (await driveCall("connect-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ return_to: location.origin + location.pathname }) })).json();
    location.assign(out.url);
  } catch (e) { driveError(e.message); }
}
async function pickFolders() {
  const g = CFG.google || {}, folders = S.settings.drive_folders || {};
  const want = DOCS.map(([k]) => folders[k] && folders[k].id).filter(Boolean);
  try {
    await loadScript("https://accounts.google.com/gsi/client");
    await loadScript("https://apis.google.com/js/api.js");
    await new Promise(r => window.gapi.load("picker", r));
  } catch (e) { driveError("Couldn't load Google's folder picker. Check your connection and try again."); return; }
  const tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: g.clientId, scope: "https://www.googleapis.com/auth/drive.file",
    callback: resp => {
      if (resp.error) { driveError("Google didn't allow access: " + resp.error); return; }
      const P = window.google.picker;
      const view = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes("application/vnd.google-apps.folder");
      if (folders.parent) view.setParent(folders.parent);
      new P.PickerBuilder().setAppId(g.appId).setOAuthToken(resp.access_token).setDeveloperKey(g.apiKey)
        .addView(view).enableFeature(P.Feature.MULTISELECT_ENABLED).setTitle("Select the Live Scan, Physical Exam, Signed 283b and TB Test folders")
        .setCallback(async data => {
          if (data[P.Response.ACTION] !== P.Action.PICKED) return;
          const picked = data[P.Response.DOCUMENTS].map(x => x[P.Document.ID]);
          const missing = DOCS.filter(([k]) => folders[k] && !picked.includes(folders[k].id)).map(([k]) => folders[k].name);
          if (missing.length) { driveError("Not all four were selected. Pick again and include: " + missing.join(", ") + "."); return; }
          const value = { granted_at: new Date().toISOString(), by: S.me.email };
          const { error } = await sb.from("settings").upsert({ key: "drive_access", value });
          if (error) { driveError(errText(error)); return; }
          S.settings.drive_access = value; renderDrive(); toast("Folder access given. Uploads now go to Google Drive.");
        }).build().setVisible(true);
    }
  });
  tokenClient.requestAccessToken({ prompt: "" });
  if (!want.length) driveError("The folders aren't set in the tracker's settings yet.");
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
  const { data } = await sb.from("activity_log").select("*").eq("student_id", s.id).order("id", { ascending: false }).limit(500);
  if (data && data.length) { data.forEach(e => { if (!S.log.some(x => x.id === e.id)) S.log.push(e); }); S.log.sort((a, b) => b.id - a.id); paint(); }
}
const fetchedHistory = new Set();
function closeDrawer() { $("layer").innerHTML = ""; draftId = null; }
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
    const pb = e.target.closest("[data-pay]"), tr = pb && pb.closest("tr[data-id]");
    const same = tr && tr.dataset.id === popCtx.id && pb.dataset.pay === popCtx.k;
    closePop(); if (same) return;
  }
  const t = e.target.closest("button,[data-close]"); if (!t || !S.me) return;
  if (t.dataset.close) { closeDrawer(); return; }
  if (t.dataset.dtab) { setDrawerTab(t.dataset.dtab); return; }
  if (t.dataset.prog) { S.page = "students"; S.program = t.dataset.prog; S.cohort = ""; S.loc = ""; S.q = ""; $("q").value = ""; try { localStorage.setItem("calace.program", S.program); } catch (err) {} render(); routeAnim(); return; }
  if (t.dataset.page === "log") { S.page = "log"; S.q = ""; $("q").value = ""; S.logLimit = 300; render(); routeAnim(); return; }
  if (t.dataset.page === "drive") { closeDrawer(); S.page = "drive"; render(); routeAnim(); return; }
  if (t.dataset.stu) { openDrawer(t.dataset.stu, "history"); return; }
  if (t.dataset.view) { S.view = (S.view === t.dataset.view && t.closest("#ledger")) ? "all" : t.dataset.view; render(); routeAnim(); return; }
  if (t.id === "add-student" || t.dataset.add) { openDrawer(null); return; }
  if (t.id === "clear-filters") { S.q = ""; $("q").value = ""; S.cohort = ""; S.sched = ""; S.loc = ""; S.view = "all"; render(); return; }
  if (t.id === "export-csv") { exportCsv(); return; }
  if (t.id === "sign-out") { await sb.auth.signOut(); location.reload(); return; }
  if (t.id === "log-more") { S.logLimit += 300; renderLog(); return; }
  const tr = t.closest("tr[data-id]"); if (!tr) return;
  const s = S.students.find(x => x.id === tr.dataset.id); if (!s) return;
  if (t.dataset.open) { openDrawer(s.id, t.dataset.open === "notes" ? "notes" : t.dataset.open === "history" ? "history" : null); return; }
  if (t.dataset.pay) { openPayPop(t, s, t.dataset.pay); return; }
  if (t.dataset.key) {
    const k = t.dataset.key, before = !!s[k], label = t.getAttribute("aria-label"), who = s.first_name + " " + s.last_name;
    t.classList.add("busy");
    try {
      await updateStudent(s.id, { [k]: !before });
      toast(`${label} ${before ? "unticked" : "ticked off"} for ${who}`, () => updateStudent(s.id, { [k]: before }).then(() => toast("Change undone. The undo is logged too.")).catch(err => toast(errText(err))));
    } catch (err) { t.classList.remove("busy"); shake(t); toast(errText(err)); }
  }
});
document.addEventListener("keydown", e => { if (e.key !== "Escape") return; if (popCtx) { closePop(); return; } if ($("layer").innerHTML) closeDrawer(); });
$("wrap").addEventListener("scroll", () => { if (popCtx) closePop(); }, { passive: true });
window.addEventListener("resize", () => { if (popCtx) closePop(); });
let qT; $("q").addEventListener("input", e => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value; renderMain(); }, 120); });
$("f-cohort").addEventListener("change", e => { S.cohort = e.target.value; renderGrid(); });
$("f-sched").addEventListener("change", e => { S.sched = e.target.value; renderGrid(); });
$("f-loc").addEventListener("change", e => { S.loc = e.target.value; renderGrid(); });
$("f-logprog").addEventListener("change", e => { S.logProg = e.target.value; renderLog(); });

/* ---------------- CSV export ---------------- */
function exportCsv() {
  const yn = b => b ? "Yes" : "No";
  const q = v => { v = String(v == null ? "" : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  let cols, rows, name;
  if (S.page === "log") {
    cols = ["Timestamp", "User", "Action", "Student", "Field", "Old", "New", "Details"];
    rows = S.log.map(e => [e.at, e.user_email, e.action, e.student_name, FIELD_LABELS[e.field] || e.field, fmtVal(e.field, e.old_value), fmtVal(e.field, e.new_value), e.details]);
    name = `calace-logs-${ISO_TODAY}.csv`;
  } else {
    cols = ["Student ID", "Last Name", "First Name", "Email", "Phone", "Program", "Pay Plan", "Start Date", "End Date", "Schedule", "Clinical Site", "Waitlist", "Withdrawn", "Dropped",
      ...STAGES.map(([, l]) => l + " Paid"), "Balance", ...REQS.map(([, l]) => l), "Minor Waiver", "Orientation", ...ATT.map(([, l]) => l), ...EXAMS.map(([, l]) => l), "OASYS", "English", "Standing", "Notes"];
    rows = filtered().map(s => { const a = assess(s); return [s.student_code, s.last_name, s.first_name, s.email, s.phone, lab(PROGRAMS, s.program), PLAN_NAMES[s.pay_plan], startOf(s), s.end_date, s.schedule, (siteOf(s) || {}).name, yn(s.waitlist), yn(s.withdrawn), yn(s.dropped),
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
  $("me").textContent = staff.full_name || email;
  $("env").textContent = CFG.environment ? CFG.environment + " data" : ""; $("env").hidden = !CFG.environment;
  playIntro(); render();
  const driveHash = { "drive-connected": "Google Drive is connected. Next, choose the four folders.", "drive-failed": "Google Drive didn't connect. Try again; if it keeps failing, check the Google Cloud setup.", "drive-cancelled": "Google Drive connection was cancelled." }[location.hash.slice(1)];
  if (driveHash) { S.page = "drive"; history.replaceState(null, "", location.pathname + location.search); }
  try { await loadAll(); render(); subscribe(); loadDriveStatus(); if (driveHash) toast(driveHash); }
  catch (e) { setConn("Couldn't load the roster: " + errText(e), ""); $("wrap").innerHTML = `<div class="empty"><h3>Couldn't load students</h3><p>${esc(errText(e))}</p><button class="ghost" type="button" onclick="location.reload()">Try again</button></div>`; }
}
// Local testing only: lets a developer render sample rows without signing in. Writes still need a real session.
if (location.hostname === "localhost") window.__calaceDebug = { S, render, show() { $("gate").hidden = true; $("app").hidden = false; } };

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
