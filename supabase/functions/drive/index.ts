// CAL ACE tracker: Google Drive document storage.
//
// Routes (all under /functions/v1/drive/):
//   POST connect-url  admin   Start connecting the school's Google account (returns the Google sign-in URL)
//   POST exchange     admin   { code, state } from Google's return to the tracker page; we keep offline access
//   GET  status       staff   Is Drive connected, and as which account
//   POST upload       staff   multipart: student_id, kind, file. Saves "{First Last} - {Start Date}.ext" into that kind's folder
//   GET  file?id=     staff   Streams a stored document so staff can view it without Drive sharing
//   POST remove       staff   { id } Moves the file to Drive's trash and removes it from the student
//   POST import       admin   { spreadsheet_id, confirm: "REPLACE" } Replaces the tracker's data with the Project1 Sheet
//
// Secrets (Supabase › Edge Functions › Secrets): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
// Scope is drive.file: the tracker only sees files it created and folders an admin picked for it.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const RETURN_URLS = ["https://jpaulcorpuz-gif.github.io/calace-tracker/", "http://localhost:5173/"];
// drive.file for documents; gmail.send so the tracker can send email from this account (Tools › Email Templates).
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.send openid email";
const ALLOWED_ORIGINS = ["https://jpaulcorpuz-gif.github.io", "http://localhost:5173"];

const KINDS: Record<string, string> = {
  live_scan: "Live Scan", "283b_signed": "Signed 283B", physical_exam: "Physical exam", tb_test: "TB test", valid_id: "Valid ID",
};
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"];

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "content-disposition",
    "Vary": "Origin",
  };
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
}

type Caller = { email: string; role: string; jwt: string; permissions: Record<string, unknown> };
async function requireStaff(req: Request, adminOnly = false): Promise<Caller> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new HttpError(401, "Sign in to the tracker first.");
  const { data, error } = await admin.auth.getUser(jwt);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) throw new HttpError(401, "Your sign-in has expired. Reload the tracker and sign in again.");
  const { data: staff } = await admin.from("staff").select("role, active, permissions").eq("email", email).maybeSingle();
  if (!staff || !staff.active) throw new HttpError(403, "This account isn't on the staff list.");
  if (adminOnly && staff.role !== "admin") throw new HttpError(403, "Only an admin can do this.");
  return { email, role: staff.role, jwt, permissions: staff.permissions ?? {} };
}
// Same rule as private.perm(): admins have everything; others use their saved level (0 none, 1 view, 2 edit).
function need(c: Caller, area: string, level: number) {
  if (c.role === "admin") return;
  if (Number(c.permissions?.[area] ?? 0) < level) throw new HttpError(403, level > 1 ? "You can view student records but not change documents. Ask an admin for edit access." : "You don't have access to student documents.");
}
// A client that acts as the signed-in staff member, so row level security and the activity log see them.
function asUser(c: Caller) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${c.jwt}` } },
  });
}

let cachedToken: { value: string; expires: number } | null = null;
async function driveToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new HttpError(503, "Google Drive isn't set up yet: the Google client ID and secret are missing.");
  const { data } = await admin.from("drive_connection").select("refresh_token").eq("id", 1).maybeSingle();
  if (!data?.refresh_token) throw new HttpError(409, "Google Drive isn't connected yet. An admin can connect it on the Google Drive page.");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: data.refresh_token, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!r.ok) {
    if (j.error === "invalid_grant") throw new HttpError(409, "Google Drive access was revoked. An admin needs to reconnect it on the Google Drive page.");
    throw new HttpError(502, `Google sign-in failed: ${j.error_description ?? j.error}`);
  }
  cachedToken = { value: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

async function folders(): Promise<Record<string, { id: string; name: string }>> {
  const { data } = await admin.from("settings").select("value").eq("key", "drive_folders").maybeSingle();
  return (data?.value ?? {}) as Record<string, { id: string; name: string }>;
}

function longDate(iso: string | null): string {
  if (!iso) return "No start date";
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[m - 1]} ${d}, ${y}`;
}
function extensionOf(name: string, type: string): string {
  const m = name.match(/\.([A-Za-z0-9]{1,5})$/);
  if (m) return "." + m[1].toLowerCase();
  return ({ "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/heic": ".heic", "image/heif": ".heif", "image/webp": ".webp" } as Record<string, string>)[type] ?? "";
}

async function trashDriveFile(token: string, fileId: string | null) {
  if (!fileId) return;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
  if (!r.ok && r.status !== 404) throw new HttpError(502, `Google Drive couldn't move the old file to the trash (${r.status}).`);
}

// ---------------------------------------------------------------- routes

async function connectUrl(req: Request) {
  const c = await requireStaff(req, true);
  if (!CLIENT_ID || !CLIENT_SECRET) throw new HttpError(503, "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the Supabase Edge Function secrets first.");
  const body = await req.json().catch(() => ({}));
  // Google sends the admin back to the tracker page itself; it must be one of the registered redirect URIs.
  const returnTo = typeof body.return_to === "string" && RETURN_URLS.includes(body.return_to) ? body.return_to : RETURN_URLS[0];
  const state = crypto.randomUUID() + crypto.randomUUID();
  await admin.from("drive_oauth_states").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
  const { error } = await admin.from("drive_oauth_states").insert({ state, created_by: c.email, return_to: returnTo });
  if (error) throw new HttpError(500, error.message);
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: returnTo, response_type: "code", scope: SCOPES,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  return json(req, { url });
}

// The tracker page receives ?code&state from Google and posts them here with the admin's sign-in.
async function exchange(req: Request) {
  const c = await requireStaff(req, true);
  const { code, state } = await req.json().catch(() => ({}));
  const { data: st } = await admin.from("drive_oauth_states").select("*").eq("state", String(state ?? "")).maybeSingle();
  if (!st) throw new HttpError(400, "This Google sign-in link is no longer valid. Click Connect Google Drive again.");
  await admin.from("drive_oauth_states").delete().eq("state", st.state);
  if (st.created_by !== c.email) throw new HttpError(403, "Finish the Google sign-in with the same tracker account that started it.");
  if (Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) throw new HttpError(400, "The Google sign-in took too long. Click Connect Google Drive again.");
  if (!code) throw new HttpError(400, "Google didn't send a sign-in code.");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: String(code), client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: st.return_to, grant_type: "authorization_code" }),
  });
  const tok = await r.json();
  if (!r.ok) throw new HttpError(502, `Google didn't accept the sign-in: ${tok.error_description ?? tok.error}`);
  if (!tok.refresh_token) throw new HttpError(502, "Google didn't grant offline access. Remove CAL ACE Tracker at myaccount.google.com/permissions, then connect again.");
  if (!String(tok.scope ?? "").includes("drive.file")) throw new HttpError(400, "Drive access wasn't allowed. Connect again and tick the Google Drive box.");
  let accountEmail: string | null = null;
  try { accountEmail = JSON.parse(atob(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email ?? null; } catch { /* email is only for display */ }
  const { error } = await admin.from("drive_connection").upsert({
    id: 1, refresh_token: tok.refresh_token, account_email: accountEmail, connected_by: c.email, connected_at: new Date().toISOString(), scopes: String(tok.scope ?? ""),
  });
  if (error) throw new HttpError(500, error.message);
  cachedToken = null;
  await admin.from("activity_log").insert({ user_email: c.email, action: "Google Drive connected", details: accountEmail ?? "" });
  return json(req, { connected: true, account_email: accountEmail });
}

async function status(req: Request) {
  await requireStaff(req);
  const { data } = await admin.from("drive_connection").select("account_email, connected_by, connected_at, scopes").eq("id", 1).maybeSingle();
  const { scopes, ...rest } = (data ?? {}) as Record<string, unknown>;
  return json(req, { configured: !!(CLIENT_ID && CLIENT_SECRET), connected: !!data, can_send: String(scopes ?? "").includes("gmail.send"), ...rest });
}

async function upload(req: Request) {
  const c = await requireStaff(req); need(c, "cna", 2);
  const form = await req.formData();
  const studentId = String(form.get("student_id") ?? "");
  const kind = String(form.get("kind") ?? "");
  const file = form.get("file");
  if (!(kind in KINDS)) throw new HttpError(400, "Unknown document type.");
  if (!(file instanceof File)) throw new HttpError(400, "No file was attached.");
  if (file.size > MAX_BYTES) throw new HttpError(413, "Files can be up to 10 MB.");
  if (file.type && !TYPES.includes(file.type)) throw new HttpError(415, "Upload a PDF, JPG, PNG or HEIC file.");

  const { data: s } = await admin.from("students").select("id, first_name, last_name, student_code, cohort:cohorts(start_date)").eq("id", studentId).maybeSingle();
  if (!s) throw new HttpError(404, "That student no longer exists.");
  const folder = (await folders())[kind];
  if (!folder?.id) throw new HttpError(409, `No Drive folder is set for ${KINDS[kind]}.`);

  // "{Student full name} - {Start Date}.ext", e.g. "Ava Testa - December 7, 2026.pdf"
  const start = (s.cohort as { start_date: string } | null)?.start_date ?? null;
  const fullName = `${s.first_name} ${s.last_name}`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  const name = `${fullName} - ${longDate(start)}${extensionOf(file.name, file.type)}`;
  const type = file.type || "application/octet-stream";

  const token = await driveToken();
  const boundary = "calace" + crypto.randomUUID().replace(/-/g, "");
  const meta = JSON.stringify({ name, parents: [folder.id], mimeType: type, description: `Uploaded from the CAL ACE tracker by ${c.email}${s.student_code ? " for " + s.student_code : ""}` });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`,
    file,
    `\r\n--${boundary}--`,
  ]);
  const up = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,size", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!up.ok) {
    if (up.status === 404) throw new HttpError(409, `The tracker can't reach the ${folder.name} folder. An admin needs to give it access on the Google Drive page.`);
    if (up.status === 403) throw new HttpError(409, "Google Drive refused the upload. The Drive account may be out of storage, or access needs to be given again on the Google Drive page.");
    throw new HttpError(502, `Google Drive couldn't save the file (${up.status}).`);
  }
  const g = await up.json();

  const db = asUser(c);
  const { data: old } = await admin.from("student_files").select("id, drive_file_id").eq("student_id", s.id).eq("kind", kind);
  const { data: row, error } = await db.from("student_files").insert({
    student_id: s.id, kind, url: g.webViewLink, file_name: g.name, size_bytes: Number(g.size ?? file.size), drive_file_id: g.id,
  }).select().single();
  if (error) { await trashDriveFile(token, g.id).catch(() => {}); throw new HttpError(500, error.message); }

  // Replace: the previous file for this document goes to Drive's trash (recoverable for 30 days).
  for (const o of old ?? []) {
    await trashDriveFile(token, o.drive_file_id).catch(() => {});
    await db.from("student_files").delete().eq("id", o.id);
  }
  return json(req, { file: row, replaced: (old ?? []).length });
}

async function viewFile(req: Request) {
  need(await requireStaff(req), "cna", 1);
  const id = Number(new URL(req.url).searchParams.get("id"));
  const { data: f } = await admin.from("student_files").select("drive_file_id, file_name").eq("id", id).maybeSingle();
  if (!f?.drive_file_id) throw new HttpError(404, "That file is no longer stored.");
  const token = await driveToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.drive_file_id)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? "The file was deleted from Google Drive." : `Google Drive couldn't send the file (${r.status}).`);
  return new Response(r.body, {
    headers: {
      ...corsHeaders(req),
      "Content-Type": r.headers.get("content-type") ?? "application/octet-stream",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(f.file_name ?? "document")}`,
      "Cache-Control": "private, no-store",
    },
  });
}

async function removeFile(req: Request) {
  const c = await requireStaff(req); need(c, "cna", 2);
  const { id } = await req.json().catch(() => ({ id: null }));
  const { data: f } = await admin.from("student_files").select("id, drive_file_id").eq("id", Number(id)).maybeSingle();
  if (!f) throw new HttpError(404, "That file was already removed.");
  if (f.drive_file_id) await trashDriveFile(await driveToken(), f.drive_file_id);
  const { error } = await asUser(c).from("student_files").delete().eq("id", f.id);
  if (error) throw new HttpError(500, error.message);
  return json(req, { removed: true });
}

// ---------------------------------------------------------------- Project1 import (admin, replaces the tracker's data)
const IMPORT_TABS = ["Students", "Class Config", "Activity Log", "Leads", "RNA-HHA Registrations", "CEU Registrations", "BLS", "Removed Students"];

function asObjects(rows: string[][]): Record<string, string>[] {
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h ?? "").trim());
  return rows.slice(1).map((row, i) => {
    const o: Record<string, string> = { _row: String(i + 2) };
    header.forEach((h, k) => { const v = row[k]; if (h && v !== undefined && v !== null && String(v) !== "") o[h] = String(v); });
    return o;
  }).filter((o) => Object.keys(o).length > 1);
}

async function importProject1(req: Request) {
  const c = await requireStaff(req, true);
  const { spreadsheet_id, confirm } = await req.json().catch(() => ({}));
  if (confirm !== "REPLACE") throw new HttpError(400, "Type REPLACE to confirm the import.");
  if (typeof spreadsheet_id !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(spreadsheet_id)) throw new HttpError(400, "Choose the Project1 Sheet first.");
  const token = await driveToken();

  const params = new URLSearchParams({ valueRenderOption: "FORMATTED_VALUE", majorDimension: "ROWS" });
  for (const t of IMPORT_TABS) params.append("ranges", `'${t.replace(/'/g, "''")}'`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheet_id}/values:batchGet?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    if (r.status === 403 || r.status === 404) throw new HttpError(409, "The tracker can't open that Sheet yet. Choose Project1 again on the Google Drive page, then import.");
    if (r.status === 400 && /Unable to parse range/i.test(detail)) throw new HttpError(400, "That Sheet is missing one of the tabs: " + IMPORT_TABS.join(", ") + ".");
    throw new HttpError(502, `Google Sheets couldn't send the data (${r.status}).`);
  }
  const j = await r.json();
  const tab: Record<string, string[][]> = {};
  IMPORT_TABS.forEach((t, i) => { tab[t] = (j.valueRanges?.[i]?.values ?? []) as string[][]; });
  if (!tab["Students"].length) throw new HttpError(400, "The Students tab is empty, so nothing was imported.");

  const payload = {
    imported_by: c.email,
    students: asObjects(tab["Students"]),
    class_config: tab["Class Config"],
    leads: asObjects(tab["Leads"]),
    rna_hha: asObjects(tab["RNA-HHA Registrations"]),
    ceu: asObjects(tab["CEU Registrations"]),
    bls: asObjects(tab["BLS"]),
    removed: tab["Removed Students"],
  };
  const { data: summary, error } = await admin.rpc("import_project1", { payload });
  if (error) throw new HttpError(500, "The import stopped and nothing was changed: " + error.message);

  // Activity Log in chunks, oldest first, after the students exist so entries link to them.
  const logRows = tab["Activity Log"].slice(1).map((row) => [0, 1, 2, 3, 4].map((k) => String(row[k] ?? "")));
  let logged = 0;
  for (let i = 0; i < logRows.length; i += 4000) {
    const { data: n, error: e } = await admin.rpc("import_activity_log", { rows: logRows.slice(i, i + 4000) });
    if (e) throw new HttpError(500, `Students imported, but the Activity Log stopped after ${logged} rows: ${e.message}`);
    logged += Number(n ?? 0);
  }
  const result = { ...(summary as Record<string, unknown>), activity_log: logged, sheet_activity_rows: logRows.length };
  await admin.from("settings").upsert([
    { key: "last_import", value: { at: new Date().toISOString(), by: c.email, spreadsheet_id, summary: result } },
  ]);
  return json(req, result);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  try {
    if (route === "exchange" && req.method === "POST") return await exchange(req);
    if (route === "connect-url" && req.method === "POST") return await connectUrl(req);
    if (route === "status" && req.method === "GET") return await status(req);
    if (route === "upload" && req.method === "POST") return await upload(req);
    if (route === "file" && req.method === "GET") return await viewFile(req);
    if (route === "remove" && req.method === "POST") return await removeFile(req);
    if (route === "import" && req.method === "POST") return await importProject1(req);
    return json(req, { error: "Not found" }, 404);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error(e);
    return json(req, { error: e instanceof Error ? e.message : "Something went wrong." }, status);
  }
});
