/* CAL ACE public Registration page. Talks only to the "register" Edge Function; no sign-in. */
(function () {
  "use strict";
  const CFG = window.CALACE_CONFIG || {};
  const API = CFG.supabaseUrl + "/functions/v1/register/";
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const longDate = iso => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" }) : "";
  const shortDate = iso => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  const money = n => "$" + Number(n).toFixed(Number(n) % 1 ? 2 : 0);

  const st = { program: new URLSearchParams(location.search).get("program") === "in_person" ? "in_person" : "hybrid", data: null, cohort: null, sched: "", site: null, score: "" };

  // ---------- program switch ----------
  function setProgram(p) {
    st.program = p; st.cohort = null; st.sched = p === "in_person" ? "weekday" : ""; st.site = null;
    document.querySelectorAll("[data-prog]").forEach(b => b.setAttribute("aria-checked", String(b.dataset.prog === p)));
    const u = new URL(location.href); if (p === "in_person") u.searchParams.set("program", "in_person"); else u.searchParams.delete("program"); history.replaceState(null, "", u);
    $("s-prog").textContent = p === "in_person" ? "CNA In-Person" : "CNA Hybrid";
    loadClasses();
  }
  document.querySelectorAll("[data-prog]").forEach(b => b.onclick = () => { if (st.program !== b.dataset.prog) setProgram(b.dataset.prog); });

  // ---------- classes ----------
  async function loadClasses() {
    $("class-loading").hidden = false; $("class-pick").hidden = true; $("class-none").hidden = true;
    try {
      const r = await fetch(API + "options?program=" + st.program, { headers: { apikey: CFG.supabaseKey } });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "Couldn't load classes.");
      st.data = j;
    } catch (e) {
      $("class-loading").hidden = true; $("class-none").hidden = false;
      $("class-none").innerHTML = `We couldn't load the open classes. Check your connection and <a href="${esc(location.href)}">reload the page</a>.`;
      return;
    }
    $("class-loading").hidden = true;
    if (!st.data.cohorts.length) {
      $("class-none").hidden = false;
      $("class-none").innerHTML = `There are no ${st.program === "in_person" ? "In-Person" : "Hybrid"} start dates open for sign-up right now. Text us at <a href="sms:+14082561347">(408) 256-1347</a> and we'll tell you when the next class opens.`;
      drawSummary(); return;
    }
    $("class-pick").hidden = false;
    $("sched-wrap").hidden = st.program === "in_person";
    $("site-lbl").textContent = st.program === "in_person" ? "Location" : "Clinical facility";
    if (st.data.cohorts.length === 1) st.cohort = st.data.cohorts[0];
    drawClass();
  }
  function groupsFor() {
    if (!st.cohort) return [];
    return st.cohort.groups.filter(g => st.program === "in_person" || g.schedule === st.sched);
  }
  function seatsLeft(g) { return Math.max(0, g.cap - g.taken); }
  // Start dates as a carousel: one card per date, scrolled with the arrows, a swipe or the keyboard.
  function carousel() {
    let track = $("starts");
    if (!track.classList.contains("car-track")) {
      const wrap = document.createElement("div"); wrap.className = "car";
      track.parentNode.insertBefore(wrap, track);
      wrap.innerHTML = `<button type="button" class="car-btn prev" aria-label="Earlier start dates">‹</button><button type="button" class="car-btn next" aria-label="Later start dates">›</button>`;
      wrap.insertBefore(track, wrap.lastChild); track.classList.add("car-track");
      const step = dir => track.scrollBy({ left: dir * Math.max(track.clientWidth * 0.8, 160), behavior: "smooth" });
      wrap.querySelector(".prev").onclick = () => step(-1); wrap.querySelector(".next").onclick = () => step(1);
      track.addEventListener("scroll", carArrows, { passive: true }); window.addEventListener("resize", carArrows);
      const cal = document.createElement("div"); cal.id = "class-cal"; cal.className = "ccal"; cal.hidden = true;
      $("start-err").after(cal);
    }
    return track;
  }
  function carArrows() {
    const t = $("starts"), w = t.parentNode; if (!w.classList.contains("car")) return;
    w.querySelector(".prev").disabled = t.scrollLeft < 4; w.querySelector(".next").disabled = t.scrollLeft + t.clientWidth > t.scrollWidth - 4;
  }
  function drawClass() {
    const track = carousel(), keep = track.scrollLeft;
    track.innerHTML = st.data.cohorts.map(c => {
      const open = c.groups.some(g => !g.full), sel = st.cohort && st.cohort.id === c.id, d = new Date(c.start + "T00:00:00");
      const left = c.groups.filter(g => !g.full).reduce((t, g) => t + Math.max(0, g.cap - g.taken), 0);
      return `<button type="button" class="opt car-card" role="radio" aria-checked="${!!sel}" data-cohort="${c.id}" aria-label="${esc(longDate(c.start))}">
        <span class="cc-mon">${esc(d.toLocaleDateString("en-US", { month: "short" }))} ${d.getFullYear()}</span><span class="cc-day">${d.getDate()}</span>
        <small>${esc(d.toLocaleDateString("en-US", { weekday: "long" }))}</small><span class="cc-seat ${open ? "ok" : "full"}">${open ? left + " seats open" : "Waitlist only"}</span></button>`;
    }).join("");
    track.scrollLeft = keep;
    document.querySelectorAll("[data-cohort]").forEach(b => b.onclick = () => {
      const changed = !st.cohort || st.cohort.id !== +b.dataset.cohort;
      st.cohort = st.data.cohorts.find(c => c.id === +b.dataset.cohort); if (changed) st.site = null;
      markOk("start-err"); drawClass();
      const card = document.querySelector(`[data-cohort="${st.cohort.id}"]`); if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
    track.onkeydown = e => { if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return; const cards = [...track.children], i = cards.indexOf(document.activeElement); if (i < 0) return;
      e.preventDefault(); const n = cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))]; n.focus(); n.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" }); };
    requestAnimationFrame(carArrows);
    drawCalendar();
    document.querySelectorAll("[data-sched]").forEach(b => {
      const has = st.cohort ? st.cohort.groups.some(g => g.schedule === b.dataset.sched) : true;
      b.disabled = !has; b.setAttribute("aria-checked", String(st.sched === b.dataset.sched));
      b.querySelector("small").textContent = (b.dataset.sched === "weekday" ? "Mon–Fri" : "Sat–Sun") + (has ? "" : " · not this date");
      b.onclick = () => { st.sched = b.dataset.sched; st.site = null; markOk("sched-err"); drawClass(); };
    });
    if (st.cohort && st.sched && !st.cohort.groups.some(g => g.schedule === st.sched) && st.program !== "in_person") { st.sched = ""; }
    const gs = groupsFor();
    if (st.program === "in_person" && gs.length === 1) st.site = gs[0];
    $("sites").innerHTML = !st.cohort ? `<p class="hint">Choose a start date first.</p>` : (!st.sched && st.program !== "in_person") ? `<p class="hint">Choose weekday or weekend first.</p>`
      : !gs.length ? `<p class="hint">No facilities for this schedule on this date. Try the other schedule or another start date.</p>`
      : gs.map(g => { const left = seatsLeft(g), sel = st.site && st.site.site_id === g.site_id && st.site.schedule === g.schedule, pct = Math.min(100, Math.round(g.taken / g.cap * 100));
        const tag = g.full ? (g.waitlist_open ? `<span class="tag full">Full · waitlist open</span>` : `<span class="tag full">Full</span>`) : left <= 3 ? `<span class="tag low">${left} ${left === 1 ? "seat" : "seats"} left</span>` : `<span class="tag ok">${left} seats left</span>`;
        return `<button type="button" class="opt site${g.full ? " isfull" : ""}" role="radio" aria-checked="${!!sel}" data-site="${g.site_id}"${g.full && !g.waitlist_open ? " disabled" : ""}>
          <span class="left"><b>${esc(g.short)}</b><small>${esc(g.city || g.site)}</small></span>${tag}<span class="meter" aria-hidden="true"><i style="width:${pct}%"></i></span></button>`; }).join("");
    document.querySelectorAll("[data-site]").forEach(b => b.onclick = () => { st.site = gs.find(g => g.site_id === +b.dataset.site); markOk("site-err"); drawClass(); });
    $("idyl").hidden = !(st.site && st.site.idylwood);
    $("wl").hidden = !(st.site && st.site.full);
    if (st.site && st.site.full) $("wl-text").textContent = `All ${st.site.cap} seats for this start date, schedule and facility are taken. You can still register for the waitlist; the Registrar will contact you as soon as a seat opens.`;
    drawSummary();
  }
  // The chosen class on a month calendar: start, 3 weeks of online theory (Mon–Fri), clinical days for the chosen schedule, and the end.
  const isoOf = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return isoOf(d); };
  function dayKind(iso, c, sched) {
    const dow = new Date(iso + "T00:00:00").getDay(), wkday = dow >= 1 && dow <= 5, wkend = dow === 0 || dow === 6;
    if (st.program === "in_person") return iso >= c.start && iso <= (c.weekday_end || c.start) && wkday ? "class" : "";
    const theoryEnd = addDays(c.start, 20);
    if (iso >= c.start && iso <= theoryEnd) return wkday ? "theory" : "";
    const inWk = c.weekday_end && iso > theoryEnd && iso <= c.weekday_end && wkday, inWe = c.weekend_end && iso > theoryEnd && iso <= c.weekend_end && wkend;
    if (sched === "weekday") return inWk ? "clin" : ""; if (sched === "weekend") return inWe ? "clin" : "";
    return inWk ? "clin-wk" : inWe ? "clin-we" : "";
  }
  function drawCalendar() {
    const box = $("class-cal"); if (!box) return;
    const c = st.cohort; if (!c) { box.hidden = true; return; }
    const sched = st.program === "in_person" ? "weekday" : st.sched;
    const end = st.program === "in_person" ? c.weekday_end : sched === "weekend" ? c.weekend_end : sched === "weekday" ? c.weekday_end : [c.weekday_end, c.weekend_end].filter(Boolean).sort().pop();
    // Every month from the start to the end date, one after another (no paging).
    const months = []; for (let d = new Date(c.start.slice(0, 7) + "-01T00:00:00"), lastM = (end || c.start).slice(0, 7); isoOf(d).slice(0, 7) <= lastM && months.length < 12; d.setMonth(d.getMonth() + 1)) months.push(isoOf(d).slice(0, 7));
    const ends = st.program === "in_person" ? [c.weekday_end] : sched === "weekday" ? [c.weekday_end] : sched === "weekend" ? [c.weekend_end] : [c.weekday_end, c.weekend_end];
    const label = { theory: "Online theory (Zoom)", clin: sched === "weekend" ? "Weekend clinicals" : "Weekday clinicals", "clin-wk": "Weekday clinicals", "clin-we": "Weekend clinicals", class: "In-person class day" };
    const month = ym => {
      const [y, m] = ym.split("-").map(Number), m1 = new Date(y, m - 1, 1), lead = m1.getDay(), n = new Date(y, m, 0).getDate();
      const cells = [...Array(lead)].map(() => `<span class="ccal-d blank" aria-hidden="true"></span>`).concat([...Array(n)].map((_, i) => {
        const d = `${ym}-${String(i + 1).padStart(2, "0")}`, k = dayKind(d, c, sched), isStart = d === c.start, isEnd = ends.includes(d);
        const tip = [isStart ? "First day" : "", isEnd ? "Last day" : "", label[k] || ""].filter(Boolean).join(" · ");
        return `<span class="ccal-d${k ? " k-" + k : ""}${isStart ? " start" : ""}${isEnd ? " end" : ""}" role="gridcell"${tip ? ` title="${esc(tip)}" aria-label="${esc(longDate(d) + ": " + tip)}"` : ""}>${i + 1}</span>`; }));
      return `<div class="ccal-month"><p class="ccal-mh">${esc(m1.toLocaleDateString("en-US", { month: "long", year: "numeric" }))}</p>
        <div class="ccal-grid" role="grid" aria-label="${esc(m1.toLocaleDateString("en-US", { month: "long", year: "numeric" }))}">${["S", "M", "T", "W", "T", "F", "S"].map(d => `<span class="ccal-wd" aria-hidden="true">${d}</span>`).join("")}${cells.join("")}</div></div>`;
    };
    box.hidden = false;
    box.innerHTML = `<div class="ccal-months">${months.map(month).join("")}</div>
      <div class="ccal-key">${st.program === "in_person" ? `<span><i class="k-class"></i>Class days (Mon–Fri)</span>`
        : `<span><i class="k-theory"></i>Online theory, first 3 weeks (Mon–Fri)</span>${sched ? `<span><i class="k-clin"></i>${esc(label.clin)}</span>` : `<span><i class="k-clin-wk"></i>Weekday clinicals</span><span><i class="k-clin-we"></i>Weekend clinicals</span>`}`}
        <span><i class="k-start"></i>First / last day</span></div>
      <p class="hint ccal-note">${esc(longDate(c.start))} to ${end ? esc(longDate(end)) : "the end date"}${!sched && st.program !== "in_person" ? ". Pick weekday or weekend below to see your clinical days" : ""}. Exact clinical days are confirmed in your Welcome Letter.</p>`;  }
  function drawSummary() {
    const c = st.cohort, g = st.site, sched = st.program === "in_person" ? "weekday" : st.sched;
    $("s-start").textContent = c ? longDate(c.start) : "Not chosen";
    $("s-sched").textContent = st.program === "in_person" ? "Full-time, Mon–Fri" : sched ? (sched === "weekend" ? "Weekend (Sat–Sun)" : "Weekday (Mon–Fri)") : "Not chosen";
    $("s-site").textContent = g ? g.short + (g.city ? ", " + g.city : "") : "Not chosen";
    const end = c ? (sched === "weekend" ? c.weekend_end : c.weekday_end) : "";
    $("s-end").textContent = end ? shortDate(end) : "—";
    const box = $("s-seats");
    if (g) { box.hidden = false; box.querySelector("i").style.width = Math.min(100, Math.round(g.taken / g.cap * 100)) + "%";
      box.querySelector("p").textContent = g.full ? "This group is full. You can join the waitlist." : `${seatsLeft(g)} of ${g.cap} seats left in this group`; }
    else box.hidden = true;
    const f = feeFor();
    $("s-fee").innerHTML = f ? `<b>${money(f.amount)} registration fee</b> secures your seat once you register. You can pay by card, Zelle or check.` : "";
  }
  function feeFor() {
    if (!st.data) return null; const fees = st.data.fees;
    if (st.program === "in_person") return fees.in_person;
    return st.cohort && st.cohort.start < fees.promo_from ? fees.standard : fees.promo;
  }

  // ---------- validation ----------
  const val = id => ($(id).value || "").trim();
  const digits = s => s.replace(/\D/g, "");
  function markBad(id, msg) { const el = $(id); const f = el && el.closest(".f"); if (f) { f.classList.add("bad"); if (msg) { const e = f.querySelector(".err"); if (e) e.textContent = msg; } } else { const e = $(id + "-err") || $(id); if (e) e.classList.add("show"); } }
  function markOk(id) { const el = $(id); const f = el && el.closest(".f"); if (f) f.classList.remove("bad"); const e = $(id + "-err") || (el && el.classList.contains("err") ? el : null); if (e) e.classList.remove("show"); }
  document.querySelectorAll("#form input, #form select").forEach(el => ["input", "change"].forEach(ev => el.addEventListener(ev, () => markOk(el.id))));
  function ageOn(dob, on) { const [y, m, d] = dob.split("-").map(Number), [Y, M, D] = on.split("-").map(Number); return Y - y - (M < m || (M === m && D < d) ? 1 : 0); }
  function minorNow() { const d = val("dob"); if (!d) return false; const a = ageOn(d, st.cohort ? st.cohort.start : (st.data ? st.data.today : new Date().toISOString().slice(0, 10))); return a >= 16 && a < 18; }
  $("dob").addEventListener("change", () => {
    const d = val("dob"), h = $("age-hint"); if (!d) { h.textContent = ""; $("guardian").hidden = true; return; }
    const a = ageOn(d, st.cohort ? st.cohort.start : new Date().toISOString().slice(0, 10));
    h.textContent = a < 16 ? `${a} years old. You must be at least 16 to enroll in the CNA program.` : a < 18 ? `${a} years old. You'll need a parent or guardian.` : "";
    h.style.color = a < 16 ? "var(--bad)" : ""; $("guardian").hidden = !minorNow();
  });
  // Common email typos: gmial.com, yahoo.con …
  const FIX = { "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gamil.com": "gmail.com", "yahoo.con": "yahoo.com", "yaho.com": "yahoo.com", "hotmail.con": "hotmail.com", "outlook.con": "outlook.com", "icloud.con": "icloud.com" };
  $("email").addEventListener("blur", () => {
    const e = val("email").toLowerCase(), dom = e.split("@")[1], p = $("email-fix");
    if (dom && FIX[dom]) { const fixed = e.split("@")[0] + "@" + FIX[dom]; p.hidden = false; p.innerHTML = `Did you mean <button type="button" class="btn ghost" style="padding:2px 8px">${esc(fixed)}</button>?`; p.querySelector("button").onclick = () => { $("email").value = fixed; p.hidden = true; }; }
    else p.hidden = true;
  });
  const fmtPhone = el => el.addEventListener("blur", () => { const d = digits(el.value); if (d.length === 10) el.value = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`; else if (d.length === 11 && d[0] === "1") el.value = `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`; });
  ["phone", "emergency_phone", "guardian_phone"].forEach(id => fmtPhone($(id)));
  document.querySelectorAll("[data-eye]").forEach(b => b.onclick = () => { const i = $(b.dataset.eye), show = i.type === "password"; i.type = show ? "text" : "password"; $("password2").type = i.type; b.textContent = show ? "Hide" : "Show"; });

  function validate() {
    document.querySelectorAll("#form .f.bad").forEach(f => f.classList.remove("bad")); document.querySelectorAll("#form .err.show").forEach(e => e.classList.remove("show"));
    let first = null; const bad = (id, msg) => { markBad(id, msg); if (!first) first = $(id) || $(id + "-err"); };
    if (!val("first_name")) bad("first_name"); if (!val("last_name")) bad("last_name");
    const d = val("dob");
    if (!d) bad("dob", "Enter your date of birth.");
    else { const a = ageOn(d, st.cohort ? st.cohort.start : new Date().toISOString().slice(0, 10)); if (a < 16 || a > 100) bad("dob", "You must be at least 16 on the start date to enroll."); }
    if (minorNow()) {
      if (!val("guardian_name")) bad("guardian_name"); if (!val("guardian_relationship")) bad("guardian_relationship");
      if (digits(val("guardian_phone")).length < 10) bad("guardian_phone"); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val("guardian_email"))) bad("guardian_email");
      if (!$("guardian_ok").checked) bad("guardian_ok");
    }
    if (!$("has_ssn").checked) bad("has_ssn");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val("email"))) bad("email");
    if (digits(val("phone")).length < 10) bad("phone");
    if (val("address").length < 8) bad("address");
    if (!st.cohort) bad("start-err");
    else if (st.program !== "in_person" && !st.sched) bad("sched-err");
    else if (!st.site) bad("site-err");
    else { if (st.site.idylwood && !$("idylwood_ok").checked) bad("idylwood_ok"); if (st.site.full && !$("waitlist").checked) bad("waitlist"); }
    if (!val("emergency_name")) bad("emergency_name"); if (digits(val("emergency_phone")).length < 10) bad("emergency_phone");
    if ($("password").value.length < 8) bad("password");
    else if ($("password").value !== $("password2").value) bad("password2");
    if (first) { first.scrollIntoView({ behavior: "smooth", block: "center" }); if (first.focus) setTimeout(() => first.focus({ preventScroll: true }), 300); }
    return !first;
  }

  // ---------- reading & math check (same 16 questions as before) ----------
  const TEST = [
    { h: "Part 1 · Words", p: "Choose the best answer for each question.", qs: [
      ['Which word means the opposite of "hot"?', ["Big", "Cold", "Fast", "Old"], 1],
      ['"She ___ a student." Which word completes the sentence?', ["are", "am", "is", "be"], 2],
      ['Which word means the same as "big"?', ["Small", "Large", "Thin", "Short"], 1]] },
    { h: "Part 2 · Sentences", p: "Read each sentence, then answer the question.", qs: [
      ['"The class starts at 9:00 in the morning." What time does the class start?', ["10:00", "12:00", "9:00", "5:00"], 2],
      ['"Please wash your hands before you touch a patient." What should you do before you touch a patient?', ["Open the window", "Turn off the light", "Eat lunch", "Wash your hands"], 3],
      ['"Do not eat or drink before the test." What is NOT allowed before the test?', ["Sleeping", "Walking", "Talking", "Eating and drinking"], 3]] },
    { h: "Part 3 · A short note", p: "Your class starts on Monday. In person: 7:30 AM in Room 103. Bring a blank ink pen and a notebook. Hybrid: join online on Zoom at 9:00 AM or 5:00 PM. Turn on your electronic device.", passage: true, qs: [
      ["What day does the class start?", ["Monday", "Tuesday", "Friday", "Sunday"], 0],
      ["What time does the in-person class start?", ["9:00 AM", "5:00 PM", "7:30 AM", "8:30 AM"], 2],
      ["Where is the in-person class?", ["Room 5", "Room 103", "Room 10", "Room 15"], 1],
      ["What should in-person students bring?", ["A blank ink pen and a notebook", "A phone and keys", "Lunch and water", "Nothing"], 0],
      ["What should hybrid students do?", ["Come to Room 103", "Join on Zoom and turn on their electronic device", "Call the school", "Stay home and say nothing"], 1]] },
    { h: "Part 4 · Basic math and measurement", p: "Read each question and choose the best answer.", qs: [
      ["One cup is 240 ml. How many ml is half a cup?", ["60 ml", "120 ml", "180 ml", "480 ml"], 1],
      ["A patient drinks 2 cups of liquid at breakfast. One cup is 240 ml. How many ml did she drink?", ["240 ml", "360 ml", "480 ml", "600 ml"], 2],
      ["A bottle has 500 ml. The patient drinks 200 ml. How many ml are left?", ["200 ml", "300 ml", "400 ml", "700 ml"], 1],
      ["A normal breathing rate (RR) is 12 to 20 breaths per minute. Which rate is in the normal range?", ["8", "14", "24", "30"], 1],
      ["A normal adult pulse is 60 to 100 beats per minute. Which pulse is in the normal range?", ["40", "72", "110", "130"], 1]] }];
  const TOTAL = TEST.reduce((t, p) => t + p.qs.length, 0);
  let built = false;
  function openCheck() {
    if (!built) {
      let n = 0;
      $("check-body").innerHTML = TEST.map((part, pi) => `<div class="part"><p class="part-h">${esc(part.h)}</p>${part.passage ? `<div class="passage">${esc(part.p)}</div>` : `<p class="hint">${esc(part.p)}</p>`}
        ${part.qs.map((q, qi) => { n++; return `<div class="q" role="radiogroup" aria-label="Question ${n}"><p>${n}. ${esc(q[0])}</p><div class="opts">${q[1].map((o, oi) => `<label><input type="radio" name="q${pi}_${qi}" value="${oi}"><span>${esc(o)}</span></label>`).join("")}</div></div>`; }).join("")}</div>`).join("");
      $("check-body").addEventListener("change", () => { const a = $("check-body").querySelectorAll("input:checked").length; $("check-count").textContent = `Answered ${a} of ${TOTAL}`; $("check-done").disabled = a < TOTAL; });
      built = true;
    }
    $("check").hidden = false; document.body.style.overflow = "hidden"; $("check-body").scrollTop = 0;
    setTimeout(() => { const f = $("check-body").querySelector("input"); if (f) f.focus(); }, 50);
  }
  function closeCheck() { $("check").hidden = true; document.body.style.overflow = ""; }
  $("check-x").onclick = closeCheck;
  $("check").addEventListener("keydown", e => { if (e.key === "Escape") closeCheck(); });
  function score() { let ok = 0; TEST.forEach((p, pi) => p.qs.forEach((q, qi) => { const c = document.querySelector(`input[name="q${pi}_${qi}"]:checked`); if (c && +c.value === q[2]) ok++; })); return ok + "/" + TOTAL; }

  // ---------- submit ----------
  $("form").addEventListener("submit", e => { e.preventDefault(); $("banner").hidden = true; if (validate()) openCheck(); });
  $("check-done").onclick = async () => {
    const b = $("check-done"); b.disabled = true; b.textContent = "Saving your registration…";
    const minor = minorNow();
    const body = {
      program: st.program, company: val("company"),
      first_name: val("first_name"), last_name: val("last_name"), dob: val("dob"), gender: val("gender"), has_ssn: $("has_ssn").checked,
      guardian_name: minor ? val("guardian_name") : "", guardian_relationship: minor ? val("guardian_relationship") : "", guardian_phone: minor ? val("guardian_phone") : "", guardian_email: minor ? val("guardian_email") : "",
      email: val("email"), phone: val("phone"), address: val("address"), referral: val("referral"),
      cohort_id: st.cohort.id, schedule: st.program === "in_person" ? "weekday" : st.sched, site_id: st.site.site_id,
      idylwood_ok: $("idylwood_ok").checked, waitlist: $("waitlist").checked,
      emergency_name: val("emergency_name"), emergency_phone: val("emergency_phone"), password: $("password").value, english_score: score(),
    };
    try {
      const r = await fetch(API + "submit", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "We couldn't save your registration. Please try again.");
      closeCheck(); showDone(j, body);
    } catch (err) {
      closeCheck(); b.disabled = false; b.textContent = "Finish & submit my registration";
      $("banner").hidden = false; $("banner").textContent = err.message; $("banner").scrollIntoView({ behavior: "smooth", block: "center" });
      if (/start date|facility|seats|waitlist/i.test(err.message)) loadClasses();
    }
  };

  function showDone(j, body) {
    document.querySelector(".hero").hidden = true; $("main").hidden = true;
    const d = $("done"); d.hidden = false; window.scrollTo(0, 0);
    const prog = body.program === "in_person" ? "CNA In-Person" : "CNA Hybrid";
    const sched = body.program === "in_person" ? "Full-time, Mon–Fri" : body.schedule === "weekend" ? "Weekend (Sat–Sun)" : "Weekday (Mon–Fri)";
    const total = j.pay.amount + j.pay.card_fee;
    d.innerHTML = `<section class="card ok-card">
      <div class="ok-mark"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></div>
      <h2>${j.waitlist ? "You're on the waitlist" : "You're registered!"}</h2>
      <p>Thank you, ${esc(body.first_name)}. ${j.waitlist ? "Your group is full right now, so you're on its waitlist. The Registrar will contact you as soon as a seat opens." : `We saved your registration for the <b>${esc(prog)}</b> class starting <b>${esc(longDate(j.start))}</b>.`} The Registrar will contact you at <b>${esc(body.email)}</b> with next steps.</p>
      ${j.waitlist ? "" : `<div class="pay">
        <h3>Pay your registration fee to secure your seat</h3>
        <p class="hint">Seats are held for students who have paid, so your seat is confirmed once your fee is in.</p>
        <div class="amt">${money(j.pay.amount)} <small>registration fee</small></div>
        <a class="btn primary big" href="${esc(j.pay.link)}" target="_blank" rel="noopener">Pay ${money(j.pay.amount)} by card</a>
        <p class="hint" style="margin-top:8px">Paid securely through Stripe. A card processing fee of ${money(j.pay.card_fee)} is added (${money(total)} total).</p>
        <div class="alt"><div><b>Zelle (no fee)</b>payments@calacenursingacademy.com<br>Put your full name in the memo.</div><div><b>Check (no fee)</b>Payable to CALACE NURSING ACADEMY<br>1535 Landess Ave, Unit 103, Milpitas, CA 95035</div></div>
      </div>`}
      ${j.minor ? `<p class="hint" style="margin-top:16px">Because you're under 18, we'll contact your parent or guardian about the consent and waiver forms.</p>` : ""}
    </section>
    <aside class="card side"><p class="side-h">Your class</p><dl class="sum">
      <div><dt>Program</dt><dd>${esc(prog)}</dd></div><div><dt>Start date</dt><dd>${esc(longDate(j.start))}</dd></div>
      <div><dt>Schedule</dt><dd>${esc(sched)}</dd></div><div><dt>${body.program === "in_person" ? "Location" : "Clinical facility"}</dt><dd>${esc(j.site.replace(/^Group\s+/i, ""))}</dd></div>
      ${j.end ? `<div><dt>Ends</dt><dd>${esc(shortDate(j.end))}</dd></div>` : ""}<div><dt>Status</dt><dd>${j.waitlist ? "Waitlist" : "Registered, fee due"}</dd></div></dl>
      <p class="side-h small">Next steps</p><ul class="next"><li>Pay your registration fee</li><li>Live Scan background clearance</li><li>TB test and physical exam</li><li>CDPH 283B form</li><li>Student orientation</li></ul></aside>`;
  }

  setProgram(st.program);
})();
