import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  extractVisaStatement, guessCategory, PAYMENT_SENTINEL,
  type ExtractedVisaTxn, type ExtractVisaResult,
} from "../../lib/visaImport";
import {
  EXPENSE_CATEGORIES, PAYMENT_METHODS,
  saveExpense, listExpenses,
} from "../../lib/expenses";

function fileMime(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".pdf")) return "application/pdf";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".heic")) return "image/heic";
  return "image/jpeg";
}
function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Row extends ExtractedVisaTxn {
  category: string;
  include: boolean;
  isPayment: boolean;
  duplicate: boolean;
  imported: boolean;
}

export default function ImportStatement() {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");
  const [meta, setMeta] = useState<Pick<ExtractVisaResult, "statement_period" | "card_last4" | "statement_total"> | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [payment, setPayment] = useState<string>("Visa Credit Card");

  async function onPick() {
    setErr(""); setStatus("");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Statement (PDF or image)", extensions: ["pdf", "jpg", "jpeg", "png", "webp", "heic"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    setBusy(true);
    setStatus("Reading file…");
    try {
      const apiKey = await invoke<string | null>("keychain_get", { key: "azure_ai_key" });
      if (!apiKey) {
        setErr("Azure AI Foundry key not found in keychain. Add it in Configuration → Staff (used for staff sign-in sheets too).");
        setBusy(false); return;
      }
      const bytes = await readFile(picked);
      const mime = fileMime(picked);
      setStatus("Extracting transactions with Azure Mistral Document AI… (30-90s for a full statement)");
      const result = await extractVisaStatement({ azureKey: apiKey, fileBytes: bytes, mimeType: mime });
      setMeta({
        statement_period: result.statement_period,
        card_last4: result.card_last4,
        statement_total: result.statement_total,
      });

      // Pull recent expenses to detect duplicates by date+amount+vendor.
      const existing = await listExpenses({
        from: result.statement_period?.slice(0, 10) || "1900-01-01",
        to: result.statement_period?.slice(-10) || "9999-12-31",
      });
      const dupKey = (d: string, a: number, v: string) => `${d}|${a.toFixed(2)}|${v.trim().toLowerCase()}`;
      const existingKeys = new Set(existing.map((e) => dupKey(e.date, e.amount, e.vendor || "")));

      const parsed: Row[] = result.transactions.map((t) => {
        const catGuess = guessCategory(t.merchant, t.category_guess);
        const isPayment = catGuess === PAYMENT_SENTINEL || t.amount < 0;
        return {
          ...t,
          category: isPayment ? "misc" : catGuess,
          isPayment,
          include: !isPayment,
          duplicate: existingKeys.has(dupKey(t.date, t.amount, t.merchant)),
          imported: false,
        };
      });
      setRows(parsed);
      setStatus(`Extracted ${parsed.length} transactions. Review, edit categories, then Import.`);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  const importable = rows.filter((r) => r.include && !r.isPayment && !r.imported);
  const importTotal = importable.reduce((a, r) => a + r.amount, 0);

  async function onImport() {
    if (importable.length === 0) { setErr("Nothing selected to import."); return; }
    setBusy(true); setErr("");
    try {
      let n = 0;
      const updated = [...rows];
      for (let i = 0; i < updated.length; i++) {
        const r = updated[i];
        if (!r.include || r.isPayment || r.imported) continue;
        await saveExpense({
          date: r.date,
          category: r.category,
          subcategory: null,
          vendor: r.merchant,
          amount: r.amount,
          payment_method: payment,
          reference: meta?.card_last4 ? `Visa ****${meta.card_last4}` : "Visa statement import",
          notes: r.foreign_amount ? `Foreign: ${r.foreign_amount}` : null,
        });
        updated[i] = { ...r, imported: true };
        n++;
      }
      setRows(updated);
      setStatus(`Imported ${n} transaction${n === 1 ? "" : "s"}. You can review them in All Expenses.`);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1300 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0 }}>Import Credit-Card Statement</h1>
          <p style={{ color: "var(--muted)", margin: "6px 0 0" }}>
            Upload a Visa / credit-card PDF statement. Gemini reads it and itemises every transaction so you can review and categorise before saving to Expenses.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={onPick} disabled={busy}>{busy ? "Working…" : "📄 Pick Statement"}</button>
        </div>
      </div>

      {err && <div style={{ background: "#fee2e2", border: "1px solid #ef4444", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12 }}>{err}</div>}
      {status && !err && <div style={{ background: "#dbeafe", border: "1px solid #3b82f6", color: "#1e3a8a", padding: 10, borderRadius: 6, marginBottom: 12 }}>{status}</div>}

      {meta && (
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 8, padding: 14, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 30, flexWrap: "wrap", fontSize: 13 }}>
            <div><strong>Statement period:</strong> {meta.statement_period || "—"}</div>
            <div><strong>Card:</strong> {meta.card_last4 ? `**** ${meta.card_last4}` : "—"}</div>
            <div><strong>Statement total:</strong> {meta.statement_total != null ? `$${fmt(meta.statement_total)}` : "—"}</div>
            <div><strong>Extracted:</strong> {rows.length} transactions</div>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <label>Payment method to record: <select value={payment} onChange={(e) => setPayment(e.target.value)}>
              {PAYMENT_METHODS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select></label>
            <label><input type="checkbox" checked={rows.every((r) => r.include || r.isPayment)} onChange={(e) => {
              const on = e.target.checked;
              setRows((prev) => prev.map((r) => r.isPayment ? r : { ...r, include: on }));
            }} /> Select all charges</label>
            <div style={{ marginLeft: "auto", fontSize: 13 }}>
              Will import <strong>{importable.length}</strong> — total <strong>${fmt(importTotal)}</strong>
            </div>
            <button className="btn" onClick={onImport} disabled={busy || importable.length === 0}>Import selected</button>
            <button className="btn secondary" onClick={() => nav("/expenses/list")}>Done</button>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff" }}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                <th style={th()}></th>
                <th style={th()}>Date</th>
                <th style={th()}>Merchant</th>
                <th style={{ ...th(), textAlign: "right" }}>Amount</th>
                <th style={th()}>Category</th>
                <th style={th()}>Notes</th>
                <th style={th()}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{
                  background: r.imported ? "#ecfdf5" : r.isPayment ? "#f3f4f6" : r.duplicate ? "#fef3c7" : undefined,
                  opacity: r.include || r.isPayment ? 1 : 0.55,
                }}>
                  <td style={td()}>
                    {r.isPayment ? <span style={{ color: "var(--muted)", fontSize: 11 }}>—</span> :
                      <input type="checkbox" checked={r.include} onChange={(e) => updateRow(i, { include: e.target.checked })} disabled={r.imported} />}
                  </td>
                  <td style={td()}>
                    <input type="date" value={r.date} onChange={(e) => updateRow(i, { date: e.target.value })} disabled={r.imported} style={{ width: 130 }} />
                  </td>
                  <td style={td()}>
                    <input value={r.merchant} onChange={(e) => updateRow(i, { merchant: e.target.value })} disabled={r.imported} style={{ width: "100%", minWidth: 200 }} />
                    {r.category_guess && <div style={{ fontSize: 11, color: "var(--muted)" }}>AI: {r.category_guess}</div>}
                  </td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 600, color: r.amount < 0 ? "#065f46" : "var(--text)" }}>
                    <input type="number" step="0.01" value={r.amount} onChange={(e) => updateRow(i, { amount: Number(e.target.value) })} disabled={r.imported} style={{ width: 90, textAlign: "right" }} />
                  </td>
                  <td style={td()}>
                    {r.isPayment ? (
                      <span style={{ color: "var(--muted)" }}>Payment / credit (skipped)</span>
                    ) : (
                      <select value={r.category} onChange={(e) => updateRow(i, { category: e.target.value })} disabled={r.imported}>
                        {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    )}
                  </td>
                  <td style={{ ...td(), fontSize: 11, color: "var(--muted)" }}>
                    {r.foreign_amount ? `Foreign: ${r.foreign_amount}` : ""}
                  </td>
                  <td style={{ ...td(), fontSize: 12 }}>
                    {r.imported && <span style={{ color: "#065f46" }}>✓ Imported</span>}
                    {!r.imported && r.duplicate && <span style={{ color: "#b45309" }}>Possible duplicate</span>}
                    {!r.imported && !r.duplicate && r.isPayment && <span style={{ color: "var(--muted)" }}>Excluded</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
            <div>• <strong>Payments/credits</strong> (negative amounts, "Thank You" lines) are excluded by default — they're not expenses, they're transfers from your bank.</div>
            <div>• <strong>Yellow rows</strong> already exist as expenses for that date/amount/vendor. Review before importing.</div>
            <div>• You can edit date, merchant, amount and category before importing. All rows below are unimported until you press <em>Import selected</em>.</div>
          </div>
        </>
      )}

      {rows.length === 0 && !busy && (
        <div style={{ background: "#fff", border: "1px dashed var(--border)", borderRadius: 8, padding: 30, textAlign: "center", color: "var(--muted)" }}>
          Pick a Visa / credit-card statement PDF to get started. The AI will extract every purchase, refund, and fee so you can review and import them as expenses.
        </div>
      )}
    </div>
  );
}

function th(): React.CSSProperties { return { textAlign: "left", padding: 6, border: "1px solid var(--border)", fontSize: 12 }; }
function td(): React.CSSProperties { return { padding: 6, border: "1px solid var(--border)", verticalAlign: "top" }; }
