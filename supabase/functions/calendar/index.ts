// CAL ACE: keeps the tracker's start dates in step with the official "CAL ACE Program Calendars" Sheet
// (Cohorts tab: Title, Track, Header, Start, Weeks, Note, Obs; Cells tab: Title, Track, Date, Type, Label, Detail).
//
//   POST sync      hourly by pg_cron (x-cron-key), or an admin ("Sync now")
//   POST resolve   admin: { id, action: "apply" | "dismiss" } for a change that needs confirming
//
// Applied by itself: new start dates (facilities copied from the previous start date), end dates, titles and notes,
// every class day, and moves or removals of start dates that have no students.
// Waits for an admin (calendar_changes): a start date with students that moved or disappeared from the calendar.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const ALLOWED_ORIGINS = ["https://jpaulcorpuz-gif.github.io", "http://localhost:5173"];
const TZ = "America/Los_Angeles";
const MOVE_WINDOW_DAYS = 28;      // a start date that shifted by up to 4 weeks counts as the same class

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") ?? "";
  return { "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5);
const nice = (iso: string | null) => iso ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—";
const PROG = (p: string) => p === "in_person" ? "CNA In-Person" : "CNA Hybrid";
const unhtml = (s: unknown) => String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- who is calling
async function caller(req: Request): Promise<{ kind: "cron" | "admin"; email: string }> {
  const key = req.headers.get("x-cron-key");
  if (key) { const { data: ok } = await db.rpc("check_cron_key", { k: key }); if (ok) return { kind: "cron", email: "Official calendar" }; throw new HttpError(401, "Not allowed."); }
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await db.auth.getUser(jwt);
  const email = data?.user?.email?.toLowerCase();
  if (!email) throw new HttpError(401, "Sign in to the tracker first.");
  const { data: st } = await db.from("staff").select("role, active").eq("email", email).maybeSingle();
  if (!st || !st.active || st.role !== "admin") throw new HttpError(403, "Only admins can sync the official calendar.");
  return { kind: "admin", email };
}

// ---------------------------------------------------------------- reading the Sheet
async function googleToken(): Promise<string> {
  const { data } = await db.from("drive_connection").select("refresh_token").eq("id", 1).maybeSingle();
  if (!data?.refresh_token) throw new HttpError(409, "The Google account isn't connected. An admin can connect it on the Google Cloud page.");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: data.refresh_token, grant_type: "refresh_token" }) });
  const j = await r.json();
  if (!r.ok) throw new HttpError(409, `Google sign-in failed: ${j.error_description ?? j.error}. An admin may need to reconnect on the Google Cloud page.`);
  return j.access_token;
}
// Small CSV reader (quoted fields, commas and line breaks inside quotes).
function csv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
// The official calendar: CAL ACE Program Calendars. Anyone with the link can view it, so it's read as CSV;
// if that stops working (the link was made private), the connected Google account is used instead.
const DEFAULT_CALENDAR = { id: "1ULoXwdNIbXNAKnDvmrM9dxP_JQxxfnP_fLCk2x9kZSY", name: "CAL ACE Program Calendars", gids: { cohorts: "1293118623", cells: "1569617541" } };
async function readSheet(): Promise<{ cohorts: string[][]; cells: string[][]; name: string }> {
  const { data: s } = await db.from("settings").select("value").eq("key", "official_calendar").maybeSingle();
  const cfg = { ...DEFAULT_CALENDAR, ...((s?.value as Record<string, unknown>) ?? {}) } as typeof DEFAULT_CALENDAR;
  const id = cfg.id;
  if (cfg.gids?.cohorts && cfg.gids?.cells) {
    const get = async (gid: string) => { const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`, { redirect: "follow" });
      const t = await r.text(); return r.ok && !/^\s*<!DOCTYPE|<html/i.test(t) ? csv(t) : null; };
    const [co, ce] = await Promise.all([get(cfg.gids.cohorts), get(cfg.gids.cells)]);
    if (co && ce && co.length > 1 && ce.length > 1) return { cohorts: co, cells: ce, name: cfg.name };
  }
  const tok = await googleToken();
  const params = new URLSearchParams(); params.append("ranges", "Cohorts!A1:G1000"); params.append("ranges", "Cells!A1:F10000"); params.set("valueRenderOption", "FORMATTED_VALUE");
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${params}`, { headers: { Authorization: `Bearer ${tok}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, r.status === 404 || r.status === 403
    ? "The tracker can't open the official calendar. Share it with the connected Google account and choose it again on the Google Cloud page."
    : `Google Sheets didn't answer: ${j?.error?.message ?? r.status}`);
  return { cohorts: j.valueRanges?.[0]?.values ?? [], cells: j.valueRanges?.[1]?.values ?? [], name: cfg.name };
}

// ---------------------------------------------------------------- the calendar as start dates
type Day = { track: string; day: string; kind: string; label: string | null; detail: string | null };
type Want = { program: string; start: string; weekday_end: string | null; weekend_end: string | null; title: string; note: string; days: Day[] };
const normDate = (v: string) => { const m = String(v ?? "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : ""; };
const trackOf = (t: string) => { const x = String(t ?? "").toUpperCase().replace(/[^A-Z]/g, ""); return x === "INPERSON" ? "in_person" : x === "WEEKEND" ? "weekend" : x === "WEEKDAY" ? "weekday" : ""; };
function parse(cohortRows: string[][], cellRows: string[][]): Want[] {
  const head = (rows: string[][]) => (rows[0] ?? []).map(h => String(h).trim().toLowerCase());
  const ch = head(cohortRows), ci = (n: string) => ch.indexOf(n);
  const xh = head(cellRows), xi = (n: string) => xh.indexOf(n);
  if (ci("title") < 0 || ci("track") < 0 || ci("start") < 0) throw new HttpError(422, "The Cohorts tab needs Title, Track and Start columns.");
  if (xi("title") < 0 || xi("track") < 0 || xi("date") < 0 || xi("type") < 0) throw new HttpError(422, "The Cells tab needs Title, Track, Date and Type columns.");
  const cells = new Map<string, Day[]>();
  for (const r of cellRows.slice(1)) {
    const track = trackOf(r[xi("track")]), day = normDate(r[xi("date")]); if (!track || !day) continue;
    const key = String(r[xi("title")] ?? "").trim().toUpperCase() + "|" + track;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key)!.push({ track, day, kind: String(r[xi("type")] ?? "").trim().toLowerCase(), label: xi("label") >= 0 ? (String(r[xi("label")] ?? "").trim() || null) : null, detail: xi("detail") >= 0 ? (unhtml(r[xi("detail")]) || null) : null });
  }
  const out = new Map<string, Want>();
  for (const r of cohortRows.slice(1)) {
    const title = String(r[ci("title")] ?? "").trim(), track = trackOf(r[ci("track")]), start = normDate(r[ci("start")]);
    if (!title || !track || !start) continue;
    const program = track === "in_person" ? "in_person" : "hybrid", key = program + "|" + start;
    const days = cells.get(title.toUpperCase() + "|" + track) ?? [];
    const last = days.map(d => d.day).sort().pop() ?? null;
    const w = out.get(key) ?? { program, start, weekday_end: null, weekend_end: null, title, note: "", days: [] };
    if (track === "weekend") w.weekend_end = last; else w.weekday_end = last;
    const note = [ci("note") >= 0 ? unhtml(r[ci("note")]) : "", ci("obs") >= 0 ? unhtml(r[ci("obs")]) : ""].filter(Boolean).join(" ");
    if (note && !w.note.includes(note)) w.note = [w.note, (program === "hybrid" ? (track === "weekend" ? "Weekend: " : "Weekday: ") : "") + note].filter(Boolean).join("\n");
    w.days.push(...days);
    out.set(key, w);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- applying
async function replaceDays(cohortId: number, days: Day[]) {
  await db.from("class_days").delete().eq("cohort_id", cohortId);
  const seen = new Set<string>(), rows = days.filter(d => { const k = d.track + d.day; if (seen.has(k)) return false; seen.add(k); return true; }).map(d => ({ cohort_id: cohortId, ...d }));
  for (let i = 0; i < rows.length; i += 500) { const { error } = await db.from("class_days").insert(rows.slice(i, i + 500)); if (error) throw error; }
}
async function copyFacilities(program: string, cohortId: number, start: string) {
  if (program !== "hybrid") return;
  const { data: prev } = await db.from("cohorts").select("id").eq("program", program).lt("start_date", start).neq("id", cohortId).order("start_date", { ascending: false }).limit(1);
  if (!prev?.length) return;
  const { data: links } = await db.from("cohort_sites").select("site_id, availability, seats").eq("cohort_id", prev[0].id);
  if (links?.length) await db.from("cohort_sites").insert(links.map(l => ({ cohort_id: cohortId, ...l })));
}
// Students with their own end date that matched the old start-date end follow the new one; individual exceptions stay.
async function followEnds(cohortId: number, old: { weekday_end: string | null; weekend_end: string | null }, now: { weekday_end: string | null; weekend_end: string | null }) {
  if (old.weekday_end && now.weekday_end && old.weekday_end !== now.weekday_end)
    await db.from("students").update({ end_date: now.weekday_end }).eq("cohort_id", cohortId).eq("end_date", old.weekday_end).or("schedule.is.null,schedule.neq.weekend");
  if (old.weekend_end && now.weekend_end && old.weekend_end !== now.weekend_end)
    await db.from("students").update({ end_date: now.weekend_end }).eq("cohort_id", cohortId).eq("end_date", old.weekend_end).eq("schedule", "weekend");
}
async function moveCohort(cohortId: number, w: Want) {
  const { data: old } = await db.from("cohorts").select("weekday_end, weekend_end").eq("id", cohortId).maybeSingle();
  if (old) await followEnds(cohortId, old, { weekday_end: w.weekday_end, weekend_end: w.weekend_end });
  const { error } = await db.from("cohorts").update({ start_date: w.start, weekday_end: w.weekday_end, weekend_end: w.program === "hybrid" ? w.weekend_end : null, calendar_title: w.title, calendar_note: w.note || null }).eq("id", cohortId);
  if (error) throw error;
  await replaceDays(cohortId, w.days);
}
async function removeCohort(cohortId: number) {
  const { error } = await db.from("cohorts").update({ open: false, archived: true }).eq("id", cohortId); if (error) throw error;
  await db.from("class_days").delete().eq("cohort_id", cohortId);
}
async function queue(kind: "move_start" | "remove", c: { id: number; program: string; start_date: string }, students: number, w: Want | null) {
  const { data: same } = await db.from("calendar_changes").select("id, status").eq("kind", kind).eq("cohort_id", c.id).in("status", ["pending", "dismissed"]);
  const match = (same ?? []).find(() => true);
  if (match) {
    if (match.status === "pending" && w) await db.from("calendar_changes").update({ to_start: w.start, students, details: w }).eq("id", match.id);   // keep it current
    return false;
  }
  await db.from("calendar_changes").insert({ kind, cohort_id: c.id, program: c.program, from_start: c.start_date, to_start: w?.start ?? null, students, details: w ?? {} });
  return true;
}

async function sync(wants: Want[], autoApprove: boolean) {
  const t = today(), done: string[] = [], waiting: string[] = [];
  const { data: cohorts } = await db.from("cohorts").select("id, program, start_date, weekday_end, weekend_end, open, archived, calendar_title, calendar_note");
  const { data: studs } = await db.from("students").select("cohort_id").not("cohort_id", "is", null);
  const count = new Map<number, number>(); (studs ?? []).forEach(s => count.set(s.cohort_id, (count.get(s.cohort_id) ?? 0) + 1));
  const all = (cohorts ?? []).filter(c => c.program === "hybrid" || c.program === "in_person");
  const byKey = new Map(all.map(c => [c.program + "|" + c.start_date, c]));
  const unmatchedWant: Want[] = [], used = new Set<number>();

  for (const w of wants) {
    const c = byKey.get(w.program + "|" + w.start);
    if (!c) { unmatchedWant.push(w); continue; }
    used.add(c.id);
    const patch: Record<string, unknown> = {};
    if ((w.weekday_end ?? null) !== (c.weekday_end ?? null) && w.weekday_end) patch.weekday_end = w.weekday_end;
    if (w.program === "hybrid" && (w.weekend_end ?? null) !== (c.weekend_end ?? null) && w.weekend_end) patch.weekend_end = w.weekend_end;
    if (w.title !== c.calendar_title) patch.calendar_title = w.title;
    if ((w.note || null) !== (c.calendar_note ?? null)) patch.calendar_note = w.note || null;
    if (Object.keys(patch).length) {
      await followEnds(c.id, c, { weekday_end: (patch.weekday_end as string) ?? c.weekday_end, weekend_end: (patch.weekend_end as string) ?? c.weekend_end });
      const { error } = await db.from("cohorts").update(patch).eq("id", c.id); if (error) throw error;
      const ends = [patch.weekday_end ? `weekday ends ${nice(patch.weekday_end as string)}` : "", patch.weekend_end ? `weekend ends ${nice(patch.weekend_end as string)}` : ""].filter(Boolean);
      if (ends.length) done.push(`${PROG(c.program)} ${nice(c.start_date)}: ${ends.join(", ")}`);
    }
    await replaceDays(c.id, w.days);
  }

  // Start dates in the tracker that the calendar no longer has. Finished classes are left alone.
  const gone = all.filter(c => !used.has(c.id) && !c.archived && [c.weekday_end, c.weekend_end, c.start_date].filter(Boolean).sort().pop()! >= t);
  for (const c of gone) {
    const n = count.get(c.id) ?? 0;
    const partner = unmatchedWant.filter(w => w.program === c.program && Math.abs(dayDiff(w.start, c.start_date)) <= MOVE_WINDOW_DAYS)
      .sort((a, b) => Math.abs(dayDiff(a.start, c.start_date)) - Math.abs(dayDiff(b.start, c.start_date)))[0];
    if (partner) {
      unmatchedWant.splice(unmatchedWant.indexOf(partner), 1);
      if (!n || autoApprove) { await moveCohort(c.id, partner); done.push(`${PROG(c.program)} ${nice(c.start_date)} moved to ${nice(partner.start)}${n ? ` with its ${n} students` : ""}`); }
      else if (await queue("move_start", c, n, partner)) waiting.push(`${PROG(c.program)} ${nice(c.start_date)} → ${nice(partner.start)} (${n} students)`);
    } else {
      if (!n || autoApprove) { await removeCohort(c.id); done.push(`${PROG(c.program)} ${nice(c.start_date)} closed and archived (not on the calendar)${n ? `; its ${n} students keep it` : ""}`); }
      else if (await queue("remove", c, n, null)) waiting.push(`${PROG(c.program)} ${nice(c.start_date)} isn't on the calendar (${n} students)`);
    }
  }

  // New start dates.
  for (const w of unmatchedWant) {
    const row = { program: w.program, start_date: w.start, weekday_end: w.weekday_end, weekend_end: w.program === "hybrid" ? w.weekend_end : null, open: w.start >= t, archived: false,
      calendar_title: w.title, calendar_note: w.note || null, ...(w.program === "in_person" ? { seats: 15, waitlist_seats: 2 } : {}) };
    const { data, error } = await db.from("cohorts").insert(row).select("id").single(); if (error) throw error;
    await copyFacilities(w.program, data.id, w.start);
    await replaceDays(data.id, w.days);
    done.push(`${PROG(w.program)} ${nice(w.start)} added`);
  }
  return { done, waiting };
}

async function record(result: { ok: boolean; done?: string[]; waiting?: string[]; error?: string }, by: string) {
  const { data: prev } = await db.from("settings").select("value").eq("key", "calendar_sync").maybeSingle();
  const history = ((prev?.value as { history?: unknown[] })?.history ?? []).slice(0, 19);
  const entry = { at: new Date().toISOString(), by, ...result };
  if (result.done?.length || result.error) history.unshift(entry);
  await db.from("settings").upsert({ key: "calendar_sync", value: { last: entry, history } });
  if (result.done?.length) await db.from("activity_log").insert({ user_email: by, action: "Official calendar sync", student_name: `${result.done.length} change${result.done.length === 1 ? "" : "s"}`, details: result.done.join("; ").slice(0, 1800) });
}

// ---------------------------------------------------------------- routes
async function routeSync(req: Request) {
  const who = await caller(req);
  try {
    const rows = await readSheet();
    const wants = parse(rows.cohorts, rows.cells);
    if (!wants.length) throw new HttpError(422, "The official calendar has no start dates. Nothing was changed.");
    const r = await sync(wants, false);
    await record({ ok: true, done: r.done, waiting: r.waiting }, who.email);
    return json(req, { ok: true, ...r, start_dates: wants.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await record({ ok: false, error: msg }, who.email);
    throw e instanceof HttpError ? e : new HttpError(500, msg);
  }
}
async function routeResolve(req: Request) {
  const who = await caller(req); if (who.kind !== "admin") throw new HttpError(403, "Only admins can confirm calendar changes.");
  const { id, action } = await req.json().catch(() => ({}));
  const { data: ch } = await db.from("calendar_changes").select("*").eq("id", id).eq("status", "pending").maybeSingle();
  if (!ch) throw new HttpError(404, "That change was already handled.");
  if (action === "apply") {
    if (ch.kind === "move_start") await moveCohort(ch.cohort_id, ch.details as Want); else await removeCohort(ch.cohort_id);
  } else if (action !== "dismiss") throw new HttpError(400, "Choose apply or dismiss.");
  await db.from("calendar_changes").update({ status: action === "apply" ? "applied" : "dismissed", resolved_at: new Date().toISOString(), resolved_by: who.email }).eq("id", id);
  const text = ch.kind === "move_start" ? `${PROG(ch.program)} ${nice(ch.from_start)} → ${nice(ch.to_start)}` : `${PROG(ch.program)} ${nice(ch.from_start)} closed and archived`;
  await db.from("activity_log").insert({ user_email: who.email, action: action === "apply" ? "Calendar change applied" : "Calendar change dismissed", student_name: text, details: ch.students ? `${ch.students} students` : null });
  return json(req, { ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  try {
    if (route === "sync" && req.method === "POST") return await routeSync(req);
    if (route === "resolve" && req.method === "POST") return await routeResolve(req);
    return json(req, { error: "Not found" }, 404);
  } catch (e) {
    const s = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error(e);
    return json(req, { error: e instanceof Error ? e.message : "Something went wrong." }, s);
  }
});
