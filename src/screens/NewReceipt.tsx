import { useEffect, useMemo, useState } from "react";
import {
  listStudents, listYears, nextReceiptNo, createReceipt, getSettings,
} from "../lib/db";
import type { Student } from "../types";
import { printReceipt, saveReceiptPdf } from "../lib/receipt";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export default function NewReceipt() {
  const today = new Date();
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number>(today.getFullYear());
  const [students, setStudents] = useState<Student[]>([]);
  const [studentId, setStudentId] = useState<number | "">("");
  const [receiptNo, setReceiptNo] = useState<number>(1001);
  const [date, setDate] = useState<string>(today.toISOString().slice(0, 10));
  const [month, setMonth] = useState<string>(MONTHS[today.getMonth()]);
  const [feeYear, setFeeYear] = useState<number>(today.getFullYear());
  const [amount, setAmount] = useState<string>("485");
  const [pending, setPending] = useState<string>("0");
  const [comments, setComments] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [descTouched, setDescTouched] = useState(false);

  async function refresh() {
    const ys = await listYears();
    setYears(ys.length ? ys : [today.getFullYear()]);
    const useYear = ys.includes(year) ? year : (ys[0] ?? today.getFullYear());
    setYear(useYear);
    const ss = await listStudents(useYear);
    setStudents(ss);
    const s = await getSettings();
    setAmount(s.default_fee || "485");
    setReceiptNo(await nextReceiptNo());
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { (async () => setStudents(await listStudents(year)))(); }, [year]);
  useEffect(() => {
    if (!descTouched) setDescription(`${month} ${feeYear} Tuition Fee`);
  }, [month, feeYear, descTouched]);

  const student = useMemo(() => students.find((s) => s.id === studentId) || null, [students, studentId]);

  async function onSave(thenPrint: boolean) {
    if (!student) { alert("Pick a student first."); return; }
    if (!description.trim()) { alert("Description is required."); return; }
    const amt = parseFloat(amount); if (!(amt >= 0)) { alert("Invalid amount."); return; }
    const pen = parseFloat(pending || "0") || 0;
    await createReceipt({
      receipt_no: receiptNo, date, student_id: student.id,
      student_name_snapshot: student.name,
      father_name_snapshot: student.father_name,
      mother_name_snapshot: student.mother_name,
      description, amount: amt, pending_amount: pen, comments: comments || null,
    });
    const settings = await getSettings();
    const r = {
      id: 0, receipt_no: receiptNo, date, student_id: student.id,
      student_name_snapshot: student.name,
      father_name_snapshot: student.father_name,
      mother_name_snapshot: student.mother_name,
      description, amount: amt, pending_amount: pen, comments: comments || null,
      voided: 0, created_at: new Date().toISOString(),
    };
    let savedPath: string | null = null;
    try { savedPath = await saveReceiptPdf(r, settings); }
    catch (e) { console.error(e); alert("Receipt saved, but PDF auto-save failed:\n" + e); }
    if (thenPrint) printReceipt(r, settings);
    setReceiptNo((n) => n + 1);
    setComments(""); setPending("0");
    alert(`Receipt #${receiptNo} saved.${savedPath ? "\nPDF: " + savedPath : "\n(Set a PDF folder in Settings to auto-save PDFs.)"}`);
  }

  return (
    <div>
      <h1>New Receipt</h1>
      <p className="subtitle">Creates an entry in Receipt History and opens the macOS print dialog (use "Save as PDF" to keep a copy).</p>

      <div className="card">
        <div className="row">
          <div className="field">
            <label>Receipt #</label>
            <input value={receiptNo} onChange={(e) => setReceiptNo(parseInt(e.target.value || "0", 10))} />
          </div>
          <div className="field">
            <label>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label>Roster Year</label>
            <select value={year} onChange={(e) => { setYear(parseInt(e.target.value, 10)); setStudentId(""); }}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Student</label>
            <select value={studentId} onChange={(e) => setStudentId(e.target.value ? parseInt(e.target.value, 10) : "")}>
              <option value="">— select —</option>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>

        {student && (
          <div className="card" style={{ background: "#f8fafc", padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 13 }}>
              <div><b>Father:</b> {student.father_name || "—"}</div>
              <div><b>Mother:</b> {student.mother_name || "—"}</div>
              <div><b>Email:</b> {student.email || "—"}</div>
            </div>
          </div>
        )}

        <div className="row">
          <div className="field">
            <label>Fee Month</label>
            <select value={month} onChange={(e) => { setMonth(e.target.value); setDescTouched(false); }}>
              {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Fee Year</label>
            <input type="number" value={feeYear} onChange={(e) => { setFeeYear(parseInt(e.target.value || "0", 10)); setDescTouched(false); }} />
          </div>
        </div>

        <div className="field">
          <label>Description</label>
          <input value={description} onChange={(e) => { setDescription(e.target.value); setDescTouched(true); }} />
        </div>

        <div className="row">
          <div className="field">
            <label>Amount Received ($)</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="field">
            <label>Pending Fees ($)</label>
            <input value={pending} onChange={(e) => setPending(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Comments</label>
          <textarea value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Optional notes (e.g., Pending Fees CAD120)" />
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button className="btn" onClick={() => onSave(true)}>Save &amp; Print</button>
          <button className="btn secondary" onClick={() => onSave(false)}>Save Only</button>
        </div>
      </div>
    </div>
  );
}
