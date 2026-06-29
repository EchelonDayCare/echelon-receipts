import type { SettingsMap } from "../types";
import type { AnnualGroup } from "./db";
import { mkdir, writeFile, exists } from "@tauri-apps/plugin-fs";
import { DEFAULT_LOGO_DATA_URL, DEFAULT_SIGNATURE_DATA_URL } from "./defaults";
import { loadHtml2Pdf } from "./lazy";

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function fmtAmount(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|']+/g, "").replace(/\s+/g, "_").slice(0, 60);
}
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function buildAnnualReceiptHtml(opts: {
  group: AnnualGroup;
  year: number;
  arNumber: string;
  recipientLabel: string;
  settings: SettingsMap;
  issuedOn?: string;
  supersededNote?: string | null;
  issuerSnapshotJson?: string | null;
}): string {
  const { group, year, arNumber, recipientLabel } = opts;
  // Merge snapshot over live settings so historical re-renders stay correct.
  let s = opts.settings;
  if (opts.issuerSnapshotJson) {
    try { s = { ...opts.settings, ...JSON.parse(opts.issuerSnapshotJson) }; } catch { /* ignore */ }
  }
  const issuedOn = opts.issuedOn || todayIso();
  const logo = s.logo_data_url || DEFAULT_LOGO_DATA_URL;
  const sig = s.signature_data_url || DEFAULT_SIGNATURE_DATA_URL;
  const directorName = s.director_name || "";
  const directorTitle = s.director_title || "Managing Director";
  const bn = s.business_number || "";

  const rows = group.receipts.map((r) => `
    <tr${r.is_refund ? ' class="refund"' : ""}>
      <td>${fmtDate(r.date)}</td>
      <td class="rno">#${r.receipt_no}</td>
      <td>${r.description}${r.is_refund ? " (Refund)" : ""}</td>
      <td class="amt">${r.is_refund ? "-" : ""}$${fmtAmount(Math.abs(r.amount))}</td>
    </tr>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${arNumber}</title>
<style>
  @page { size: Letter; margin: 0.5in; }
  body { font-family: Georgia, "Times New Roman", serif; color:#111; margin:0; }
  .sheet { width:7.5in; padding:0.2in 0.3in; }
  .head { display:flex; align-items:center; gap:18px; border-bottom:1px solid #000; padding-bottom:12px; }
  .logo { width:96px; height:96px; border-radius:50%; object-fit:cover; flex:0 0 96px; }
  .title { font-size:24px; font-weight:700; margin:0; }
  .addr { margin:4px 0 0; font-size:13px; }
  .bn { margin:2px 0 0; font-size:12px; color:#444; }
  .docTitle { text-align:center; margin:22px 0 8px; }
  .docTitle h2 { font-size:20px; margin:0; letter-spacing:1px; }
  .docTitle .sub { font-size:12px; color:#555; margin-top:4px; }
  .meta { display:grid; grid-template-columns: 1fr 1fr; gap:6px 18px; margin:14px 0 6px; font-size:13px; }
  .meta b { display:inline-block; min-width:110px; }
  table.items { width:100%; border-collapse:collapse; margin-top:10px; }
  table.items th, table.items td { border:1px solid #777; padding:6px 8px; font-size:12px; }
  table.items th { background:#eef2f7; }
  table.items td.amt { text-align:right; white-space:nowrap; font-variant-numeric: tabular-nums; }
  table.items td.rno { white-space:nowrap; }
  table.items tr.refund { color:#8a1c1c; }
  .total { margin-top:8px; text-align:right; font-size:15px; }
  .total b { font-size:17px; }
  .sigRow { margin-top:36px; display:flex; align-items:center; gap:14px; }
  .sig { height:48px; }
  .sigDetail { font-size:13px; }
  .ar { font-family: Consolas, monospace; }
  .superseded { background:#fff3cd; border:1px solid #d4ac0d; padding:6px 10px; margin:14px 0; font-size:12px; }
  .footer { margin-top:30px; padding-top:12px; border-top:1px solid #ccc; font-size:11px; color:#555; text-align:center; }
</style></head>
<body><div class="sheet">

  <div class="head">
    <img class="logo" src="${logo}"/>
    <div>
      <p class="title">${s.daycare_name || "Echelon Daycare Society"}</p>
      <p class="addr">${s.daycare_address || ""}</p>
      ${bn ? `<p class="bn">Business Number: ${bn}</p>` : ""}
    </div>
  </div>

  <div class="docTitle">
    <h2>ANNUAL CHILD CARE RECEIPT &mdash; ${year}</h2>
    <div class="sub">For CRA Form T778 / Line 21400 (Child Care Expenses Deduction)</div>
  </div>

  ${opts.supersededNote ? `<div class="superseded">${opts.supersededNote}</div>` : ""}

  <div class="meta">
    <div><b>Receipt #</b> <span class="ar">${arNumber}</span></div>
    <div style="text-align:right"><b>Issued on:</b> ${fmtDate(issuedOn)}</div>
    <div><b>Issued to:</b> ${recipientLabel}</div>
    <div style="text-align:right"><b>Period:</b> Jan 1 &ndash; Dec 31, ${year}</div>
    <div><b>For child:</b> ${group.student_name}</div>
    <div style="text-align:right"><b>Payments:</b> ${group.count}</div>
  </div>

  <table class="items">
    <thead>
      <tr><th>Date</th><th>Receipt #</th><th>Description</th><th class="amt">Amount</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="total">Total paid in ${year}: <b>$${fmtAmount(group.total)}</b></div>

  <div class="sigRow">
    <div class="sigDetail">
      <div>Issued by:</div>
      <img class="sig" src="${sig}"/>
      <div>${directorName}${directorName ? ", " : ""}${directorTitle}</div>
    </div>
  </div>

  <div class="footer">
    If you have any questions regarding this receipt, please contact us at
    ${s.contact_email || ""}${s.contact_phone ? " or " + s.contact_phone : ""}.
  </div>
</div></body></html>`;
}

async function renderAnnualPdfBytes(html: string): Promise<Uint8Array> {
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
        filename: "annual-receipt.pdf",
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
      })
      .outputPdf("blob");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    document.body.removeChild(host);
  }
}

export async function renderAnnualReceiptPdf(opts: Parameters<typeof buildAnnualReceiptHtml>[0]): Promise<Uint8Array> {
  return renderAnnualPdfBytes(buildAnnualReceiptHtml(opts));
}

export async function saveAnnualReceiptPdf(opts: {
  group: AnnualGroup;
  year: number;
  arNumber: string;
  recipientLabel: string;
  settings: SettingsMap;
  supersededNote?: string | null;
}): Promise<string | null> {
  const folder = (opts.settings.pdf_folder || "").trim();
  if (!folder) return null;
  const html = buildAnnualReceiptHtml(opts);
  const bytes = await renderAnnualPdfBytes(html);
  const subdir = `${folder.replace(/[\\/]+$/, "")}/${opts.year}/Annual`;
  if (!(await exists(subdir))) await mkdir(subdir, { recursive: true });
  const fname = `${opts.arNumber}_${safeName(opts.group.student_name)}.pdf`;
  const full = `${subdir}/${fname}`;
  await writeFile(full, bytes);
  return full;
}

export function renderAnnualEmailTemplate(tpl: string, ctx: {
  group: AnnualGroup; year: number; arNumber: string; settings: SettingsMap;
}): string {
  const map: Record<string, string> = {
    year: String(ctx.year),
    student: ctx.group.student_name,
    total: fmtAmount(ctx.group.total),
    count: String(ctx.group.count),
    ar_number: ctx.arNumber,
    contact_email: ctx.settings.contact_email || "",
    contact_phone: ctx.settings.contact_phone || "",
    daycare_name: ctx.settings.daycare_name || "",
  };
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (map[k] !== undefined ? map[k] : ""));
}
