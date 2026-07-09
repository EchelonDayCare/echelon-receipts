// AI text-capture panel for the Recurring Bills tab (v2.1.3).
//
// Free-text → RecurringExpense template rows. Uses parse_recurring_expense
// Tauri command with enum-constrained categories/payment methods. Review
// grid lets the owner tweak frequency/day/start date/amount before bulk
// save via saveRecurring.

import { useState } from "react";
import { parseRecurringExpense, type ParsedRecurring } from "../../lib/voice";
import { showAlert } from "../../lib/dialogs";
import {
  saveRecurring, EXPENSE_CATEGORIES, PAYMENT_METHODS, FREQUENCIES,
} from "../../lib/expenses";

type Row = ParsedRecurring & { include: boolean };

const EXAMPLES = [
  "Rogers internet $89.99 monthly on the 5th, auto-pay",
  "BC Hydro $220 quarterly, direct deposit",
  "Rent $4500 monthly on the 1st, cheque to landlord",
];

const CATEGORY_VALUES = EXPENSE_CATEGORIES.map((c) => c.value);

export default function RecurringAiTextPanel({ onSaved }: { onSaved: () => void }) {
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
      const res = await parseRecurringExpense({
        text: t,
        categories: CATEGORY_VALUES,
        paymentMethods: PAYMENT_METHODS,
      });
      if (res.recurring.length === 0) {
        setErr("AI couldn't find any recurring bills in that text. Try: '<name> $<amount> monthly'.");
        setBusy("idle");
        return;
      }
      setRows(res.recurring.map((r) => ({ ...r, include: true })));
      setBusy("idle");
    } catch (e: any) {
      setErr(String(e?.message ?? e)); setBusy("idle");
    }
  }

  async function save() {
    if (!rows) return;
    const toSave = rows.filter((r) => r.include && r.amount > 0 && r.name.trim() && r.category && r.paymentMethod);
    if (toSave.length === 0) { setErr("Nothing to save — every row is either excluded or missing required fields."); return; }
    const skipped = rows.length - toSave.length;
    setBusy("saving"); setErr(null);
    let ok = 0;
    const failed: string[] = [];
    for (const r of toSave) {
      try {
        await saveRecurring({
          name: r.name,
          category: r.category,
          subcategory: r.subcategory || null,
          vendor: r.vendor || null,
          amount: r.amount,
          payment_method: r.paymentMethod,
          frequency: r.frequency,
          day_of_month: r.dayOfMonth,
          start_date: r.startDate,
          end_date: null,
          active: 1,
          notes: r.notes || null,
        });
        ok++;
      } catch (e: any) {
        failed.push(`${r.name}: ${String(e?.message ?? e)}`);
      }
    }
    setBusy("idle");
    if (failed.length > 0) {
      setErr(`Saved ${ok}. Failed ${failed.length}: ${failed.slice(0, 3).join(" · ")}`);
    } else {
      const msg = skipped > 0 ? `Saved ${ok}. Skipped ${skipped}.` : `Saved ${ok}.`;
      setErr(null);
      onSaved();
      setText(""); setRows(null); setExpanded(false);
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
          ✨ Type in plain English → AI creates recurring bills
        </button>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.title}>✨ AI Recurring Bill Capture</div>
        <button style={styles.closeBtn} onClick={() => { setText(""); setRows(null); setErr(null); setExpanded(false); }} title="Close">✕</button>
      </div>
      <div style={styles.subLabel}>Describe recurring bills in plain English — one per line works too. Review + tweak before saving.</div>

      {!rows && (
        <>
          <textarea
            style={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='e.g. "Rogers internet $89.99 monthly on the 5th, auto-pay"'
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
            Review {rows.length} parsed bill{rows.length === 1 ? "" : "s"}. Uncheck to skip; edit before saving.
          </div>
          <div style={styles.rowsWrap}>
            {rows.map((r, i) => {
              const bad = !r.name.trim() || !r.category || !r.paymentMethod || !(r.amount > 0);
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
                      type="text"
                      style={{ ...styles.input, minWidth: 160 }}
                      value={r.name}
                      onChange={(e) => updateRow(i, { name: e.target.value })}
                      placeholder="Bill name (e.g. Rogers Internet)"
                    />
                    <select
                      style={{ ...styles.input, minWidth: 160 }}
                      value={r.category}
                      onChange={(e) => updateRow(i, { category: e.target.value })}
                    >
                      <option value="">— category —</option>
                      {EXPENSE_CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      style={{ ...styles.input, width: 100 }}
                      value={r.amount}
                      onChange={(e) => updateRow(i, { amount: parseFloat(e.target.value || "0") })}
                      placeholder="Amount"
                    />
                    <select
                      style={{ ...styles.input, minWidth: 120 }}
                      value={r.frequency}
                      onChange={(e) => updateRow(i, { frequency: e.target.value })}
                    >
                      {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                    <label style={styles.mini}>
                      Day
                      <input
                        type="number"
                        min={1}
                        max={28}
                        style={{ ...styles.input, width: 60 }}
                        value={r.dayOfMonth}
                        onChange={(e) => updateRow(i, { dayOfMonth: Math.max(1, Math.min(28, parseInt(e.target.value || "1", 10))) })}
                      />
                    </label>
                    <label style={styles.mini}>
                      Starts
                      <input
                        type="date"
                        style={{ ...styles.input, width: 140 }}
                        value={r.startDate}
                        onChange={(e) => updateRow(i, { startDate: e.target.value })}
                      />
                    </label>
                    <select
                      style={{ ...styles.input, minWidth: 130 }}
                      value={r.paymentMethod}
                      onChange={(e) => updateRow(i, { paymentMethod: e.target.value })}
                    >
                      <option value="">— payment —</option>
                      {PAYMENT_METHODS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <input
                      type="text"
                      style={{ ...styles.input, flex: 1, minWidth: 140 }}
                      value={r.vendor || ""}
                      onChange={(e) => updateRow(i, { vendor: e.target.value })}
                      placeholder="Vendor (optional)"
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
              {busy === "saving" ? "Saving…" : `✓ Save ${rows.filter((r) => r.include).length} recurring bill${rows.filter((r) => r.include).length === 1 ? "" : "s"}`}
            </button>
            <button style={styles.linkBtn} onClick={() => { setRows(null); }} disabled={busy === "saving"}>
              Back to text
            </button>
          </div>
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
  card: {
    margin: "8px 0 16px", padding: 16, borderRadius: 12,
    background: "linear-gradient(180deg, #faf5ff, #fff)", border: "1px solid #ddd6fe",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  title: { fontWeight: 600, fontSize: 15, color: "#5b21b6" },
  closeBtn: { border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "#888" },
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
  mini: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#555" },
  input: { padding: "4px 6px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, fontFamily: "inherit" },
  lowConf: { color: "#c2410c", fontSize: 14, marginLeft: 4 },
  err: { fontSize: 13, color: "#991b1b", padding: 8, background: "#fee2e2", borderRadius: 6, marginTop: 8 },
};
