import { mkdir, writeFile, writeTextFile, exists } from "@tauri-apps/plugin-fs";
import type { Receipt, SettingsMap, AnnualReceipt } from "../types";
import { db, listReceipts } from "./db";
import { buildReceiptHtml, saveReceiptPdf } from "./receipt";
import { loadHtml2Pdf } from "./lazy";

function csvEscape(v: any): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|']+/g, "").replace(/\s+/g, "_").slice(0, 60);
}

async function renderPdf(html: string): Promise<Uint8Array> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0";
  host.innerHTML = html;
  document.body.appendChild(host);
  const target = (host.querySelector(".sheet") as HTMLElement) || host;
  try {
    const html2pdf = await loadHtml2Pdf();
    const blob: Blob = await html2pdf().from(target).set({
      margin: 0.4, image: { type: "jpeg", quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
      jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
    }).outputPdf("blob");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    document.body.removeChild(host);
  }
}

export async function exportYearArchive(opts: {
  year: number;
  settings: SettingsMap;
  baseFolder: string;             // user-picked destination root
  onProgress?: (msg: string) => void;
}): Promise<string> {
  const { year, settings: s, baseFolder, onProgress } = opts;
  const log = (m: string) => { onProgress?.(m); };

  const root = `${baseFolder.replace(/[\\/]+$/, "")}/Echelon_Year_${year}_Archive`;
  if (!(await exists(root))) await mkdir(root, { recursive: true });

  const receiptsDir = `${root}/Receipts`;
  const annualDir = `${root}/AnnualReceipts`;
  if (!(await exists(receiptsDir))) await mkdir(receiptsDir, { recursive: true });
  if (!(await exists(annualDir))) await mkdir(annualDir, { recursive: true });

  // 1) All receipts in calendar year (inc. voided for audit completeness)
  log(`Loading ${year} receipts…`);
  const all = await (await db()).select<Receipt[]>(
    `SELECT * FROM receipts WHERE substr(date,1,4)=? ORDER BY receipt_no ASC`,
    [String(year)]
  );

  // 2) Master CSV of all receipts
  log(`Writing master CSV (${all.length} rows)…`);
  const header = [
    "receipt_no","date","student_name","father_name","mother_name",
    "description","amount","is_refund","pending_amount","comments","voided",
    "emailed_at","emailed_to","created_at",
  ];
  const csvLines = [header.join(",")];
  for (const r of all) {
    csvLines.push([
      r.receipt_no, r.date, r.student_name_snapshot, r.father_name_snapshot, r.mother_name_snapshot,
      r.description, r.amount, r.is_refund, r.pending_amount, r.comments, r.voided,
      r.emailed_at, r.emailed_to, r.created_at,
    ].map(csvEscape).join(","));
  }
  await writeTextFile(`${root}/Receipts_${year}.csv`, csvLines.join("\n"));

  // 3) Voided log
  const voided = all.filter((r) => r.voided);
  if (voided.length) {
    const vLines = ["receipt_no,date,student_name,description,amount,voided"];
    for (const r of voided) {
      vLines.push([r.receipt_no, r.date, r.student_name_snapshot, r.description, r.amount, "1"].map(csvEscape).join(","));
    }
    await writeTextFile(`${root}/Voided_${year}.csv`, vLines.join("\n"));
  }

  // 4) Per-receipt PDFs (skip voided)
  for (const r of all) {
    if (r.voided) continue;
    log(`PDF receipt #${r.receipt_no}…`);
    // Reuse the year-archive folder (write directly under Receipts/)
    const html = buildReceiptHtml(r, s);
    const bytes = await renderPdf(html);
    const fname = `${r.receipt_no}_${r.date}_${safeName(r.student_name_snapshot)}.pdf`;
    await writeFile(`${receiptsDir}/${fname}`, bytes);
  }

  // 5) Annual receipts log + PDFs
  log(`Annual receipts log…`);
  const ars = await (await db()).select<AnnualReceipt[]>(
    `SELECT * FROM annual_receipts WHERE calendar_year=? ORDER BY ar_number ASC`,
    [year]
  );
  if (ars.length) {
    const aLines = [
      "ar_number,issued_at,student_name,recipient_label,total_amount,receipt_count,emailed_at,emailed_to,superseded_by"
    ];
    for (const a of ars) {
      aLines.push([
        a.ar_number, a.issued_at, a.student_name, a.recipient_label,
        a.total_amount, a.receipt_count, a.emailed_at, a.emailed_to,
        a.superseded_by,
      ].map(csvEscape).join(","));
    }
    await writeTextFile(`${root}/AnnualReceipts_${year}.csv`, aLines.join("\n"));
  }

  // 6) Manifest
  const manifest = {
    daycare: s.daycare_name || "",
    business_number: s.business_number || "",
    address: s.daycare_address || "",
    year,
    generated_at: new Date().toISOString(),
    counts: {
      receipts_total: all.length,
      receipts_active: all.filter((r) => !r.voided).length,
      receipts_voided: voided.length,
      annual_receipts: ars.length,
    },
  };
  await writeTextFile(`${root}/MANIFEST.json`, JSON.stringify(manifest, null, 2));
  await writeTextFile(`${root}/README.txt`, [
    `Echelon Daycare Society — Year ${year} Archive`,
    `Generated: ${new Date().toString()}`,
    ``,
    `Contents:`,
    `  Receipts/                  - One PDF per non-voided receipt`,
    `  AnnualReceipts/            - Per-family CRA annual receipt PDFs (if generated)`,
    `  Receipts_${year}.csv       - Master spreadsheet of every receipt`,
    `  AnnualReceipts_${year}.csv - Index of all CRA annual receipts issued`,
    `  Voided_${year}.csv         - Audit log of voided receipts`,
    `  MANIFEST.json              - Counts + business info for accountant / auditor`,
    ``,
    `Hand this folder to your accountant or include it in your CRA records.`,
  ].join("\n"));

  log(`Done.`);
  return root;
}

// Also re-save existing PDFs into the configured pdf_folder structure (resync helper).
export async function resyncReceiptsForYear(year: number, settings: SettingsMap, onProgress?: (m: string) => void): Promise<number> {
  const all = await listReceipts({ year });
  let count = 0;
  for (const r of all) {
    if (r.voided) continue;
    onProgress?.(`Saving #${r.receipt_no}…`);
    await saveReceiptPdf(r, settings);
    count++;
  }
  return count;
}
