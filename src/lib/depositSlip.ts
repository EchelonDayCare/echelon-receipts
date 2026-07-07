// Bank Business Deposit Slip renderer.
//
// Mirrors the layout Luxmi uses in her Excel replica: a two-column form with
// the cheque list on the left and the cash-count / totals block on the right.
// Bank fields (date, branch #, account #) are intentionally left blank — she
// pen-fills them at the teller.
import { showPdfPreview } from "./pdfPreview";
import type { Receipt, Deposit, SettingsMap } from "../types";
import { h } from "./html";

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
}
function fmtAmount(n: number): string {
  return n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function buildDepositSlipHtml(
  deposit: Deposit,
  receipts: Receipt[],
  settings: SettingsMap
): string {
  const rows = receipts.map((r, i) => {
    // Prefer the parent name if available (that's whose cheque it is); fall
    // back to the student's name if the parent snapshot wasn't captured.
    const payer =
      r.father_name_snapshot?.trim() ||
      r.mother_name_snapshot?.trim() ||
      r.student_name_snapshot ||
      "";
    return `<tr>
      <td class="idx">${i + 1}</td>
      <td class="cid">${h(payer)}</td>
      <td class="amt">$${fmtAmount(r.amount)}</td>
    </tr>`;
  }).join("");

  // Pad to 15 rows so the printed form looks consistent regardless of count.
  const padRows = Math.max(0, 15 - receipts.length);
  const pads = Array.from({ length: padRows }, (_, i) =>
    `<tr><td class="idx">${receipts.length + i + 1}</td><td class="cid"></td><td class="amt"></td></tr>`
  ).join("");

  void settings; // reserved for future (logo, org info)

  return `<!doctype html><html><head><meta charset="utf-8"><title>Deposit Slip #${deposit.id}</title>
<style>
  @page { size: Letter; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; }
  .sheet { width: 7.5in; padding: 0.5in; box-sizing: border-box; }
  .bankHead { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #000; padding-bottom: 6px; }
  .orgBox { font-size: 12px; min-width: 3in; }
  .orgBox .label { font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  .orgBox .cell { border-bottom: 1px solid #000; min-height: 22px; padding: 2px 4px; }
  .bankBox { text-align: right; font-size: 12px; }
  .bankBox .slipName { font-weight: 700; font-size: 13px; color: #333; }
  .metaRow { display: grid; grid-template-columns: 1.4fr 1fr 1.4fr 1fr; gap: 10px; margin-top: 10px; font-size: 11px; }
  .metaRow .cell { border-bottom: 1px solid #000; min-height: 22px; padding: 2px 4px; }
  .metaRow .lbl { font-size: 9px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  .creditCorner { position: relative; margin-top: 4px; }
  .creditCorner .creditLbl { position: absolute; top: 4px; right: 8px; font-size: 10px; color: #007a33; font-weight: 700; letter-spacing: 1px; }
  .grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; margin-top: 14px; }
  h3.section { font-size: 11px; margin: 0 0 4px; color: #007a33; text-transform: uppercase; letter-spacing: 0.5px; }
  table.cheques { width: 100%; border-collapse: collapse; font-size: 11px; }
  table.cheques th, table.cheques td { border: 1px solid #333; padding: 4px 6px; }
  table.cheques th { background: #f0f0f0; font-size: 10px; text-align: left; }
  table.cheques td.idx { width: 24px; text-align: center; color: #666; }
  table.cheques td.amt { width: 80px; text-align: right; }
  table.cash { width: 100%; border-collapse: collapse; font-size: 11px; }
  table.cash td { border: 1px solid #333; padding: 3px 6px; }
  table.cash td.denom { width: 70%; }
  table.cash td.amt { text-align: right; }
  table.cash tr.subtotal td { font-weight: 700; background: #f7f7f7; }
  .totalsBlock { margin-top: 10px; border: 2px solid #007a33; padding: 6px 8px; font-size: 12px; }
  .totalsBlock .row { display: flex; justify-content: space-between; padding: 3px 0; }
  .totalsBlock .row.grand { border-top: 2px solid #000; margin-top: 4px; padding-top: 6px; font-weight: 700; font-size: 14px; }
  .foot { margin-top: 14px; font-size: 10px; color: #666; text-align: center; border-top: 1px dashed #ccc; padding-top: 6px; }
  .depMeta { display: flex; gap: 18px; font-size: 11px; margin-top: 4px; color: #333; }
  .depMeta b { color: #000; }
</style></head>
<body><div class="sheet">
  <div class="bankHead">
    <div class="orgBox">
      <div class="label">Name of Account</div>
      <div class="cell"></div>
    </div>
    <div class="bankBox">
      <div class="slipName">BUSINESS ACCOUNT DEPOSIT SLIP</div>
    </div>
  </div>

  <div class="metaRow">
    <div><div class="lbl">Date</div><div class="cell"></div></div>
    <div><div class="lbl">Branch No.</div><div class="cell"></div></div>
    <div><div class="lbl">Account No.</div><div class="cell"></div></div>
    <div><div class="lbl">Credit</div><div class="cell"></div></div>
  </div>

  <div class="depMeta">
    <span><b>Deposit #:</b> ${deposit.id}</span>
    <span><b>Prepared:</b> ${h(fmtDate(deposit.deposit_date))}</span>
    <span><b>Cheques:</b> ${deposit.cheque_count}</span>
    <span><b>Total:</b> $${fmtAmount(deposit.total_amount)}</span>
    ${deposit.notes ? `<span><b>Notes:</b> ${h(deposit.notes)}</span>` : ""}
  </div>

  <div class="grid">
    <div>
      <h3 class="section">List of Cheques</h3>
      <table class="cheques">
        <thead>
          <tr><th>#</th><th>Cheque Identification</th><th style="text-align:right">Amount</th></tr>
        </thead>
        <tbody>
          ${rows}
          ${pads}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2" style="text-align:right;font-weight:700;background:#f7f7f7">Cheque Subtotal</td>
            <td class="amt" style="font-weight:700;background:#f7f7f7">$${fmtAmount(deposit.total_amount)}</td>
          </tr>
          <tr>
            <td colspan="2" style="text-align:right;background:#f7f7f7">Total # of Cheques</td>
            <td class="amt" style="background:#f7f7f7">${deposit.cheque_count}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div>
      <h3 class="section">Cash Count</h3>
      <table class="cash">
        <tbody>
          <tr><td class="denom">× $5</td><td class="amt">&nbsp;</td></tr>
          <tr><td class="denom">× $10</td><td class="amt">&nbsp;</td></tr>
          <tr><td class="denom">× $20</td><td class="amt">&nbsp;</td></tr>
          <tr><td class="denom">× $50</td><td class="amt">&nbsp;</td></tr>
          <tr><td class="denom">× $100</td><td class="amt">&nbsp;</td></tr>
          <tr><td class="denom">× $1 Coin</td><td class="amt">&nbsp;</td></tr>
          <tr><td class="denom">× $2 Coin</td><td class="amt">&nbsp;</td></tr>
          <tr class="subtotal"><td class="denom">Cash Subtotal</td><td class="amt">&nbsp;</td></tr>
        </tbody>
      </table>

      <div class="totalsBlock">
        <div class="row"><span>Cash Subtotal</span><span>_________</span></div>
        <div class="row"><span>Cheque Subtotal</span><span>$${fmtAmount(deposit.total_amount)}</span></div>
        <div class="row grand"><span>TOTAL DEPOSIT</span><span>$${fmtAmount(deposit.total_amount)}</span></div>
      </div>
    </div>
  </div>

  <div class="foot">
    Deposit #${deposit.id} — Bank fields to be completed at branch.
  </div>
</div></body></html>`;
}

export function printDepositSlip(deposit: Deposit, receipts: Receipt[], settings: SettingsMap) {
  const html = buildDepositSlipHtml(deposit, receipts, settings);
  void showPdfPreview({
    html,
    title: `Deposit slip #${deposit.id} — ${deposit.deposit_date}`,
    filename: `Deposit_${deposit.id}_${deposit.deposit_date}.pdf`,
    format: "letter",
    margin: 0.4,
  });
}
