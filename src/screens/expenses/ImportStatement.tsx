import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { showConfirm } from "../../lib/dialogs";
import { getSettings } from "../../lib/db";
import {
  extractVisaStatement, guessCategory, PAYMENT_SENTINEL,
  type ExtractedVisaTxn, type ExtractVisaResult,
} from "../../lib/visaImport";
import {
  EXPENSE_CATEGORIES, PAYMENT_METHODS,
  saveExpense, listExpenses, deleteImportBatch, listImportBatches,
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

// Detect any YYYY-MM-DD substring; return [earliest, latest].
function extractDateRange(period: string | null | undefined, txns: ExtractedVisaTxn[]): { from: string; to: string } {
  const dates: string[] = [];
  if (period) {
    const matches = period.match(/\d{4}-\d{2}-\d{2}/g) || [];
    dates.push(...matches);
  }
  for (const t of txns) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t.date)) dates.push(t.date);
  }
  if (dates.length === 0) return { from: "1900-01-01", to: "9999-12-31" };
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

// Stable hash of a transaction for dedup across re-imports of the same
// statement. Card last-4 anchors us to the specific card even if the AI
// re-interprets vendor whitespace slightly.
function txnHashFromFields(cardLast4: string | null, date: string, amount: number, merchant: string): string {
  const seed = `${cardLast4 || "----"}|${date}|${amount.toFixed(2)}|${merchant.trim().toLowerCase()}`;
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, "0");
}
function txnHash(cardLast4: string | null, t: ExtractedVisaTxn): string {
  return txnHashFromFields(cardLast4, t.date, t.amount, t.merchant);
}

// True credit-card statement payments to distinguish from merchant refunds.
// A merchant refund on Visa still shows as a negative amount, but the merchant
// line is not the bank's payment/thank-you sentinel. We flag only bank-side
// payments as "excluded from expenses".
function looksLikeCardPayment(merchant: string): boolean {
  return /\b(payment\s*-\s*)?thank\s*you\b|payment\s*received|autopay|preauthorized\s*payment/i.test(merchant);
}

interface Row extends ExtractedVisaTxn {
  category: string;
  include: boolean;
  isPayment: boolean;      // bank-side payment (excluded)
  isRefund: boolean;       // merchant refund (contra-expense — negative amount)
  duplicate: boolean;
  imported: boolean;
  hash: string;
}

export default function ImportStatement() {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");
  const [meta, setMeta] = useState<Pick<ExtractVisaResult, "statement_period" | "card_last4" | "statement_total"> | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [payment, setPayment] = useState<string>("Visa Credit Card");
  const [lastBatchId, setLastBatchId] = useState<string | null>(null);
  const [batches, setBatches] = useState<Awaited<ReturnType<typeof listImportBatches>>>([]);

  async function refreshBatches() {
    try { setBatches(await listImportBatches(10)); } catch { /* fine */ }
  }
  useEffect(() => { void refreshBatches(); }, []);

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
      const settings = await getSettings();
      if (settings.azure_ai_key_set !== "1") {
        setErr("Azure AI Foundry key not configured. Add it in Configuration → Optional features.");
        setBusy(false); return;
      }
      const bytes = await readFile(picked);
      const mime = fileMime(picked);
      setStatus("Extracting transactions with Azure Mistral Document AI… (30-90s for a full statement)");
      const result = await extractVisaStatement({ fileBytes: bytes, mimeType: mime });

      // Sanity: transactions must have valid YYYY-MM-DD dates and finite amounts.
      const clean = (result.transactions || []).filter((t) =>
        /^\d{4}-\d{2}-\d{2}$/.test(t.date) && isFinite(t.amount) && t.merchant?.trim().length
      );
      if (clean.length === 0) {
        setErr("No transactions extracted. If the statement is very long, try re-uploading or crop to the transaction pages.");
        setBusy(false); return;
      }

      setMeta({
        statement_period: result.statement_period,
        card_last4: result.card_last4,
        statement_total: result.statement_total,
      });

      // Build a robust dedup window. Regex-extract from statement_period; fall
      // back to min/max of transaction dates.
      const range = extractDateRange(result.statement_period, clean);
      const existing = await listExpenses({ from: range.from, to: range.to });
      const existingHashSet = new Set(existing.map((e) => e.source_txn_hash).filter(Boolean) as string[]);
      setExistingHashes(existingHashSet);
      setCardLast4(result.card_last4);

      const parsed: Row[] = clean.map((t) => {
        const catGuess = guessCategory(t.merchant, t.category_guess);
        const isPayment = catGuess === PAYMENT_SENTINEL || looksLikeCardPayment(t.merchant);
        const isRefund = !isPayment && t.amount < 0;
        const h = txnHash(result.card_last4, t);
        return {
          ...t,
          category: isPayment ? "misc" : (catGuess === PAYMENT_SENTINEL ? "misc" : catGuess),
          isPayment,
          isRefund,
          include: !isPayment,
          duplicate: existingHashSet.has(h),
          imported: false,
          hash: h,
        };
      });

      // Reconciliation check: sum of parsed charges vs statement total.
      if (result.statement_total != null) {
        const netCharges = parsed.filter((r) => !r.isPayment).reduce((a, r) => a + r.amount, 0);
        const drift = Math.abs(netCharges - result.statement_total);
        if (drift > 1.0) {
          setStatus(`⚠ Extracted ${parsed.length} transactions but the sum of charges ($${fmt(netCharges)}) does not match the statement total ($${fmt(result.statement_total)}). Review carefully before importing.`);
        } else {
          setStatus(`Extracted ${parsed.length} transactions. Review, edit categories, then Import.`);
        }
      } else {
        setStatus(`Extracted ${parsed.length} transactions. Review, edit categories, then Import.`);
      }
      setRows(parsed);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  // Precomputed dedup set + card_last4 so field edits can recompute the hash live.
  const [existingHashes, setExistingHashes] = useState<Set<string>>(new Set());
  const [cardLast4, setCardLast4] = useState<string | null>(null);

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => {
      if (idx !== i) return r;
      const next = { ...r, ...patch };
      // If any hash input changed, recompute hash + duplicate flag so the user
      // sees an accurate dup warning after inline edits, and the DB unique
      // index actually catches re-imports of edited rows.
      if (patch.date !== undefined || patch.merchant !== undefined || patch.amount !== undefined) {
        next.hash = txnHashFromFields(cardLast4, next.date, next.amount, next.merchant);
        next.duplicate = existingHashes.has(next.hash);
      }
      return next;
    }));
  }

  const importable = rows.filter((r) => r.include && !r.isPayment && !r.imported);
  const importTotal = importable.reduce((a, r) => a + r.amount, 0);

  async function onImport() {
    if (importable.length === 0) { setErr("Nothing selected to import."); return; }
    const dupCount = importable.filter((r) => r.duplicate).length;
    if (dupCount > 0) {
      const proceed = await showConfirm(
        `${dupCount} of the selected transactions match existing expenses (same date/amount/merchant). Import anyway?`,
        { kind: "warning" }
      );
      if (!proceed) return;
    }
    setBusy(true); setErr("");
    const batchId = crypto.randomUUID();
    try {
      let n = 0;
      const updated = [...rows];
      for (let i = 0; i < updated.length; i++) {
        const r = updated[i];
        if (!r.include || r.isPayment || r.imported) continue;
        // Final defense: recompute hash from current field values in case an
        // edit slipped past the updateRow live-recompute.
        const freshHash = txnHashFromFields(cardLast4, r.date, r.amount, r.merchant);
        try {
          await saveExpense({
            date: r.date,
            category: r.category,
            subcategory: null,
            vendor: r.merchant,
            amount: r.amount,
            payment_method: payment,
            reference: meta?.card_last4 ? `Visa ****${meta.card_last4}` : "Visa statement import",
            notes: [
              r.isRefund ? "Merchant refund (contra-expense)" : null,
              r.foreign_amount ? `Foreign: ${r.foreign_amount}` : null,
            ].filter(Boolean).join(" · ") || null,
            import_batch_id: batchId,
            source_txn_hash: freshHash,
          });
          updated[i] = { ...r, imported: true, hash: freshHash };
          n++;
        } catch (e: any) {
          const msg = String(e?.message || e);
          // Unique-index collision on source_txn_hash → row already imported previously.
          if (/UNIQUE constraint failed/i.test(msg) && /source_txn_hash/i.test(msg)) {
            updated[i] = { ...r, imported: true, duplicate: true };
          } else {
            throw e;
          }
        }
      }
      setRows(updated);
      setLastBatchId(batchId);
      setStatus(`Imported ${n} transaction${n === 1 ? "" : "s"} as batch ${batchId.slice(0, 8)}. Use "Undo last import" below if you spot a mistake.`);
      await refreshBatches();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function onUndoBatch(batchId: string, label: string) {
    if (!(await showConfirm(`Delete all ${label} expenses that came in with batch ${batchId.slice(0, 8)}? This cannot be undone.`, { kind: "warning" }))) return;
    setBusy(true);
    try {
      const removed = await deleteImportBatch(batchId);
      setStatus(`Removed ${removed} expense${removed === 1 ? "" : "s"} from batch ${batchId.slice(0, 8)}.`);
      if (lastBatchId === batchId) setLastBatchId(null);
      // Clear the imported flag on rows so the same file could be re-imported cleanly.
      setRows((prev) => prev.map((r) => ({ ...r, imported: false })));
      await refreshBatches();
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
            Upload a Visa / credit-card PDF statement. Azure Mistral Document AI reads it and itemises every transaction so you can review and categorise before saving to Expenses.
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
            }} /> Select all charges & refunds</label>
            <div style={{ marginLeft: "auto", fontSize: 13 }}>
              Will import <strong>{importable.length}</strong> — net <strong>${fmt(importTotal)}</strong>
            </div>
            <button className="btn" onClick={onImport} disabled={busy || importable.length === 0}>Import selected</button>
            {lastBatchId && <button className="btn secondary" onClick={() => onUndoBatch(lastBatchId, "just-imported")} disabled={busy} style={{ color: "#b91c1c" }}>Undo last import</button>}
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
                  background: r.imported ? "#ecfdf5" : r.isPayment ? "#f3f4f6" : r.duplicate ? "#fef3c7" : r.isRefund ? "#eff6ff" : undefined,
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
                      <span style={{ color: "var(--muted)" }}>Card payment (excluded)</span>
                    ) : (
                      <select value={r.category} onChange={(e) => updateRow(i, { category: e.target.value })} disabled={r.imported}>
                        {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    )}
                  </td>
                  <td style={{ ...td(), fontSize: 11, color: "var(--muted)" }}>
                    {r.isRefund && <div style={{ color: "#1d4ed8", fontWeight: 600 }}>Merchant refund</div>}
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
            <div>• <strong>Card payments</strong> (bank "Thank You" / autopay lines) are excluded by default — they're not expenses, they're transfers from your bank.</div>
            <div>• <strong>Merchant refunds</strong> (blue rows, negative amount) are imported as negative expenses so they reduce category totals in P&L.</div>
            <div>• <strong>Yellow rows</strong> match an already-imported transaction by hash (date + amount + merchant + card). Safe to skip.</div>
          </div>
        </>
      )}

      {batches.length > 0 && (
        <div style={{ marginTop: 24, background: "#fff", border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
          <h3 style={{ margin: "0 0 10px 0" }}>Recent import batches</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                <th style={th()}>Batch</th>
                <th style={th()}>Imported</th>
                <th style={th()}>Range</th>
                <th style={{ ...th(), textAlign: "right" }}>Count</th>
                <th style={{ ...th(), textAlign: "right" }}>Total</th>
                <th style={th()}></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.batch_id}>
                  <td style={td()}><code>{b.batch_id.slice(0, 8)}</code></td>
                  <td style={td()}>{b.imported_at}</td>
                  <td style={td()}>{b.first_date} → {b.last_date}</td>
                  <td style={{ ...td(), textAlign: "right" }}>{b.count}</td>
                  <td style={{ ...td(), textAlign: "right" }}>${fmt(b.total)}</td>
                  <td style={td()}><button className="btn secondary" onClick={() => onUndoBatch(b.batch_id, "batch")} style={{ color: "#b91c1c", fontSize: 11, padding: "4px 8px" }}>Undo</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length === 0 && !busy && (
        <div style={{ background: "#fff", border: "1px dashed var(--border)", borderRadius: 8, padding: 30, textAlign: "center", color: "var(--muted)", marginTop: batches.length > 0 ? 12 : 0 }}>
          Pick a Visa / credit-card statement PDF to get started. The AI will extract every purchase, refund, and fee so you can review and import them as expenses.
        </div>
      )}
    </div>
  );
}

function th(): React.CSSProperties { return { textAlign: "left", padding: 6, border: "1px solid var(--border)", fontSize: 12 }; }
function td(): React.CSSProperties { return { padding: 6, border: "1px solid var(--border)", verticalAlign: "top" }; }
