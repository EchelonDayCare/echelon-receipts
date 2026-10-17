import { useEffect, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { showConfirm } from "../../lib/dialogs";
import { printCurrentWindow } from "../../lib/print";
import { finance, money, toCents, parseBankCsv, sourceHash, groupFinanceMonths,
  type Snapshot, type Statement, type StatementLine, type Allocation, type JournalEntry,
  type FinanceReport, type ImportLine, type AccountKind, type DepositBatch } from "../../lib/finance";
import "./finance.css";

const empty: Snapshot = { config: [], accounts: [], statements: [], policies: [], funding: [], exports: [], purchase_batches: [], legacy: [] };
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const initialStart = () => `${new Date().getFullYear() - (new Date().getMonth() < 8 ? 1 : 0)}-09-01`;
type Draft = { date_from: string; date_to: string; opening_cents: number | null; closing_cents: number | null; lines: ImportLine[] };

export default function Finance() {
  const location = useLocation();
  const reportPage = location.pathname.endsWith("/accounting");
  const incomePage = location.pathname.endsWith("/income");
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [start, setStart] = useState(initialStart);
  const [preview, setPreview] = useState<{ source: string; count: number; cents: number }[] | null>(null);
  const [ack, setAck] = useState(false);
  const [account, setAccount] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountKind, setAccountKind] = useState<AccountKind>("bank");
  const [opening, setOpening] = useState("");
  const [reason, setReason] = useState("");
  const [program, setProgram] = useState("CCFRI");
  const [treatment, setTreatment] = useState("unresolved");
  const [policyRule, setPolicyRule] = useState("");
  const [fundingFrom, setFundingFrom] = useState(initialStart);
  const [fundingTo, setFundingTo] = useState(today);
  const [fundingReference, setFundingReference] = useState("");
  const [fundingReceipt, setFundingReceipt] = useState("");
  const [batches, setBatches] = useState<DepositBatch[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftOpening, setDraftOpening] = useState("");
  const [draftClosing, setDraftClosing] = useState("");
  const [draftAmounts, setDraftAmounts] = useState<string[]>([]);
  const [fileHash, setFileHash] = useState("");
  const [sourceEvidence, setSourceEvidence] = useState({ source_name: "", source_b64: "" });
  const [reviewed, setReviewed] = useState(false);
  const [selected, setSelected] = useState<Statement | null>(null);
  const [lines, setLines] = useState<StatementLine[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [lineId, setLineId] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("receipt");
  const [counterpart, setCounterpart] = useState("");
  const [source, setSource] = useState("");
  const [candidates, setCandidates] = useState<JournalEntry[]>([]);
  const [description, setDescription] = useState("");
  const [from, setFrom] = useState(initialStart);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [period, setPeriod] = useState<"month" | "quarter" | "year">("month");
  const [exportLabel, setExportLabel] = useState("");
  const [journalDay, setJournalDay] = useState(today);
  const [debit, setDebit] = useState("");
  const [credit, setCredit] = useState("");
  const [journalAmount, setJournalAmount] = useState("");
  const [releaseDate, setReleaseDate] = useState(today);
  const [releaseAmount, setReleaseAmount] = useState("");
  const [releaseEvidence, setReleaseEvidence] = useState("");
  const enabled = snapshot.config[0];
  async function refresh() { setSnapshot(await finance<Snapshot>("snapshot")); }
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(""); setStatus(""); setReport(null);
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  useEffect(() => { void act(refresh); }, []);
  async function detail(s: Statement) {
    const data = await finance<{ lines: StatementLine[]; allocations: Allocation[] }>("lines", { statement_id: s.id });
    setSelected(s); setLines(data.lines); setAllocations(data.allocations); setLineId("");
  }
  async function loadCandidates(next: string, target = lineId) {
    setKind(next); setSource(""); setCandidates([]);
    if (["receipt", "expense", "existing"].includes(next) && target) setCandidates(await finance<JournalEntry[]>("candidates", { kind: next, line_id: Number(target) }));
    if (next === "batch") setBatches(await finance<DepositBatch[]>("deposit_batches"));
  }
  async function pick() {
    if (!account) throw new Error("Choose the bank/card account first.");
    const path = await open({ multiple: false, filters: [{ name: "Statement", extensions: ["csv", "pdf", "png", "jpg", "jpeg"] }] });
    if (!path || Array.isArray(path)) return;
    const bytes = await readFile(path);
    if (bytes.length > 20 * 1024 * 1024) throw new Error("Use a statement smaller than 20 MB.");
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const base64 = btoa(binary);
    let result: Draft;
    if (path.toLowerCase().endsWith(".csv")) {
      const parsed = parseBankCsv(new TextDecoder().decode(bytes));
      const dates = parsed.map((l) => l.date).sort();
      result = { date_from: dates[0] || "", date_to: dates[dates.length - 1] || "", opening_cents: null, closing_cents: null, lines: parsed };
    } else {
      if (!await showConfirm("This sends the complete selected statement to the configured Azure Mistral service. It can contain financial and account information. Continue?")) return;
      result = await invoke<Draft>("extract_bank_statement", { args: { file_b64: base64,
        mime_type: path.toLowerCase().endsWith(".pdf") ? "application/pdf" : path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg" } });
      if (!result || !Array.isArray(result.lines)) throw new Error("The extraction did not return valid statement lines.");
    }
    setSourceEvidence({ source_name: path.split(/[\\/]/).pop() || "statement", source_b64: base64 });
    setFileHash(await sourceHash(bytes)); setDraft(result); setReviewed(false);
    setDraftOpening(result.opening_cents == null ? "" : (result.opening_cents / 100).toFixed(2));
    setDraftClosing(result.closing_cents == null ? "" : (result.closing_cents / 100).toFixed(2));
    setDraftAmounts(result.lines.map((l) => (l.cents / 100).toFixed(2)));
  }
  async function saveDraft() {
    if (!draft || !reviewed) throw new Error("Review all lines and confirm statement controls first.");
    const s = await finance<Snapshot>("stage", { ...draft, ...sourceEvidence, account, source_hash: fileHash,
      opening_cents: toCents(draftOpening), closing_cents: toCents(draftClosing),
      lines: draft.lines.map((l, i) => ({ ...l, cents: toCents(draftAmounts[i]) })) });
    setSnapshot(s); setDraft(null); setStatus("Statement staged. Match or classify each transaction; no income was automatically created.");
  }
  async function allocate() {
    await finance(kind === "batch" ? "allocate_batch" : "allocate", {
      line_id: Number(lineId), cents: toCents(amount), kind,
      source_id: source, entry_id: Number(source), account: counterpart, description,
      batch_id: Number(source), program, period_from: fundingFrom, period_to: fundingTo,
      reference: fundingReference, reason, receipt_id: Number(fundingReceipt),
    });
    await refresh();
    if (selected) await detail(selected);
    await loadCandidates(kind);
    setStatus("Allocation saved. Review the remaining amount before reconciling.");
  }
  async function runReport() { setExportLabel(""); setReport(await finance<FinanceReport>("report", { from, to })); }
  async function captureReport() {
    const saved = await finance<{ id: number; report: FinanceReport }>("export_report", { from, to });
    setReport(saved.report); setExportLabel(`Saved report #${saved.id}`);
    await refresh();
    return saved;
  }
  async function csv() {
    const { id, report } = await captureReport();
    const quote = (v: string | number) => {
      const value = typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
      return `"${value.replace(/"/g, '""')}"`;
    };
    const content = [
      [`Saved report #${id}`, "Cash-basis accounting", report.from, report.to, report.provisional ? "PROVISIONAL" : "Reviewed controls complete"],
      ...report.warnings.map((w) => ["Warning", w]),
      ["Month", "Income CAD", "Expenses CAD", "Net CAD"],
      ...groupFinanceMonths(report.months, period).map((m) => [m.label, (m.income_cents / 100).toFixed(2), (m.expense_cents / 100).toFixed(2), ((m.income_cents - m.expense_cents) / 100).toFixed(2)]),
      ["Journal ID", "Date", "Description", "Debit account", "Credit account", "CAD", "Source"],
      ...report.entries.map((e) => [e.id, e.date, /^[=+\-@]/.test(e.description) ? `'${e.description}` : e.description, e.debit, e.credit, (e.cents / 100).toFixed(2), e.source]),
      ["Account", "Kind", "Balance cents"], ...report.trial_balance.map((a) => [a.code, a.kind, a.balance_cents]),
      ["Funding entry", "Program", "Reference", "Period from", "Period to", "Received cents", "Released cents", "Refunded cents"],
      ...report.funding.map((f) => [f.entry_id, f.program, f.reference, f.period_from, f.period_to, f.received_cents, f.released_cents, f.refunded_cents]),
    ].map((r) => r.map(quote).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `finance-${report.from}-${report.to}-v${id}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  const accountOptions = snapshot.accounts.map((a) => <option key={a.code} value={a.code}>{a.name} ({a.kind})</option>);
  const patchDraft = (i: number, patch: Partial<ImportLine>) => {
    setReviewed(false); setDraft((d) => d && ({ ...d, lines: d.lines.map((l, n) => n === i ? { ...l, ...patch } : l) }));
  };
  return <section className="finance-workspace">
    <h1>{reportPage ? "Accounting reports" : incomePage ? "Income & adjustments" : "Bank statements & reconciliation"}</h1>
    <p className="subtitle">Cash basis · CAD · September–August fiscal year. Statement matching is separate from income recognition.</p>
    <nav className="toolbar no-print" aria-label="Finance workflow">
      <Link to="/expenses/banking">Statements & accounts</Link>
      <Link to="/expenses/income">Income & adjustments</Link>
      <Link to="/expenses/accounting">Accounting reports</Link>
    </nav>
    {error && <p role="alert" className="finance-error">{error}</p>}
    {status && <p role="status">{status}</p>}
    <fieldset disabled={busy}>
    {!enabled ? <section className="card">
      <h2>Set up accounting safely</h2>
      <p>Existing reports stay unchanged until activation. Choose the first fiscal year to convert. This is a one-time cutover, not an annual reset.</p>
      <p>Receipts are treated as parent payments received, not invoices; expenses as paid purchases. Receipt-attributed subsidies are not assumed to be received funding. Confirm these assumptions against your records before enabling.</p>
      <label>First fiscal-year start <input type="date" value={start} onChange={(e) => { setStart(e.target.value); setPreview(null); setAck(false); }} /></label>
      <button className="btn secondary" onClick={() => void act(async () => setPreview(await finance("preview", { start_date: start })))}>Preview conversion</button>
      {preview && <>
        <table className="data"><thead><tr><th>Source since cutover</th><th>Records</th><th>Net amount</th></tr></thead>
          <tbody>{preview.map((p) => <tr key={p.source}><td>{p.source}</td><td>{p.count}</td><td>{money(p.cents)}</td></tr>)}</tbody></table>
        <p>Converted payments start in clearing until matched to bank statements. Opening balances and unconfirmed funding remain review gates. Historical receipt amounts and numbering are not changed.</p>
        <label className="finance-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I reviewed the preview and confirm the payment assumptions. Create a safety backup before enabling.</label>
        <button className="btn" disabled={!ack} onClick={() => void act(async () => {
          const result = await finance<Snapshot & { backup_path: string }>("configure", { start_date: start, confirm_preview: true });
          setSnapshot(result); setStatus(`Accounting enabled. Safety backup: ${result.backup_path}`);
        })}>Back up & enable accounting</button>
      </>}
    </section> : <>
      <p>Cutover: <strong>{enabled.start_date}</strong>. {enabled.closed_through ? `Books closed through ${enabled.closed_through}.` : "Books are open."}</p>
      {!reportPage && !incomePage && <>
        <details className="card"><summary>Accounts, opening balances & policy controls</summary>
          <h3>Funding policies</h3>
          <p>Unknown funding stays unresolved. Funding allocation enforces the latest reviewed policy and retains its revision, remittance evidence and service period. Restricted money stays a liability until an evidenced release.</p>
          {snapshot.policies.map((p) => <p key={p.program}><strong>{p.program}: {p.treatment.replace(/_/g, " ")}</strong> — {p.rule} · Evidence: {p.evidence}</p>)}
          <div className="toolbar">
            <label>Program <select value={program} onChange={(e) => setProgram(e.target.value)}>{["CCFRI", "ACCB", "MCCB", "Other"].map((p) => <option key={p}>{p}</option>)}</select></label>
            <label>Treatment <select value={treatment} onChange={(e) => setTreatment(e.target.value)}>
              <option value="unresolved">Unresolved</option><option value="cash_income">Cash income under approved rules</option><option value="liability_until_release">Liability until approved release</option><option value="not_applicable">Not applicable</option>
            </select></label>
            <label>Recognition / release rule <input value={policyRule} onChange={(e) => setPolicyRule(e.target.value)} /></label>
            <button className="btn secondary" onClick={() => void act(async () => setSnapshot(await finance("funding_policy", { program, treatment, rule: policyRule, reason })))}>Save policy revision</button>
          </div>
          <p>Opening balances are the balances immediately before cutover transactions. Card balances owed are negative; do not include converted activity twice.</p>
          <table className="data"><thead><tr><th>Account</th><th>Type</th><th>Book balance</th></tr></thead>
            <tbody>{snapshot.accounts.map((a) => <tr key={a.code}><td>{a.name}</td><td>{a.kind}</td><td>{money(a.balance_cents)}</td></tr>)}</tbody></table>
          <div className="toolbar">
            <label>New account name <input value={accountName} onChange={(e) => setAccountName(e.target.value)} /></label>
            <label>Type <select value={accountKind} onChange={(e) => setAccountKind(e.target.value as AccountKind)}>
              {["bank", "card", "income", "expense", "asset", "liability"].map((k) => <option key={k}>{k}</option>)}
            </select></label>
            <button className="btn secondary" onClick={() => void act(async () => {
              setSnapshot(await finance("account", { name: accountName, kind: accountKind })); setAccountName("");
            })}>Add account</button>
          </div>
          <div className="toolbar">
            <label>Account <select value={account} onChange={(e) => setAccount(e.target.value)} disabled={!!draft}><option value="">Choose account</option>{accountOptions}</select></label>
            <label>Signed opening balance CAD <input value={opening} onChange={(e) => setOpening(e.target.value)} inputMode="decimal" /></label>
            <button className="btn secondary" onClick={() => void act(async () => {
              if (await showConfirm("Record this verified opening balance? If one already exists, it will be reversed and replaced, retaining the journal and approval evidence. Affected statements need revalidation.")) {
                setSnapshot(await finance("opening", { account, cents: toCents(opening), reason }));
              }
            })}>Record / correct opening</button>
          </div>
          <label>Approval evidence / reason <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reference the reviewed opening balances or funding policy" /></label>
          <div className="toolbar">
            <button className="btn secondary" onClick={() => void act(async () => {
              if (await showConfirm("Confirm all opening balances and outstanding items were reviewed?")) setSnapshot(await finance("confirm_opening", { reason }));
            })}>Confirm reviewed openings</button>
            <button className="btn secondary" onClick={() => void act(async () => {
              if (await showConfirm("Confirm the funding recognition policy and all applicable remittances have been reviewed? Do not confirm while they are unknown.")) setSnapshot(await finance("confirm_funding", { reason }));
            })}>Confirm reviewed funding policy</button>
            <button className="btn secondary" onClick={() => void act(async () => {
              if (await showConfirm("Confirm all current journals were reviewed for cash recognition, card-purchase timing, capital purchases, payroll liabilities and taxes? Existing expense categories alone do not establish correct accounting. Record any reclassifications first.")) setSnapshot(await finance("confirm_classification", { reason }));
            })}>Confirm journal classifications</button>
          </div>
        </details>
        <section className="card">
          <h2>Upload a statement</h2>
          <p>CSV stays local. PDF/image extraction requires explicit Azure consent. Include all payments/transfers, not just expenses. For card statements, balances owed are negative and purchases reduce the signed balance.</p>
          <p>Supported CSV headers: <code>Date,Description,Amount</code> (signed), or <code>Date,Description,Withdrawal,Deposit</code>. Dates must be YYYY-MM-DD.</p>
          <div className="toolbar"><label>Bank/card account <select value={account} onChange={(e) => setAccount(e.target.value)} disabled={!!draft}>
            <option value="">Choose account</option>{snapshot.accounts.filter((a) => a.kind === "bank" || a.kind === "card").map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
          </select></label><button className="btn" onClick={() => void act(pick)}>Choose CSV, PDF or image</button></div>
          {draft && <>
            <div className="toolbar">
              <label>Period start <input type="date" value={draft.date_from || ""} onChange={(e) => { setReviewed(false); setDraft({ ...draft, date_from: e.target.value }); }} /></label>
              <label>Period end <input type="date" value={draft.date_to || ""} onChange={(e) => { setReviewed(false); setDraft({ ...draft, date_to: e.target.value }); }} /></label>
              <label>Opening CAD <input value={draftOpening} inputMode="decimal" onChange={(e) => { setReviewed(false); setDraftOpening(e.target.value); }} /></label>
              <label>Closing CAD <input value={draftClosing} inputMode="decimal" onChange={(e) => { setReviewed(false); setDraftClosing(e.target.value); }} /></label>
            </div>
            <p>Enter independently verified period controls if extraction returned blanks. Never substitute a current website balance from a different date.</p>
            <div className="finance-table"><table className="data"><thead><tr><th>Date</th><th>Description</th><th>Signed CAD</th></tr></thead><tbody>
              {draft.lines.map((l, i) => <tr key={i}><td><input aria-label={`Row ${i + 1} date`} type="date" value={l.date} onChange={(e) => patchDraft(i, { date: e.target.value })} /></td>
                <td><input aria-label={`Row ${i + 1} description`} value={l.description} onChange={(e) => patchDraft(i, { description: e.target.value })} /></td>
                <td><input aria-label={`Row ${i + 1} amount`} value={draftAmounts[i]} inputMode="decimal" onChange={(e) => { setReviewed(false); setDraftAmounts((values) => values.map((value, n) => n === i ? e.target.value : value)); }} /></td></tr>)}
            </tbody></table></div>
            <p>Original extracted totals before corrections — deposits: {money(draft.lines.filter((l) => l.cents > 0).reduce((n, l) => n + l.cents, 0))}; withdrawals: {money(-draft.lines.filter((l) => l.cents < 0).reduce((n, l) => n + l.cents, 0))}. Corrected amounts must balance exactly when saved.</p>
            <label className="finance-check"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />I checked every row, period and independently verified opening/closing balance.</label>
            <button className="btn" disabled={!reviewed} onClick={() => void act(saveDraft)}>Save for reconciliation</button>
            <button className="btn secondary" onClick={() => setDraft(null)}>Discard draft</button>
          </>}
        </section>
        <section className="card"><h2>Imported statements</h2>
          {!snapshot.statements.length ? <p>No statements imported. Start with your first fiscal month.</p> : <table className="data"><thead><tr><th>Account / period</th><th>Status</th><th>Unresolved</th><th>Action</th></tr></thead><tbody>
            {snapshot.statements.map((s) => <tr key={s.id}><td>{s.account_name}<br />{s.date_from} to {s.date_to}</td><td>{s.status}</td><td>{s.unresolved}</td>
              <td><button className="btn secondary" onClick={() => void act(async () => { await detail(s); await loadCandidates(kind); })}>Review</button></td></tr>)}
          </tbody></table>}
        </section>
        {snapshot.purchase_batches.length > 0 && <details className="card"><summary>Previous purchase-only card imports</summary>
          <p>Match these already-posted purchases as existing journals on card statements. Do not recreate them. A reversal retains original source snapshots and cancels the purchase journals; unmatch/reopen first.</p>
          <label>Reversal evidence <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <table className="data"><thead><tr><th>Batch / dates</th><th>Purchases</th><th>Net</th><th>Correction</th></tr></thead><tbody>
            {snapshot.purchase_batches.map((b) => <tr key={b.id}><td>{b.id.slice(0, 8)}<br />{b.date_from} to {b.date_to}</td><td>{b.count}</td><td>{money(b.cents)}</td><td>
              <button className="btn secondary" onClick={() => void act(async () => {
                if (!await showConfirm("Reverse all purchases in this import? Original records and reversal journals remain in history.")) return;
                await finance("undo_import", { batch_id: b.id, reason }); await refresh(); setSelected(null);
                setStatus("Purchase import reversed; source snapshots and journals retained.");
              })}>Reverse import</button>
            </td></tr>)}
          </tbody></table>
        </details>}
        {selected && <section className="card"><h2>Reconcile {selected.account_name}: {selected.date_from} to {selected.date_to}</h2>
          <p>Leave uncertain funding unresolved. Match grouped deposits using a deposit batch or individual receipts. Suggestions rank compatible remaining amounts and date proximity; nothing is accepted automatically.</p>
          <div className="finance-table"><table className="data"><thead><tr><th>Date</th><th>Description</th><th>Signed CAD</th><th>Remaining</th><th>Action</th></tr></thead><tbody>
            {lines.map((l) => <tr key={l.id}><td>{l.date}</td><td>{l.description}</td><td>{money(l.cents)}</td><td>{money(l.remaining)}</td><td>
              <button className="btn secondary" disabled={!l.remaining || selected.status !== "review"} onClick={() => void act(async () => {
                setLineId(String(l.id)); setAmount((l.remaining / 100).toFixed(2)); setDescription(l.description); await loadCandidates(kind, String(l.id));
              })}>Allocate</button>
            </td></tr>)}
          </tbody></table></div>
          {lineId && <div className="finance-allocation">
            <h3>Allocate transaction #{lineId}</h3>
            <label>Action <select value={kind} onChange={(e) => void act(() => loadCandidates(e.target.value))}>
              <option value="receipt">Match parent receipt</option><option value="expense">Match paid expense</option>
              <option value="batch">Match deposit batch</option><option value="funding">Funding remittance</option><option value="funding_refund">Funding repayment/refund</option>
              <option value="existing">Match existing journal / transfer counterpart</option><option value="new">New income / expense / liability</option><option value="transfer">Transfer / card repayment</option>
            </select></label>
            <label>Amount CAD <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
            {["receipt", "expense", "existing"].includes(kind) ? <label>Source <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Choose source</option>{candidates.filter((e) => e.remaining == null || e.remaining > 0).map((e) => <option key={e.id} value={kind === "existing" ? e.id : e.source_id}>#{e.id} {e.date} {e.description} {money(e.remaining ?? e.cents)}{e.days_apart == null ? "" : ` · ${e.days_apart} days apart`}</option>)}
            </select></label> : kind === "batch" ? <label>Deposit batch <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Choose batch</option>{batches.map((b) => <option key={b.id} value={b.id}>#{b.id} {b.deposit_date} · {money(b.remaining)} remaining</option>)}
            </select></label> : kind === "funding" ? <>
              <label>Program <select value={program} onChange={(e) => setProgram(e.target.value)}>{["CCFRI", "ACCB", "MCCB", "Other"].map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>Service period from <input type="date" value={fundingFrom} onChange={(e) => setFundingFrom(e.target.value)} /></label>
              <label>Service period through <input type="date" value={fundingTo} onChange={(e) => setFundingTo(e.target.value)} /></label>
              <label>Remittance reference <input value={fundingReference} onChange={(e) => setFundingReference(e.target.value)} /></label>
              <label>Policy / remittance evidence <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            </> : kind === "funding_refund" ? <>
              <label>Original remittance <select value={fundingReceipt} onChange={(e) => setFundingReceipt(e.target.value)}><option value="">Choose receipt</option>{snapshot.funding.map((f) => <option key={f.entry_id} value={f.entry_id}>#{f.entry_id} {f.program} {f.reference} · {money(f.received_cents - f.released_cents - f.refunded_cents)} remaining</option>)}</select></label>
              <label>Refund evidence <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            </> : <>
              <label>Counterpart category/account <select value={counterpart} onChange={(e) => setCounterpart(e.target.value)}><option value="">Choose account</option>{accountOptions}</select></label>
              <label>Explanation <input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
            </>}
            <button className="btn" onClick={() => void act(allocate)}>Save allocation</button>
          </div>}
          {allocations.length > 0 && <details><summary>Saved allocations</summary>{allocations.map((a) => <p key={a.id}>Line #{a.line_id}: {a.description} · {money(a.cents)} <button className="btn secondary" onClick={() => void act(async () => {
            if (!await showConfirm("Unmatch this allocation? Generated settlement entries will be reversed; source receipts/expenses stay intact.")) return;
            await finance("unmatch", { allocation_id: a.id }); await detail(selected); await refresh();
          })}>Unmatch</button></p>)}</details>}
          <div className="toolbar">
            <button className="btn secondary" onClick={() => void act(async () => {
              const evidence = await finance<{ name: string; base64: string }>("source", { statement_id: selected.id });
              const target = await save({ defaultPath: evidence.name });
              if (target) await writeFile(target, Uint8Array.from(atob(evidence.base64), (c) => c.charCodeAt(0)));
            })}>Save original statement</button>
            <button className="btn" onClick={() => void act(async () => { setSnapshot(await finance("reconcile", { statement_id: selected.id })); setStatus("Statement reconciled against book opening and closing balances."); setSelected(null); })}>Reconcile statement</button>
            <button className="btn secondary" onClick={() => void act(async () => { setSnapshot(await finance("reopen", { statement_id: selected.id, reason })); setSelected(null); })}>Reopen with reason</button>
            {selected.status !== "withdrawn" && <button className="btn secondary" onClick={() => void act(async () => {
              if (!await showConfirm("Withdraw this staged statement? Unmatch every allocation first. Original evidence stays archived. To replace it, import a corrected CSV, not the same original file.")) return;
              setSnapshot(await finance("withdraw_statement", { statement_id: selected.id, reason })); setSelected(null);
            })}>Withdraw with reason</button>}
          </div>
          <label>Reason for reopening <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </section>}
      </>}
      {incomePage && <section className="card"><h2>Record income or a reviewed adjustment</h2>
        <p>For ordinary income, debit the receiving bank and credit the income category. Do not add income already represented by a parent receipt or funding allocation. Later match the statement using “existing entry”.</p>
        <p>Statement-created expenses also appear in Expenses automatically. Unmatching removes settlement, not the purchase; correct or void the purchase separately. Record funding through the remittance controls rather than an unrestricted journal.</p>
        <div className="toolbar">
          <label>Date <input type="date" value={journalDay} onChange={(e) => setJournalDay(e.target.value)} /></label>
          <label>Amount CAD <input value={journalAmount} onChange={(e) => setJournalAmount(e.target.value)} inputMode="decimal" /></label>
          <label>Debit <select value={debit} onChange={(e) => setDebit(e.target.value)}><option value="">Choose account</option>{accountOptions}</select></label>
          <label>Credit <select value={credit} onChange={(e) => setCredit(e.target.value)}><option value="">Choose account</option>{accountOptions}</select></label>
        </div>
        <label>Description / evidence <input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <button className="btn" onClick={() => void act(async () => {
          if (!await showConfirm(`Post ${money(toCents(journalAmount))} to the selected debit and credit accounts? This creates a permanent journal record.`)) return;
          await finance("journal", { date: journalDay, description, debit, credit, cents: toCents(journalAmount) }); await refresh(); setStatus("Journal posted.");
        })}>Review & post entry</button>
      </section>}
      {incomePage && <section className="card">
        <h2>Funding remittances & releases</h2>
        <p>Receipts retain their original policy revision. Partial releases and repayments cannot exceed the remaining remittance. A later policy change never rewrites posted history.</p>
        <div className="finance-table"><table className="data"><thead><tr><th>Receipt / reference</th><th>Program / service period</th><th>Received</th><th>Released</th><th>Repaid</th><th>Held as liability</th></tr></thead><tbody>
          {snapshot.funding.map((f) => <tr key={f.entry_id}><td>#{f.entry_id} {f.reference}<br />{f.date}</td><td>{f.program}<br />{f.period_from} to {f.period_to}</td>
            <td>{money(f.received_cents)}</td><td>{money(f.released_cents)}</td><td>{money(f.refunded_cents)}</td><td>{money(f.treatment === "liability_until_release" ? f.received_cents - f.released_cents - f.refunded_cents : 0)}</td></tr>)}
        </tbody></table></div>
        <div className="toolbar">
          <label>Restricted/deferred receipt <select value={fundingReceipt} onChange={(e) => setFundingReceipt(e.target.value)}><option value="">Choose remittance</option>
            {snapshot.funding.filter((f) => f.treatment === "liability_until_release").map((f) => <option key={f.entry_id} value={f.entry_id}>#{f.entry_id} {f.program} {f.reference}</option>)}
          </select></label>
          <label>Release date <input type="date" value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} /></label>
          <label>Release CAD <input value={releaseAmount} onChange={(e) => setReleaseAmount(e.target.value)} inputMode="decimal" /></label>
          <label>Evidence that release conditions were met <input value={releaseEvidence} onChange={(e) => setReleaseEvidence(e.target.value)} /></label>
          <button className="btn" onClick={() => void act(async () => {
            if (!await showConfirm("Recognize this amount as funding income under the original remittance policy? Retain supporting approval evidence.")) return;
            setSnapshot(await finance("funding_release", { receipt_id: Number(fundingReceipt), date: releaseDate, cents: toCents(releaseAmount), reason: releaseEvidence }));
            setReleaseAmount(""); setReleaseEvidence("");
            setStatus("Funding release posted. No new bank deposit was recorded.");
          })}>Review & release funding</button>
        </div>
      </section>}
      {(reportPage || incomePage) && <section className="card">
        <h2>{incomePage ? "Journal and income history" : "Cash-basis P&L and trial balance"}</h2>
        <div className="toolbar no-print">
          <label>From <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setReport(null); }} /></label>
          <label>Through <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setReport(null); }} /></label>
          <label>Group by <select value={period} onChange={(e) => setPeriod(e.target.value as "month" | "quarter" | "year")}>
            <option value="month">Month</option><option value="quarter">Fiscal quarter</option><option value="year">Fiscal year</option>
          </select></label>
          <button className="btn" onClick={() => void act(runReport)}>Load report</button>
        </div>
        {report && <>
          <p><strong>{report.provisional ? "PROVISIONAL — not final accounts" : "Reconciliation controls complete — review adjustments with your accountant"}</strong> · {report.from} to {report.to} · Cash basis · CAD{exportLabel && ` · ${exportLabel}`}</p>
          {report.warnings.length > 0 && <ul>{report.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          {report.outstanding.length > 0 && <details><summary>Outstanding payments / deposits in transit</summary>
            <p>Review each item at this report end date. Approval records evidence of a genuine paid/received item awaiting bank clearance, not unexplained money or a funding-classification exception. It never creates a bank movement.</p>
            <label>Outstanding-item evidence <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <table className="data"><thead><tr><th>Source</th><th>Date</th><th>Outstanding</th><th>Review</th></tr></thead><tbody>
              {report.outstanding.map((e) => <tr key={e.id}><td>{e.description}</td><td>{e.date}</td><td>{money(e.remaining)}</td><td>
                {e.approved ? "Evidence recorded" : <button className="btn secondary" onClick={() => void act(async () => {
                  if (!await showConfirm(`Approve ${money(e.remaining)} as a documented outstanding source payment at ${report.to}? This is not a bank-balance adjustment.`)) return;
                  await finance("review_outstanding", { entry_id: e.id, through: report.to, cents: e.remaining, reason }); await runReport(); await refresh();
                })}>Record reviewed evidence</button>}
              </td></tr>)}
            </tbody></table>
          </details>}
          <table className="data"><thead><tr><th>Month</th><th>Income</th><th>Expenses</th><th>Net</th></tr></thead><tbody>
            {groupFinanceMonths(report.months, period).map((m) => <tr key={m.label}><td>{m.label}</td><td>{money(m.income_cents)}</td><td>{money(m.expense_cents)}</td><td>{money(m.income_cents - m.expense_cents)}</td></tr>)}
            <tr><th>Total</th><td>{money(report.months.reduce((s, m) => s + m.income_cents, 0))}</td><td>{money(report.months.reduce((s, m) => s + m.expense_cents, 0))}</td><td>{money(report.months.reduce((s, m) => s + m.income_cents - m.expense_cents, 0))}</td></tr>
          </tbody></table>
          <details><summary>Funding remittances through report end</summary><table className="data"><thead><tr><th>Program / reference</th><th>Service period</th><th>Received</th><th>Released</th><th>Repaid</th><th>Held</th></tr></thead><tbody>
            {report.funding.map((f) => <tr key={f.entry_id}><td>{f.program} · {f.reference}</td><td>{f.period_from} to {f.period_to}</td><td>{money(f.received_cents)}</td><td>{money(f.released_cents)}</td><td>{money(f.refunded_cents)}</td><td>{money(f.treatment === "liability_until_release" ? f.received_cents - f.released_cents - f.refunded_cents : 0)}</td></tr>)}
          </tbody></table></details>
          <h3>Posted bank cash movement — not profit</h3>
          <p>Excludes opening balances. Unclassified statement lines are not posted bank movements yet.</p>
          <table className="data"><thead><tr><th>Bank</th><th>Money in</th><th>Money out</th><th>Net movement</th></tr></thead><tbody>
            {report.cash_flow.map((a) => <tr key={a.name}><td>{a.name}</td><td>{money(a.inflow_cents)}</td><td>{money(a.outflow_cents)}</td><td>{money(a.inflow_cents - a.outflow_cents)}</td></tr>)}
          </tbody></table>
          <details><summary>Period income/expense categories</summary><table className="data"><thead><tr><th>Category</th><th>Type</th><th>Net CAD</th></tr></thead><tbody>
            {report.categories.map((a) => <tr key={a.code}><td>{a.name}</td><td>{a.kind}</td><td>{money(a.kind === "income" ? -a.balance_cents : a.balance_cents)}</td></tr>)}
          </tbody></table></details>
          <details><summary>Categories and trial balance</summary><table className="data"><thead><tr><th>Account</th><th>Type</th><th>Debit (+) / credit (−)</th></tr></thead><tbody>
            {report.trial_balance.map((a) => <tr key={a.code}><td>{a.name}</td><td>{a.kind}</td><td>{money(a.balance_cents)}</td></tr>)}
          </tbody></table></details>
          <details open={incomePage}><summary>Journal drill-down</summary><div className="finance-table"><table className="data"><thead><tr><th>ID / date</th><th>Description / source</th><th>Debit</th><th>Credit</th><th>CAD</th><th>Correction</th></tr></thead><tbody>
            {report.entries.map((e) => <tr key={e.id}><td>#{e.id}<br />{e.date}</td><td>{e.description}<br />{e.source} #{e.source_id}{e.reversal_of ? ` (reverses #${e.reversal_of})` : ""}</td><td>{e.debit}</td><td>{e.credit}</td><td>{money(e.cents)}</td><td>
              {["adjustment", "funding_release"].includes(e.source) && <button className="btn secondary" onClick={() => void act(async () => { await finance("reverse", { entry_id: e.id, date: journalDay, reason }); await refresh(); await runReport(); })}>Reverse</button>}
            </td></tr>)}
          </tbody></table></div></details>
          <details><summary>Audit history (latest 100 actions)</summary>{report.audit.map((a) => <p key={a.id}>{a.created_at} · {a.action}: {a.detail}</p>)}</details>
          <div className="toolbar no-print">
            <button className="btn secondary" onClick={() => void act(csv)}>Export versioned CSV</button>
            <button className="btn secondary" onClick={() => void act(async () => {
              await captureReport();
              await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
              await printCurrentWindow();
            })}>Print / PDF</button>
            <button className="btn" disabled={report.provisional} onClick={() => void act(async () => { if (await showConfirm(`Close all accounting through ${to}?`)) setSnapshot(await finance("close_period", { through: to })); })}>Close period</button>
            <button className="btn secondary" onClick={() => void act(async () => { setSnapshot(await finance("reopen_period", { reason })); setReport(null); })}>Reopen period with reason</button>
          </div>
          <label className="no-print">Reason for corrections/reopening <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label className="no-print">Correction date <input type="date" value={journalDay} onChange={(e) => setJournalDay(e.target.value)} /></label>
        </>}
      </section>}
      {reportPage && <section className="card no-print"><h2>Saved report versions</h2>
        <p>Saved figures do not change. Later postings or review changes mark previous exports superseded; check this list before reusing an old file.</p>
        {snapshot.exports.length === 0 ? <p>No saved report versions yet.</p> : <table className="data"><thead><tr><th>Version</th><th>Period</th><th>Status</th><th>Action</th></tr></thead><tbody>
          {snapshot.exports.map((e) => <tr key={e.id}><td>#{e.id} · {e.created_at}</td><td>{e.date_from} to {e.date_to}</td><td>{e.superseded ? "Superseded — regenerate" : "Saved"}</td><td>
            <button className="btn secondary" onClick={() => void act(async () => {
              const saved = await finance<{ id: number; report: FinanceReport; superseded: boolean }>("saved_report", { id: e.id });
              setFrom(saved.report.from); setTo(saved.report.to); setReport(saved.report);
              setExportLabel(`Saved report #${saved.id}${saved.superseded ? " — SUPERSEDED" : ""}`);
            })}>View original figures</button>
          </td></tr>)}
        </tbody></table>}
      </section>}
    </>}
    </fieldset>
    {busy && <p role="status">Working…</p>}
  </section>;
}
