import { useEffect, useState } from "react";
import { exists } from "@tauri-apps/plugin-fs";
import type { SettingsMap } from "../types";
import { listStudents } from "../lib/db";

interface Check {
  key: string;
  label: string;
  state: "ok" | "warn" | "error";
  detail: string;
}

interface Props {
  settings: SettingsMap;
}

export default function HealthCheck({ settings }: Props) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    const out: Check[] = [];

    // 1. Daycare identity
    if (settings.daycare_name?.trim()) {
      out.push({ key: "daycare", label: "Daycare details", state: "ok",
        detail: `${settings.daycare_name}${settings.business_number ? " · BN " + settings.business_number : ""}` });
    } else {
      out.push({ key: "daycare", label: "Daycare details", state: "error",
        detail: "Daycare name is empty — required on every receipt." });
    }

    // 2. PDF folder
    if (!settings.pdf_folder?.trim()) {
      out.push({ key: "pdf", label: "PDF archive folder", state: "warn",
        detail: "No folder chosen. Receipts open from a temp location and won't be archived." });
    } else {
      try {
        const ok = await exists(settings.pdf_folder);
        out.push({ key: "pdf", label: "PDF archive folder", state: ok ? "ok" : "error",
          detail: ok ? settings.pdf_folder : `Folder not found: ${settings.pdf_folder}` });
      } catch (e: any) {
        out.push({ key: "pdf", label: "PDF archive folder", state: "error",
          detail: `Cannot access folder: ${e?.message || e}` });
      }
    }

    // 2b. Reports folder (AGM Minutes + other generated reports)
    if (!settings.reports_folder?.trim()) {
      out.push({ key: "reports", label: "Reports folder", state: "warn",
        detail: "Not set — AGM Minutes and other generated reports need a home. Pick one in Settings → Folders." });
    } else {
      try {
        const ok = await exists(settings.reports_folder);
        out.push({ key: "reports", label: "Reports folder", state: ok ? "ok" : "error",
          detail: ok ? settings.reports_folder : `Folder not found: ${settings.reports_folder}` });
      } catch (e: any) {
        out.push({ key: "reports", label: "Reports folder", state: "error",
          detail: `Cannot access folder: ${e?.message || e}` });
      }
    }

    // 3. SMTP credentials
    if (!settings.smtp_host?.trim() || !settings.sender_email?.trim()) {
      out.push({ key: "smtp", label: "Email (SMTP)", state: "error",
        detail: "Sender email or SMTP host is missing — receipts can be saved but not emailed." });
    } else {
      const storedPwd = settings.smtp_password_set === "1";
      if (!storedPwd) {
        out.push({ key: "smtp", label: "Email (SMTP)", state: "warn",
          detail: `Host configured (${settings.smtp_host}) but no app password stored. Use 'Send Test Email' below to verify.` });
      } else {
        out.push({ key: "smtp", label: "Email (SMTP)", state: "ok",
          detail: `${settings.smtp_host}:${settings.smtp_port || "587"} · App password saved in OS keychain.` });
      }
    }

    // 4. Students with email
    try {
      const studs = await listStudents(new Date().getFullYear(), true);
      const missing = studs.filter(s => !s.email?.trim()).length;
      if (studs.length === 0) {
        out.push({ key: "students", label: "Active students", state: "warn", detail: "No active students for this year yet." });
      } else if (missing === 0) {
        out.push({ key: "students", label: "Active students", state: "ok",
          detail: `${studs.length} active · all have a parent email on file.` });
      } else {
        out.push({ key: "students", label: "Active students", state: "warn",
          detail: `${studs.length} active · ${missing} missing parent email (you can save receipts but not email them).` });
      }
    } catch (e: any) {
      out.push({ key: "students", label: "Active students", state: "error", detail: `Cannot read students: ${e?.message || e}` });
    }

    // 5. Subsidies (only if enabled)
    if (settings.subsidies_enabled === "1") {
      const gross = parseFloat(settings.gross_monthly_fee || "");
      const ccfri = parseFloat(settings.ccfri_monthly_reduction || "");
      if (!(gross > 0)) {
        out.push({ key: "sub", label: "BC subsidies", state: "error", detail: "Subsidies enabled but Gross Monthly Fee is not set." });
      } else if (!(ccfri >= 0)) {
        out.push({ key: "sub", label: "BC subsidies", state: "warn", detail: "Gross fee set but no CCFRI reduction — fee breakdown will show $0 for CCFRI." });
      } else {
        out.push({ key: "sub", label: "BC subsidies", state: "ok", detail: `Gross $${gross.toFixed(2)} · CCFRI –$${ccfri.toFixed(2)}` });
      }
    } else {
      out.push({ key: "sub", label: "BC subsidies", state: "ok", detail: "Disabled — receipts use a flat amount." });
    }

    // 6. Backup (prefer cloud, fall back to local)
    const lastCloud = settings.last_cloud_backup_at;
    const lastLocal = settings.last_backup_at;
    const last = lastCloud || lastLocal;
    const source = lastCloud ? "cloud" : "local";
    if (!last) {
      out.push({ key: "backup", label: "Database backup", state: "warn", detail: "No backup yet. Cloud backup runs automatically on the first launch of each month — or click 'Back up to email now' below." });
    } else {
      const days = Math.floor((Date.now() - Date.parse(last)) / (1000 * 60 * 60 * 24));
      out.push({
        key: "backup", label: "Database backup",
        state: days > 35 ? "warn" : "ok",
        detail: `Last ${source} backup ${days === 0 ? "today" : days + " day(s) ago"} (${last.slice(0,10)})`,
      });
    }

    setChecks(out);
    setRunning(false);
  }

  // Only re-run when the fields HealthCheck actually inspects change.
  useEffect(() => { run();   }, [
    settings.daycare_name,
    settings.business_number,
    settings.smtp_host,
    settings.smtp_password_set,
    settings.sender_email,
    settings.contact_email,
    settings.pdf_folder,
    settings.reports_folder,
    settings.subsidies_enabled,
    settings.gross_monthly_fee,
    settings.ccfri_monthly_reduction,
    settings.backup_cloud_enabled,
    settings.backup_recipient_email,
  ]);

  const overall = !checks ? "running"
    : checks.some(c => c.state === "error") ? "error"
    : checks.some(c => c.state === "warn") ? "warn"
    : "ok";

  return (
    <div className="card health">
      <div className="health-head">
        <div>
          <div className="health-title">
            {overall === "ok" && <>✅ <span>All set — ready to send receipts.</span></>}
            {overall === "warn" && <>🟡 <span>A few things to check.</span></>}
            {overall === "error" && <>❌ <span>One or more required settings are missing.</span></>}
            {overall === "running" && <>⏳ <span>Checking setup…</span></>}
          </div>
          <div className="subtitle" style={{ margin: 0 }}>Click any item below to jump to the relevant setting.</div>
        </div>
        <button className="btn secondary" onClick={run} disabled={running}>{running ? "Checking…" : "Re-run checks"}</button>
      </div>
      {checks && (
        <ul className="health-list">
          {checks.map(c => (
            <li key={c.key} className={`health-item ${c.state}`}>
              <span className="health-dot" aria-hidden>{c.state === "ok" ? "✓" : c.state === "warn" ? "!" : "✗"}</span>
              <div>
                <div className="health-lbl">{c.label}</div>
                <div className="health-det">{c.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
