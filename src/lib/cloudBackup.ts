// Cloud backup: emails the SQLite DB to the configured recipient via SMTP.
// Schedule: on first app open of a calendar month, back up the *previous* month.
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getSettings, setSetting, checkpointWal } from "./db";
import type { SettingsMap } from "../types";

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function prevMonthKey(d: Date): string {
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return monthKey(p);
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
}

export interface CloudBackupResult {
  ok: boolean;
  monthKey: string;
  recipient: string;
  bytes: number;
  error?: string;
}

function recipientFor(s: SettingsMap): string {
  return (
    s.backup_recipient_email?.trim() ||
    s.sender_email?.trim() ||
    s.contact_email?.trim() ||
    ""
  );
}

export async function sendCloudBackup(forMonthKey: string): Promise<CloudBackupResult> {
  const s = await getSettings();
  const recipient = recipientFor(s);
  if (!recipient) {
    return { ok: false, monthKey: forMonthKey, recipient: "", bytes: 0, error: "No backup recipient email configured." };
  }
  const password = await invoke<string | null>("keychain_get", { key: "smtp_password" });
  if (!password) {
    return { ok: false, monthKey: forMonthKey, recipient, bytes: 0, error: "SMTP password not set." };
  }
  const host = (s.smtp_host || "").trim();
  const port = parseInt(s.smtp_port || "587", 10);
  if (!host || !port) {
    return { ok: false, monthKey: forMonthKey, recipient, bytes: 0, error: "SMTP host/port not set." };
  }

  // Flush the WAL into the main .db file before reading, otherwise recent
  // commits live only in echelon.db-wal and the email backup is incomplete.
  // A restore from a non-checkpointed snapshot would silently lose them.
  await checkpointWal();

  const dbPath = await join(await appDataDir(), "echelon.db");
  const bytes = await readFile(dbPath);
  const b64 = bytesToBase64(bytes);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const daycare = s.daycare_name || "Echelon Daycare";
  const sender = (s.sender_email || s.contact_email || "").trim();

  await invoke("send_email", {
    args: {
      smtp_host: host,
      smtp_port: port,
      smtp_user: (s.smtp_user || sender).trim(),
      smtp_password: password,
      from_name: s.sender_name || daycare,
      from_email: sender,
      to: [recipient],
      cc: [],
      bcc: [],
      subject: `[Echelon Backup] ${monthLabel(forMonthKey)} — ${daycare}`,
      body_text:
        `Automatic monthly backup of the Echelon Receipts database.\n\n` +
        `Covers data up to: ${new Date().toISOString().slice(0, 10)}\n` +
        `Backup month tag: ${forMonthKey}\n` +
        `File: echelon-${forMonthKey}.db (${(bytes.length / 1024).toFixed(1)} KB)\n\n` +
        `To restore: save the attached .db file into the app data folder, ` +
        `replacing echelon.db (close the app first). Keep this email — it is your safety net.`,
      attachment_b64: b64,
      attachment_filename: `echelon-${forMonthKey}-${stamp}.db`,
      attachment_mime: "application/octet-stream",
    },
  });

  const nowIso = new Date().toISOString();
  await setSetting("last_cloud_backup_month", forMonthKey);
  await setSetting("last_cloud_backup_at", nowIso);
  await setSetting("last_cloud_backup_recipient", recipient);
  await setSetting("last_backup_error", ""); // clear stale failure flag
  return { ok: true, monthKey: forMonthKey, recipient, bytes: bytes.length };
}

// Runs on every app start. If we haven't backed up this calendar month yet,
// send a snapshot tagged for the previous month. Idempotent — does nothing if up to date.
export async function runCloudBackupIfDue(): Promise<CloudBackupResult | null> {
  try {
    const s = await getSettings();
    if (s.backup_cloud_enabled === "0") return null; // explicitly off
    if (!recipientFor(s)) return null; // not configured yet — silent
    if (!s.smtp_host || !s.smtp_user) return null;
    if (s.smtp_password_set !== "1") return null; // no password stored — don't prompt keychain

    const now = new Date();
    const thisMonth = monthKey(now);
    const targetMonth = prevMonthKey(now); // back up the month that just ended
    const last = s.last_cloud_backup_month || "";
    // Already backed up this calendar month? skip — avoids keychain prompt on every launch.
    if (last && last >= targetMonth) return null;
    // Brand new install (no last value) — back up the previous month once.
    // (Avoids spamming a backup on day 1 of installation in the same month with no data.)
    void thisMonth;
    return await sendCloudBackup(targetMonth);
  } catch (e: any) {
    // Never crash startup on backup failure — but do surface it via
    // the Notification Bell so the owner isn't silently unprotected.
    console.warn("Cloud backup check failed:", e?.message || e);
    try { await setSetting("last_backup_error", String(e?.message || e)); } catch {}
    return { ok: false, monthKey: "", recipient: "", bytes: 0, error: String(e?.message || e) };
  }
}
