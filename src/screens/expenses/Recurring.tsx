import { useEffect, useState } from "react";
import { showConfirm, showAlert, showPrompt } from "../../lib/dialogs";
import {
  listRecurring, saveRecurring, deleteRecurring, postRecurring, targetDateForPeriod, isPeriodPosted,
  EXPENSE_CATEGORIES, PAYMENT_METHODS, FREQUENCIES, CATEGORY_LABEL,
  type RecurringExpense,
} from "../../lib/expenses";
import { isAiTextConfigured } from "../../lib/voice";
import { getSettings } from "../../lib/db";
import RecurringAiTextPanel from "./RecurringAiTextPanel";

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function ymToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const BLANK: Partial<RecurringExpense> = {
  name: "", category: "rent_lease", subcategory: "", vendor: "",
  amount: 0, payment_method: "Direct Deposit (Bank)", frequency: "monthly",
  day_of_month: 1, start_date: todayStr(), end_date: null, active: 1, notes: "",
};

type DueInfo = { target: string | null; posted: boolean };

export default function Recurring() {
  const [rows, setRows] = useState<RecurringExpense[]>([]);
  const [dueMap, setDueMap] = useState<Record<number, DueInfo>>({});
  const [editing, setEditing] = useState<Partial<RecurringExpense> | null>(null);
  const [ym, setYm] = useState<string>(ymToday());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [aiEnabled, setAiEnabled] = useState(false);

  useEffect(() => {
    getSettings().then((s) => setAiEnabled(isAiTextConfigured(s))).catch(() => setAiEnabled(false));
  }, []);

  async function reload() {
    const list = await listRecurring(false);
    setRows(list);
    const map: Record<number, DueInfo> = {};
    for (const r of list) {
      const target = targetDateForPeriod(r, ym);
      map[r.id] = { target, posted: target ? await isPeriodPosted(r.id, ym) : false };
    }
    setDueMap(map);
  }
  useEffect(() => { void reload(); }, [ym]);

  async function onSave() {
    if (!editing) return;
    if (!editing.name || !editing.amount || !editing.category) {
      setMsg("Name, category and amount are required");
      return;
    }
    setBusy(true);
    try {
      await saveRecurring(editing);
      setEditing(null);
      setMsg("Saved.");
      await reload();
    } catch (e: any) {
      setMsg(String(e?.message || e));
    } finally { setBusy(false); }
  }

  async function onDelete(id: number) {
    if (!(await showConfirm("Delete this recurring template? Past posted expenses are not affected."))) return;
    await deleteRecurring(id);
    await reload();
  }

  async function onPost(r: RecurringExpense, dueDate: string) {
    // Give the operator a chance to override the amount (variable bills like
    // phone / internet / CRA are the common case).
    const answer = await showPrompt(
      `Post "${r.name}" for ${dueDate}\n\nAmount to post ($). Leave as-is to use the template default of $${fmt(r.amount)}.`,
      String(r.amount)
    );
    if (answer == null) return;
    const trimmed = answer.trim();
    const amt = trimmed ? Number(trimmed) : r.amount;
    if (!isFinite(amt) || amt <= 0) { void showAlert("Amount must be a positive number."); return; }
    setBusy(true);
    try {
      await postRecurring(r.id, dueDate, amt);
      setMsg(`Posted "${r.name}" for ${dueDate} at $${fmt(amt)}.`);
      await reload();
    } catch (e: any) {
      setMsg(String(e?.message || e));
    } finally { setBusy(false); }
  }

  async function onPostAllDue() {
    const due: Array<{ r: RecurringExpense; date: string }> = [];
    for (const r of rows) {
      const info = dueMap[r.id];
      if (info && info.target && !info.posted) due.push({ r, date: info.target });
    }
    if (due.length === 0) { setMsg("Nothing due for this period."); return; }
    if (!(await showConfirm(`Post ${due.length} recurring bill(s) for ${ym} at their template amounts?\n\nUse the row-level Post button if you need to override the amount for a variable bill.`))) return;
    setBusy(true);
    try {
      for (const x of due) await postRecurring(x.r.id, x.date);
      setMsg(`Posted ${due.length} recurring bill(s).`);
      await reload();
    } catch (e: any) {
      setMsg(String(e?.message || e));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0 }}>Recurring Expenses</h1>
          <p style={{ color: "var(--muted)", margin: "6px 0 0" }}>
            Rent, WCB, CRA remittance, phone, internet, insurance and other bills that repeat. Amounts can be overridden per-post for variable bills.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 13 }}>Period: <input type="month" value={ym} onChange={(e) => setYm(e.target.value)} /></label>
          <button className="btn secondary" onClick={onPostAllDue} disabled={busy}>Post all due</button>
          <button className="btn" onClick={() => setEditing({ ...BLANK })}>+ New template</button>
        </div>
      </div>

      {msg && <div style={{ marginBottom: 12, padding: 10, borderRadius: 6, background: "#dbeafe", color: "#1e3a8a", fontSize: 13 }}>{msg}</div>}

      {aiEnabled && <RecurringAiTextPanel onSaved={reload} />}

      {editing && (
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 18 }}>
          <h3 style={{ marginTop: 0 }}>{editing.id ? "Edit template" : "New template"}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <label>Name<input value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={inp} placeholder="Rent — 123 Main St" /></label>
            <label>Category
              <select value={editing.category || "misc"} onChange={(e) => setEditing({ ...editing, category: e.target.value })} style={inp}>
                {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label>Vendor<input value={editing.vendor || ""} onChange={(e) => setEditing({ ...editing, vendor: e.target.value })} style={inp} /></label>
            <label>Default amount ($)<input type="number" step="0.01" value={editing.amount ?? 0} onChange={(e) => setEditing({ ...editing, amount: Number(e.target.value) })} style={inp} /></label>
            <label>Payment
              <select value={editing.payment_method || ""} onChange={(e) => setEditing({ ...editing, payment_method: e.target.value })} style={inp}>
                {PAYMENT_METHODS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>Frequency
              <select value={editing.frequency || "monthly"} onChange={(e) => setEditing({ ...editing, frequency: e.target.value })} style={inp}>
                {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            <label>Day of month<input type="number" min="1" max="31" value={editing.day_of_month ?? 1} onChange={(e) => setEditing({ ...editing, day_of_month: Number(e.target.value) })} style={inp} /></label>
            <label>Start date<input type="date" value={editing.start_date || todayStr()} onChange={(e) => setEditing({ ...editing, start_date: e.target.value })} style={inp} /></label>
            <label>End date <span style={{ color: "var(--muted)", fontWeight: 400 }}>(optional)</span><input type="date" value={editing.end_date || ""} onChange={(e) => setEditing({ ...editing, end_date: e.target.value || null })} style={inp} /></label>
            <label style={{ gridColumn: "1 / -1" }}>Notes<input value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} style={inp} /></label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, gridColumn: "1 / -1" }}>
              <input type="checkbox" checked={editing.active !== 0} onChange={(e) => setEditing({ ...editing, active: e.target.checked ? 1 : 0 })} />
              Active (paused templates won't appear as "due")
            </label>
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn" onClick={onSave} disabled={busy}>Save</button>
          </div>
        </div>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff" }}>
        <thead>
          <tr style={{ background: "#f8fafc" }}>
            <th style={th()}>Name</th>
            <th style={th()}>Category</th>
            <th style={th()}>Freq.</th>
            <th style={{ ...th(), textAlign: "right" }}>Default</th>
            <th style={th()}>Payment</th>
            <th style={th()}>Last posted</th>
            <th style={th()}>Status for {ym}</th>
            <th style={th()}></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={8} style={{ ...td(), textAlign: "center", color: "var(--muted)", padding: 20 }}>No recurring templates yet. Create one to auto-track monthly bills.</td></tr>
          ) : rows.map((r) => {
            const info = dueMap[r.id] || { target: null, posted: false };
            return (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.55 }}>
                <td style={td()}><strong>{r.name}</strong>{r.vendor ? <div style={{ color: "var(--muted)", fontSize: 12 }}>{r.vendor}</div> : null}</td>
                <td style={td()}>{CATEGORY_LABEL[r.category] || r.category}</td>
                <td style={td()}>{r.frequency}</td>
                <td style={{ ...td(), textAlign: "right" }}>${fmt(r.amount)}</td>
                <td style={td()}>{r.payment_method}</td>
                <td style={td()}>{r.last_posted_date || "—"}</td>
                <td style={td()}>
                  {!r.active ? <span style={{ color: "var(--muted)" }}>Paused</span>
                    : !info.target ? <span style={{ color: "var(--muted)" }}>Not scheduled</span>
                    : info.posted ? <span style={{ color: "#065f46" }}>✓ Posted for {ym}</span>
                    : <span style={{ color: "#b45309", fontWeight: 600 }}>Due {info.target}</span>}
                </td>
                <td style={{ ...td(), whiteSpace: "nowrap" }}>
                  {info.target && !info.posted && r.active && <button className="btn" onClick={() => onPost(r, info.target!)} style={{ marginRight: 6 }}>Post</button>}
                  <button className="btn secondary" onClick={() => setEditing(r)} style={{ marginRight: 6 }}>Edit</button>
                  <button className="btn secondary" onClick={() => onDelete(r.id)} style={{ color: "#b91c1c" }}>Delete</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const inp: React.CSSProperties = {
  display: "block", width: "100%", padding: "8px 10px", marginTop: 4,
  border: "1px solid var(--border)", borderRadius: 6, boxSizing: "border-box",
};
function th(): React.CSSProperties { return { textAlign: "left", padding: 6, border: "1px solid var(--border)" }; }
function td(): React.CSSProperties { return { padding: 6, border: "1px solid var(--border)" }; }
