// Communications module — DB helpers + group email sender.
// See src/screens/comms/* for the UI.
import { invoke } from "@tauri-apps/api/core";
import { db, execRetry, listStudents } from "./db";
import { parseRecipients } from "./email";
import type { Student, SettingsMap } from "../types";

export interface MessageTemplate {
  id: number;
  name: string;
  subject: string;
  body: string;
  kind: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export interface CommLogEntry {
  id: number;
  sent_at: string;
  kind: string;                 // 'group_email' | 'receipt' | 'annual_receipt' | 'subsidy_stmt' | 'scheduled' | 'test'
  subject: string;
  body: string | null;
  recipient_count: number;
  recipients: string;
  attachment_names: string | null;
  status: "sent" | "partial" | "failed" | string;
  error: string | null;
  related_id: number | null;
}

export interface ScheduledMessage {
  id: number;
  scheduled_for: string;
  subject: string;
  body: string;
  recipient_filter: string;     // JSON: RecipientFilter
  attachments: string | null;   // JSON array of {filename,b64,mime}
  status: "pending" | "sent" | "cancelled";
  created_at: string;
  sent_at: string | null;
}

export type RecipientFilter =
  | { mode: "all_active" }
  | { mode: "year"; year: number }
  | { mode: "students"; studentIds: number[] };

// ---------------- Templates ----------------
export async function listTemplates(): Promise<MessageTemplate[]> {
  return (await db()).select<MessageTemplate[]>(
    "SELECT * FROM message_templates ORDER BY is_builtin DESC, name COLLATE NOCASE"
  );
}

export async function upsertTemplate(t: Partial<MessageTemplate>): Promise<number> {
  if (t.id) {
    await execRetry(
      "UPDATE message_templates SET name=?, subject=?, body=?, kind=?, updated_at=datetime('now') WHERE id=?",
      [t.name || "", t.subject || "", t.body || "", t.kind || "general", t.id]
    );
    return t.id;
  }
  const r = await execRetry(
    "INSERT INTO message_templates(name,subject,body,kind,is_builtin) VALUES(?,?,?,?,0)",
    [t.name || "Untitled", t.subject || "", t.body || "", t.kind || "general"]
  );
  return r.lastInsertId;
}

export async function deleteTemplate(id: number): Promise<void> {
  await execRetry("DELETE FROM message_templates WHERE id=? AND is_builtin=0", [id]);
}

// ---------------- Communication log ----------------
export async function logCommunication(entry: Omit<CommLogEntry, "id" | "sent_at"> & { sent_at?: string }): Promise<number> {
  const r = await execRetry(
    `INSERT INTO communication_log
       (sent_at, kind, subject, body, recipient_count, recipients, attachment_names, status, error, related_id)
     VALUES (COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.sent_at || null,
      entry.kind,
      entry.subject,
      entry.body,
      entry.recipient_count,
      entry.recipients,
      entry.attachment_names,
      entry.status,
      entry.error,
      entry.related_id,
    ]
  );
  return r.lastInsertId;
}

export interface LogFilter {
  kind?: string;
  status?: string;
  from?: string;   // YYYY-MM-DD
  to?: string;
  search?: string; // matches subject or recipients
  limit?: number;
}
export async function listCommunications(f: LogFilter = {}): Promise<CommLogEntry[]> {
  const w: string[] = ["1=1"];
  const args: any[] = [];
  if (f.kind && f.kind !== "all") { w.push("kind=?"); args.push(f.kind); }
  if (f.status && f.status !== "all") { w.push("status=?"); args.push(f.status); }
  if (f.from) { w.push("substr(sent_at,1,10) >= ?"); args.push(f.from); }
  if (f.to)   { w.push("substr(sent_at,1,10) <= ?"); args.push(f.to); }
  if (f.search) {
    w.push("(subject LIKE ? OR recipients LIKE ?)");
    args.push(`%${f.search}%`, `%${f.search}%`);
  }
  const sql = `SELECT * FROM communication_log WHERE ${w.join(" AND ")} ORDER BY sent_at DESC LIMIT ?`;
  args.push(f.limit ?? 500);
  return (await db()).select<CommLogEntry[]>(sql, args);
}

// ---------------- Scheduled ----------------
export async function listScheduled(status?: string): Promise<ScheduledMessage[]> {
  if (status) {
    return (await db()).select<ScheduledMessage[]>(
      "SELECT * FROM scheduled_messages WHERE status=? ORDER BY scheduled_for ASC",
      [status]
    );
  }
  return (await db()).select<ScheduledMessage[]>(
    "SELECT * FROM scheduled_messages ORDER BY scheduled_for DESC"
  );
}

export async function upsertScheduled(m: Partial<ScheduledMessage> & { recipient_filter: string }): Promise<number> {
  if (m.id) {
    await execRetry(
      "UPDATE scheduled_messages SET scheduled_for=?, subject=?, body=?, recipient_filter=?, attachments=?, status=? WHERE id=?",
      [m.scheduled_for, m.subject, m.body, m.recipient_filter, m.attachments || null, m.status || "pending", m.id]
    );
    return m.id;
  }
  const r = await execRetry(
    "INSERT INTO scheduled_messages(scheduled_for, subject, body, recipient_filter, attachments, status) VALUES(?,?,?,?,?,?)",
    [m.scheduled_for, m.subject, m.body, m.recipient_filter, m.attachments || null, m.status || "pending"]
  );
  return r.lastInsertId;
}

export async function cancelScheduled(id: number): Promise<void> {
  await execRetry("UPDATE scheduled_messages SET status='cancelled' WHERE id=? AND status='pending'", [id]);
}

export async function deleteScheduled(id: number): Promise<void> {
  await execRetry("DELETE FROM scheduled_messages WHERE id=?", [id]);
}

export async function dueScheduled(nowIso?: string): Promise<ScheduledMessage[]> {
  const now = nowIso || new Date().toISOString();
  return (await db()).select<ScheduledMessage[]>(
    "SELECT * FROM scheduled_messages WHERE status='pending' AND scheduled_for <= ? ORDER BY scheduled_for ASC",
    [now]
  );
}

export async function markScheduledSent(id: number): Promise<void> {
  await execRetry("UPDATE scheduled_messages SET status='sent', sent_at=datetime('now') WHERE id=?", [id]);
}

export async function markScheduledFailed(id: number, reason: string): Promise<void> {
  await execRetry("UPDATE scheduled_messages SET status='failed', sent_at=datetime('now') WHERE id=?", [id]);
  void reason; // reason is captured in communication_log; no dedicated column here.
}

// ---------------- Recipient resolution ----------------
export interface ResolvedRecipient {
  student: Student;
  parentName: string;
  emails: string[];
}

export async function resolveRecipients(f: RecipientFilter, activeYear?: number): Promise<ResolvedRecipient[]> {
  let students: Student[] = [];
  if (f.mode === "all_active") {
    students = await listStudents(activeYear, true);
  } else if (f.mode === "year") {
    students = await listStudents(f.year, false);
  } else {
    const all = await listStudents(undefined, false);
    const ids = new Set(f.studentIds);
    students = all.filter((s) => ids.has(s.id));
  }
  return students
    .map((s) => {
      const emails = parseRecipients(s.email);
      const parentName = [s.father_name, s.mother_name].filter(Boolean).join(" & ") || "Parent";
      return { student: s, parentName, emails };
    })
    .filter((r) => r.emails.length > 0);
}

// ---------------- Merge template ----------------
export interface MergeContext {
  student_name: string;
  parent_name: string;
  daycare_name: string;
  contact_email: string;
  contact_phone: string;
  month: string;      // e.g. "January"
  year: string;
  date: string;       // ISO date today
  [k: string]: string;
}

export function buildMergeContext(r: ResolvedRecipient, s: SettingsMap, extra: Record<string, string> = {}): MergeContext {
  const now = new Date();
  return {
    student_name: r.student.name,
    parent_name: r.parentName,
    daycare_name: s.daycare_name || "Echelon Daycare",
    contact_email: s.contact_email || "",
    contact_phone: s.contact_phone || "",
    month: now.toLocaleString(undefined, { month: "long" }),
    year: String(now.getFullYear()),
    date: now.toISOString().slice(0, 10),
    ...extra,
  };
}

export function renderCommsTemplate(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (ctx[k] !== undefined ? ctx[k] : ""));
}

// ---------------- Attachment helper ----------------
export interface CommAttachment {
  filename: string;
  b64: string;
  mime?: string;
}

export async function fileToAttachment(file: File): Promise<CommAttachment> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 8192) {
    s += String.fromCharCode(...buf.subarray(i, i + 8192));
  }
  return { filename: file.name, b64: btoa(s), mime: file.type || undefined };
}

// ---------------- Send group email ----------------
export interface GroupSendProgress {
  index: number;
  total: number;
  recipient: string;
  student: string;
  ok: boolean;
  error?: string;
}

export interface GroupSendOptions {
  subject: string;              // template with {{tokens}}
  body: string;                 // template with {{tokens}}
  recipients: ResolvedRecipient[];
  attachments: CommAttachment[];
  extraContext?: Record<string, string>;  // template-specific fields entered on Compose form
  settings: SettingsMap;
  onProgress?: (p: GroupSendProgress) => void;
  logKind?: string; // default 'group_email' — 'scheduled' when driven by scheduler
}

export interface GroupSendResult {
  sent: number;
  failed: number;
  errors: Array<{ recipient: string; student: string; error: string }>;
  logId: number;
}

export async function sendGroupEmail(opts: GroupSendOptions): Promise<GroupSendResult> {
  const { recipients, attachments, subject, body, extraContext = {}, settings: s, onProgress } = opts;
  if (recipients.length === 0) throw new Error("No recipients matched the filter (0 students with email addresses).");

  const password = await invoke<string | null>("keychain_get", { key: "smtp_password" });
  if (!password) throw new Error("SMTP password not set. Open Settings → Email and save it first.");
  const sender = (s.sender_email || s.contact_email || "").trim();
  if (!sender) throw new Error("Sender email not set. Open Settings → Email.");
  const host = (s.smtp_host || "").trim();
  const port = parseInt(s.smtp_port || "587", 10);
  if (!host || !port) throw new Error("SMTP host/port not set. Open Settings → Email.");

  const errors: GroupSendResult["errors"] = [];
  let sent = 0;
  const allRecipients = new Set<string>();

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const ctx = buildMergeContext(r, s, extraContext);
    const perSubject = renderCommsTemplate(subject, ctx);
    const perBody = renderCommsTemplate(body, ctx);
    try {
      await invoke("send_email", {
        args: {
          smtp_host: host,
          smtp_port: port,
          smtp_user: (s.smtp_user || sender).trim(),
          smtp_password: password,
          from_name: s.sender_name || s.daycare_name || "Echelon Daycare",
          from_email: sender,
          to: r.emails,
          cc: [],
          bcc: s.bcc_self === "1" && i === 0 ? [sender] : [], // bcc once per batch
          subject: perSubject,
          body_text: perBody,
          attachments,
        },
      });
      sent++;
      r.emails.forEach((e) => allRecipients.add(e));
      onProgress?.({ index: i, total: recipients.length, recipient: r.emails.join(", "), student: r.student.name, ok: true });
      // Throttle to be gentle with SMTP servers (Gmail ~100/day free — pace at ~1/sec).
      if (i < recipients.length - 1) await new Promise((res) => setTimeout(res, 400));
    } catch (e: any) {
      const msg = String(e?.message || e);
      errors.push({ recipient: r.emails.join(", "), student: r.student.name, error: msg });
      onProgress?.({ index: i, total: recipients.length, recipient: r.emails.join(", "), student: r.student.name, ok: false, error: msg });
    }
  }

  const status = errors.length === 0 ? "sent" : sent === 0 ? "failed" : "partial";
  const logId = await logCommunication({
    kind: opts.logKind || "group_email",
    subject,
    body,
    recipient_count: sent,
    recipients: Array.from(allRecipients).join(", "),
    attachment_names: attachments.length ? JSON.stringify(attachments.map((a) => a.filename)) : null,
    status,
    error: errors.length ? errors.map((e) => `${e.student}: ${e.error}`).join(" | ") : null,
    related_id: null,
  });

  return { sent, failed: errors.length, errors, logId };
}

// ---------------- Scheduled runner (called on app launch) ----------------
export interface ScheduledRunResult {
  attempted: number;
  sent: number;
  failed: number;
}

export async function runDueScheduled(settings: SettingsMap): Promise<ScheduledRunResult> {
  const due = await dueScheduled();
  let sentCount = 0;
  let failedCount = 0;
  for (const m of due) {
    try {
      const filter: RecipientFilter = JSON.parse(m.recipient_filter);
      const attachments: CommAttachment[] = m.attachments ? JSON.parse(m.attachments) : [];
      const recipients = await resolveRecipients(filter);
      if (recipients.length === 0) {
        await logCommunication({
          kind: "scheduled",
          subject: m.subject,
          body: m.body,
          recipient_count: 0,
          recipients: "",
          attachment_names: null,
          status: "failed",
          error: "No matching recipients at time of send",
          related_id: m.id,
        });
        // Mark failed so we don't re-fire an unsolvable send every app open;
        // the operator can inspect the audit log and re-schedule if desired.
        await markScheduledFailed(m.id, "no recipients");
        failedCount++;
      } else {
        const res = await sendGroupEmail({
          subject: m.subject,
          body: m.body,
          recipients,
          attachments,
          settings,
          logKind: "scheduled",
        });
        if (res.failed === 0) {
          sentCount++;
          await markScheduledSent(m.id);
        } else {
          // Some or all recipients failed. Leave scheduled status untouched
          // (still 'pending') so the operator can see it and retry, and record
          // the partial-failure in the communication log for the audit trail.
          failedCount++;
        }
      }
    } catch (e: any) {
      failedCount++;
      await logCommunication({
        kind: "scheduled",
        subject: m.subject,
        body: m.body,
        recipient_count: 0,
        recipients: "",
        attachment_names: null,
        status: "failed",
        error: String(e?.message || e),
        related_id: m.id,
      });
    }
  }
  return { attempted: due.length, sent: sentCount, failed: failedCount };
}
