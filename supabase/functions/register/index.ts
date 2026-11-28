// CAL ACE: public CNA Registration page (register.html). No sign-in needed.
//
//   GET  options?program=hybrid|in_person   open start dates, their facilities (Weekday/Weekend) and live seats
//   POST submit                              saves the student in the tracker (shows on Leads until they pay)
//
// Seats are held only by PAID students (any payment recorded), the same rule as the Business Overview.
// Start dates, facilities and seat counts come from Class Configuration in the tracker.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGINS = ["https://jpaulcorpuz-gif.github.io", "http://localhost:5173"];
const TZ = "America/Los_Angeles";
const MAX_PER_HOUR = 8;          // sign-up attempts per connection per hour
const MIN_AGE = 16, ADULT = 18;

// Registration fee, paid by card on Stripe. Hybrid students starting on or after PROMO_FROM pay the $50 promo;
// In-Person students pay $50. (Same links as the current Apps Script form.)
const PROMO_FROM = "2026-11-30";
const PAY = {
  promo: { plan: "promo_50", amount: 50, link: "https://pay.calacenursingacademy.com/b/fZu8wQ3k54KwfCjdGdfw40F" },
  standard: { plan: "standard", amount: 200, link: "https://pay.calacenursingacademy.com/b/aEU01e2HfbUT8WkaEM" },
  in_person: { plan: "in_person", amount: 50, link: "https://pay.calacenursingacademy.com/b/fZu8wQ3k54KwfCjdGdfw40F" },
};
const cardFee = (a: number) => Math.round(((a + 0.30) / (1 - 0.029) - a) * 100) / 100;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") ?? "";
  return { "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const ageOn = (dob: string, on: string) => { const [y, m, d] = dob.split("-").map(Number), [Y, M, D] = on.split("-").map(Number); return Y - y - (M < m || (M === m && D < d) ? 1 : 0); };

type Group = { site_id: number; site: string; short: string; city: string; schedule: string; cap: number; taken: number; waiting: number; full: boolean; waitlist_open: boolean; idylwood: boolean };
type Cohort = { id: number; start: string; weekday_end: string | null; weekend_end: string | null; waitlist_seats: number | null; groups: Group[] };

async function loadOptions(program: string): Promise<Cohort[]> {
  const t = today();
  const [{ data: cohorts }, { data: links }, { data: sites }, { data: cap }] = await Promise.all([
    db.from("cohorts").select("id, program, start_date, weekday_end, weekend_end, seats, waitlist_seats, closes_on, open, archived").eq("program", program).eq("open", true).eq("archived", false).gte("start_date", t).order("start_date"),
    db.from("cohort_sites").select("cohort_id, site_id, availability, seats"),
    db.from("sites").select("id, name, short_name, city, kind, active, sort_order").order("sort_order"),
    db.from("settings").select("value").eq("key", "seat_cap").maybeSingle(),
  ]);
  const list = (cohorts ?? []).filter(c => !c.closes_on || c.closes_on >= t);
  if (!list.length) return [];
  const ids = list.map(c => c.id);
  const { data: studs } = await db.from("students").select("id, cohort_id, site_id, schedule, waitlist").in("cohort_id", ids).eq("withdrawn", false).eq("dropped", false);
  const sIds = (studs ?? []).map(s => s.id);
  const paid = new Set<string>();
  for (let i = 0; i < sIds.length; i += 300) {
    const { data: pays } = await db.from("payments").select("student_id, amount").in("student_id", sIds.slice(i, i + 300));
    const sum = new Map<string, number>(); (pays ?? []).forEach(p => sum.set(p.student_id, (sum.get(p.student_id) ?? 0) + Number(p.amount)));
    sum.forEach((v, k) => { if (v > 0) paid.add(k); });
  }
  const defCap = Number(typeof cap?.value === "object" ? (cap?.value as Record<string, number>)?.value : cap?.value) || 13;
  const siteById = new Map((sites ?? []).map(s => [s.id, s]));
  return list.map(c => {
    const groups: Group[] = [];
    const add = (siteId: number, schedule: string, seats: number | null) => {
      const s = siteById.get(siteId); if (!s || (s.active === false && s.kind !== "in_person")) return;   // the In-Person campus is kept "off" so it stays out of clinical lists
      const here = (studs ?? []).filter(x => x.cohort_id === c.id && x.site_id === siteId && (program === "in_person" || x.schedule === schedule) && paid.has(x.id));
      const taken = here.filter(x => !x.waitlist).length, waiting = here.filter(x => x.waitlist).length, capN = seats || defCap;
      const wlOpen = c.waitlist_seats == null ? true : waiting < c.waitlist_seats;
      groups.push({ site_id: siteId, site: s.name, short: s.short_name || s.name, city: s.city || "", schedule, cap: capN, taken, waiting, full: taken >= capN, waitlist_open: wlOpen, idylwood: /idylwood/i.test(s.name) });
    };
    if (program === "in_person") (sites ?? []).filter(s => s.kind === "in_person").forEach(s => add(s.id, "weekday", c.seats));
    else (links ?? []).filter(l => l.cohort_id === c.id && l.availability && l.availability !== "off").forEach(l => {
      const s = siteById.get(l.site_id); if (!s || s.kind !== "clinical") return;
      if (l.availability === "both" || l.availability === "weekday") add(l.site_id, "weekday", l.seats);
      if (l.availability === "both" || l.availability === "weekend") add(l.site_id, "weekend", l.seats);
    });
    return { id: c.id, start: c.start_date, weekday_end: c.weekday_end, weekend_end: c.weekend_end, waitlist_seats: c.waitlist_seats, groups };
  }).filter(c => c.groups.length);
}

async function options(req: Request) {
  const program = new URL(req.url).searchParams.get("program") === "in_person" ? "in_person" : "hybrid";
  const cohorts = await loadOptions(program);
  const fee = (p: typeof PAY.promo) => ({ amount: p.amount, card_fee: cardFee(p.amount) });
  return json(req, { program, today: today(), cohorts, fees: { promo_from: PROMO_FROM, promo: fee(PAY.promo), standard: fee(PAY.standard), in_person: fee(PAY.in_person) } });
}

async function ipKey(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SUPABASE_URL + "|" + ip));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function submit(req: Request) {
  const d = await req.json().catch(() => ({}));
  if (clean(d.company)) return json(req, { ok: true });     // honeypot: bots fill the hidden field; pretend it worked
  const ip = await ipKey(req);
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db.from("registration_attempts").select("id", { count: "exact", head: true }).eq("ip_hash", ip).gte("at", since);
  await db.from("registration_attempts").insert({ ip_hash: ip });
  if ((count ?? 0) >= MAX_PER_HOUR) throw new HttpError(429, "Too many sign-ups from this connection. Wait an hour, or text us at (408) 256-1347.");

  const program = d.program === "in_person" ? "in_person" : "hybrid";
  const first = clean(d.first_name, 80), last = clean(d.last_name, 80), email = clean(d.email, 160).toLowerCase();
  const phone = clean(d.phone, 40), address = clean(d.address, 300), dob = clean(d.dob, 10), gender = clean(d.gender, 30);
  const ecName = clean(d.emergency_name, 120), ecPhone = clean(d.emergency_phone, 40), referral = clean(d.referral, 60);
  const password = String(d.password ?? "");
  const english = /^\d{1,2}\/16$/.test(String(d.english_score ?? "")) ? String(d.english_score) : null;
  if (!first || !last) throw new HttpError(400, "Enter your first and last name.");
  if (!validEmail(email)) throw new HttpError(400, "Enter a valid email address.");
  if (phone.replace(/\D/g, "").length < 10) throw new HttpError(400, "Enter a valid phone number.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new HttpError(400, "Enter your date of birth.");
  if (address.length < 8) throw new HttpError(400, "Enter your street, city, state and ZIP.");
  if (!ecName || ecPhone.replace(/\D/g, "").length < 10) throw new HttpError(400, "Enter an emergency contact name and phone number.");
  if (d.has_ssn !== true) throw new HttpError(400, "A Tax ID (ITIN) or Social Security Number is required to enroll.");
  if (password.length < 8 || password.length > 72) throw new HttpError(400, "Use a password of at least 8 characters.");

  // The class: it must be one the page offered, and still open.
  const cohorts = await loadOptions(program);
  const c = cohorts.find(x => x.id === Number(d.cohort_id));
  if (!c) throw new HttpError(409, "That start date is no longer open. Reload the page and pick another one.");
  const schedule = program === "in_person" ? "weekday" : (d.schedule === "weekend" ? "weekend" : "weekday");
  const g = c.groups.find(x => x.site_id === Number(d.site_id) && x.schedule === schedule);
  if (!g) throw new HttpError(409, "That clinical facility isn't offered for this start date and schedule. Reload the page and pick again.");
  if (g.idylwood && d.idylwood_ok !== true) throw new HttpError(400, "Please agree to Idylwood's clinical requirements, or choose another facility.");
  let waitlist = false;
  if (g.full) {
    if (!g.waitlist_open) throw new HttpError(409, "This group and its waitlist are full. Pick another facility or start date, or text us at (408) 256-1347.");
    if (d.waitlist !== true) throw new HttpError(409, `All ${g.cap} seats in this group are taken. Tick the waitlist box to join the waitlist.`);
    waitlist = true;
  }
  const age = ageOn(dob, c.start);
  if (age < MIN_AGE || age > 100) throw new HttpError(400, `You must be at least ${MIN_AGE} on the start date to enroll in the CNA program.`);
  const minor = age < ADULT;
  const guardian = { name: clean(d.guardian_name, 120), rel: clean(d.guardian_relationship, 60), phone: clean(d.guardian_phone, 40), email: clean(d.guardian_email, 160).toLowerCase() };
  if (minor && (!guardian.name || !guardian.rel || guardian.phone.replace(/\D/g, "").length < 10 || !validEmail(guardian.email)))
    throw new HttpError(400, "Students under 18 need a parent or guardian's name, relationship, phone and email.");

  const { data: dupe } = await db.from("students").select("id").ilike("email", email).limit(1);
  if (dupe && dupe.length) throw new HttpError(409, `${email} is already registered. Text us at (408) 256-1347 if you need to change your class.`);

  // The student's own sign-in for the student portal. If the address already has a sign-in, it's left as it is.
  let authId: string | null = null;
  const { data: au, error: auErr } = await db.auth.admin.createUser({ email, password, email_confirm: false, user_metadata: { kind: "student", first_name: first, last_name: last } });
  if (!auErr) authId = au.user?.id ?? null;
  else if (!/already|registered|exists/i.test(auErr.message)) console.error("createUser", auErr.message);

  const pay = program === "in_person" ? PAY.in_person : c.start >= PROMO_FROM ? PAY.promo : PAY.standard;
  const row = {
    program, pay_plan: pay.plan, first_name: first, last_name: last, email, phone, address, date_of_birth: dob, gender: gender || null,
    emergency_name: ecName, emergency_phone: ecPhone, cohort_id: c.id, schedule, site_id: g.site_id, waitlist,
    english_score: english, referral_source: referral || null, has_ssn: true,
    guardian_name: minor ? guardian.name : null, guardian_relationship: minor ? guardian.rel : null, guardian_phone: minor ? guardian.phone : null, guardian_email: minor ? guardian.email : null,
    signup_source: "Registration page", auth_user_id: authId,
    notes: `Registered online ${today()}${waitlist ? " (waitlist)" : ""}.${english ? ` Reading & math check: ${english}.` : ""}`,
  };
  const { data: st, error } = await db.from("students").insert(row).select("id").single();
  if (error) { if (authId) await db.auth.admin.deleteUser(authId).catch(() => null); console.error(error); throw new HttpError(500, "We couldn't save your registration. Please try again, or text us at (408) 256-1347."); }
  await db.from("registration_attempts").update({ ok: true }).eq("ip_hash", ip).gte("at", since);
  const end = program === "in_person" ? c.weekday_end : schedule === "weekend" ? c.weekend_end : c.weekday_end;
  return json(req, { ok: true, id: st.id, waitlist, minor, start: c.start, end, schedule, site: g.site, city: g.city,
    pay: { amount: pay.amount, card_fee: cardFee(pay.amount), link: `${pay.link}?prefilled_email=${encodeURIComponent(email)}` } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  try {
    if (route === "options" && req.method === "GET") return await options(req);
    if (route === "submit" && req.method === "POST") return await submit(req);
    return json(req, { error: "Not found" }, 404);
  } catch (e) {
    const s = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error(e);
    return json(req, { error: e instanceof HttpError ? e.message : "Something went wrong. Please try again." }, s);
  }
});
