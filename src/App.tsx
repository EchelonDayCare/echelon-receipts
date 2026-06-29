import { HashRouter, NavLink, Route, Routes, Navigate } from "react-router-dom";
import Today from "./screens/Today";
import NewReceipt from "./screens/NewReceipt";
import History from "./screens/History";
import Students from "./screens/Students";
import Reports from "./screens/Reports";
import AnnualReceipts from "./screens/AnnualReceipts";
import Settings from "./screens/Settings";
import "./App.css";

export default function App() {
  return (
    <HashRouter>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-logo">🧸</div>
            <div>
              <div className="brand-name">Echelon</div>
              <div className="brand-sub">Receipts</div>
            </div>
          </div>
          <nav>
            <NavLink to="/today" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Today</NavLink>
            <NavLink to="/new" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>New Receipt</NavLink>
            <NavLink to="/history" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Receipt History</NavLink>
            <NavLink to="/students" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Students</NavLink>
            <NavLink to="/reports" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Reports</NavLink>
            <NavLink to="/annual" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Annual Tax Receipts</NavLink>
            <NavLink to="/settings" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>Settings</NavLink>
          </nav>
          <div className="sidebar-foot">v0.1.0</div>
        </aside>
        <main className="content">
          <Routes>
            <Route path="/" element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<Today />} />
            <Route path="/new" element={<NewReceipt />} />
            <Route path="/history" element={<History />} />
            <Route path="/students" element={<Students />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/annual" element={<AnnualReceipts />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
