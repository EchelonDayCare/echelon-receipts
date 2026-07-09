// AI text-capture panel for the Expenses page (v2.1.2).
//
// Free-text → structured expense rows. Uses parse_expense Tauri command
// which is constrained server-side to the EXPENSE_CATEGORIES + PAYMENT_METHODS
// enums we pass in from the frontend (no hardcoded policy in Rust).
// Every parsed row is reviewable + editable before save; the model never
// writes directly.

import { useState } from "react";
import { parseExpense, type ParsedExpense } from "../../lib/voice";
import { showAlert } from "../../lib/dialogs";
import {
  saveExpense, EXPENSE_CATEGORIES, PAYMENT_METHODS, CATEGORY_LABEL,
} from "../../lib/expenses";

type Row = ParsedExpense & { include: boolean };

const EXAMPLES = [
  "$47 at Michaels yesterday for craft supplies, cash",
  "Rogers internet $89.99 monthly auto-pay",
  "Payroll today: $1200 Priya, $1100 Sarah, $950 Anita, direct deposit",
];

const CATEGORY_VALUES = EXPENSE_CATEGORIES.map((c) => c.value);

export default function ExpenseAiTextPanel({ onSaved }: { onSaved: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"idle" | "parsing" | "saving">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);

  async function parse() {
    const t = text.trim();
    if (!t) { setErr("Type something first."); return; }
    setErr(null); setBusy("parsing"); setRows(null);
    try {
      const res = await parseExpense({
        text: t,
        categories: CATEGORY_VALUES,
        paymentMethods: PAYMENT_METHODS,
      });
      if (res.expenses.length === 0) {
        setErr("AI couldn't find any expenses in that text. Try including an amount + what it was for.");
        setBusy("idle");
        return;
      }
      setRows(res.expenses.map((e) => ({ ...e, include: true })));
      setBusy("idle");
    } catch (e: any) {
      setErr(String(e?.message ?? e)); setBusy("idle");
    }
  }

  async function save() {
    if (!rows) return;
    const toSave = rows.filter((r) => r.include && r.amount > 0 && r.category && r.paymentMethod && r.date);
    if (toSave.length === 0) { setErr("Nothing to save — every row is either excluded or missing required fields."); return; }
    const skipped = rows.length - toSave.length;
    setBusy("saving"); setErr(null);
    let ok = 0;
    const failed: string[] = [];
    for (const r of toSave) {
      try {
        await saveExpense({
          date: r.date,
          category: r.category,
          subcategory: r.subcategory || null,
          vendor: r.vendor || null,
          amount: r.amount,
          payment_method: r.paymentMethod,
          reference: r.reference || null,
          notes: r.notes || null,
        });
        ok++;
      } catch (e: any) {
        failed.push(`${r.vendor || r.category} $${r.amount}: ${String(e?.message ?? e)}`);
      }
    }
    setBusy("idle");
    if (failed.length > 0) {
      setErr(`Saved ${ok}. Failed ${failed.length}: ${failed.slice(0, 3).join(" · ")}`);
    } else {
      const msg = skipped > 0 ? `Saved ${ok}. Skipped ${skipped}.` : `Saved ${ok}.`;
      setErr(null);
      onSaved();
      setText(""); setRows(null);
      window.setTimeout(() => void showAlert(msg), 50);
    }
  }

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev ? prev.map((r, ix) => ix === i ? { ...r, ...patch } : r) : prev);
  }

  if (!expanded) {
    return (
      <div style={styles.strip}>
        <button style={styles.stripBtn} onClick={() => setExpanded(true)}>
          ✨ Type in plain English → AI logs expenses
        </button>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.title}>✨ AI Expense Capture</div>
        <button style={styles.closeBtn} onClick={() => { setText(""); setRows(null); setErr(null); setExpanded(false); }} title="Close">✕</button>
      </div>
      <div style={styles.subLabel}>Type expenses in plain English — paste receipts, list multiple, describe recurring bills. AI turns them into rows you review before saving.</div>

      {!rows && (
        <>
          <textarea
            style={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='e.g. "$47 at Michaels yesterday, craft supplies, cash" or paste a whole receipt list'
            rows={3}
            disabled={busy === "parsing"}
          />
          <div style={styles.examples}>
            <span style={styles.examplesLabel}>Try:</span>
            {EXAMPLES.map((ex, i) => (
              <button key={i} style={styles.exampleChip} onClick={() => setText(ex)} disabled={busy === "parsing"}>
                {ex}
              </button>
            ))}
          </div>
          <div style={styles.actions}>
            <button style={styles.primaryBtn} onClick={parse} disabled={busy === "parsing" || !text.trim()}>
              {busy === "parsing" ? "Thinking…" : "✨ Parse with AI"}
            </button>
            <button style={styles.linkBtn} onClick={() => setText("")} disabled={busy === "parsing"}>Clear</button>
          </div>
        </>
      )}

      {rows && (
        <div>
          <div style={styles.reviewHeader}>
            Review {rows.length} parsed expense{rows.length === 1 ? "" : "s"}. Uncheck to skip; edit any field before saving.
          </div>
          <div style={styles.rowsWrap}>
            {rows.map((r, i) => {
              const needsCat = !r.category || !CATEGORY_VALUES.includes(r.category);
              const needsPay = !r.paymentMethod || !PAYMENT_METHODS.includes(r.paymentMethod);
              const bad = needsCat || needsPay || !(r.amount > 0);
              return (
                <div key={i} style={{ ...styles.row, background: bad ? "#fef3c7" : "#f8fafc", opacity: r.include ? 1 : 0.5 }}>
                  <input
                    type="checkbox"
                    checked={r.include}
                    onChange={(e) => updateRow(i, { include: e.target.checked })}
                    style={{ marginTop: 6 }}
                  />
                  <div style={styles.rowGrid}>
                    <input
                      type="date"
                      style={{ ...styles.input, width: 130 }}
                      value={r.date}
                      onChange={(e) => updateRow(i, { date: e.target.value })}
                    />
                    <select
                      style={{ ...styles.input, minWidth: 160 }}
                      value={r.category}
                      onChange={(e) => updateRow(i, { category: e.target.value })}
                    >
                      <option value="">{needsCat ? "⚠ pick category…" : "— pick —"}</option>
                      {EXPENSE_CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      style={{ ...styles.input, minWidth: 140 }}
                      value={r.vendor || ""}
                      onChange={(e) => updateRow(i, { vendor: e.target.value })}
                      placeholder="Vendor"
                    />
                    <input
                      type="number"
                      step="0.01"
                      style={{ ...styles.input, width: 100 }}
                      value={r.amount}
                      onChange={(e) => updateRow(i, { amount: parseFloat(e.target.value || "0") })}
                      placeholder="Amount"
                    />
                    <select
                      style={{ ...styles.input, minWidth: 130 }}
                      value={r.paymentMethod}
                      onChange={(e) => updateRow(i, { paymentMethod: e.target.value })}
                    >
                      <option value="">{needsPay ? "⚠ payment…" : "— pick —"}</option>
                      {PAYMENT_METHODS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <input
                      type="text"
                      style={{ ...styles.input, flex: 1, minWidth: 160 }}
                      value={r.notes || ""}
                      onChange={(e) => updateRow(i, { notes: e.target.value })}
                      placeholder="Notes"
                    />
                    {r.confidence != null && r.confidence < 0.7 && (
                      <span style={styles.lowConf} title="Model wasn't sure">⚠</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={styles.actions}>
            <button style={styles.primaryBtn} onClick={save} disabled={busy === "saving"}>
              {busy === "saving" ? "Saving…" : `✓ Save ${rows.filter((r) => r.include).length} expense${rows.filter((r) => r.include).length === 1 ? "" : "s"}`}
            </button>
            <button style={styles.linkBtn} onClick={() => { setRows(null); }} disabled={busy === "saving"}>
              Back to text
            </button>
          </div>
          {/* Hidden lookup, keeps CATEGORY_LABEL import used for future tooltips */}
          <div style={{ display: "none" }}>{Object.keys(CATEGORY_LABEL).length}</div>
        </div>
      )}

      {err && <div style={styles.err}>{err}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  strip: { margin: "8px 0 12px" },
  stripBtn: {
    width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px dashed #7c3aed",
    background: "linear-gradient(90deg, #faf5ff, #f5f3ff)", color: "#5b21b6",
    fontSize: 14, fontWeight: 500, cursor: "pointer", textAlign: "left",
  },
  closeBtn: { border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "#888" },
  card: {
    margin: "8px 0 16px", padding: 16, borderRadius: 12,
    background: "linear-gradient(180deg, #faf5ff, #fff)", border: "1px solid #ddd6fe",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  title: { fontWeight: 600, fontSize: 15, color: "#5b21b6" },
  subLabel: { fontSize: 12, color: "#666", marginBottom: 10 },
  textarea: {
    width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd", fontFamily: "inherit",
    fontSize: 14, resize: "vertical", boxSizing: "border-box",
  },
  examples: { display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0 4px", alignItems: "center" },
  examplesLabel: { fontSize: 12, color: "#666" },
  exampleChip: {
    padding: "4px 10px", borderRadius: 999, border: "1px solid #e5e7eb",
    background: "#fff", fontSize: 12, cursor: "pointer", color: "#555",
  },
  actions: { display: "flex", gap: 8, marginTop: 12, alignItems: "center" },
  primaryBtn: {
    padding: "8px 16px", borderRadius: 8, border: "none",
    background: "#7c3aed", color: "#fff", fontWeight: 500, cursor: "pointer", fontSize: 14,
  },
  linkBtn: { padding: "8px 12px", border: "none", background: "transparent", color: "#666", cursor: "pointer", fontSize: 13 },
  reviewHeader: { fontSize: 12, color: "#555", marginBottom: 8, marginTop: 4 },
  rowsWrap: { display: "flex", flexDirection: "column", gap: 6 },
  row: {
    display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 8px",
    borderRadius: 6, fontSize: 13,
  },
  rowGrid: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", flex: 1 },
  input: { padding: "4px 6px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, fontFamily: "inherit" },
  lowConf: { color: "#c2410c", fontSize: 14, marginLeft: 4 },
  err: { fontSize: 13, color: "#991b1b", padding: 8, background: "#fee2e2", borderRadius: 6, marginTop: 8 },
};
