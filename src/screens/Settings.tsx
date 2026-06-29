import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { copyFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getSettings, setSetting } from "../lib/db";
import { sendTestEmail, SMTP_PRESETS } from "../lib/email";
import { sendCloudBackup } from "../lib/cloudBackup";
import { DEFAULT_LOGO_DATA_URL, DEFAULT_SIGNATURE_DATA_URL } from "../lib/defaults";
import type { SettingsMap } from "../types";
import HealthCheck from "../components/HealthCheck";

function Field({ s, setS, k, label, hint, placeholder }: {
  s: Record<string,string>; setS: (u: Record<string,string>) => void;
  k: string; label: string; hint?: string; placeholder?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input value={s[k] || ""} placeholder={placeholder} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
      {hint && <small style={{ color: "var(--muted)" }}>{hint}</small>}
    </div>
  );
}

function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ marginTop: 4, marginBottom: 10 }}>
      <h3 style={{ margin: 0, fontSize: 14, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>{title}</h3>
      {sub && <p className="subtitle" style={{ margin: "2px 0 0", fontSize: 12 }}>{sub}</p>}
    </div>
  );
}

export default function Settings() {
  const [s, setS] = useState<SettingsMap>({});
  const [saving, setSaving] = useState(false);
  const [smtpPassword, setSmtpPassword] = useState<string>("");
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    (async () => {
      setS(await getSettings());
      try {
        const p = await invoke<string | null>("keychain_get", { key: "smtp_password" });
        setHasStoredPassword(!!p);
      } catch { /* keychain may not be available in dev — ignore */ }
    })();
  }, []);

  async function save() {
    setSaving(true);
    try {
      for (const [k, v] of Object.entries(s)) await setSetting(k, v ?? "");
      if (smtpPassword.trim()) {
        await invoke("keychain_set", { key: "smtp_password", value: smtpPassword.trim() });
        setHasStoredPassword(true);
        setSmtpPassword("");
      }
      alert("Settings saved.");
    } catch (e) {
      alert("Save failed: " + e);
    } finally {
      setSaving(false);
    }
  }

  async function clearStoredPassword() {
    if (!confirm("Remove the stored SMTP password from the OS keychain?")) return;
    await invoke("keychain_delete", { key: "smtp_password" });
    setHasStoredPassword(false);
    alert("Password removed.");
  }

  async function runTest() {
    setTesting(true);
    try {
      // Persist current edits first so the test uses what's on screen.
      for (const [k, v] of Object.entries(s)) await setSetting(k, v ?? "");
      if (smtpPassword.trim()) {
        await invoke("keychain_set", { key: "smtp_password", value: smtpPassword.trim() });
        setHasStoredPassword(true); setSmtpPassword("");
      }
      await sendTestEmail(await getSettings());
      alert("✅ Test email sent. Check the inbox of " + (s.sender_email || s.contact_email));
    } catch (e: any) {
      alert("❌ SMTP test failed:\n\n" + (e?.message || e));
    } finally {
      setTesting(false);
    }
  }

  async function backupNow() {
    try {
      const folder = s.pdf_folder?.trim()
        ? await join(s.pdf_folder, "Backups")
        : await join(await appDataDir(), "Backups");
      if (!(await exists(folder))) await mkdir(folder, { recursive: true });
      const src = await join(await appDataDir(), "echelon.db");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dst = await join(folder, `echelon-${stamp}.db`);
      await copyFile(src, dst);
      const now = new Date().toISOString();
      await setSetting("last_backup_at", now);
      await setSetting("last_backup_path", dst);
      setS((cur) => ({ ...cur, last_backup_at: now, last_backup_path: dst }));
      alert(`✅ Backup saved to:\n${dst}`);
    } catch (e: any) {
      alert("❌ Backup failed:\n" + (e?.message || e));
    }
  }

  async function cloudBackupNow() {
    try {
      // Persist current edits first so the backup uses the current recipient/SMTP values.
      for (const [k, v] of Object.entries(s)) await setSetting(k, v ?? "");
      const now = new Date();
      const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const res = await sendCloudBackup(key);
      if (!res.ok) throw new Error(res.error || "unknown error");
      setS((cur) => ({
        ...cur,
        last_cloud_backup_at: new Date().toISOString(),
        last_cloud_backup_month: key,
        last_cloud_backup_recipient: res.recipient,
      }));
      alert(`✅ Backup emailed to ${res.recipient}\n(${(res.bytes / 1024).toFixed(1)} KB)`);
    } catch (e: any) {
      alert("❌ Cloud backup failed:\n" + (e?.message || e));
    }
  }

  async function restoreFromFile() {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "SQLite database", extensions: ["db", "sqlite", "sqlite3"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      const ok = confirm(
        `⚠️  This will REPLACE your current database with:\n\n${picked}\n\n` +
        `A safety copy of your current data will be saved to the Backups folder first. ` +
        `The app will close and reopen automatically.\n\nProceed?`
      );
      if (!ok) return;
      const pending = await invoke<string>("stage_restore", { srcPath: picked });
      alert(`✅ Restore staged.\n${pending}\n\nThe app will now restart to apply the restore.`);
      await invoke("restart_app");
    } catch (e: any) {
      alert("❌ Restore failed:\n" + (e?.message || e));
    }
  }

  function pickImage(key: "logo_data_url" | "signature_data_url") {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*";
    inp.onchange = () => {
      const f = inp.files?.[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => setS((cur) => ({ ...cur, [key]: String(r.result || "") }));
      r.readAsDataURL(f);
    };
    inp.click();
  }

  return (
    <div>
      <h1>Settings</h1>
      <p className="subtitle">These values appear on every printed receipt.</p>

      <HealthCheck settings={s} />

      <div className="card">
        <SectionHead title="Business identity" sub="Shown at the top of every receipt." />
        <Field s={s} setS={setS} k="daycare_name" label="Daycare Name" />
        <Field s={s} setS={setS} k="daycare_address" label="Address" />

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
        <SectionHead title="Contact" sub="Used for the receipt footer and parent replies." />
        <div className="row">
          <Field s={s} setS={setS} k="contact_email" label="Contact Email" placeholder="you@daycare.com" />
          <Field s={s} setS={setS} k="contact_phone" label="Contact Phone" placeholder="604-000-0000" />
        </div>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
        <SectionHead title="Receipt defaults" sub="Starting values when creating a new receipt." />
        <div className="row">
          <Field s={s} setS={setS} k="default_fee" label="Default Fee ($)" placeholder="485" />
          <Field s={s} setS={setS} k="next_receipt_no" label="Next Receipt #" placeholder="1001" />
        </div>
        <Field s={s} setS={setS} k="business_number"
          label="Business Number (BN)"
          placeholder="12345 6789 RC0001"
          hint="Required on CRA annual tax receipts." />

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
        <SectionHead title="Signing block" sub="Printed in the signature area at the bottom of each receipt." />
        <div className="row">
          <Field s={s} setS={setS} k="director_name" label="Signing Name" placeholder="Jane Doe" hint="Person signing receipts." />
          <Field s={s} setS={setS} k="director_title" label="Signing Title" placeholder="Managing Director" />
        </div>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
        <SectionHead title="Branding" sub="The logo prints in the header; the signature prints next to the signing name." />
        <div className="row" style={{ marginTop: 8 }}>
          <div className="field">
            <label>Logo</label>
            {s.logo_data_url
              ? <img src={s.logo_data_url} style={{ width: 80, height: 80, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border)" }} />
              : <img src={DEFAULT_LOGO_DATA_URL} title="Bundled default logo (in use)" style={{ width: 80, height: 80, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border)", opacity: 0.9 }} />}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button className="btn secondary" onClick={() => pickImage("logo_data_url")}>Choose…</button>
              {s.logo_data_url && <button className="btn ghost" onClick={() => setS({ ...s, logo_data_url: "" })}>Clear</button>}
            </div>
          </div>
          <div className="field">
            <label>Signature (Received by)</label>
            {s.signature_data_url
              ? <img src={s.signature_data_url} style={{ height: 50, border: "1px solid var(--border)", background: "#fff", padding: 4 }} />
              : <img src={DEFAULT_SIGNATURE_DATA_URL} title="Bundled default signature (in use)" style={{ height: 50, border: "1px solid var(--border)", background: "#fff", padding: 4, opacity: 0.9 }} />}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button className="btn secondary" onClick={() => pickImage("signature_data_url")}>Choose…</button>
              {s.signature_data_url && <button className="btn ghost" onClick={() => setS({ ...s, signature_data_url: "" })}>Clear</button>}
            </div>
          </div>
        </div>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
        <SectionHead title="PDF archive" sub="Where saved/sent receipt PDFs are filed on this computer." />
        <div className="field">
          <label>PDF Archive Folder</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ flex: 1 }}
              value={s.pdf_folder || ""}
              onChange={(e) => setS({ ...s, pdf_folder: e.target.value })}
              placeholder="(none — disable auto-save)" />
            <button className="btn secondary" onClick={async () => {
              const picked = await open({ directory: true, multiple: false });
              if (picked && !Array.isArray(picked)) setS({ ...s, pdf_folder: picked });
            }}>Choose…</button>
            {s.pdf_folder && <button className="btn ghost" onClick={() => setS({ ...s, pdf_folder: "" })}>Clear</button>}
          </div>
          <small style={{ color: "var(--muted)" }}>
            PDFs auto-save to <code>&lt;folder&gt;/YYYY/MM/&lt;receipt#&gt;_&lt;date&gt;_&lt;Student&gt;.pdf</code>
          </small>
        </div>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "20px 0" }} />
        <h3 style={{ margin: "0 0 4px" }}>BC Subsidies (CCFRI &amp; ACCB)</h3>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          Track the BC Child Care Fee Reduction Initiative and Affordable Child Care Benefit on every receipt
          so parents only claim what they actually paid out-of-pocket on their tax return.
          {" "}Toggle off to revert to a flat-amount workflow — data is preserved.
        </p>

        <div className="field">
          <label>
            <input type="checkbox" checked={s.subsidies_enabled === "1"}
              onChange={(e) => setS({ ...s, subsidies_enabled: e.target.checked ? "1" : "0" })}
              style={{ marginRight: 6, verticalAlign: "middle" }} />
            Enable BC subsidy breakdown on receipts
          </label>
        </div>

        {s.subsidies_enabled === "1" && (
          <>
            <div className="row">
              <div className="field">
                <label>Gross Monthly Fee ($)</label>
                <input value={s.gross_monthly_fee || ""}
                  onChange={(e) => setS({ ...s, gross_monthly_fee: e.target.value })}
                  placeholder="e.g. 1035" />
                <small style={{ color: "var(--muted)" }}>
                  The published full-time monthly fee before any subsidy. Used as the default for every student
                  (individual overrides are available on the Students page).
                </small>
              </div>
              <div className="field">
                <label>CCFRI Monthly Reduction ($)</label>
                <input value={s.ccfri_monthly_reduction || ""}
                  onChange={(e) => setS({ ...s, ccfri_monthly_reduction: e.target.value })}
                  placeholder="e.g. 550" />
                <small style={{ color: "var(--muted)" }}>
                  BC&apos;s reduction for &quot;Group Care 30-mo to school age&quot; full-time. Check current
                  rates at <a href="https://www2.gov.bc.ca/gov/content/family-social-supports/caring-for-young-children/childcarebc-programs/fee-reduction-initiative" target="_blank" rel="noreferrer">gov.bc.ca CCFRI</a>.
                </small>
              </div>
            </div>

            <div className="field">
              <label>Subsidy Statement — Email Subject</label>
              <input value={s.subsidy_stmt_subject || ""}
                onChange={(e) => setS({ ...s, subsidy_stmt_subject: e.target.value })} />
            </div>
            <div className="field">
              <label>Subsidy Statement — Email Body</label>
              <textarea rows={7} value={s.subsidy_stmt_body || ""}
                onChange={(e) => setS({ ...s, subsidy_stmt_body: e.target.value })} />
              <small style={{ color: "var(--muted)" }}>
                Tokens: {"{{student}} {{month_label}} {{year}} {{gross}} {{ccfri}} {{accb}} {{parent_paid}} {{daycare_name}} {{contact_email}} {{contact_phone}}"}
              </small>
            </div>
          </>
        )}

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "20px 0" }} />
        <h3 style={{ margin: "0 0 4px" }}>Email (SMTP)</h3>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          Configure once so you can email receipts to parents in one click. Password is stored in the OS keychain (encrypted), never in the database.
        </p>

        <div className="row">
          <div className="field">
            <label>Provider</label>
            <select
              value={Object.entries(SMTP_PRESETS).find(([, v]) => v.host === s.smtp_host)?.[0] || "Custom"}
              onChange={(e) => {
                const p = SMTP_PRESETS[e.target.value];
                if (p) setS({ ...s, smtp_host: p.host, smtp_port: String(p.port) });
              }}>
              <option value="Custom">Custom…</option>
              {Object.keys(SMTP_PRESETS).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Sender Email</label>
            <input value={s.sender_email || ""} placeholder="echelondaycare@hotmail.com"
              onChange={(e) => setS({ ...s, sender_email: e.target.value })} />
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label>Sender Display Name</label>
            <input value={s.sender_name || ""} placeholder="Echelon Daycare Society"
              onChange={(e) => setS({ ...s, sender_name: e.target.value })} />
          </div>
          <div className="field">
            <label>Email login (usually same as sender)</label>
            <input value={s.smtp_user || ""} placeholder="leave blank to use Sender Email"
              onChange={(e) => setS({ ...s, smtp_user: e.target.value })} />
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label>Email server (host)</label>
            <input value={s.smtp_host || ""} onChange={(e) => setS({ ...s, smtp_host: e.target.value })} />
            <small style={{ color: "var(--muted)" }}>Gmail: smtp.gmail.com · Outlook: smtp-mail.outlook.com</small>
          </div>
          <div className="field">
            <label>Port (usually 587)</label>
            <input value={s.smtp_port || "587"} onChange={(e) => setS({ ...s, smtp_port: e.target.value })} />
          </div>
        </div>

        <div className="field">
          <label>App Password {hasStoredPassword && <span className="badge ok" style={{ marginLeft: 8 }}>Saved</span>}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="password" style={{ flex: 1 }}
              value={smtpPassword}
              onChange={(e) => setSmtpPassword(e.target.value)}
              placeholder={hasStoredPassword ? "•••••••••••••••• (leave blank to keep)" : "Paste 16-char App Password"} />
            {hasStoredPassword && (
              <button className="btn ghost" style={{ color: "var(--danger)" }} onClick={clearStoredPassword}>Remove</button>
            )}
          </div>
          <small style={{ color: "var(--muted)" }}>
            Hotmail/Outlook → <a href="https://account.live.com/proofs/AppPassword" target="_blank" rel="noreferrer">Generate App Password</a> ·
            Gmail → <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Generate App Password</a>
          </small>
        </div>

        <div className="field">
          <label>
            <input type="checkbox" checked={s.bcc_self === "1"}
              onChange={(e) => setS({ ...s, bcc_self: e.target.checked ? "1" : "0" })}
              style={{ marginRight: 6, verticalAlign: "middle" }} />
            BCC myself on every sent receipt (recommended)
          </label>
        </div>

        <div className="field">
          <label>Email Subject Template</label>
          <input value={s.email_subject || ""} onChange={(e) => setS({ ...s, email_subject: e.target.value })} />
        </div>
        <div className="field">
          <label>Email Body Template</label>
          <textarea rows={8} value={s.email_body || ""} onChange={(e) => setS({ ...s, email_body: e.target.value })} />
          <small style={{ color: "var(--muted)" }}>
            Tokens: {"{{receipt_no}} {{student}} {{description}} {{amount}} {{pending}} {{pending_line}} {{date}} {{daycare_name}} {{contact_email}} {{contact_phone}}"}
          </small>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button className="btn secondary" onClick={runTest} disabled={testing}>
            {testing ? "Sending…" : "Send Test Email to Myself"}
          </button>
        </div>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "20px 0" }} />
        <h3 style={{ margin: "0 0 4px" }}>Cloud backup (recommended)</h3>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          On the first app launch of each month, a copy of your database is automatically
          emailed to the address below. Your Gmail (or other email) keeps every monthly
          backup forever — no extra accounts, no extra software.
        </p>
        <div className="field">
          <label>
            <input type="checkbox" checked={s.backup_cloud_enabled !== "0"}
              onChange={(e) => setS({ ...s, backup_cloud_enabled: e.target.checked ? "1" : "0" })}
              style={{ marginRight: 6, verticalAlign: "middle" }} />
            Enable automatic monthly cloud backup
          </label>
        </div>
        <div className="field">
          <label>Send backups to</label>
          <input
            type="email"
            placeholder={s.sender_email || s.contact_email || "you@example.com"}
            value={s.backup_recipient_email || ""}
            onChange={(e) => setS({ ...s, backup_recipient_email: e.target.value })}
          />
          <small style={{ color: "var(--muted)" }}>
            Leave blank to use your sender email ({s.sender_email || s.contact_email || "not set"}).
            Tip: use the same Gmail address you log in with — backups land in your inbox.
          </small>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={cloudBackupNow}>Back up to email now</button>
          {s.last_cloud_backup_at && (
            <small style={{ color: "var(--muted)" }}>
              Last cloud backup: <strong>{s.last_cloud_backup_at.slice(0, 19).replace("T", " ")}</strong>
              {s.last_cloud_backup_month && <> (tagged {s.last_cloud_backup_month})</>}
              {s.last_cloud_backup_recipient && <> → {s.last_cloud_backup_recipient}</>}
            </small>
          )}
        </div>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "20px 0" }} />
        <h3 style={{ margin: "0 0 4px" }}>Restore from a backup</h3>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          Replace this computer's data with a backup <code>.db</code> file — for example, an attachment
          downloaded from your cloud backup email, or a file from the local <code>Backups/</code> folder.
          A safety copy of the current database is saved first, and the app restarts to apply the restore.
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn danger" onClick={restoreFromFile}>Restore from backup file…</button>
        </div>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "20px 0" }} />
        <h3 style={{ margin: "0 0 4px" }}>Local backup</h3>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          A second safety copy on this computer. Stored in <code>Backups/</code> under your PDF folder
          (or the app data folder if no PDF folder is chosen).
          {s.last_backup_at && <> Last local backup: <strong>{s.last_backup_at.slice(0, 19).replace("T", " ")}</strong>.</>}
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn secondary" onClick={backupNow}>Back up to this computer</button>
          {s.last_backup_path && (
            <small style={{ color: "var(--muted)", alignSelf: "center" }}>→ {s.last_backup_path}</small>
          )}
        </div>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "20px 0" }} />
        <button className="btn" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Settings"}</button>
      </div>
    </div>
  );
}
