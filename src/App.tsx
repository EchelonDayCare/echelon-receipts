import { HashRouter, NavLink, Route, Routes, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState, lazy, Suspense, type ReactElement } from "react";
import Home from "./screens/Home";
import AppGate from "./components/AppGate";
const Today = lazy(() => import("./screens/Today"));
const ThisMonth = lazy(() => import("./screens/ThisMonth"));
const NewReceipt = lazy(() => import("./screens/NewReceipt"));
const History = lazy(() => import("./screens/History"));
const Students = lazy(() => import("./screens/Students"));
const Reports = lazy(() => import("./screens/Reports"));
const AnnualReceipts = lazy(() => import("./screens/AnnualReceipts"));
const MonthlyAttendance = lazy(() => import("./screens/MonthlyAttendance"));
const AgingReport = lazy(() => import("./screens/AgingReport"));
const StaffScreen = lazy(() => import("./screens/Staff"));
const StaffCredentials = lazy(() => import("./screens/StaffCredentials"));
const Settings = lazy(() => import("./screens/Settings"));
const CommsCompose = lazy(() => import("./screens/comms/Compose"));
const CommsTemplates = lazy(() => import("./screens/comms/Templates"));
const CommsHistory = lazy(() => import("./screens/comms/History"));
const CommsDirectory = lazy(() => import("./screens/comms/Directory"));
const CommsScheduled = lazy(() => import("./screens/comms/Scheduled"));
const ReportsOverview = lazy(() => import("./screens/reports/Overview"));
const EnrollmentRoster = lazy(() => import("./screens/reports/EnrollmentRoster"));
const AttendanceSummary = lazy(() => import("./screens/reports/AttendanceSummary"));
const CredentialsCompliance = lazy(() => import("./screens/reports/CredentialsCompliance"));
const DrillLog = lazy(() => import("./screens/reports/DrillLog"));
const SubsidyReport = lazy(() => import("./screens/reports/Subsidy"));
const AgmPackage = lazy(() => import("./screens/reports/Agm"));
const ExpensesDashboard = lazy(() => import("./screens/expenses/Dashboard"));
const ExpenseForm = lazy(() => import("./screens/expenses/ExpenseForm"));
const ExpenseList = lazy(() => import("./screens/expenses/ExpenseList"));
const ExpenseRecurring = lazy(() => import("./screens/expenses/Recurring"));
const ExpenseReports = lazy(() => import("./screens/expenses/Reports"));
const ExpenseImport = lazy(() => import("./screens/expenses/ImportStatement"));
const AskEchelon = lazy(() => import("./screens/AskEchelon"));
const WaitlistOverview = lazy(() => import("./screens/waitlist/Overview"));
const WaitlistList = lazy(() => import("./screens/waitlist/List"));
const WaitlistEnrolled = lazy(() => import("./screens/waitlist/Enrolled"));
const WaitlistArchived = lazy(() => import("./screens/waitlist/Archived"));
const VaultLibrary = lazy(() => import("./screens/vault/Library"));
const StaffSchedule = lazy(() => import("./screens/staff/Schedule"));
const StaffMeetings = lazy(() => import("./screens/staff/Meetings"));
const OrganizerScreen = lazy(() => import("./screens/organizer/Organizer"));
const OrganizerNotes = lazy(() => import("./screens/organizer/Notes"));
const NotificationsHistory = lazy(() => import("./screens/Notifications"));
const Deposits = lazy(() => import("./screens/Deposits"));
const Graduation = lazy(() => import("./screens/Graduation"));
import { runCloudBackupIfDue } from "./lib/cloudBackup";
import { getSettings } from "./lib/db";
import { getVersion } from "@tauri-apps/api/app";
import { DEFAULT_LOGO_DATA_URL } from "./lib/defaults";
import PromptHost from "./components/PromptHost";
import NotificationBell from "./components/NotificationBell";
import SettingsFab from "./components/SettingsFab";
import AlertDot from "./components/AlertDot";
import { HomeAlertsProvider, useHomeAlerts } from "./hooks/useHomeAlerts";
import { startScheduler, stopScheduler, runScanSoon } from "./lib/notifications/scheduler";
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
  items: { to: string; label: string; match?: (path: string, search: string) => boolean; header?: boolean }[];
}) {
  const nav = useNavigate();
  const [ver, setVer] = useState("");
  const loc = useLocation();
  const { snapshot: alertSnap } = useHomeAlerts();
  useEffect(() => { getVersion().then(setVer).catch(() => setVer("")); }, []);
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">
          <img src={logo} alt="Logo" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="brand-name" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
          <div className="brand-sub" style={{ color: accent }}>{title}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => nav("/")}
        title="Back to Home"
        style={{
          margin: "14px 0 6px",
          background: "rgba(148,163,184,.12)",
          border: "1px solid rgba(148,163,184,.25)",
          color: "#e2e8f0", cursor: "pointer",
          padding: "8px 12px", borderRadius: 8, fontSize: 13,
          display: "flex", alignItems: "center", gap: 8,
          transition: "background .1s, border-color .1s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(148,163,184,.22)";
          (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(148,163,184,.4)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(148,163,184,.12)";
          (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(148,163,184,.25)";
        }}
      >
        <span aria-hidden style={{ fontSize: 15 }}>⌂</span>
        <span>Home</span>
      </button>
      <nav>
        {items.map((it) => {
          if (it.header) {
            return (
              <div
                key={`h-${it.label}`}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  color: "rgba(148,163,184,.75)",
                  padding: "14px 12px 4px",
                }}
              >
                {it.label}
              </div>
            );
          }
          const isActive = it.match
            ? it.match(loc.pathname, loc.search)
            : loc.pathname === it.to.split("?")[0] && loc.search === (it.to.includes("?") ? "?" + it.to.split("?")[1] : "");
          const badge = alertSnap.bySidebar[it.to];
          return (
            <NavLink
              key={it.to}
              to={it.to}
              end
              // Function form disables react-router's built-in `active` class,
              // which would otherwise also mark siblings with the same pathname
              // active (e.g. /vault and /vault?expiring=60).
              className={() => "nav-item" + (isActive ? " active" : "")}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
            >
              <span>{it.label}</span>
              {badge && (
                <AlertDot
                  tone={badge.tone}
                  size="sm"
                  count={badge.count}
                  title={badge.items.map((i) => `• ${i.text}`).join("\n")}
                />
              )}
            </NavLink>
          );
        })}
      </nav>
      <div className="sidebar-foot">{ver ? `v${ver}` : ""}</div>
    </aside>
  );
}

function Shell({ logo, name, staffEnabled }: { logo: string; name: string; staffEnabled: boolean }) {
  const location = useLocation();
  const path = location.pathname;
  const isHome = path === "/" || path === "";

  if (isHome) {
    return (
      <>
        <div style={{ position: "fixed", top: 20, right: 28, zIndex: 900 }}>
          <NotificationBell size={40} />
        </div>
        <SettingsFab />
        <main className="content content-home">
          <Home />
        </main>
      </>
    );
  }

  // Notifications history: give it its own ModuleSidebar so it matches
  // the rest of the app visually. We still don't put it in the Home grid;
  // the bell footer is the only way in.
  if (path === "/notifications" || path.startsWith("/notifications/")) {
    return (
      <div className="app">
        <ModuleSidebar
          title="Notifications"
          accent="#7c3aed"
          logo={logo}
          name={name}
          items={[
            { to: "/notifications", label: "All", match: (p, s) => p === "/notifications" && !s.includes("category=") },

            { to: "", label: "Priority", header: true },
            { to: "/notifications?category=staff_credential_expiring", label: "Staff credentials", match: (p, s) => p === "/notifications" && s.includes("category=staff_credential") },
            { to: "/notifications?category=drill_overdue", label: "Drills", match: (p, s) => p === "/notifications" && s.includes("category=drill_overdue") },

            { to: "", label: "Compliance", header: true },
            { to: "/notifications?category=document_expiring", label: "Vault documents", match: (p, s) => p === "/notifications" && s.includes("category=document_") },
            { to: "/notifications?category=agm_deadline", label: "AGM deadline", match: (p, s) => p === "/notifications" && s.includes("category=agm_deadline") },
            { to: "/notifications?category=tslip_deadline", label: "T-slip deadline", match: (p, s) => p === "/notifications" && s.includes("category=tslip_deadline") },
            { to: "/notifications?category=ccfri_claim_due", label: "CCFRI claims", match: (p, s) => p === "/notifications" && s.includes("category=ccfri_claim_due") },

            { to: "", label: "Operations", header: true },
            { to: "/notifications?category=receipt_aging", label: "Receipts", match: (p, s) => p === "/notifications" && s.includes("category=receipt_aging") },
            { to: "/notifications?category=schedule_not_published", label: "Schedule", match: (p, s) => p === "/notifications" && s.includes("category=schedule_") },
            { to: "/notifications?category=meeting_action_due", label: "Meetings & follow-ups", match: (p, s) => p === "/notifications" && (s.includes("category=meeting_") || s.includes("category=followup_")) },
            { to: "/notifications?category=waitlist_new_application", label: "Waitlist", match: (p, s) => p === "/notifications" && s.includes("category=waitlist_") },

            { to: "", label: "System", header: true },
            { to: "/notifications?category=backup_stale", label: "Backups", match: (p, s) => p === "/notifications" && s.includes("category=backup_") },
            { to: "/notifications?category=system_error", label: "System errors", match: (p, s) => p === "/notifications" && s.includes("category=system_error") },
          ]}
        />
        <main className="content">
          <Suspense fallback={<div style={{ padding: 24, color: "var(--muted)" }}>Loading…</div>}>
            <Routes>
              <Route path="/notifications" element={<NotificationsHistory />} />
            </Routes>
          </Suspense>
        </main>
      </div>
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
          { to: "/students/annual", label: "Annual Tax Receipts" },
          { to: "/students/deposits", label: "Bank Deposits" },
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
          { to: "/staff/schedule", label: "Schedule", match: (p) => p.startsWith("/staff/schedule") },
          { to: "/staff/credentials", label: "Credentials" },
          { to: "/staff/meetings", label: "Meeting Notes" },
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
          { to: "/config/folders", label: "Folders" },
          { to: "/config/staff", label: "Staff" },
          { to: "/config/backups", label: "Backups" },
          { to: "/config/security", label: "Security" },
          { to: "/config/holidays", label: "Stat Holidays" },
          { to: "/config/notifications", label: "Notifications" },
          { to: "/config/waitlist", label: "Waitlist" },
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
  } else if (path.startsWith("/reports")) {
    sidebar = (
      <ModuleSidebar
        title="Reports & Compliance"
        accent="#0369a1"
        logo={logo}
        name={name}
        items={[
          { to: "/reports/overview", label: "Overview" },
          { to: "/reports/monthly", label: "Monthly Revenue" },
          { to: "/reports/aging", label: "Aging (A/R)" },
          { to: "/reports/subsidy", label: "Subsidy Reconciliation" },
          { to: "/reports/enrollment", label: "Enrollment Roster" },
          { to: "/reports/attendance", label: "Attendance Analytics" },
          { to: "/reports/credentials", label: "Staff Credentials" },
          { to: "/reports/drills", label: "Drill Log" },
          { to: "/reports/agm", label: "AGM / Board Package" },
        ]}
      />
    );
  } else if (path.startsWith("/graduation")) {
    sidebar = (
      <ModuleSidebar
        title="Graduation Day"
        accent="#c2410c"
        logo={logo}
        name={name}
        items={[{ to: "/graduation", label: "Render Year-End Content" }]}
      />
    );
  } else if (path.startsWith("/expenses")) {
    sidebar = (
      <ModuleSidebar
        title="Expenses"
        accent="#047857"
        logo={logo}
        name={name}
        items={[
          { to: "/expenses/dashboard", label: "Dashboard" },
          { to: "/expenses/new", label: "Add Expense" },
          { to: "/expenses/list", label: "All Expenses" },
          { to: "/expenses/recurring", label: "Recurring Bills" },
          { to: "/expenses/import", label: "Import Statement (AI)" },
          { to: "/expenses/reports", label: "Expense Reports (P&L)" },
        ]}
      />
    );
  } else if (path.startsWith("/ask")) {
    sidebar = (
      <ModuleSidebar
        title="Ask Echelon"
        accent="#2563eb"
        logo={logo}
        name={name}
        items={[
          { to: "/ask", label: "Ask a Question" },
        ]}
      />
    );
  } else if (path.startsWith("/waitlist")) {
    sidebar = (
      <ModuleSidebar
        title="Waitlist"
        accent="#7c3aed"
        logo={logo}
        name={name}
        items={[
          { to: "/waitlist", label: "Overview" },
          { to: "/waitlist/list", label: "All Applications" },
          { to: "/waitlist/enrolled", label: "Enrolled" },
          { to: "/waitlist/archived", label: "Archived" },
          { to: "/config/waitlist", label: "Settings ↗" },
        ]}
      />
    );
  } else if (path.startsWith("/organizer")) {
    sidebar = (
      <ModuleSidebar
        title="Organizer"
        accent="#e11d48"
        logo={logo}
        name={name}
        items={[
          { to: "/organizer", label: "Dashboard" },
          { to: "/organizer/notes", label: "Notes" },
        ]}
      />
    );
  } else if (path.startsWith("/vault")) {
    sidebar = (
      <ModuleSidebar
        title="Document Vault"
        accent="#0d9488"
        logo={logo}
        name={name}
        items={[
          { to: "/vault", label: "Library", match: (p, s) => p === "/vault" && !s.includes("expiring=") },
          { to: "/vault?expiring=60", label: "Expiring soon", match: (p, s) => p === "/vault" && s.includes("expiring=") },
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
          <Route path="/students/attendance" element={<MonthlyAttendance />} />
          <Route path="/students/history" element={<History />} />
          <Route path="/students/roster" element={<Students />} />
          <Route path="/students/reports" element={<Reports />} />
          <Route path="/students/aging" element={<AgingReport />} />
          <Route path="/students/annual" element={<AnnualReceipts />} />
          <Route path="/students/deposits" element={<Deposits />} />

          {/* Staff module. Routes are mounted unconditionally so that a
              race between the settings load (staffEnabled state) and a
              user click on the Staff tile doesn't briefly flash the
              module then bounce to "/" via the "*" catch-all. The
              feature-flag gate lives at the entry points (Home tile,
              /staff redirect below) and inside the screens themselves. */}
          <Route path="/staff" element={<Navigate to={staffEnabled ? "/staff/hours" : "/config/staff"} replace />} />
          <Route path="/staff/hours" element={<StaffScreen />} />
          <Route path="/staff/schedule" element={<StaffSchedule />} />
          <Route path="/staff/credentials" element={<StaffCredentials />} />
          <Route path="/staff/meetings" element={<StaffMeetings />} />

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

          {/* Reports & Compliance module */}
          <Route path="/reports" element={<Navigate to="/reports/overview" replace />} />
          <Route path="/reports/overview" element={<ReportsOverview />} />
          <Route path="/reports/monthly" element={<Reports />} />
          <Route path="/reports/aging" element={<AgingReport />} />
          <Route path="/reports/subsidy" element={<SubsidyReport />} />
          <Route path="/reports/enrollment" element={<EnrollmentRoster />} />
          <Route path="/reports/attendance" element={<AttendanceSummary />} />
          <Route path="/reports/credentials" element={<CredentialsCompliance />} />
          <Route path="/reports/drills" element={<DrillLog />} />
          <Route path="/reports/agm" element={<AgmPackage />} />

          {/* Expenses module */}
          <Route path="/expenses" element={<Navigate to="/expenses/dashboard" replace />} />
          <Route path="/expenses/dashboard" element={<ExpensesDashboard />} />
          <Route path="/expenses/new" element={<ExpenseForm />} />
          <Route path="/expenses/edit/:id" element={<ExpenseForm />} />
          <Route path="/expenses/list" element={<ExpenseList />} />
          <Route path="/expenses/recurring" element={<ExpenseRecurring />} />
          <Route path="/expenses/import" element={<ExpenseImport />} />
          <Route path="/expenses/reports" element={<ExpenseReports />} />

          {/* Ask Echelon (natural-language query) */}
          <Route path="/ask" element={<AskEchelon />} />

          {/* Waitlist module (v0.8.0) */}
          <Route path="/waitlist" element={<WaitlistOverview />} />
          <Route path="/waitlist/list" element={<WaitlistList />} />
          <Route path="/waitlist/enrolled" element={<WaitlistEnrolled />} />
          <Route path="/waitlist/archived" element={<WaitlistArchived />} />
          <Route path="/waitlist/settings" element={<Navigate to="/config/waitlist" replace />} />

          {/* Document Vault module (v1.1.0) */}
          <Route path="/vault" element={<VaultLibrary />} />

          {/* Organizer */}
          <Route path="/organizer" element={<OrganizerScreen />} />
          <Route path="/organizer/notes" element={<OrganizerNotes />} />

          {/* Notifications history — accessible only via the bell footer */}
          <Route path="/notifications" element={<NotificationsHistory />} />
          <Route path="/graduation" element={<Graduation />} />

          {/* Redirects for old Students routes now moved to Reports module */}
          <Route path="/students/reports" element={<Navigate to="/reports/monthly" replace />} />
          <Route path="/students/aging" element={<Navigate to="/reports/aging" replace />} />

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

    // Notification Bell (v1.5.0) — 10-minute scan loop + first scan shortly
    // after mount. Also re-scan on tab focus so the badge reflects reality
    // when the owner returns after a break.
    startScheduler();
    const onFocus = () => { void runScanSoon(); };
    window.addEventListener("focus", onFocus);

    // Fire any due scheduled messages on app launch and every 15 min thereafter,
    // so a session that stays open through the scheduled time still delivers.
    (async () => {
      try {
        const { runDueScheduled } = await import("./lib/comms");
        const settings = await getSettings();
        const res = await runDueScheduled(settings);
        if (res.attempted > 0) {
          console.log(`[scheduled] attempted=${res.attempted} sent=${res.sent} failed=${res.failed}`);
        }
      } catch (e) { console.warn("[scheduled] startup run failed:", e); }
    })();
    const schedTimer = window.setInterval(async () => {
      try {
        const { runDueScheduled } = await import("./lib/comms");
        const settings = await getSettings();
        await runDueScheduled(settings);
      } catch { /* silent — visible in the Scheduled screen if it recurs */ }
    }, 15 * 60 * 1000);

    // Waitlist auto-sync is intentionally NOT started here (v1.0.1). It is
    // kicked off lazily the first time a /waitlist/* screen mounts, so that
    // fresh installs — where the module has never been opened — don't touch
    // the Rust waitlist command (and therefore the macOS Keychain) at boot.
    // See src/screens/waitlist/*.tsx for the trigger.

    return () => {
      window.removeEventListener("settings-saved", onSaved);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(schedTimer);
      stopScheduler();
    };
  }, []);

  return (
    <AppGate>
      <HashRouter>
        <HomeAlertsProvider>
          <PromptHost />
          <Routes>
            <Route path="/*" element={<Shell logo={logo} name={name} staffEnabled={staffEnabled} />} />
          </Routes>
        </HomeAlertsProvider>
      </HashRouter>
    </AppGate>
  );
}
