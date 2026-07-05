import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  EXPENSE_CATEGORIES, PAYMENT_METHODS,
  saveExpense, getExpense, deleteExpense,
} from "../../lib/expenses";
import { showConfirm } from "../../lib/dialogs";

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function ExpenseForm() {
  const { id } = useParams<{ id?: string }>();
  const editing = !!id;
  const nav = useNavigate();

  const [date, setDate] = useState(todayStr());
  const [category, setCategory] = useState("misc");
  const [subcategory, setSubcategory] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (editing && id) {
      (async () => {
        const e = await getExpense(Number(id));
        if (!e) { setErr("Expense not found"); return; }
        setDate(e.date);
        setCategory(e.category);
        setSubcategory(e.subcategory || "");
        setVendor(e.vendor || "");
        setAmount(String(e.amount));
        setPaymentMethod(e.payment_method);
        setReference(e.reference || "");
        setNotes(e.notes || "");
      })();
    }
  }, [id, editing]);

  async function onSave() {
    setErr("");
    const amt = Number(amount);
    if (!date) { setErr("Date is required"); return; }
    if (!Number.isFinite(amt) || amt === 0) { setErr("Amount must be non-zero (use a negative amount for a refund/credit)"); return; }
    setBusy(true);
    try {
      await saveExpense({
        id: editing && id ? Number(id) : undefined,
        date, category, subcategory, vendor, amount: amt,
        payment_method: paymentMethod, reference, notes,
      });
      nav("/expenses/list");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!editing || !id) return;
    if (!(await showConfirm("Delete this expense? This cannot be undone.", { kind: "warning" }))) return;
    await deleteExpense(Number(id));
    nav("/expenses/list");
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>{editing ? "Edit Expense" : "Add Expense"}</h1>
      {err && <div style={{ background: "#fee2e2", border: "1px solid #ef4444", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12 }}>{err}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <label>Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        </label>
        <label>Amount ($)
          <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} placeholder="0.00 (negative for refund/credit)" />
        </label>
        <label>Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label>Subcategory <span style={{ color: "var(--muted)", fontWeight: 400 }}>(optional)</span>
          <input value={subcategory} onChange={(e) => setSubcategory(e.target.value)} style={inputStyle} placeholder="e.g. Craft paper, Snacks" />
        </label>
        <label>Vendor
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} style={inputStyle} placeholder="e.g. Costco, BC Hydro" />
        </label>
        <label>Payment Method
          <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} style={inputStyle}>
            {PAYMENT_METHODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>Reference <span style={{ color: "var(--muted)", fontWeight: 400 }}>(cheque #, invoice #, txn ID)</span>
          <input value={reference} onChange={(e) => setReference(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>Notes
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical" }} />
        </label>
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 8, justifyContent: "space-between" }}>
        <div>
          {editing && <button className="btn secondary" onClick={onDelete} style={{ color: "#b91c1c" }}>Delete</button>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn secondary" onClick={() => nav(-1)}>Cancel</button>
          <button className="btn" onClick={onSave} disabled={busy}>{busy ? "Saving…" : (editing ? "Save Changes" : "Add Expense")}</button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block", width: "100%", padding: "8px 10px", marginTop: 4,
  border: "1px solid var(--border)", borderRadius: 6, boxSizing: "border-box",
};
