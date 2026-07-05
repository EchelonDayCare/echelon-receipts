import { useEffect, useState } from "react";
import { db, getSettings, listYears } from "../../lib/db";
import type { SettingsMap } from "../../types";
import { fiscalYearBounds, fiscalYearLabel } from "../../lib/fiscalYear";
import AgmMinutesEditor from "./AgmMinutes";

interface YearRow {
  label: string;
  active: number;
  total: number;
  receipts: number;
  gross: number;
  ccfri: number;
  accb: number;
  paid: number;
  refunds: number;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Agm() {
  const [tab, setTab] = useState<"package" | "minutes">("package");
  return (
    <div>
      <div className="no-print" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", padding: "12px 24px 0" }}>
        <TabBtn active={tab === "package"} onClick={() => setTab("package")}>Board Package (numbers)</TabBtn>
        <TabBtn active={tab === "minutes"}  onClick={() => setTab("minutes")}>AGM Minutes (document)</TabBtn>
      </div>
      {tab === "package" ? <BoardPackage /> : <AgmMinutesEditor />}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid var(--accent, #2563eb)" : "2px solid transparent",
        color: active ? "var(--fg)" : "var(--muted)",
        fontWeight: active ? 600 : 500,
        padding: "8px 14px",
        cursor: "pointer",
        marginBottom: -1,
      }}>
      {children}
    </button>
  );
}

function BoardPackage() {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [rows, setRows] = useState<YearRow[]>([]);
  const [mode, setMode] = useState<"fiscal_sep_aug" | "calendar">("fiscal_sep_aug");

  async function load() {
    const s = await getSettings();
    setSettings(s);
    const yearsList = await listYears();
    if (yearsList.length === 0) { setRows([]); return; }
    // Build rows for last 5 years (or all available)
    const now = new Date();
    const nowYear = now.getFullYear();
    const startYear = Math.min(...yearsList, mode === "fiscal_sep_aug" ? (now.getMonth() + 1 >= 9 ? nowYear : nowYear - 1) : nowYear);
    const endYear = mode === "fiscal_sep_aug"
      ? (now.getMonth() + 1 >= 9 ? nowYear : nowYear - 1)
      : nowYear;

    const d = await db();
    const out: YearRow[] = [];
    for (let y = endYear; y >= Math.max(startYear, endYear - 5); y--) {
      let label: string, dateFrom: string, dateTo: string, rosterYear: number;
      if (mode === "fiscal_sep_aug") {
        const b = fiscalYearBounds(y);
        label = fiscalYearLabel(y);
        dateFrom = b.start; dateTo = b.end; rosterYear = y + 1; // students table is per-calendar-year roster; use the year that spans most of the FY
      } else {
        label = String(y); dateFrom = `${y}-01-01`; dateTo = `${y}-12-31`; rosterYear = y;
      }
      const [studentAgg, receiptAgg] = await Promise.all([
        d.select<{ active: number; total: number }[]>(
          "SELECT SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active, COUNT(*) AS total FROM students WHERE year=?",
          [rosterYear]
        ),
        d.select<{ receipts: number; gross: number; ccfri: number; accb: number; paid: number; refunds: number }[]>(
          `SELECT COUNT(*) AS receipts,
                  COALESCE(SUM(CASE WHEN is_refund=1 THEN -COALESCE(gross_amount, amount) ELSE COALESCE(gross_amount, amount) END),0) AS gross,
                  COALESCE(SUM(CASE WHEN is_refund=1 THEN -COALESCE(ccfri_amount,0) ELSE COALESCE(ccfri_amount,0) END),0) AS ccfri,
                  COALESCE(SUM(CASE WHEN is_refund=1 THEN -COALESCE(accb_amount,0) ELSE COALESCE(accb_amount,0) END),0) AS accb,
                  COALESCE(SUM(CASE WHEN is_refund=1 THEN -amount ELSE amount END),0) AS paid,
                  COALESCE(SUM(CASE WHEN is_refund=1 THEN amount ELSE 0 END),0) AS refunds
             FROM receipts
            WHERE voided=0 AND date>=? AND date<=?`,
          [dateFrom, dateTo]
        ),
      ]);
      const sa = studentAgg[0] || { active: 0, total: 0 };
      const ra = receiptAgg[0] || { receipts: 0, gross: 0, ccfri: 0, accb: 0, paid: 0, refunds: 0 };
      out.push({ label, active: sa.active || 0, total: sa.total || 0, ...ra });
    }
    setRows(out);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [mode]);

  function exportCsv() {
    const lines = ["Year,Active Students,Total Enrolled,Receipts,Gross Fees,CCFRI,ACCB,Parent Paid,Refunds"];
    rows.forEach((r) => {
      lines.push([r.label, r.active, r.total, r.receipts, fmt(r.gross), fmt(r.ccfri), fmt(r.accb), fmt(r.paid), fmt(r.refunds)]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `agm-package-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const daycareName = settings.daycare_name || "Echelon Daycare";
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  const grandTotal = rows.reduce((a, r) => ({
    gross: a.gross + r.gross, ccfri: a.ccfri + r.ccfri, accb: a.accb + r.accb, paid: a.paid + r.paid,
  }), { gross: 0, ccfri: 0, accb: 0, paid: 0 });

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h1 style={{ marginTop: 0, marginBottom: 6 }}>AGM / Board Package</h1>
          <p style={{ color: "var(--muted)", margin: 0 }}>
            Multi-year enrollment and revenue summary for the Society's Annual General Meeting.
            Pair with the Treasurer's expense report from your bookkeeping tool.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="fiscal_sep_aug">Fiscal (Sep–Aug)</option>
            <option value="calendar">Calendar (Jan–Dec)</option>
          </select>
          <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <div className="report-sheet" style={{ background: "#fff", padding: 24, border: "1px solid var(--border)", borderRadius: 8 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{daycareName}</div>
          <div style={{ color: "var(--muted)" }}>AGM Package — {mode === "fiscal_sep_aug" ? "Fiscal Years" : "Calendar Years"}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Prepared: {today}</div>
        </div>

        <h3 style={{ marginBottom: 8 }}>Enrollment</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 24 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Year</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Active Students</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Total Enrolled (incl. withdrawn)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td style={{ padding: 6, border: "1px solid var(--border)" }}>{r.label}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{r.active}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{r.total}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ marginBottom: 8 }}>Revenue &amp; Subsidies</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Year</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Receipts</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Gross Fees</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>CCFRI</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>ACCB</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Parent Paid</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Refunds</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td style={{ padding: 6, border: "1px solid var(--border)" }}>{r.label}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{r.receipts}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(r.gross)}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(r.ccfri)}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(r.accb)}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(r.paid)}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(r.refunds)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background: "#f8fafc", fontWeight: 700 }}>
              <td style={{ padding: 6, border: "1px solid var(--border)" }}>Multi-year total</td>
              <td style={{ padding: 6, border: "1px solid var(--border)" }}></td>
              <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(grandTotal.gross)}</td>
              <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(grandTotal.ccfri)}</td>
              <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(grandTotal.accb)}</td>
              <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(grandTotal.paid)}</td>
              <td style={{ padding: 6, border: "1px solid var(--border)" }}></td>
            </tr>
          </tfoot>
        </table>

        <div style={{ marginTop: 24, padding: 12, background: "#f8fafc", borderRadius: 6, fontSize: 12, color: "var(--muted)" }}>
          <strong>For the AGM minutes, the Society should also report:</strong> operating expenses, staff FTE, capital purchases, grants received, and next-year budget.
          Those live in your bookkeeping / QuickBooks and outside this app.
        </div>
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          .report-sheet { border: none !important; padding: 0 !important; }
          @page { margin: 0.5in; }
        }
      `}</style>
    </div>
  );
}
