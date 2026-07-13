import { invoke } from "@tauri-apps/api/core";
import type { Receipt, SettingsMap } from "../types";
import { buildReceiptHtml } from "./receipt";
import { loadHtml2Pdf } from "./lazy";

export const SMTP_PRESETS: Record<string, { host: string; port: number }> = {
  "Hotmail / Outlook": { host: "smtp-mail.outlook.com", port: 587 },
  "Gmail":             { host: "smtp.gmail.com",        port: 587 },
  "iCloud":            { host: "smtp.mail.me.com",      port: 587 },
  "Yahoo":             { host: "smtp.mail.yahoo.com",   port: 587 },
};

export function parseRecipients(emailField: string | null | undefined): string[] {
  if (!emailField) return [];
  return emailField
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => e.includes("@"));
}

// Deliverability extras threaded into every send_email call.
//
// reply_to:
//   Gmail (free tier) rewrites the From header to match the authenticated
//   account. Reply-To, however, is preserved — so if the owner authenticates
//   as echelondaycare@gmail.com but has a real inbox at contact@daycare.ca,
//   parents replying will still reach that inbox.
//
// list_unsubscribe:
//   Google's Feb-2024 sender rules made List-Unsubscribe (RFC 8058) a strong
//   inbox-placement signal even at low volume. mailto: with subject=unsubscribe
//   is honored by Gmail and lands the request in the sender's own inbox for
//   manual handling.
export function deliverabilityExtras(s: SettingsMap, sender: string): {
  reply_to?: string;
  list_unsubscribe?: string;
} {
  const contact = (s.contact_email || "").trim();
  const senderLc = sender.trim().toLowerCase();
  const out: { reply_to?: string; list_unsubscribe?: string } = {};
  if (contact && contact.toLowerCase() !== senderLc) {
    out.reply_to = contact;
  }
  if (senderLc) {
    out.list_unsubscribe = `mailto:${senderLc}?subject=unsubscribe`;
  }
  return out;
}

function fmtAmount(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderSubject(tpl: string, r: Receipt, s: SettingsMap): string {
  // For refunds we drop the description from the subject entirely — refund comments are
  // usually a full sentence and would look weird when truncated. Parents get the details
  // in the body. Normal receipts keep the original description in the subject.
  const rForSubject: Receipt = r.is_refund
    ? { ...r, description: "", comments: null }
    : r;
  let out = renderTemplate(tpl, rForSubject, s);
  if (r.is_refund) {
    // Prepend "Refund " if user's template doesn't already open with it,
    // then tidy any dangling " - " left where {{description}} used to be.
    out = out.replace(/\s*-\s*$/, "").replace(/\s+-\s+-\s+/g, " - ");
    if (!/^refund\b/i.test(out.trim())) {
      out = `Refund ${out}`;
    }
  }
  return out;
}

export function renderTemplate(tpl: string, r: Receipt, s: SettingsMap): string {
  const pendingLine = r.pending_amount > 0 ? `\nPending Fees: CAD ${fmtAmount(r.pending_amount)}` : "";
  const isRefund = !!r.is_refund;
  // For refunds, prefer comments (e.g. "overpayment July - refund for 3 sick days") over the
  // stored description (which is usually the monthly tuition label). Falls back to description
  // if no comments were entered.
  const descForEmail = isRefund
    ? ((r.comments && r.comments.trim()) ? r.comments.trim() : r.description)
    : r.description;
  const amountLabel = isRefund ? "Refund Amount" : "Amount";
  const refundPrefix = isRefund ? "Refund " : "";
  const map: Record<string, string> = {
    receipt_no: String(r.receipt_no),
    student: r.student_name_snapshot,
    description: descForEmail,
    amount: fmtAmount(r.amount),
    amount_label: amountLabel,
    refund_prefix: refundPrefix,
    pending: fmtAmount(r.pending_amount),
    pending_line: pendingLine,
    date: r.date,
    contact_email: s.contact_email || "",
    contact_phone: s.contact_phone || "",
    daycare_name: s.daycare_name || "",
  };
  let out = tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (map[k] !== undefined ? map[k] : ""));
  // Backwards-compat: existing user templates hardcode "Amount:" — rewrite to "Refund Amount:"
  // for refund receipts so parents see the correct label without needing to re-save the template.
  if (isRefund) {
    out = out.replace(/(^|\n)Amount:\s/g, "$1Refund Amount: ");
  }
  return out;
}

async function renderReceiptPdfBytes(r: Receipt, s: SettingsMap): Promise<Uint8Array> {
  const html = buildReceiptHtml(r, s);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0";
  host.innerHTML = html;
  document.body.appendChild(host);
  const target = (host.querySelector(".sheet") as HTMLElement) || host;
  try {
    const html2pdf = await loadHtml2Pdf();
    const blob: Blob = await html2pdf()
      .from(target)
      .set({
        margin: 0.4,
        filename: "receipt.pdf",
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 1.5, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
      })
      .outputPdf("blob");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    document.body.removeChild(host);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

export async function sendAnnualReceiptEmail(opts: {
  pdfBytes: Uint8Array;
  filename: string;
  subject: string;
  body: string;
  recipients: string[];
  settings: SettingsMap;
  logKind?: string;      // 'annual_receipt' | 'subsidy_stmt'
  logRelatedId?: number;
}): Promise<void> {
  const { pdfBytes, filename, subject, body, recipients, settings: s } = opts;
  if (recipients.length === 0) throw new Error("No recipient email addresses.");
  if (s.smtp_password_set !== "1") throw new Error("SMTP password not set. Open Settings → Email and save it first.");

  const sender = (s.sender_email || s.contact_email || "").trim();
  if (!sender) throw new Error("Sender email not set. Open Settings → Email.");
  const host = (s.smtp_host || "").trim();
  const port = parseInt(s.smtp_port || "587", 10);
  if (!host || !port) throw new Error("SMTP host/port not set. Open Settings → Email.");

  let logErr: string | null = null;
  try {
    await invoke("send_email", {
      args: {
        smtp_host: host, smtp_port: port,
        smtp_user: (s.smtp_user || sender).trim(),
        from_name: s.sender_name || s.daycare_name || "Echelon Daycare",
        from_email: sender,
        to: recipients, cc: [],
        bcc: s.bcc_self === "1" ? [sender] : [],
        subject, body_text: body,
        attachment_b64: bytesToBase64(pdfBytes),
        attachment_filename: filename,
        ...deliverabilityExtras(s, sender),
      },
    });
  } catch (e: any) {
    logErr = String(e?.message || e);
    throw e;
  } finally {
    // Best-effort audit log — failure to log must never mask a send failure.
    try {
      const { logCommunication } = await import("./comms");
      await logCommunication({
        kind: opts.logKind || "annual_receipt",
        subject, body,
        recipient_count: recipients.length,
        recipients: recipients.join(", "),
        attachment_names: JSON.stringify([filename]),
        status: logErr ? "failed" : "sent",
        error: logErr,
        related_id: opts.logRelatedId ?? null,
      });
    } catch {}
  }
}

export async function sendReceiptEmail(opts: {
  receipt: Receipt;
  recipients: string[];
  settings: SettingsMap;
}): Promise<void> {
  const { receipt: r, recipients, settings: s } = opts;
  if (recipients.length === 0) throw new Error("No recipient email addresses.");
  if (s.smtp_password_set !== "1") throw new Error("SMTP password not set. Open Settings → Email and save it first.");

  const sender = (s.sender_email || s.contact_email || "").trim();
  if (!sender) throw new Error("Sender email not set. Open Settings → Email.");
  const host = (s.smtp_host || "").trim();
  const port = parseInt(s.smtp_port || "587", 10);
  if (!host || !port) throw new Error("SMTP host/port not set. Open Settings → Email.");

  const pdf = await renderReceiptPdfBytes(r, s);
  const b64 = bytesToBase64(pdf);
  const subject = renderSubject(s.email_subject || "Receipt #{{receipt_no}}", r, s);
  const body = renderTemplate(s.email_body || "Receipt attached.", r, s);
  const filename = `Receipt-${r.receipt_no}-${r.student_name_snapshot.replace(/[^\w]+/g, "_")}.pdf`;

  let logErr: string | null = null;
  try {
    await invoke("send_email", {
      args: {
        smtp_host: host,
        smtp_port: port,
        smtp_user: (s.smtp_user || sender).trim(),
        from_name: s.sender_name || s.daycare_name || "Echelon Daycare",
        from_email: sender,
        to: recipients,
        cc: [],
        bcc: s.bcc_self === "1" ? [sender] : [],
        subject,
        body_text: body,
        attachment_b64: b64,
        attachment_filename: filename,
        ...deliverabilityExtras(s, sender),
      },
    });
  } catch (e: any) {
    logErr = String(e?.message || e);
    throw e;
  } finally {
    try {
      const { logCommunication } = await import("./comms");
      await logCommunication({
        kind: "receipt",
        subject, body,
        recipient_count: recipients.length,
        recipients: recipients.join(", "),
        attachment_names: JSON.stringify([filename]),
        status: logErr ? "failed" : "sent",
        error: logErr,
        related_id: r.id ?? null,
      });
    } catch {}
  }
}

export async function sendSubsidyStatementEmail(opts: {
  pdfBytes: Uint8Array;
  filename: string;
  subject: string;
  body: string;
  recipients: string[];
  settings: SettingsMap;
}): Promise<void> {
  // Same wire format as the annual receipt email — single attachment.
  return sendAnnualReceiptEmail(opts);
}

export async function sendTestEmail(s: SettingsMap): Promise<void> {
  if (s.smtp_password_set !== "1") throw new Error("Save the SMTP password first.");
  const sender = (s.sender_email || s.contact_email || "").trim();
  if (!sender) throw new Error("Sender email not set.");
  const host = (s.smtp_host || "").trim();
  const port = parseInt(s.smtp_port || "587", 10);

  // Tiny 1-byte placeholder so the attachment field isn't empty (we send a text-only body otherwise)
  await invoke("send_email", {
    args: {
      smtp_host: host,
      smtp_port: port,
      smtp_user: (s.smtp_user || sender).trim(),
      from_name: s.sender_name || "Echelon Daycare",
      from_email: sender,
      to: [sender],
      cc: [],
      bcc: [],
      subject: "Echelon Receipts — test email",
      body_text: "✅ SMTP is working. You can now email receipts from the app.",
      attachment_b64: btoa("test"),
      attachment_filename: "test.txt",
      ...deliverabilityExtras(s, sender),
    },
  });
}
