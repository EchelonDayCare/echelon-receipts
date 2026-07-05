import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { db, getSettings, listStudents } from "../lib/db";
import { listAllCredentialsWithStaff, credStatus } from "../lib/credentials";
import { DEFAULT_LOGO_DATA_URL } from "../lib/defaults";
import { checkForUpdates, type UpdateStatus } from "../lib/updateCheck";
import type { SettingsMap } from "../types";

interface Alert {
  tone: "danger" | "warn" | "info";
  text: string;
  cta?: { label: string; to: string };
}

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export default function Home() {
  const nav = useNavigate();
  const [s, setS] = useState<SettingsMap>({});
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [staffEnabled, setStaffEnabled] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");

  useEffect(() => {
    (async () => {
      const settings = await getSettings();
      setS(settings);
      setStaffEnabled(settings.feature_staff_hours_enabled === "1");

      const list: Alert[] = [];
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth() + 1;
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      try {
        const d = await db();
        const [total, issued] = await Promise.all([
          listStudents(y, true),
          d.select<{ n: number }[]>(
            `SELECT COUNT(DISTINCT student_id) AS n
               FROM receipts
              WHERE substr(date,1,7) = ?
                AND voided = 0
                AND is_refund = 0`,
            [ym]
          ),
        ]);
        const issuedCount = issued[0]?.n ?? 0;
        const missing = total.length - issuedCount;
        if (missing > 0) {
          list.push({
            tone: "warn",
            text: `${missing} of ${total.length} students don't yet have a receipt for ${now.toLocaleString(undefined, { month: "long", year: "numeric" })}.`,
            cta: { label: "Issue receipts", to: "/students/month" },
          });
        }
      } catch {}

      // Cloud backup overdue
      const sinceCloud = daysSince(settings.last_cloud_backup_at);
      if (settings.backup_cloud_enabled !== "0") {
        if (sinceCloud == null) {
          list.push({
            tone: "warn",
            text: "Cloud backup not configured yet — your data isn't being emailed anywhere.",
            cta: { label: "Set up backup", to: "/config/backups" },
          });
        } else if (sinceCloud > 35) {
          list.push({
            tone: "danger",
            text: `Last cloud backup was ${sinceCloud} days ago — overdue.`,
            cta: { label: "Back up now", to: "/config/backups" },
          });
        }
      }

      // SMTP not set up
      if (!settings.smtp_host?.trim() || settings.smtp_password_set !== "1") {
        list.push({
          tone: "warn",
          text: "Email isn't configured — receipts can be saved but not emailed.",
          cta: { label: "Set up email", to: "/config/email" },
        });
      }

      // Staff credential expiries (only when feature is on)
      if (settings.feature_staff_hours_enabled === "1") {
        try {
          const alertDays = Number(settings.staff_cred_alert_days || "60");
          const creds = await listAllCredentialsWithStaff();
          let expired = 0, expiring = 0;
          for (const c of creds) {
            const st = credStatus(c.expiry_date, alertDays);
            if (st === "expired") expired++;
            else if (st === "expiring") expiring++;
          }
          if (expired > 0) {
            list.push({
              tone: "danger",
              text: `${expired} staff credential${expired === 1 ? " has" : "s have"} expired.`,
              cta: { label: "Review credentials", to: "/staff/credentials" },
            });
          }
          if (expiring > 0) {
            list.push({
              tone: "warn",
              text: `${expiring} staff credential${expiring === 1 ? "" : "s"} expir${expiring === 1 ? "es" : "e"} in the next ${alertDays} days.`,
              cta: { label: "Review credentials", to: "/staff/credentials" },
            });
          }
        } catch {}
      }

      // Staff cert tracker placeholder (Phase 1 not built yet — skip until built)

      // Scheduled messages due
      try {
        const { dueScheduled } = await import("../lib/comms");
        const due = await dueScheduled();
        if (due.length > 0) {
          list.push({
            tone: "info",
            text: `${due.length} scheduled message${due.length === 1 ? " is" : "s are"} ready to send.`,
            cta: { label: "Review & send", to: "/communications/scheduled" },
          });
        }
      } catch {}

      setAlerts(list);
    })();

    // Read the real Cargo version at runtime and use it for both the footer
    // and the update-check gating (hardcoding was showing v0.1.0 and turning
    // every release into a "downgrade" prompt).
    (async () => {
      try {
        const v = await getVersion();
        setAppVersion(v);
        const u = await checkForUpdates(v);
        if (u.hasUpdate) setUpdate(u);
      } catch {
        // On non-tauri builds (never in production) fall back silently.
      }
    })();
  }, []);

  const daycareName = s.daycare_name || "Echelon Daycare";
  const logo = s.logo_data_url || DEFAULT_LOGO_DATA_URL;

  return (
    <div className="home">
      <header className="home-head">
        <img src={logo} alt="Logo" className="home-logo" />
        <div>
          <h1 style={{ margin: 0 }}>{daycareName}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>
      </header>

      <div className="home-tiles">
        <button className="home-tile students" onClick={() => nav("/students/today")}>
          <div className="home-tile-icon">👶</div>
          <h2>Students</h2>
          <p>Receipts, subsidies, annual tax receipts, roster</p>
        </button>

        <button className="home-tile staff" onClick={() => nav(staffEnabled ? "/staff/hours" : "/config/staff")}>
          <div className="home-tile-icon">👩‍🏫</div>
          <h2>Staff{staffEnabled ? "" : " (disabled)"}</h2>
          <p>{staffEnabled ? "Hours, credentials, drill log, payroll prep" : "Turn on in Configuration → Staff to enable."}</p>
        </button>

        <button className="home-tile comms" onClick={() => nav("/communications/compose")}>
          <div className="home-tile-icon">✉️</div>
          <h2>Communications</h2>
          <p>Group email, templates, message history, contact directory</p>
        </button>

        <button className="home-tile expenses" onClick={() => nav("/expenses/dashboard")}>
          <div className="home-tile-icon">💵</div>
          <h2>Expenses</h2>
          <p>Track spending, recurring bills, WCB/CRA remittance, P&L reports</p>
        </button>

        <button className="home-tile reports" onClick={() => nav("/reports/overview")}>
          <div className="home-tile-icon">📊</div>
          <h2>Reports & Compliance</h2>
          <p>Revenue, aging, subsidies, licensing rosters, credentials, drills, AGM</p>
        </button>

        <button className="home-tile config" onClick={() => nav("/config/identity")}>
          <div className="home-tile-icon">⚙️</div>
          <h2>Configuration</h2>
          <p>Daycare identity, email, backups, optional features</p>
        </button>

        <button className="home-tile" onClick={() => nav("/ask")} style={{ background: "linear-gradient(135deg, #eff6ff, #dbeafe)" }}>
          <div className="home-tile-icon">🤖</div>
          <h2>Ask Echelon</h2>
          <p>Plain-English questions about your data — attendance, revenue, staff, credentials</p>
        </button>
      </div>

      {alerts.length > 0 && (
        <section className="home-alerts">
          <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>
            Needs your attention
          </h3>
          {alerts.map((a, i) => (
            <div key={i} className={`home-alert tone-${a.tone}`}>
              <span>{a.text}</span>
              {a.cta && (
                <button className="btn link" onClick={() => nav(a.cta!.to)}>
                  {a.cta.label} →
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {update?.hasUpdate && (
        <div className="home-alert tone-info" style={{ marginTop: 12 }}>
          <span>
            <strong>Update available:</strong> {update.latest} (you have v{update.current}).
          </span>
          <button className="btn link" onClick={() => update.url && void openUrl(update.url)}>
            Download →
          </button>
        </div>
      )}

      <footer className="home-foot">
        <span>{appVersion ? `v${appVersion} · ` : ""}Echelon Receipts</span>
      </footer>
    </div>
  );
}
