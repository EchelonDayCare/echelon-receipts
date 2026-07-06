// H-14: shared sub-nav for the three Staff Schedule screens. These used to
// be peer top-level entries in the Staff sidebar (Schedule / Schedule Audit
// / Confirmations); moved here as in-page tabs since they're really one
// module with three views, not three separate destinations.
import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/staff/schedule", label: "Week grid", end: true },
  { to: "/staff/schedule/audit", label: "Audit" },
  { to: "/staff/schedule/confirmations", label: "Confirmations" },
];

export default function ScheduleSubNav() {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 16, borderBottom: "1px solid var(--border, #1e293b)", paddingBottom: 10 }}>
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) => "btn" + (isActive ? " primary" : "")}
          style={{ fontSize: 12, textDecoration: "none" }}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}
