import { HashRouter, NavLink, Route, Routes, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState, lazy, Suspense, type ReactElement } from "react";
import Home from "./screens/Home";
const Today = lazy(() => import("./screens/Today"));
const ThisMonth = lazy(() => import("./screens/ThisMonth"));
const NewReceipt = lazy(() => import("./screens/NewReceipt"));
const History = lazy(() => import("./screens/History"));
const Students = lazy(() => import("./screens/Students"));
const Reports = lazy(() => import("./screens/Reports"));
const AnnualReceipts = lazy(() => import("./screens/AnnualReceipts"));
const Attendance = lazy(() => import("./screens/Attendance"));
const AgingReport = lazy(() => import("./screens/AgingReport"));
const StaffScreen = lazy(() => import("./screens/Staff"));
const StaffCredentials = lazy(() => import("./screens/StaffCredentials"));
const Settings = lazy(() => import("./screens/Settings"));
const CommsCompose = lazy(() => import("./screens/comms/Compose"));
const CommsTemplates = lazy(() => import("./screens/comms/Templates"));
const CommsHistory = lazy(() => import("./screens/comms/History"));
const CommsDirectory = lazy(() => import("./screens/comms/Directory"));
const CommsScheduled = lazy(() => import("./screens/comms/Scheduled"));
import { runCloudBackupIfDue } from "./lib/cloudBackup";
import { getSettings } from "./lib/db";
import { DEFAULT_LOGO_DATA_URL } from "./lib/defaults";
import PromptHost from "./components/PromptHost";
import "./App.css";

function ModuleSidebar({
  title,
  accent,
  logo,
  name,
  items,
}: {
  title: string;
  accent: string;
  logo: string;
  name: string;
  items: { to: string; label: string }[];
}) {
  const nav = useNavigate();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">
          <img src={logo} alt="Logo" />
        </div>
        <div>
          <div className="brand-name">{name}</div>
          <div className="brand-sub" style={{ color: accent }}>{title}</div>
        </div>
      </div>
      <button
        className="nav-item"
        onClick={() => nav("/")}
        style={{ background: "transparent", border: "none", textAlign: "left", cursor: "pointer", color: "var(--muted)", marginBottom: 8 }}
      >
        ← Home
      </button>
      <nav>
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
          >
            {it.label}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-foot">v0.1.0</div>
    </aside>
  );
}

function Shell({ logo, name, staffEnabled }: { logo: string; name: string; staffEnabled: boolean }) {
  const location = useLocation();
  const path = location.pathname;
  const isHome = path === "/" || path === "";

  if (isHome) {
    return (
      <main className="content content-home">
        <Home />
      </main>
    );
  }

  let sidebar: ReactElement | null = null;
  if (path.startsWith("/students")) {
    sidebar = (
      <ModuleSidebar
        title="Students"
        accent="#2563eb"
        logo={logo}
        name={name}
        items={[
          { to: "/students/today", label: "Today" },
          { to: "/students/month", label: "This Month" },
          { to: "/students/new", label: "New Receipt" },
          { to: "/students/attendance", label: "Attendance" },
          { to: "/students/history", label: "Receipt History" },
          { to: "/students/roster", label: "Roster" },
          { to: "/students/reports", label: "Reports" },
          { to: "/students/aging", label: "Aging (A/R)" },
          { to: "/students/annual", label: "Annual Tax Receipts" },
        ]}
      />
    );
  } else if (path.startsWith("/staff")) {
    sidebar = (
      <ModuleSidebar
        title="Staff"
        accent="#9333ea"
        logo={logo}
        name={name}
        items={[
          { to: "/staff/hours", label: "Hours" },
          { to: "/staff/credentials", label: "Credentials" },
        ]}
      />
    );
  } else if (path.startsWith("/config")) {
    sidebar = (
      <ModuleSidebar
        title="Configuration"
        accent="#0f766e"
        logo={logo}
        name={name}
        items={[
          { to: "/config/identity", label: "Identity" },
          { to: "/config/email", label: "Receipts & Email" },
          { to: "/config/staff", label: "Staff" },
          { to: "/config/backups", label: "Backups" },
          { to: "/config/about", label: "About" },
        ]}
      />
    );
  } else if (path.startsWith("/communications")) {
    sidebar = (
      <ModuleSidebar
        title="Communications"
        accent="#c2410c"
        logo={logo}
        name={name}
        items={[
          { to: "/communications/compose", label: "Compose Group Email" },
          { to: "/communications/templates", label: "Templates" },
          { to: "/communications/history", label: "Message History" },
          { to: "/communications/directory", label: "Contact Directory" },
          { to: "/communications/scheduled", label: "Scheduled" },
        ]}
      />
    );
  }

  return (
    <div className="app">
      {sidebar}
      <main className="content">
        <Suspense fallback={<div style={{ padding: 24, color: "var(--muted)" }}>Loading…</div>}>
          <Routes>
          {/* Students module */}
          <Route path="/students" element={<Navigate to="/students/today" replace />} />
          <Route path="/students/today" element={<Today />} />
          <Route path="/students/month" element={<ThisMonth />} />
          <Route path="/students/new" element={<NewReceipt />} />
          <Route path="/students/attendance" element={<Attendance />} />
          <Route path="/students/history" element={<History />} />
          <Route path="/students/roster" element={<Students />} />
          <Route path="/students/reports" element={<Reports />} />
          <Route path="/students/aging" element={<AgingReport />} />
          <Route path="/students/annual" element={<AnnualReceipts />} />

          {/* Staff module */}
          <Route path="/staff" element={<Navigate to={staffEnabled ? "/staff/hours" : "/config/staff"} replace />} />
          {staffEnabled && <Route path="/staff/hours" element={<StaffScreen />} />}
          {staffEnabled && <Route path="/staff/credentials" element={<StaffCredentials />} />}

          {/* Configuration module */}
          <Route path="/config" element={<Navigate to="/config/identity" replace />} />
          <Route path="/config/:tab" element={<Settings />} />

          {/* Communications module */}
          <Route path="/communications" element={<Navigate to="/communications/compose" replace />} />
          <Route path="/communications/compose" element={<CommsCompose />} />
          <Route path="/communications/templates" element={<CommsTemplates />} />
          <Route path="/communications/history" element={<CommsHistory />} />
          <Route path="/communications/directory" element={<CommsDirectory />} />
          <Route path="/communications/scheduled" element={<CommsScheduled />} />

          {/* Legacy redirects (preserve old hash links) */}
          <Route path="/today" element={<Navigate to="/students/today" replace />} />
          <Route path="/month" element={<Navigate to="/students/month" replace />} />
          <Route path="/new" element={<Navigate to="/students/new" replace />} />
          <Route path="/history" element={<Navigate to="/students/history" replace />} />
          <Route path="/reports" element={<Navigate to="/students/reports" replace />} />
          <Route path="/annual" element={<Navigate to="/students/annual" replace />} />
          <Route path="/settings" element={<Navigate to="/config/identity" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}

export default function App() {
  const [logo, setLogo] = useState<string>(DEFAULT_LOGO_DATA_URL);
  const [name, setName] = useState<string>("Echelon");
  const [staffEnabled, setStaffEnabled] = useState(false);

  useEffect(() => {
    const load = () => {
      getSettings().then((s) => {
        if (s.logo_data_url) setLogo(s.logo_data_url);
        if (s.daycare_name) setName(s.daycare_name.replace(/\s+Society$/i, "").trim() || s.daycare_name);
        setStaffEnabled(s.feature_staff_hours_enabled === "1");
      });
    };
    load();
    const onSaved = () => load();
    window.addEventListener("settings-saved", onSaved);
    runCloudBackupIfDue().then((res) => {
      if (res?.ok) {
        console.log(`[backup] Monthly backup emailed for ${res.monthKey} (${(res.bytes / 1024).toFixed(1)} KB)`);
      } else if (res?.error) {
        console.warn(`[backup] Skipped: ${res.error}`);
      }
    });
    return () => window.removeEventListener("settings-saved", onSaved);
  }, []);

  return (
    <HashRouter>
      <PromptHost />
      <Routes>
        <Route path="/*" element={<Shell logo={logo} name={name} staffEnabled={staffEnabled} />} />
      </Routes>
    </HashRouter>
  );
}
