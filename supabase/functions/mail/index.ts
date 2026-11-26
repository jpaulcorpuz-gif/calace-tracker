// CAL ACE tracker: sending email from Gmail. Uses the email sending account connected on the Google Drive page
// (row 2 of drive_connection), or the folder account (row 1) if it allowed sending and no sending account is connected.
//
// Routes (all under /functions/v1/mail/):
//   GET  status   staff     Can the tracker send, and from which address; how many sent today
//   POST send     staff*    { messages: [{ to, bcc?, subject, html, student_id?, kind? }], attachments: [{ name, url }] }
//                           *needs Email templates (view or edit) or Leads edit access
//   POST auto     scheduler Sends the automatic emails that are switched on (called every 15 minutes by pg_cron with x-cron-key)
//
// Automatic emails, each at most once per student (unique index on email_sends):
//   followup_1..3   unpaid leads who signed up after the email was switched on; due 1, 3, 7 days after the previous step
//   welcome         students whose first payment was recorded after it was switched on
//   start_reminder  active paid students, auto_days days before their start date
//   missing_reqs    active paid students still missing clinical requirements, auto_days days before their start date
//   custom (auto_rule) added by staff: before/after start, after end, after sign-up, after first payment; audience filters

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const ALLOWED_ORIGINS = ["https://jpaulcorpuz-gif.github.io", "http://localhost:5173"];
const TZ = "America/Los_Angeles";
const MAX_PER_REQUEST = 100, MAX_AUTO_PER_RUN = 80, MAX_ATTACH_BYTES = 20 * 1024 * 1024;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") ?? "";
  return { "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

type Caller = { email: string; name: string };
async function requireSender(req: Request): Promise<Caller> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new HttpError(401, "Sign in to the tracker first.");
  const { data, error } = await db.auth.getUser(jwt);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) throw new HttpError(401, "Your sign-in has expired. Reload the tracker and sign in again.");
  const { data: st } = await db.from("staff").select("role, active, permissions, full_name").eq("email", email).maybeSingle();
  if (!st || !st.active) throw new HttpError(403, "This account isn't on the staff list.");
  const p = (st.permissions ?? {}) as Record<string, number>;
  if (st.role !== "admin" && !(Number(p.templates ?? 0) >= 1 || Number(p.leads ?? 0) >= 2)) throw new HttpError(403, "You don't have permission to send email. Ask an admin for Email templates access.");
  return { email, name: st.full_name ?? email };
}

// ---------------------------------------------------------------- Gmail
// Sends from the email sending account (row 2) when one is connected, otherwise from the Drive account (row 1) if it allowed sending.
let token: { value: string; expires: number; scopes: string; key: string } | null = null;
async function gmailToken(): Promise<{ value: string; account: string | null }> {
  const { data: rows } = await db.from("drive_connection").select("id, refresh_token, account_email, scopes, connected_at");
  const data = (rows ?? []).find(r => r.id === 2) ?? (rows ?? []).find(r => r.id === 1 && String(r.scopes ?? "").includes("gmail.send"));
  if (!data?.refresh_token) throw new HttpError(409, "No email sending account is connected. An admin can connect one on the Google Drive page.");
  const key = data.id + "|" + data.connected_at;
  if (token && token.key === key && token.expires > Date.now() + 60_000) return { value: token.value, account: data.account_email };
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: data.refresh_token, grant_type: "refresh_token" }) });
  const j = await r.json();
  if (!r.ok) throw new HttpError(j.error === "invalid_grant" ? 409 : 502, j.error === "invalid_grant" ? "Google access was revoked. An admin needs to reconnect on the Google Drive page." : `Google sign-in failed: ${j.error_description ?? j.error}`);
  token = { value: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000, scopes: j.scope ?? "", key };
  return { value: token.value, account: data.account_email };
}
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const b64utf8 = (s: string) => b64(new TextEncoder().encode(s));
const wrap76 = (s: string) => s.replace(/(.{76})/g, "$1\r\n");
const encHeader = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64utf8(s)}?=`;
function htmlToText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<li[^>]*>/gi, "• ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
}
type Att = { name: string; type: string; data: Uint8Array };
async function loadAttachments(list: { name?: string; url?: string }[]): Promise<Att[]> {
  const out: Att[] = []; let total = 0;
  for (const a of list ?? []) {
    const url = String(a.url ?? "");
    if (!url.startsWith(SUPABASE_URL + "/storage/v1/object/public/email-assets/")) continue;   // only files uploaded to the tracker
    const r = await fetch(url); if (!r.ok) throw new HttpError(502, `Couldn't load the attachment ${a.name ?? ""}.`);
    const data = new Uint8Array(await r.arrayBuffer()); total += data.length;
    if (total > MAX_ATTACH_BYTES) throw new HttpError(413, "Attachments are over 20 MB in total.");
    out.push({ name: String(a.name ?? "attachment"), type: r.headers.get("content-type") ?? "application/octet-stream", data });
  }
  return out;
}
function mime(from: string, to: string, bcc: string, subject: string, html: string, atts: Att[]): string {
  const alt = "alt" + crypto.randomUUID().replace(/-/g, ""), mix = "mix" + crypto.randomUUID().replace(/-/g, "");
  const doc = `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1e252d">${html}</body></html>`;
  const head = [`From: ${encHeader("CAL ACE Nursing Academy")} <${from}>`, to ? `To: ${to}` : "", bcc ? `Bcc: ${bcc}` : "", `Subject: ${encHeader(subject)}`, "MIME-Version: 1.0"].filter(Boolean);
  const altPart = [`--${alt}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64utf8(htmlToText(html))),
    `--${alt}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64utf8(doc)), `--${alt}--`].join("\r\n");
  if (!atts.length) return [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, "", altPart].join("\r\n");
  const parts = atts.map(a => [`--${mix}`, `Content-Type: ${a.type}; name="${encHeader(a.name)}"`, "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${encHeader(a.name)}"`, "", wrap76(b64(a.data))].join("\r\n"));
  return [...head, `Content-Type: multipart/mixed; boundary="${mix}"`, "", `--${mix}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "", altPart, ...parts, `--${mix}--`].join("\r\n");
}
async function gmailSend(tok: string, raw: string): Promise<string> {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: b64utf8(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 403 && /insufficient/i.test(JSON.stringify(j))) throw new HttpError(409, "The sending account didn't allow sending. An admin needs to connect it again on the Google Drive page.");
    if (r.status === 429) throw new HttpError(429, "Gmail's daily sending limit was reached. Try again tomorrow.");
    throw new HttpError(502, `Gmail didn't send it: ${j?.error?.message ?? r.status}`);
  }
  return j.id;
}
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const splitList = (s: string) => String(s ?? "").split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(validEmail);

async function logSend(row: Record<string, unknown>, studentName: string | null, by: string) {
  await db.from("email_sends").insert(row);
  if (row.student_id && row.status === "sent") await db.from("activity_log").insert({ user_email: by, action: "Email sent", student_id: row.student_id, student_name: studentName, details: String(row.subject ?? "") });
}

// ---------------------------------------------------------------- routes
async function status(req: Request) {
  await requireSender(req).catch(() => null);   // anyone signed in may ask; details only matter to senders
  const { data: rows } = await db.from("drive_connection").select("id, account_email, scopes");
  const data = (rows ?? []).find(r => r.id === 2) ?? (rows ?? []).find(r => r.id === 1 && String(r.scopes ?? "").includes("gmail.send"));
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count } = await db.from("email_sends").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", since);
  return json(req, { connected: !!data, can_send: !!data, account: data?.account_email ?? null, sent_24h: count ?? 0 });
}

async function send(req: Request) {
  const c = await requireSender(req);
  const body = await req.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) throw new HttpError(400, "Nothing to send.");
  if (messages.length > MAX_PER_REQUEST) throw new HttpError(400, `Send at most ${MAX_PER_REQUEST} emails at a time.`);
  const tok = await gmailToken(); if (!tok.account) throw new HttpError(409, "The connected Google account has no email address.");
  const atts = await loadAttachments(body.attachments ?? []);
  const results: { to: string; ok: boolean; error?: string }[] = [];
  for (const m of messages) {
    const to = splitList(m.to).join(", "), bcc = splitList(m.bcc).join(", "), subject = String(m.subject ?? "").trim(), html = String(m.html ?? "");
    if (!to && !bcc) { results.push({ to: String(m.to ?? ""), ok: false, error: "No valid email address" }); continue; }
    if (!subject) throw new HttpError(400, "Add a subject.");
    let student: { id: string; first_name: string; last_name: string } | null = null;
    if (m.student_id) { const { data } = await db.from("students").select("id, first_name, last_name").eq("id", m.student_id).maybeSingle(); student = data; }
    try {
      await gmailSend(tok.value, mime(tok.account, to, bcc, subject, html, atts));
      await logSend({ student_id: student?.id ?? null, kind: String(m.kind ?? "manual"), subject, sent_by: c.email, to_email: to || bcc, template_id: m.template_id ?? null, status: "sent", auto: false },
        student ? `${student.last_name}, ${student.first_name}` : null, c.email);
      results.push({ to: to || bcc, ok: true });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 409 || e.status === 429)) throw e;   // stop: nothing else will go either
      const msg = e instanceof Error ? e.message : "Failed";
      await db.from("email_sends").insert({ student_id: student?.id ?? null, kind: String(m.kind ?? "manual"), subject, sent_by: c.email, to_email: to || bcc, status: "failed", error: msg, auto: false });
      results.push({ to: to || bcc, ok: false, error: msg });
    }
  }
  return json(req, { sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok), from: tok.account });
}

// ---------------------------------------------------------------- automatic emails
type Student = Record<string, unknown> & { id: string; first_name: string; last_name: string; email: string | null; program: string; pay_plan: string; cohort_id: number | null; site_id: number | null; schedule: string | null; created_at: string; end_date?: string | null };
const PROGRAM = (p: string) => p === "in_person" ? "CNA In-Person" : "CNA Hybrid";
const REQS: [string, string][] = [["form_283b", "283B form"], ["live_scan", "Live Scan"], ["tb_test", "TB test"], ["physical_exam", "Physical exam"], ["onboarding", "Onboarding letter"], ["valid_id", "Valid ID"]];
const FOLLOW = [["followup_1", "followup_1_at", 1], ["followup_2", "followup_2_at", 3], ["followup_3", "followup_3_at", 7]] as const;
const isoInTZ = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const longDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

async function auto(req: Request) {
  const key = req.headers.get("x-cron-key") ?? "";
  const { data: ok } = await db.rpc("check_cron_key", { k: key });
  if (!ok) throw new HttpError(401, "Not allowed.");
  const { data: all } = await db.from("email_templates").select("*").eq("auto_on", true);
  const tpls = (all ?? []).filter(t => t.auto_key || t.auto_rule);   // built-in automatic emails, and ones staff added
  if (!tpls.length) return json(req, { sent: 0, note: "No automatic emails are switched on." });
  let tok; try { tok = await gmailToken(); } catch (e) { return json(req, { sent: 0, note: e instanceof Error ? e.message : "Gmail not ready" }); }

  const [{ data: students }, { data: pays }, { data: cohorts }, { data: sites }, { data: settings }, { data: done }] = await Promise.all([
    db.from("students").select("*").eq("withdrawn", false).eq("dropped", false),
    db.from("payments").select("student_id, amount, created_at"),
    db.from("cohorts").select("id, start_date, weekday_end, weekend_end"),
    db.from("sites").select("id, short_name"),
    db.from("settings").select("value").eq("key", "pay_plans").maybeSingle(),
    db.from("email_sends").select("student_id, kind").eq("auto", true).eq("status", "sent"),
  ]);
  const plans = (settings?.value ?? {}) as Record<string, Record<string, number>>;
  const paid = new Map<string, number>(), firstPay = new Map<string, string>();
  for (const p of pays ?? []) {
    if (Number(p.amount) > 0) { const t = firstPay.get(p.student_id); if (!t || p.created_at < t) firstPay.set(p.student_id, p.created_at); }
    paid.set(p.student_id, (paid.get(p.student_id) ?? 0) + Number(p.amount));
  }
  const sent = new Set((done ?? []).map(d => d.student_id + "|" + d.kind));
  const startOf = (s: Student) => (cohorts ?? []).find(c => c.id === s.cohort_id)?.start_date ?? null;
  const endOf = (s: Student): string | null => { if (s.end_date) return String(s.end_date); const c = (cohorts ?? []).find(x => x.id === s.cohort_id);
    return c ? ((s.schedule === "weekend" && c.weekend_end) || c.weekday_end || c.weekend_end || null) : null; };
  const today = isoInTZ(new Date());
  const values = (s: Student): Record<string, string> => {
    const start = startOf(s), plan = plans[s.pay_plan] ?? {}, due = Object.values(plan).reduce((t, v) => t + Number(v || 0), 0);
    const missing = REQS.filter(([k]) => !s[k]).map(([, l]) => l);
    return { first_name: s.first_name ?? "", last_name: s.last_name ?? "", program: PROGRAM(s.program), start_date: start ? longDate(start) : "soon",
      schedule: s.schedule === "weekend" ? "weekend" : s.schedule === "weekday" ? "weekday" : "", site: (sites ?? []).find(x => x.id === s.site_id)?.short_name ?? "your clinical site",
      registration: Number(plan.registration) > 0 ? money(Number(plan.registration)) : "", balance: money(Math.max(0, due - (paid.get(s.id) ?? 0))),
      missing_requirements: missing.length ? missing.join(", ") : "nothing", email: s.email ?? "", phone: String(s.phone ?? ""), staff_name: "The CAL ACE team" };
  };
  const fill = (t: string, v: Record<string, string>, html: boolean) => String(t ?? "").replace(/\{(\w+)\}/g, (m, k) => k in v ? (html ? esc(v[k]) : v[k]) : m);

  let total = 0; const report: Record<string, number> = {};
  for (const t of tpls) {
    const since = t.auto_on_since ? String(t.auto_on_since) : new Date().toISOString();
    const kind: string = t.auto_key ?? ("tpl:" + t.id);
    let list: Student[] = (students ?? []) as Student[];
    list = list.filter(s => s.email && validEmail(String(s.email)) && !sent.has(s.id + "|" + kind));
    const isPaid = (s: Student) => (paid.get(s.id) ?? 0) > 0;
    const f = FOLLOW.find(x => x[0] === t.auto_key);
    if (f) {
      const idx = FOLLOW.indexOf(f);
      list = list.filter(s => !isPaid(s) && !s[f[1]] && s.created_at >= since && FOLLOW.slice(0, idx).every(p => !!s[p[1]])).filter(s => {
        const base = idx === 0 ? s.created_at : String(s[FOLLOW[idx - 1][1]]);
        return addDays(isoInTZ(new Date(base)), f[2]) <= today;
      });
    } else if (t.auto_key === "welcome") {
      list = list.filter(s => isPaid(s) && (firstPay.get(s.id) ?? "") >= since);
    } else if (t.auto_key === "start_reminder" || t.auto_key === "missing_reqs") {
      const days = Number(t.auto_days ?? 0);
      list = list.filter(s => isPaid(s) && startOf(s) && addDays(today, days) === startOf(s));
      if (t.auto_key === "missing_reqs") list = list.filter(s => REQS.some(([k]) => !s[k]));
    } else if (!t.auto_key && t.auto_rule) {
      // Added by staff. Date-based events fire on one exact day; sign-up and payment events only for students from the switch-on time.
      const r = t.auto_rule as { event?: string; days?: number; audience?: string; program?: string; missing_only?: boolean };
      const days = Math.max(0, Math.min(365, Math.round(Number(r.days ?? 0))));
      if (r.program) list = list.filter(s => s.program === r.program);
      if (r.audience === "paid") list = list.filter(isPaid); else if (r.audience === "unpaid") list = list.filter(s => !isPaid(s));
      if (r.missing_only) list = list.filter(s => REQS.some(([k]) => !s[k]));
      if (r.event === "before_start") list = list.filter(s => !!startOf(s) && addDays(today, days) === startOf(s));
      else if (r.event === "after_start") list = list.filter(s => !!startOf(s) && addDays(startOf(s)!, days) === today);
      else if (r.event === "after_end") list = list.filter(s => { const e = endOf(s); return !!e && addDays(e, days) === today; });
      else if (r.event === "after_signup") list = list.filter(s => s.created_at >= since && addDays(isoInTZ(new Date(s.created_at)), days) <= today);
      else if (r.event === "first_payment") list = list.filter(s => { const fp = firstPay.get(s.id); return !!fp && fp >= since && addDays(isoInTZ(new Date(fp)), days) <= today; });
      else list = [];
    } else list = [];

    let n = 0;
    const atts = list.length ? await loadAttachments(t.attachments ?? []) : [];
    for (const s of list) {
      if (total >= MAX_AUTO_PER_RUN) break;
      const v = values(s), subject = fill(t.subject, v, false), html = fill(t.body_html, v, true);
      // Claim the send first so a slow run can't send the same email twice.
      const { error: claimErr } = await db.from("email_sends").insert({ student_id: s.id, kind, subject, sent_by: "Automatic", to_email: s.email, template_id: t.id, status: "sent", auto: true });
      if (claimErr) continue;
      try {
        await gmailSend(tok.value, mime(tok.account!, String(s.email), "", subject, html, atts));
        await db.from("activity_log").insert({ user_email: "Automatic email", action: "Email sent", student_id: s.id, student_name: `${s.last_name}, ${s.first_name}`, details: subject });
        if (f) await db.from("students").update({ [f[1]]: new Date().toISOString() }).eq("id", s.id);
        n++; total++;
      } catch (e) {
        await db.from("email_sends").update({ status: "failed", error: e instanceof Error ? e.message : "Failed" }).eq("student_id", s.id).eq("kind", kind).eq("auto", true).eq("status", "sent");
        if (e instanceof HttpError && (e.status === 409 || e.status === 429)) return json(req, { sent: total, stopped: e.message, report });
      }
    }
    report[t.auto_key ?? t.name] = n;
  }
  return json(req, { sent: total, report });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  try {
    if (route === "status" && req.method === "GET") return await status(req);
    if (route === "send" && req.method === "POST") return await send(req);
    if (route === "auto" && req.method === "POST") return await auto(req);
    return json(req, { error: "Not found" }, 404);
  } catch (e) {
    const s = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error(e);
    return json(req, { error: e instanceof Error ? e.message : "Something went wrong." }, s);
  }
});
