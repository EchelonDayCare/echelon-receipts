import { HashRouter, NavLink, Route, Routes, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import Today from "./screens/Today";
import ThisMonth from "./screens/ThisMonth";
import NewReceipt from "./screens/NewReceipt";
import History from "./screens/History";
import Students from "./screens/Students";
import Reports from "./screens/Reports";
import AnnualReceipts from "./screens/AnnualReceipts";
import StaffScreen from "./screens/Staff";
import Settings from "./screens/Settings";
import { runCloudBackupIfDue } from "./lib/cloudBackup";
import { getSettings } from "./lib/db";
import { DEFAULT_LOGO_DATA_URL } from "./lib/defaults";
import "./App.css";

export default function App() {
  const [logo, setLogo] = useState<string>(DEFAULT_LOGO_DATA_URL);
  const [name, setName] = useState<string>("Echelon");
  const [staffEnabled, setStaffEnabled] = useState(false);
  useEffect(() => {
    getSettings().then((s) => {
      if (s.logo_data_url) setLogo(s.logo_data_url);
      if (s.daycare_name) setName(s.daycare_name.replace(/\s+Society$/i, "").trim() || s.daycare_name);
      setStaffEnabled(s.feature_staff_hours_enabled === "1");
    });
    // Fire-and-forget monthly backup check on app start.
    runCloudBackupIfDue().then((res) => {
      if (res?.ok) {
        console.log(`[backup] Monthly backup emailed for ${res.monthKey} (${(res.bytes / 1024).toFixed(1)} KB)`);
      } else if (res?.error) {
        console.warn(`[backup] Skipped: ${res.error}`);
      }
    });
  }, []);
  return (
    <HashRouter>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-logo">
              <img src={logo} alt="Logo" />
            </div>
            <div>
              <div className="brand-name">{name}</div>
              <div className="brand-sub">Receipts</div>
            </div>
          </div>
          <nav>
            <NavLink to="/today" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Today</NavLink>
            <NavLink to="/month" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>This Month</NavLink>
            <NavLink to="/new" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>New Receipt</NavLink>
            <NavLink to="/history" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Receipt History</NavLink>
            <NavLink to="/students" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Students</NavLink>
            <NavLink to="/reports" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Reports</NavLink>
            <NavLink to="/annual" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Annual Tax Receipts</NavLink>
            {staffEnabled && <NavLink to="/staff" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Staff Hours</NavLink>}
            <NavLink to="/settings" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Settings</NavLink>
          </nav>
          <div className="sidebar-foot">v0.1.0</div>
        </aside>
        <main className="content">
          <Routes>
            <Route path="/" element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<Today />} />
            <Route path="/month" element={<ThisMonth />} />
            <Route path="/new" element={<NewReceipt />} />
            <Route path="/history" element={<History />} />
            <Route path="/students" element={<Students />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/annual" element={<AnnualReceipts />} />
            {staffEnabled && <Route path="/staff" element={<StaffScreen />} />}
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
