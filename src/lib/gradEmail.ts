import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import type { SettingsMap } from "../types";
import {
  bytesToBase64,
  deliverabilityExtras,
  parseRecipients,
} from "./email";

// v3.8.0: send a per-child graduation reel MP4 to that student's parents.
//
// Design notes:
// - We attach the MP4 directly via SMTP. Per-child reels are ~6-8 MB for a
//   15 s 720p H.264 clip, well under the 25 MB SMTP attachment ceiling that
//   Gmail / Outlook / iCloud enforce. If a future reel grows beyond that,
//   this helper will surface the send error from lettre and the caller can
//   fall back to a share link.
// - Template placeholders mirror the receipt-email conventions: {{student}},
//   {{year}}, {{parent_name}}, {{contact_email}}, {{contact_phone}}. We use a
//   focused renderer (not renderTemplate from ./email) because that helper is
//   receipt-specific and takes a full Receipt struct we don't have here.

export interface GradReelRecipient {
  student_id: number;
  student_name: string;
  parent_name: string;      // best-effort display name, may be empty
  email_field: string;      // raw students.email; comma / semicolon separated
  video_path: string;       // absolute path to the rendered MP4
  video_filename: string;   // suggested attachment filename
}

export interface GradReelSendResult {
  student_id: number;
  student_name: string;
  ok: boolean;
  error?: string;
  recipients?: string[];
}

function renderGradTemplate(
  tpl: string,
  ctx: { student: string; year: string; parent_name: string },
  s: SettingsMap,
): string {
  const map: Record<string, string> = {
    student: ctx.student,
    year: ctx.year,
    parent_name: ctx.parent_name || "there",
    contact_email: s.contact_email || "",
    contact_phone: s.contact_phone || "",
    daycare_name: s.daycare_name || "Echelon Daycare",
  };
  return tpl.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_, key) => {
    const v = map[key];
    return v === undefined ? "" : v;
  });
}

export async function sendGradReelEmail(opts: {
  recipient: GradReelRecipient;
  year: string;
  subjectTpl: string;
  bodyTpl: string;
  settings: SettingsMap;
}): Promise<string[]> {
  const { recipient: r, year, subjectTpl, bodyTpl, settings: s } = opts;

  const emails = parseRecipients(r.email_field);
  if (emails.length === 0) throw new Error("No parent email on file.");

  if (s.smtp_password_set !== "1") {
    throw new Error("SMTP password not set. Open Settings → Email and save it first.");
  }
  const sender = (s.sender_email || s.contact_email || "").trim();
  if (!sender) throw new Error("Sender email not set. Open Settings → Email.");
  const host = (s.smtp_host || "").trim();
  const port = parseInt(s.smtp_port || "587", 10);
  if (!host || !port) throw new Error("SMTP host/port not set. Open Settings → Email.");

  // Read the reel bytes from disk. Video paths always live inside the user's
  // chosen graduation folder which sits under $HOME (fs-scope permits it).
  let bytes: Uint8Array;
  try {
    bytes = await readFile(r.video_path);
  } catch (e: any) {
    throw new Error(`Could not read video file: ${e?.message || e}`);
  }
  if (bytes.length === 0) throw new Error("Video file is empty.");
  // v3.8.0 review-fix (Sonnet #1): pre-flight the 25 MB SMTP ceiling.
  // Gmail / Outlook / iCloud all cap attachments at 25 MB; a naked
  // lettre error at that point is opaque ("552" or a socket close).
  // Front-load the check with a clear message so the operator can
  // uncheck the row or share via cloud link.
  const SMTP_LIMIT = 25 * 1024 * 1024;
  if (bytes.length > SMTP_LIMIT) {
    const mb = (bytes.length / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Video is ${mb} MB — exceeds the 25 MB SMTP attachment limit. ` +
        `Uncheck this row and share the file via a cloud link instead.`,
    );
  }

  const ctx = { student: r.student_name, year, parent_name: r.parent_name };
  const subject = renderGradTemplate(subjectTpl, ctx, s);
  const body = renderGradTemplate(bodyTpl, ctx, s);

  // Mirror sendReceiptEmail / sendAnnualReceiptEmail: audit-log BOTH
  // success and failure via try/catch/finally, so an SMTP error is
  // still recorded in the communications history. Otherwise a failed
  // send leaves no trace and the user can't diagnose "why didn't this
  // land?" after the fact.
  let logErr: string | null = null;
  try {
    await invoke("send_email", {
      args: {
        smtp_host: host,
        smtp_port: port,
        smtp_user: (s.smtp_user || sender).trim(),
        from_name: s.sender_name || s.daycare_name || "Echelon Daycare",
        from_email: sender,
        to: emails,
        cc: [],
        bcc: s.bcc_self === "1" ? [sender] : [],
        subject,
        body_text: body,
        attachment_b64: bytesToBase64(bytes),
        attachment_filename: r.video_filename,
        attachment_mime: "video/mp4",
        // v3.8.0 review-fix (Sonnet #9): keep reply_to (parents replying
        // land in the right inbox) but drop list_unsubscribe. This is
        // a one-time personal video, not a bulk mailing — the
        // "Unsubscribe" chip that Gmail renders next to bulk senders
        // would undermine the warm-and-personal framing.
        reply_to: deliverabilityExtras(s, sender).reply_to,
      },
    });
  } catch (e: any) {
    logErr = String(e?.message || e);
    throw e;
  } finally {
    try {
      const { logCommunication } = await import("./comms");
      await logCommunication({
        kind: "grad_reel",
        subject,
        body,
        recipient_count: emails.length,
        recipients: emails.join(", "),
        attachment_names: JSON.stringify([r.video_filename]),
        status: logErr ? "failed" : "sent",
        error: logErr,
        related_id: r.student_id,
      });
    } catch {
      // Audit log itself failed — non-critical, never mask the SMTP
      // outcome.
    }
  }

  return emails;
}
