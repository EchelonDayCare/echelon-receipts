import { useNavigate } from "react-router-dom";

interface ReportCard {
  to: string;
  title: string;
  desc: string;
  category: "Financial" | "Compliance" | "Governance";
  icon: string;
}

const REPORTS: ReportCard[] = [
  { to: "/reports/monthly", title: "Monthly Revenue", category: "Financial", icon: "💰",
    desc: "Receipts issued and collected per month, quarterly totals, refund summary. Fiscal (Sep–Aug) or calendar year." },
  { to: "/reports/aging", title: "Aging (A/R)", category: "Financial", icon: "⏳",
    desc: "Outstanding balances by student, aged 0-30 / 31-60 / 60+ days. Used for follow-up on unpaid fees." },
  { to: "/reports/subsidy", title: "Subsidy Reconciliation", category: "Financial", icon: "🏛️",
    desc: "CCFRI + ACCB claimed by month. Match against BC Ministry statements at year-end." },
  { to: "/reports/enrollment", title: "Enrollment Roster", category: "Compliance", icon: "📋",
    desc: "Printable roster of active students with parent contacts. Kept on-site per BC Child Care Licensing Regulation §57." },
  { to: "/reports/attendance", title: "Attendance Summary", category: "Compliance", icon: "📅",
    desc: "Days present, hours logged, absences per student per month. Required daily record (BC CCLR §57)." },
  { to: "/reports/credentials", title: "Staff Credentials Compliance", category: "Compliance", icon: "🎓",
    desc: "ECE, Criminal Record Check, First Aid, TB, immunization status per staff. Inspection-ready format." },
  { to: "/reports/drills", title: "Emergency Drill Log", category: "Compliance", icon: "🚨",
    desc: "Fire, earthquake and lockdown drill history. BC CCLR requires monthly fire drills." },
  { to: "/reports/agm", title: "AGM / Board Package", category: "Governance", icon: "🏛",
    desc: "Multi-year enrollment trends, revenue by year, subsidies received. For the Society's Annual General Meeting." },
  { to: "/expenses/reports", title: "Expense Reports (P&L)", category: "Financial", icon: "💵",
    desc: "Revenue vs Expenses — monthly, quarterly and yearly. P&L summary with category breakdown." },
];

const CATEGORY_ORDER: ReportCard["category"][] = ["Financial", "Compliance", "Governance"];

export default function Overview() {
  const nav = useNavigate();
  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <h1 style={{ marginTop: 0 }}>Reports & Compliance</h1>
      <p style={{ color: "var(--muted)", marginTop: -8 }}>
        All reports for financial management, BC Child Care Licensing inspections, CRA reporting, and the Society's AGM.
        Everything prints or exports.
      </p>

      {CATEGORY_ORDER.map((cat) => (
        <section key={cat} style={{ marginTop: 24 }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 14, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--muted)" }}>{cat}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
            {REPORTS.filter((r) => r.category === cat).map((r) => (
              <button
                key={r.to}
                onClick={() => nav(r.to)}
                className="card"
                style={{ padding: 16, textAlign: "left", cursor: "pointer", border: "1px solid var(--border)", background: "#fff" }}
              >
                <div style={{ fontSize: 24, marginBottom: 6 }}>{r.icon}</div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{r.title}</div>
                <div style={{ fontSize: 13, color: "var(--muted)" }}>{r.desc}</div>
              </button>
            ))}
          </div>
        </section>
      ))}

      <section style={{ marginTop: 32, padding: 16, background: "#fef3c7", borderRadius: 8, color: "#78350f" }}>
        <h3 style={{ marginTop: 0 }}>Reports not yet available</h3>
        <p style={{ margin: "0 0 8px" }}>
          These are useful for a BC non-profit daycare but require data the app doesn't collect yet. If any become priority, ask and we'll add the fields:
        </p>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li><strong>Age-group ratio compliance</strong> — needs date of birth on students</li>
          <li><strong>Immunization status</strong> — needs immunization records per child</li>
          <li><strong>Injury & incident log</strong> — needs an incident-tracking table</li>
          <li><strong>Medication administration log</strong> — needs a medication log table</li>
          <li><strong>CCOF monthly enrollment</strong> — needs program-type field (Infant/Toddler / 3-5 / OSC) per child</li>
          <li><strong>T3010 charity return support</strong> — needs full income & expense ledger (bookkeeping, not a receipts app)</li>
        </ul>
      </section>
    </div>
  );
}
