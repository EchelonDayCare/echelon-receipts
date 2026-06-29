import type { Receipt, SettingsMap } from "../types";
import { mkdir, writeFile, exists } from "@tauri-apps/plugin-fs";
import { DEFAULT_LOGO_DATA_URL, DEFAULT_SIGNATURE_DATA_URL } from "./defaults";
import { loadHtml2Pdf } from "./lazy";
import { issuerViewFor } from "./db";

function fmtDate(iso: string): string {
  // dd/mm/yyyy to match the existing receipt
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function fmtAmount(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|']+/g, "").replace(/\s+/g, "_").slice(0, 60);
}

export function buildReceiptHtml(r: Receipt, settings: SettingsMap): string {
  // Prefer the issuer snapshot taken at receipt-issue time so historical PDFs
  // stay consistent even if the daycare's address / signer / BN changed later.
  const s = issuerViewFor(r, settings);
  const logo = s.logo_data_url || DEFAULT_LOGO_DATA_URL;
  const sig = s.signature_data_url || DEFAULT_SIGNATURE_DATA_URL;
  const hasBreakdown =
    r.gross_amount != null && r.gross_amount > 0 &&
    ((r.ccfri_amount ?? 0) > 0 || (r.accb_amount ?? 0) > 0);
  const breakdownRows = hasBreakdown ? `
  <table class="bk">
    <tbody>
      <tr><td>Gross monthly fee</td><td class="r">$${fmtAmount(r.gross_amount!)}</td></tr>
      ${(r.ccfri_amount ?? 0) > 0 ? `<tr><td>BC CCFRI reduction</td><td class="r minus">−$${fmtAmount(r.ccfri_amount!)}</td></tr>` : ""}
      ${(r.accb_amount  ?? 0) > 0 ? `<tr><td>ACCB subsidy</td><td class="r minus">−$${fmtAmount(r.accb_amount!)}</td></tr>`  : ""}
      <tr class="bktot"><td>Amount paid by parent</td><td class="r">$${fmtAmount(r.amount)}</td></tr>
    </tbody>
  </table>` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${r.receipt_no}</title>
<style>
  @page { size: Letter; margin: 0.5in; }
  body { font-family: Georgia, "Times New Roman", serif; color: #111; margin: 0; }
  .sheet { width: 7.5in; padding: 0.2in 0.3in; }
  .head { display: flex; align-items: center; gap: 18px; border-bottom: 1px solid #000; padding-bottom: 12px; }
  .logo { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; flex: 0 0 96px; background:#cfeaf6; }
  .title { font-size: 28px; font-weight: 700; margin: 0; }
  .addr { margin: 4px 0 0; font-size: 13px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 18px 0 8px; font-size: 14px; }
  .meta b { display: inline-block; min-width: 90px; }
  .recv { margin: 6px 0 18px; font-size: 14px; }
  .recv b { display: inline-block; min-width: 90px; vertical-align: top; }
  .recv .parents { display: inline-block; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.items th, table.items td { border: 1px solid #000; padding: 10px 12px; }
  table.items th { background: #f4f4f4; font-size: 14px; }
  table.items td.amount { text-align: center; font-weight: 700; font-size: 16px; width: 28%; }
  table.items td.desc { width: 52%; }
  table.items td.name { width: 20%; text-align: center; font-weight: 600; }
  table.bk { width: 60%; margin: 10px 0 0 auto; border-collapse: collapse; font-size: 12px; }
  table.bk td { padding: 3px 8px; }
  table.bk td.r { text-align: right; }
  table.bk td.minus { color: #15803d; }
  table.bk tr.bktot td { border-top: 1px solid #999; font-weight: 700; padding-top: 5px; }
  .comments { margin: 18px 0 6px; font-size: 14px; }
  .comments .lbl { display: inline-block; min-width: 100px; }
  .pending { font-style: italic; }
  .recvd { margin: 24px 0 8px; font-size: 14px; display: flex; align-items: center; gap: 12px; }
  .sig { height: 36px; }
  .footer { margin-top: 36px; text-align: center; font-size: 13px; border-top: 1px solid #ccc; padding-top: 14px; }
  .thank { font-family: "Brush Script MT", "Lucida Handwriting", cursive; font-size: 24px; margin-top: 4px; }
  .voided { color: #b00020; font-weight: 700; }
</style></head>
<body><div class="sheet">
  <div class="head">
    ${logo ? `<img class="logo" src="${logo}"/>` : `<div class="logo"></div>`}
    <div>
      <p class="title">${s.daycare_name || "Echelon Daycare Society"}</p>
      <p class="addr">${s.daycare_address || ""}</p>
    </div>
  </div>

  <div class="meta">
    <div><b>Receipt #</b> ${r.receipt_no}${r.voided ? ' <span class="voided">(VOIDED)</span>' : ""}</div>
    <div style="text-align:right"><b>Date:</b> ${fmtDate(r.date)}</div>
  </div>

  <div class="recv">
    <b>Received From</b>
    <span class="parents">
      ${r.father_name_snapshot ? r.father_name_snapshot + "<br/>" : ""}
      ${r.mother_name_snapshot || ""}
    </span>
  </div>

  <table class="items">
    <thead>
      <tr><th colspan="2">Description</th><th>${r.is_refund ? "Refund" : "Amount Received"}</th></tr>
    </thead>
    <tbody>
      <tr>
        <td class="name">${r.student_name_snapshot}</td>
        <td class="desc">${r.description}${r.is_refund ? " <b>(REFUND)</b>" : ""}</td>
        <td class="amount">${r.is_refund ? "-" : ""}$${fmtAmount(Math.abs(r.amount))}</td>
      </tr>
    </tbody>
  </table>
  ${breakdownRows}

  <div class="comments">
    <span class="lbl">Comments:</span>
    ${r.comments ? r.comments : ""}
    ${r.pending_amount > 0 ? ` <span class="pending">Pending Fees CAD${fmtAmount(r.pending_amount)}</span>` : ""}
  </div>

  <div class="recvd">
    <b>Received by:</b>
    ${sig ? `<img class="sig" src="${sig}"/>` : `<span style="border-bottom:1px solid #000;display:inline-block;width:200px;height:24px"></span>`}
  </div>

  <div class="footer">
    If you have any questions regarding this receipt, please feel free to contact us at:<br/>
    ${s.contact_email || ""} or ${s.contact_phone || ""}
    <div class="thank">THANK YOU!</div>
  </div>
</div></body></html>`;
}

export function printReceipt(r: Receipt, s: SettingsMap) {
  const html = buildReceiptHtml(r, s);
  // Use a hidden iframe inside the main window — Tauri's webview blocks window.open.
  const existing = document.getElementById("__print_frame");
  if (existing) existing.remove();
  const iframe = document.createElement("iframe");
  iframe.id = "__print_frame";
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) { alert("Print failed: could not open iframe."); return; }
  doc.open();
  doc.write(html);
  doc.close();
  const fire = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (e) {
      alert("Print failed: " + e);
    }
  };
  // Wait a tick for images (logo/signature) to lay out, then print.
  setTimeout(fire, 350);
}

// Render the receipt HTML offscreen, generate a PDF Blob, and write it to
// <pdfFolder>/<YYYY>/<MM>/<receiptNo>_<YYYY-MM-DD>_<Student>.pdf
// Returns the absolute file path, or null if pdfFolder isn't configured.
export async function saveReceiptPdf(r: Receipt, s: SettingsMap): Promise<string | null> {
  const folder = (s.pdf_folder || "").trim();
  if (!folder) return null;

  const html = buildReceiptHtml(r, s);
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.innerHTML = html;
  document.body.appendChild(host);
  // html2pdf operates on the .sheet element to get accurate sizing
  const target = host.querySelector(".sheet") as HTMLElement || host;

  let bytes: Uint8Array;
  try {
    const html2pdf = await loadHtml2Pdf();
    const blob: Blob = await html2pdf()
      .from(target)
      .set({
        margin: 0.4,
        filename: "receipt.pdf",
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
      })
      .outputPdf("blob");
    bytes = new Uint8Array(await blob.arrayBuffer());
  } finally {
    document.body.removeChild(host);
  }

  const [yy, mm] = r.date.split("-");
  const subdir = `${folder.replace(/[\\/]+$/, "")}/${yy}/${mm}`;
  if (!(await exists(subdir))) await mkdir(subdir, { recursive: true });

  const fname = `${r.receipt_no}_${r.date}_${safeName(r.student_name_snapshot)}.pdf`;
  const fullPath = `${subdir}/${fname}`;
  await writeFile(fullPath, bytes);
  return fullPath;
}
