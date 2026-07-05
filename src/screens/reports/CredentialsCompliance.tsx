import { useEffect, useState } from "react";
import { getSettings } from "../../lib/db";
import { listAllCredentialsWithStaff, credStatus, daysUntil, type CredStatus } from "../../lib/credentials";
import type { StaffCredential, SettingsMap } from "../../types";

type Row = StaffCredential & { staff_name: string; staff_active: number };

const STATUS_LABEL: Record<CredStatus, string> = {
  expired: "EXPIRED",
  expiring: "Expiring soon",
  ok: "Current",
  unknown: "No expiry recorded",
};
const STATUS_STYLE: Record<CredStatus, React.CSSProperties> = {
  expired:  { background: "#fee2e2", color: "#991b1b" },
  expiring: { background: "#fef3c7", color: "#92400e" },
  ok:       { background: "#dcfce7", color: "#166534" },
  unknown:  { background: "#f1f5f9", color: "#475569" },
};

export default function CredentialsCompliance() {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [alertDays, setAlertDays] = useState(60);
  const [includeArchived, setIncludeArchived] = useState(false);

  async function reload(showArchived: boolean) {
    const [s, list] = await Promise.all([getSettings(), listAllCredentialsWithStaff(showArchived)]);
    setSettings(s);
    setAlertDays(Number(s.staff_cred_alert_days || "60"));
    setRows(list);
  }

  useEffect(() => { reload(includeArchived); }, [includeArchived]);

  const counts = rows.reduce((a, r) => {
    const st = credStatus(r.expiry_date, alertDays);
    a[st] = (a[st] || 0) + 1;
    return a;
  }, {} as Record<string, number>);

  function exportCsv() {
    const lines = ["Staff,Credential,Issued,Expires,Status,Days Until Expiry"];
    rows.forEach((r) => {
      const st = credStatus(r.expiry_date, alertDays);
      const days = daysUntil(r.expiry_date);
      lines.push([r.staff_name, r.type, r.issued_date || "", r.expiry_date || "",
        STATUS_LABEL[st], days === null ? "" : String(days)]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `staff-credentials-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const daycareName = settings.daycare_name || "Echelon Daycare";
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h1 style={{ marginTop: 0, marginBottom: 6 }}>Staff Credentials Compliance</h1>
          <p style={{ color: "var(--muted)", margin: 0 }}>
            ECE Certificates, Criminal Record Checks, First Aid, TB clearance. BC Child Care Licensing Regulation requires currency for every child-facing employee.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }} title="Include credentials belonging to archived (inactive) staff — useful for handoff / historical audits.">
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            Include archived staff
          </label>
          <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <div className="report-sheet" style={{ background: "#fff", padding: 24, border: "1px solid var(--border)", borderRadius: 8 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{daycareName}</div>
          <div style={{ color: "var(--muted)" }}>Staff Credentials Compliance Report</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Printed: {today} — alert window: {alertDays} days</div>
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          {(["expired", "expiring", "ok", "unknown"] as CredStatus[]).map((st) => (
            <div key={st} style={{ ...STATUS_STYLE[st], padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
              {STATUS_LABEL[st]}: {counts[st] || 0}
            </div>
          ))}
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Staff</th>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Credential</th>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Issued</th>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Expires</th>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = credStatus(r.expiry_date, alertDays);
              const days = daysUntil(r.expiry_date);
              return (
                <tr key={r.id}>
                  <td style={{ padding: 6, border: "1px solid var(--border)", fontWeight: 600 }}>{r.staff_name}</td>
                  <td style={{ padding: 6, border: "1px solid var(--border)" }}>{r.type}</td>
                  <td style={{ padding: 6, border: "1px solid var(--border)" }}>{r.issued_date || "—"}</td>
                  <td style={{ padding: 6, border: "1px solid var(--border)" }}>{r.expiry_date || "—"}</td>
                  <td style={{ padding: 6, border: "1px solid var(--border)" }}>
                    <span style={{ ...STATUS_STYLE[st], padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600 }}>{STATUS_LABEL[st]}</span>
                    {days !== null && st !== "ok" && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--muted)" }}>({days < 0 ? `${-days}d overdue` : `in ${days}d`})</span>}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No credentials recorded. Add credentials in Staff → Credentials.</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ marginTop: 16, fontSize: 11, color: "var(--muted)", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          Sorted by soonest expiry first. Update credentials in Staff → Credentials.
          Regulations: BC Child Care Licensing Regulation, ss. 15–19, Schedule A.
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
