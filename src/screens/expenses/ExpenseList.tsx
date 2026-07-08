import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  listExpenses, EXPENSE_CATEGORIES, PAYMENT_METHODS, CATEGORY_LABEL,
  type Expense,
} from "../../lib/expenses";
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
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [from, to, category, payment, q]);

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
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff" }}>
        <thead>
          <tr style={{ background: "#f8fafc" }}>
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
            <tr><td colSpan={7} style={{ ...td(), textAlign: "center", color: "var(--muted)", padding: 20 }}>No expenses match your filters.</td></tr>
          ) : rows.map((r) => (
            <tr key={r.id}>
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

function th(): React.CSSProperties { return { textAlign: "left", padding: 6, border: "1px solid var(--border)" }; }
function td(): React.CSSProperties { return { padding: 6, border: "1px solid var(--border)" }; }
