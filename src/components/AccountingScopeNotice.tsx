import { Link } from "react-router-dom";

export default function AccountingScopeNotice() {
  return <p className="no-print" style={{ padding: "12px 16px", background: "var(--panel)", border: "1px solid var(--border)", lineHeight: 1.5 }}>
    <strong>Report scope:</strong> existing receipt, subsidy, purchase and AGM screens show operational records.
    Statement-created purchases also appear in Expenses, but operational summaries do not include all income, adjustments or bank clearance.
    Use <Link to="/expenses/accounting">Finance → Accounting Reports</Link> for ledger-based cash P&amp;L,
    reconciliation warnings and journal drill-down. Bank cash movement is not profit.
  </p>;
}
