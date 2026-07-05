import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  summaryByCategory, listExpenses, listRecurring, nextDueForPeriod,
  CATEGORY_LABEL, type Expense, type RecurringExpense,
} from "../../lib/expenses";

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ymToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthBounds(ym: string): { from: string; to: string; label: string } {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}`, label };
}

export default function ExpensesDashboard() {
  const [ym, setYm] = useState<string>(ymToday());
  const [totals, setTotals] = useState<Array<{ category: string; total: number; count: number }>>([]);
  const [recent, setRecent] = useState<Expense[]>([]);
  const [dueRecurring, setDueRecurring] = useState<Array<{ r: RecurringExpense; date: string }>>([]);

  const { from, to, label } = monthBounds(ym);

  async function reload() {
    const [byCat, list, recurring] = await Promise.all([
      summaryByCategory(from, to),
      listExpenses({ from, to, limit: 8 }),
      listRecurring(true),
    ]);
    setTotals(byCat);
    setRecent(list);
    const due: Array<{ r: RecurringExpense; date: string }> = [];
    for (const r of recurring) {
      const d = nextDueForPeriod(r, ym);
      if (d) due.push({ r, date: d });
    }
    setDueRecurring(due);
  }

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ym]);

  const monthTotal = totals.reduce((a, r) => a + r.total, 0);

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h1 style={{ marginTop: 0, marginBottom: 6 }}>Expenses — {label}</h1>
          <p style={{ color: "var(--muted)", margin: 0 }}>Track daycare spending, recurring bills and generate expense reports.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
          <Link to="/expenses/import" className="btn secondary">📄 Import Statement</Link>
          <Link to="/expenses/new" className="btn">+ Add Expense</Link>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <div style={card()}>
          <div style={cardLabel()}>This Month</div>
          <div style={cardValue()}>${fmt(monthTotal)}</div>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>{totals.reduce((a, r) => a + r.count, 0)} entries</div>
        </div>
        <div style={card()}>
          <div style={cardLabel()}>Top Category</div>
          <div style={cardValue()}>{totals[0] ? CATEGORY_LABEL[totals[0].category] || totals[0].category : "—"}</div>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>{totals[0] ? `$${fmt(totals[0].total)}` : ""}</div>
        </div>
        <div style={card()}>
          <div style={cardLabel()}>Recurring Due</div>
          <div style={{ ...cardValue(), color: dueRecurring.length ? "#b45309" : "var(--text)" }}>{dueRecurring.length}</div>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>bills to post</div>
        </div>
        <div style={card()}>
          <div style={cardLabel()}>Categories Used</div>
          <div style={cardValue()}>{totals.length}</div>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>this month</div>
        </div>
      </div>

      {dueRecurring.length > 0 && (
        <div style={{ background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: 8, padding: 14, marginBottom: 20 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Recurring bills due this month</div>
          <div style={{ fontSize: 13, color: "#78350f", marginBottom: 8 }}>
            These recurring templates have not been posted for {label}. Go to <Link to="/expenses/recurring">Recurring</Link> to post them.
          </div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {dueRecurring.map((x) => (
              <li key={x.r.id} style={{ fontSize: 13 }}>
                <strong>{x.r.name}</strong> — ${fmt(x.r.amount)} ({x.r.payment_method}) — due {x.date}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <div>
          <h3 style={{ marginTop: 0 }}>By Category</h3>
          {totals.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>No expenses this month.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  <th style={th()}>Category</th>
                  <th style={{ ...th(), textAlign: "right" }}>Count</th>
                  <th style={{ ...th(), textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((r) => (
                  <tr key={r.category}>
                    <td style={td()}>{CATEGORY_LABEL[r.category] || r.category}</td>
                    <td style={{ ...td(), textAlign: "right" }}>{r.count}</td>
                    <td style={{ ...td(), textAlign: "right" }}>${fmt(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ marginTop: 0 }}>Recent Expenses</h3>
            <Link to="/expenses/list" style={{ fontSize: 13 }}>View all →</Link>
          </div>
          {recent.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>No expenses this month yet.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  <th style={th()}>Date</th>
                  <th style={th()}>Vendor</th>
                  <th style={{ ...th(), textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id}>
                    <td style={td()}>{e.date}</td>
                    <td style={td()}>
                      <Link to={`/expenses/edit/${e.id}`}>{e.vendor || CATEGORY_LABEL[e.category] || "—"}</Link>
                    </td>
                    <td style={{ ...td(), textAlign: "right" }}>${fmt(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function card(): React.CSSProperties {
  return { background: "#fff", border: "1px solid var(--border)", borderRadius: 8, padding: 14 };
}
function cardLabel(): React.CSSProperties {
  return { color: "var(--muted)", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 };
}
function cardValue(): React.CSSProperties {
  return { fontSize: 24, fontWeight: 700, marginBottom: 2 };
}
function th(): React.CSSProperties {
  return { textAlign: "left", padding: 6, border: "1px solid var(--border)", fontSize: 12 };
}
function td(): React.CSSProperties {
  return { padding: 6, border: "1px solid var(--border)" };
}
