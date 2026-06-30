// Monthly Subsidy Statement: companion PDF to the regular receipt that breaks
// down gross fee, CCFRI reduction, ACCB subsidy, and what the parent actually
// paid. Required for BC licensing audits and answers the common parent question
// "why does my receipt say $X when full-time daycare costs more?"
import type { Receipt, SettingsMap } from "../types";
import { mkdir, writeFile, exists } from "@tauri-apps/plugin-fs";
import { DEFAULT_LOGO_DATA_URL } from "./defaults";
import { loadHtml2Pdf } from "./lazy";
import { h } from "./html";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function fmtAmount(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|']+/g, "").replace(/\s+/g, "_").slice(0, 60);
}
export function monthLabelFromDate(iso: string): { year: number; month: number; label: string } {
  const [y, m] = iso.split("-").map((x) => parseInt(x, 10));
  return { year: y, month: m, label: MONTHS[m - 1] || "" };
}

export function buildSubsidyStatementHtml(r: Receipt, s: SettingsMap): string {
  const logo = s.logo_data_url || DEFAULT_LOGO_DATA_URL;
  const { year, label } = monthLabelFromDate(r.date);
  const gross = r.gross_amount ?? 0;
  const ccfri = r.ccfri_amount ?? 0;
  const accb  = r.accb_amount ?? 0;
  const paid  = r.amount;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Subsidy Statement ${h(r.receipt_no)}</title>
<style>
  @page { size: Letter; margin: 0.5in; }
  body { font-family: Georgia, "Times New Roman", serif; color: #111; margin: 0; }
  .sheet { width: 7.5in; padding: 0.2in 0.3in; }
  .head { display:flex; align-items:center; gap:18px; border-bottom: 1px solid #000; padding-bottom: 12px; }
  .logo { width: 84px; height: 84px; border-radius: 50%; object-fit: cover; background:#cfeaf6; }
  h1 { margin: 0; font-size: 24px; }
  .addr { margin: 4px 0 0; font-size: 12px; color: #444; }
  .title2 { text-align:center; font-size: 19px; font-weight: 700; margin: 16px 0 4px; letter-spacing: 1px; }
  .sub { text-align:center; font-size: 12px; color:#555; margin-bottom: 14px; }
  .meta { display:grid; grid-template-columns: 1fr 1fr; gap:8px; font-size: 13px; margin: 6px 0 12px; }
  .meta b { display:inline-block; min-width: 110px; }
  table.b { width: 80%; margin: 0 auto; border-collapse: collapse; font-size: 14px; }
  table.b td { padding: 8px 12px; }
  table.b td.r { text-align:right; }
  table.b tr.line td { border-top: 1px solid #999; }
  table.b tr.tot td { border-top: 2px solid #111; font-weight: 700; padding-top: 10px; font-size: 16px; }
  .minus { color:#15803d; }
  .note { margin-top: 24px; padding: 12px; border: 1px solid #cbd5e1; background:#f8fafc; font-size: 12px; color:#334155; border-radius: 4px; }
  .footer { margin-top: 30px; text-align: center; font-size: 12px; border-top: 1px solid #ccc; padding-top: 10px; color:#444; }
</style></head>
<body><div class="sheet">
  <div class="head">
    ${logo ? `<img class="logo" src="${logo}"/>` : `<div class="logo"></div>`}
    <div>
      <h1>${h(s.daycare_name || "Echelon Daycare Society")}</h1>
      <p class="addr">${h(s.daycare_address || "")}</p>
    </div>
  </div>

  <div class="title2">MONTHLY FEE BREAKDOWN</div>
  <div class="sub">${h(label)} ${h(year)}</div>

  <div class="meta">
    <div><b>Child:</b> ${h(r.student_name_snapshot)}</div>
    <div style="text-align:right"><b>Receipt #</b> ${h(r.receipt_no)}</div>
    <div><b>Parents:</b>
      ${[r.father_name_snapshot, r.mother_name_snapshot].filter(Boolean).map((n) => h(n)).join(" &amp; ") || "—"}
    </div>
    <div style="text-align:right"><b>Period:</b> ${h(label)} ${h(year)}</div>
  </div>

  <table class="b">
    <tbody>
      <tr><td>Gross monthly fee</td><td class="r">$${fmtAmount(gross)}</td></tr>
      ${ccfri > 0 ? `<tr class="line"><td>Less: BC Child Care Fee Reduction Initiative (CCFRI)</td><td class="r minus">−$${fmtAmount(ccfri)}</td></tr>` : ""}
      ${accb  > 0 ? `<tr class="line"><td>Less: Affordable Child Care Benefit (ACCB)</td><td class="r minus">−$${fmtAmount(accb)}</td></tr>`  : ""}
      <tr class="tot"><td>Amount paid by parent (out-of-pocket)</td><td class="r">$${fmtAmount(paid)}</td></tr>
    </tbody>
  </table>

  <div class="note">
    <b>About this statement:</b> The amount you paid is the only portion that appears on your CRA Annual Tax Receipt
    (used for Form T778, Child Care Expenses Deduction). The CCFRI and ACCB amounts above are paid by the
    Province of British Columbia directly to ${h(s.daycare_name || "Echelon Daycare Society")} on your behalf and cannot
    be claimed as a personal child-care expense.
  </div>

  <div class="footer">
    Questions? ${h(s.contact_email || "")} · ${h(s.contact_phone || "")}
  </div>
</div></body></html>`;
}

async function renderPdfBytes(html: string): Promise<Uint8Array> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0";
  host.innerHTML = html;
  document.body.appendChild(host);
  const target = host.querySelector(".sheet") as HTMLElement || host;
  try {
    const html2pdf = await loadHtml2Pdf();
    const blob: Blob = await html2pdf()
      .from(target)
      .set({
        margin: 0.4,
        filename: "subsidy.pdf",
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
export async function renderSubsidyStatementPdf(r: Receipt, s: SettingsMap): Promise<Uint8Array> {
  return renderPdfBytes(buildSubsidyStatementHtml(r, s));
}
export async function saveSubsidyStatementPdf(r: Receipt, s: SettingsMap): Promise<string | null> {
  const folder = (s.pdf_folder || "").trim();
  if (!folder) return null;
  const bytes = await renderSubsidyStatementPdf(r, s);
  const [yy, mm] = r.date.split("-");
  const subdir = `${folder.replace(/[\\/]+$/, "")}/${yy}/${mm}/SubsidyStatements`;
  if (!(await exists(subdir))) await mkdir(subdir, { recursive: true });
  const fname = `SUB_${r.receipt_no}_${r.date}_${safeName(r.student_name_snapshot)}.pdf`;
  const full = `${subdir}/${fname}`;
  await writeFile(full, bytes);
  return full;
}

export function renderSubsidyEmailTemplate(tpl: string, r: Receipt, s: SettingsMap): string {
  const { year, label } = monthLabelFromDate(r.date);
  const map: Record<string, string> = {
    student: r.student_name_snapshot,
    month_label: label,
    year: String(year),
    gross: fmtAmount(r.gross_amount ?? 0),
    ccfri: fmtAmount(r.ccfri_amount ?? 0),
    accb:  fmtAmount(r.accb_amount  ?? 0),
    parent_paid: fmtAmount(r.amount),
    daycare_name: s.daycare_name || "",
    contact_email: s.contact_email || "",
    contact_phone: s.contact_phone || "",
  };
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (map[k] !== undefined ? map[k] : ""));
}
