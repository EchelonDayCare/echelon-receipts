import type { Receipt, SettingsMap } from "../types";

function fmtDate(iso: string): string {
  // dd/mm/yyyy to match the existing receipt
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function fmtAmount(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function buildReceiptHtml(r: Receipt, s: SettingsMap): string {
  const logo = s.logo_data_url || "";
  const sig = s.signature_data_url || "";
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
      <tr><th colspan="2">Description</th><th>Amount Received</th></tr>
    </thead>
    <tbody>
      <tr>
        <td class="name">${r.student_name_snapshot}</td>
        <td class="desc">${r.description}</td>
        <td class="amount">$${fmtAmount(r.amount)}</td>
      </tr>
    </tbody>
  </table>

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
  const w = window.open("", "_blank", "width=820,height=1000");
  if (!w) { alert("Pop-ups blocked. Allow pop-ups for this app."); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.onload = () => { setTimeout(() => { w.focus(); w.print(); }, 200); };
}
