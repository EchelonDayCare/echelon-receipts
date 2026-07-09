import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  listExpenses, EXPENSE_CATEGORIES, PAYMENT_METHODS, CATEGORY_LABEL,
  findDuplicateIds, findDuplicatePartners, deleteExpense,
  type Expense,
} from "../../lib/expenses";
import { showConfirm } from "../../lib/dialogs";
import { isAiTextConfigured } from "../../lib/voice";
import { getSettings } from "../../lib/db";
import ExpenseAiTextPanel from "./ExpenseAiTextPanel";

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function firstOfYear(): string {
  return `${new Date().getFullYear()}-01-01`;
}
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function ExpenseList() {
  const [from, setFrom] = useState(firstOfYear());
  const [to, setTo] = useState(today());
  const [category, setCategory] = useState("");
  const [payment, setPayment] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Expense[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [dupModal, setDupModal] = useState<{ target: Expense; partners: Expense[] } | null>(null);

  const dupIds = useMemo(() => findDuplicateIds(rows), [rows]);

  useEffect(() => {
    getSettings().then((s) => setAiEnabled(isAiTextConfigured(s))).catch(() => setAiEnabled(false));
  }, []);

  async function reload() {
    const list = await listExpenses({
      from, to,
      category: category || undefined,
      payment_method: payment || undefined,
      q: q || undefined,
    });
    setRows(list);
  }
  useEffect(() => { reload();   }, [from, to, category, payment, q]);

  const total = rows.reduce((a, r) => a + r.amount, 0);

  function exportCsv() {
    const lines = ["Date,Category,Subcategory,Vendor,Amount,Payment Method,Reference,Notes"];
    rows.forEach((r) => {
      lines.push([
        r.date, CATEGORY_LABEL[r.category] || r.category, r.subcategory || "",
        r.vendor || "", fmt(r.amount), r.payment_method, r.reference || "", r.notes || "",
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    });
    lines.push(["Total", "", "", "", fmt(total), "", "", ""].map((v) => `"${v}"`).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `expenses-${from}-to-${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>All Expenses</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
          <Link to="/expenses/new" className="btn">+ Add Expense</Link>
        </div>
      </div>

      {aiEnabled && <ExpenseAiTextPanel onSaved={reload} />}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "flex-end" }}>
        <label>From<br /><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<br /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>Category<br />
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label>Payment<br />
          <select value={payment} onChange={(e) => setPayment(e.target.value)}>
            <option value="">All</option>
            {PAYMENT_METHODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 180 }}>Search<br />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="vendor / notes / ref" style={{ width: "100%" }} />
        </label>
      </div>

      <div style={{ marginBottom: 10, color: "var(--muted)", fontSize: 13 }}>
        {rows.length} entries — Total <strong style={{ color: "var(--text)" }}>${fmt(total)}</strong>
        {dupIds.size > 0 && (
          <span style={{ marginLeft: 12, padding: "2px 8px", background: "#fef3c7", color: "#92400e", borderRadius: 10, fontSize: 12 }}>
            ⚠ {dupIds.size} possible duplicate{dupIds.size === 1 ? "" : "s"} — click ⚠ in the table to review
          </span>
        )}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff" }}>
        <thead>
          <tr style={{ background: "#f8fafc" }}>
            <th style={th()}></th>
            <th style={th()}>Date</th>
            <th style={th()}>Category</th>
            <th style={th()}>Vendor</th>
            <th style={th()}>Payment</th>
            <th style={th()}>Reference</th>
            <th style={{ ...th(), textAlign: "right" }}>Amount</th>
            <th style={th()}>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={8} style={{ ...td(), textAlign: "center", color: "var(--muted)", padding: 20 }}>No expenses match your filters.</td></tr>
          ) : rows.map((r) => {
            const isDup = dupIds.has(r.id);
            return (
              <tr key={r.id} style={isDup ? { background: "#fffbeb" } : undefined}>
                <td style={{ ...td(), textAlign: "center", width: 32 }}>
                  {isDup && (
                    <button
                      type="button"
                      onClick={() => setDupModal({ target: r, partners: findDuplicatePartners(r, rows) })}
                      title="Possible duplicate — click to review"
                      style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 16, padding: 0 }}
                    >⚠️</button>
                  )}
                </td>
                <td style={td()}>{r.date}</td>
                <td style={td()}>
                  <Link to={`/expenses/edit/${r.id}`}>{CATEGORY_LABEL[r.category] || r.category}</Link>
                  {r.subcategory ? <span style={{ color: "var(--muted)" }}> · {r.subcategory}</span> : null}
                </td>
                <td style={td()}>{r.vendor || "—"}</td>
                <td style={td()}>{r.payment_method}</td>
                <td style={td()}>{r.reference || ""}</td>
                <td style={{ ...td(), textAlign: "right" }}>${fmt(r.amount)}</td>
                <td style={{ ...td(), color: "var(--muted)", fontSize: 12 }}>{r.notes || ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {dupModal && (
        <DupReviewModal
          target={dupModal.target}
          partners={dupModal.partners}
          onClose={() => setDupModal(null)}
          onDeleted={async () => { setDupModal(null); await reload(); }}
        />
      )}
    </div>
  );
}

function DupReviewModal({ target, partners, onClose, onDeleted }: {
  target: Expense; partners: Expense[]; onClose: () => void; onDeleted: () => void | Promise<void>;
}) {
  async function del(id: number) {
    if (!(await showConfirm(`Delete expense #${id}? This cannot be undone.`))) return;
    await deleteExpense(id);
    await onDeleted();
  }
  const card = (r: Expense, label: string): React.ReactElement => (
    <div key={r.id} style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 12, background: "#fff", flex: 1 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, margin: "4px 0" }}>${fmt(r.amount)}</div>
      <div style={{ fontSize: 13 }}>{r.date} · <strong>{r.vendor || "(no vendor)"}</strong></div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{CATEGORY_LABEL[r.category] || r.category}{r.subcategory ? ` · ${r.subcategory}` : ""}</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{r.payment_method}{r.reference ? ` · ref ${r.reference}` : ""}</div>
      {r.notes && <div style={{ fontSize: 12, marginTop: 6 }}>{r.notes}</div>}
      {r.recurring_id ? <div style={{ marginTop: 6, fontSize: 11, color: "#7c3aed" }}>↻ Posted from recurring template</div> : null}
      <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
        <Link to={`/expenses/edit/${r.id}`} className="btn secondary" style={{ fontSize: 12 }}>Edit</Link>
        <button className="btn" onClick={() => del(r.id)} style={{ fontSize: 12, background: "#dc2626", color: "#fff" }}>Delete this</button>
      </div>
    </div>
  );
  return (
    <div role="dialog" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 24 }}>
      <div style={{ background: "#fff", borderRadius: 10, padding: 20, maxWidth: 900, width: "100%", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Possible duplicate</h2>
          <button onClick={onClose} className="btn secondary">Close</button>
        </div>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>
          These expenses look like the same charge (same vendor, similar amount, within 3 days). Delete the copy you don't want, or close if they're actually different bills.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {card(target, "This expense")}
          {partners.map((p, i) => card(p, partners.length > 1 ? `Match ${i + 1}` : "Matches"))}
        </div>
      </div>
    </div>
  );
}

function th(): React.CSSProperties { return { textAlign: "left", padding: 6, border: "1px solid var(--border)" }; }
function td(): React.CSSProperties { return { padding: 6, border: "1px solid var(--border)" }; }
