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

function fmtAmount(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderTemplate(tpl: string, r: Receipt, s: SettingsMap): string {
  const pendingLine = r.pending_amount > 0 ? `\nPending Fees: CAD ${fmtAmount(r.pending_amount)}` : "";
  const map: Record<string, string> = {
    receipt_no: String(r.receipt_no),
    student: r.student_name_snapshot,
    description: r.description,
    amount: fmtAmount(r.amount),
    pending: fmtAmount(r.pending_amount),
    pending_line: pendingLine,
    date: r.date,
    contact_email: s.contact_email || "",
    contact_phone: s.contact_phone || "",
    daycare_name: s.daycare_name || "",
  };
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (map[k] !== undefined ? map[k] : ""));
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
}): Promise<void> {
  const { pdfBytes, filename, subject, body, recipients, settings: s } = opts;
  if (recipients.length === 0) throw new Error("No recipient email addresses.");
  const password = await invoke<string | null>("keychain_get", { key: "smtp_password" });
  if (!password) throw new Error("SMTP password not set. Open Settings → Email and save it first.");

  const sender = (s.sender_email || s.contact_email || "").trim();
  if (!sender) throw new Error("Sender email not set. Open Settings → Email.");
  const host = (s.smtp_host || "").trim();
  const port = parseInt(s.smtp_port || "587", 10);
  if (!host || !port) throw new Error("SMTP host/port not set. Open Settings → Email.");

  await invoke("send_email", {
    args: {
      smtp_host: host, smtp_port: port,
      smtp_user: (s.smtp_user || sender).trim(),
      smtp_password: password,
      from_name: s.sender_name || s.daycare_name || "Echelon Daycare",
      from_email: sender,
      to: recipients, cc: [],
      bcc: s.bcc_self === "1" ? [sender] : [],
      subject, body_text: body,
      attachment_b64: bytesToBase64(pdfBytes),
      attachment_filename: filename,
    },
  });
}

export async function sendReceiptEmail(opts: {
  receipt: Receipt;
  recipients: string[];
  settings: SettingsMap;
}): Promise<void> {
  const { receipt: r, recipients, settings: s } = opts;
  if (recipients.length === 0) throw new Error("No recipient email addresses.");
  const password = await invoke<string | null>("keychain_get", { key: "smtp_password" });
  if (!password) throw new Error("SMTP password not set. Open Settings → Email and save it first.");

  const sender = (s.sender_email || s.contact_email || "").trim();
  if (!sender) throw new Error("Sender email not set. Open Settings → Email.");
  const host = (s.smtp_host || "").trim();
  const port = parseInt(s.smtp_port || "587", 10);
  if (!host || !port) throw new Error("SMTP host/port not set. Open Settings → Email.");

  const pdf = await renderReceiptPdfBytes(r, s);
  const b64 = bytesToBase64(pdf);

  await invoke("send_email", {
    args: {
      smtp_host: host,
      smtp_port: port,
      smtp_user: (s.smtp_user || sender).trim(),
      smtp_password: password,
      from_name: s.sender_name || s.daycare_name || "Echelon Daycare",
      from_email: sender,
      to: recipients,
      cc: [],
      bcc: s.bcc_self === "1" ? [sender] : [],
      subject: renderTemplate(s.email_subject || "Receipt #{{receipt_no}}", r, s),
      body_text: renderTemplate(s.email_body || "Receipt attached.", r, s),
      attachment_b64: b64,
      attachment_filename: `Receipt-${r.receipt_no}-${r.student_name_snapshot.replace(/[^\w]+/g, "_")}.pdf`,
    },
  });
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
  const password = await invoke<string | null>("keychain_get", { key: "smtp_password" });
  if (!password) throw new Error("Save the SMTP password first.");
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
      smtp_password: password,
      from_name: s.sender_name || "Echelon Daycare",
      from_email: sender,
      to: [sender],
      cc: [],
      bcc: [],
      subject: "Echelon Receipts — test email",
      body_text: "✅ SMTP is working. You can now email receipts from the app.",
      attachment_b64: btoa("test"),
      attachment_filename: "test.txt",
    },
  });
}
