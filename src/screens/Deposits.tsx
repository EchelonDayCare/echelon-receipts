import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  listUndepositedReceipts, createDeposit, listDeposits, getDepositWithReceipts,
  voidDeposit, getSettings,
} from "../lib/db";
import type { Receipt, Deposit, SettingsMap } from "../types";
import { printDepositSlip } from "../lib/depositSlip";
import { showAlert, showConfirm, showPrompt } from "../lib/dialogs";

function fmtMoney(n: number): string {
  return "$" + n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function Deposits() {
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get("highlight");
  const highlightRef = useRef<HTMLTableRowElement | null>(null);
  const [pending, setPending] = useState<Receipt[]>([]);
  const [past, setPast] = useState<Deposit[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [depositDate, setDepositDate] = useState<string>(todayIso());
  const [notes, setNotes] = useState<string>("");
  const [settings, setSettings] = useState<SettingsMap>({});
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [u, d, s] = await Promise.all([
      listUndepositedReceipts(), listDeposits(), getSettings(),
    ]);
    setPending(u); setPast(d); setSettings(s);
  }
  useEffect(() => { refresh(); }, []);

  // Scroll to the highlighted deposit once loaded (from a History void
  // attempt that was blocked because this deposit still exists).
  useEffect(() => {
    if (!highlightId || past.length === 0) return;
    const el = highlightRef.current;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightId, past]);

  const totals = useMemo(() => {
    let count = 0, sum = 0;
    for (const r of pending) if (selected.has(r.id)) { count++; sum += r.amount; }
    return { count, sum };
  }, [pending, selected]);

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }
  function selectAll() { setSelected(new Set(pending.map(r => r.id))); }
  function clearSel() { setSelected(new Set()); }

  async function onCreate() {
    if (selected.size === 0) { void showAlert("Select at least one receipt."); return; }
    if (!depositDate) { void showAlert("Pick a deposit date."); return; }
    setBusy(true);
    try {
      const id = await createDeposit([...selected], depositDate, notes.trim() || null);
      const bundle = await getDepositWithReceipts(id);
      if (!bundle) throw new Error("Deposit created but could not be reloaded.");
      printDepositSlip(bundle.deposit, bundle.receipts, settings);
      setSelected(new Set()); setNotes("");
      await refresh();
    } catch (e: any) {
      void showAlert("Could not create deposit: " + (e?.message ?? e));
    } finally { setBusy(false); }
  }

  async function onReprint(d: Deposit) {
    const bundle = await getDepositWithReceipts(d.id);
    if (!bundle) { void showAlert("Deposit not found."); return; }
    printDepositSlip(bundle.deposit, bundle.receipts, settings);
  }

  async function onVoid(d: Deposit) {
    if (!(await showConfirm(`Void deposit #${d.id}? Its ${d.cheque_count} receipt(s) will be returned to the undeposited list.`))) return;
    const reason = await showPrompt("Reason (optional):", "");
    await voidDeposit(d.id, reason || undefined);
    await refresh();
  }

  return (
    <div style={{ padding: "16px 20px", maxWidth: 1100 }}>
      <h1 style={{ marginTop: 0 }}>Bank Deposits</h1>
      <p style={{ color: "#555", marginTop: -6 }}>
        Select cheque/cash receipts to bundle into a bank deposit slip. Bank fields
        (date, branch #, account #) are handwritten at the teller.
      </p>

      <section style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 16, margin: "12px 0" }}>Undeposited receipts</h2>
        {pending.length === 0 ? (
          <div style={{ padding: 16, background: "#f7f7f7", borderRadius: 8, color: "#666" }}>
            No undeposited receipts. New payments will appear here automatically.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button onClick={selectAll} type="button">Select all</button>
              <button onClick={clearSel} type="button">Clear</button>
              <span style={{ marginLeft: "auto", fontWeight: 600 }}>
                {totals.count} selected · {fmtMoney(totals.sum)}
              </span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f0f0f0" }}>
                  <th style={{ textAlign: "left", padding: 6 }}></th>
                  <th style={{ textAlign: "left", padding: 6 }}>Date</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Receipt #</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Student</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Payer</th>
                  <th style={{ textAlign: "right", padding: 6 }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {pending.map(r => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: 6 }}>
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </td>
                    <td style={{ padding: 6 }}>{r.date}</td>
                    <td style={{ padding: 6 }}>{r.receipt_no}</td>
                    <td style={{ padding: 6 }}>{r.student_name_snapshot}</td>
                    <td style={{ padding: 6 }}>{r.father_name_snapshot || r.mother_name_snapshot || ""}</td>
                    <td style={{ padding: 6, textAlign: "right" }}>{fmtMoney(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label>Deposit date:&nbsp;
                <input type="date" value={depositDate} onChange={e => setDepositDate(e.target.value)} />
              </label>
              <label style={{ flex: 1, minWidth: 220 }}>Notes:&nbsp;
                <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="Optional" style={{ width: "70%" }} />
              </label>
              <button type="button" disabled={busy || totals.count === 0} onClick={onCreate}
                style={{ padding: "8px 14px", fontWeight: 600 }}>
                {busy ? "Working…" : `Create deposit & print (${totals.count})`}
              </button>
            </div>
          </>
        )}
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 16, margin: "12px 0" }}>Past deposits</h2>
        {past.length === 0 ? (
          <div style={{ color: "#666" }}>No deposits recorded yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f0f0f0" }}>
                <th style={{ textAlign: "left", padding: 6 }}>#</th>
                <th style={{ textAlign: "left", padding: 6 }}>Date</th>
                <th style={{ textAlign: "right", padding: 6 }}>Cheques</th>
                <th style={{ textAlign: "right", padding: 6 }}>Total</th>
                <th style={{ textAlign: "left", padding: 6 }}>Status</th>
                <th style={{ textAlign: "left", padding: 6 }}>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {past.map(d => {
                const isHighlight = String(d.id) === highlightId;
                return (
                <tr
                  key={d.id}
                  ref={isHighlight ? highlightRef : undefined}
                  style={{
                    borderBottom: "1px solid #eee",
                    opacity: d.voided ? 0.55 : 1,
                    background: isHighlight ? "#fef3c7" : undefined,
                    outline: isHighlight ? "2px solid #f59e0b" : undefined,
                  }}
                >
                  <td style={{ padding: 6 }}>{d.id}</td>
                  <td style={{ padding: 6 }}>{d.deposit_date}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>{d.cheque_count}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>{fmtMoney(d.total_amount)}</td>
                  <td style={{ padding: 6 }}>{d.voided ? "Voided" : "Active"}</td>
                  <td style={{ padding: 6 }}>{d.notes || ""}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>
                    <button type="button" onClick={() => onReprint(d)}>Reprint</button>
                    {!d.voided && (
                      <button type="button" onClick={() => onVoid(d)} style={{ marginLeft: 6 }}>Void</button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
