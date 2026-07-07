import { showAlert, showConfirm, showPrompt } from "../lib/dialogs";
import { useEffect, useState } from "react";
import { useParams, useNavigate, NavLink } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { copyFile, mkdir, exists, readFile } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import { getSettings, setSetting, setSettings as setSettingsBulk, checkpointWal } from "../lib/db";
import { sendTestEmail, SMTP_PRESETS } from "../lib/email";
import { sendCloudBackup } from "../lib/cloudBackup";
import { DEFAULT_LOGO_DATA_URL, DEFAULT_SIGNATURE_DATA_URL } from "../lib/defaults";
import { readErrorLog, errorLogPath, clearErrorLog } from "../lib/errorLog";
import type { SettingsMap } from "../types";
import HealthCheck from "../components/HealthCheck";
import NotificationsSettingsSection from "../components/NotificationsSettingsSection";
import WaitlistSettings from "./waitlist/Settings";

function HelpTip({ text }: { text: string }) {
  return (
    <span
      title={text}
      aria-label={text}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 16, height: 16, marginLeft: 6, borderRadius: "50%",
        background: "var(--border)", color: "var(--muted)",
        fontSize: 10, fontWeight: 700, cursor: "help", verticalAlign: "middle",
        userSelect: "none",
      }}
    >?</span>
  );
}

function Field({ s, setS, k, label, hint, placeholder, tip }: {
  s: Record<string,string>; setS: (u: Record<string,string>) => void;
  k: string; label: string; hint?: string; placeholder?: string; tip?: string;
}) {
  return (
    <div className="field">
      <label>{label}{tip && <HelpTip text={tip} />}</label>
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
  const [azureKey, setAzureKey] = useState<string>("");
  const [hasAzureKey, setHasAzureKey] = useState(false);
  const [whisperKey, setWhisperKey] = useState<string>("");
  const [hasWhisperKey, setHasWhisperKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [errorLogText, setErrorLogText] = useState<string>("");
  const [errorLogPathStr, setErrorLogPathStr] = useState<string>("");
  const [showErrorLog, setShowErrorLog] = useState(false);
  const [appVersion, setAppVersion] = useState<string>("");
  const [backupPassphrase, setBackupPassphrase] = useState<string>("");
  const [backupPassphraseConfirm, setBackupPassphraseConfirm] = useState<string>("");
  const [hasBackupPassphrase, setHasBackupPassphrase] = useState(false);

  useEffect(() => {
    (async () => {
      const loaded = await getSettings();
      setS(loaded);
      setHasStoredPassword(loaded.smtp_password_set === "1");
      setHasAzureKey(loaded.azure_ai_key_set === "1");
      setHasWhisperKey(loaded.azure_whisper_key_set === "1");
      setHasBackupPassphrase(loaded.backup_passphrase_set === "1");
      try { setAppVersion(await getVersion()); } catch { /* fine */ }
    })();
  }, []);

  async function save() {
    setSaving(true);
    try {
      await setSettingsBulk(s as Record<string, string>);
      if (smtpPassword.trim()) {
        await invoke("keychain_set", { key: "smtp_password", value: smtpPassword.trim() });
        await setSetting("smtp_password_set", "1");
        setHasStoredPassword(true);
        setSmtpPassword("");
      }
      if (azureKey.trim()) {
        await invoke("keychain_set", { key: "azure_ai_key", value: azureKey.trim() });
        await setSetting("azure_ai_key_set", "1");
        setHasAzureKey(true);
        setAzureKey("");
      }
      if (whisperKey.trim()) {
        await invoke("keychain_set", { key: "azure_whisper_key", value: whisperKey.trim() });
        await setSetting("azure_whisper_key_set", "1");
        setHasWhisperKey(true);
        setWhisperKey("");
      }
      void showAlert("Settings saved.");
      window.dispatchEvent(new Event("settings-saved"));
    } catch (e) {
      void showAlert("Save failed: " + e);
    } finally {
      setSaving(false);
    }
  }

  async function clearStoredPassword() {
    if (!await showConfirm("Remove the stored SMTP password from the OS keychain?")) return;
    await invoke("keychain_delete", { key: "smtp_password" });
    await setSetting("smtp_password_set", "");
    setHasStoredPassword(false);
    void showAlert("Password removed.");
  }

  async function clearAzureKey() {
    if (!await showConfirm("Remove the stored Azure AI Foundry key from the OS keychain?")) return;
    await invoke("keychain_delete", { key: "azure_ai_key" });
    await setSetting("azure_ai_key_set", "");
    setHasAzureKey(false);
    void showAlert("Azure AI key removed.");
  }

  async function clearWhisperKey() {
    if (!await showConfirm("Remove the stored Azure Whisper key from the OS keychain?")) return;
    await invoke("keychain_delete", { key: "azure_whisper_key" });
    await setSetting("azure_whisper_key_set", "");
    setHasWhisperKey(false);
    void showAlert("Whisper key removed.");
  }

  // ── C-1: encrypted cloud backup passphrase ──────────────────────────
  async function saveBackupPassphrase() {
    const p = backupPassphrase.trim();
    if (p.length < 8) {
      void showAlert("Passphrase must be at least 8 characters."); return;
    }
    if (p !== backupPassphraseConfirm.trim()) {
      void showAlert("Passphrase and confirmation don't match."); return;
    }
    try {
      const hash = await invoke<string>("backup_set_passphrase", { args: { passphrase: p } });
      await setSetting("backup_passphrase_hash", hash);
      await setSetting("backup_passphrase_set", "1");
      setHasBackupPassphrase(true);
      setBackupPassphrase(""); setBackupPassphraseConfirm("");
      void showAlert("✅ Backup passphrase set. Cloud backups will now be encrypted with it.");
    } catch (e: any) {
      void showAlert("❌ Failed to set passphrase:\n" + (e?.message || e));
    }
  }

  async function clearBackupPassphraseHandler() {
    const ok = await showConfirm(
      "Remove the backup passphrase? Automatic cloud backups will stop until a new one is set. " +
      "Existing encrypted backups will still need the OLD passphrase to restore — write it down first!"
    );
    if (!ok) return;
    await invoke("backup_clear_passphrase");
    await setSetting("backup_passphrase_set", "");
    await setSetting("backup_passphrase_hash", "");
    setHasBackupPassphrase(false);
    void showAlert("Backup passphrase removed.");
  }

  async function testDecryptLastBackup() {
    try {
      if (!s.last_cloud_backup_at) { void showAlert("No cloud backup has been sent yet."); return; }
      const dbPath = await join(await appDataDir(), "echelon.db");
      await checkpointWal();
      const bytes = await readFile(dbPath);
      let b64 = "";
      for (let i = 0; i < bytes.length; i += 8192) b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const plaintextB64 = btoa(b64);
      const { encrypted_b64: encB64 } = await invoke<{ encrypted_b64: string }>("encrypt_backup", { args: { plaintext_b64: plaintextB64 } });
      const { was_encrypted } = await invoke<{ plaintext_b64: string; was_encrypted: boolean }>(
        "decrypt_backup", { args: { encrypted_b64: encB64 } }
      );
      void showAlert(was_encrypted
        ? "✅ Encrypt → decrypt round-trip succeeded using the current backup passphrase."
        : "⚠️ Unexpected: archive was not recognised as encrypted.");
    } catch (e: any) {
      void showAlert("❌ Test decrypt failed:\n" + (e?.message || e));
    }
  }

  async function runTest() {
    setTesting(true);
    try {
      // Persist current edits first so the test uses what's on screen.
      await setSettingsBulk(s as Record<string, string>);
      if (smtpPassword.trim()) {
        await invoke("keychain_set", { key: "smtp_password", value: smtpPassword.trim() });
        await setSetting("smtp_password_set", "1");
        setHasStoredPassword(true); setSmtpPassword("");
      }
      await sendTestEmail(await getSettings());
      void showAlert("✅ Test email sent. Check the inbox of " + (s.sender_email || s.contact_email));
    } catch (e: any) {
      void showAlert("❌ SMTP test failed:\n\n" + (e?.message || e));
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
      // Checkpoint WAL so the .db file we copy is complete.
      await checkpointWal();
      const src = await join(await appDataDir(), "echelon.db");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dst = await join(folder, `echelon-${stamp}.db`);
      await copyFile(src, dst);
      const now = new Date().toISOString();
      await setSetting("last_backup_at", now);
      await setSetting("last_backup_path", dst);
      setS((cur) => ({ ...cur, last_backup_at: now, last_backup_path: dst }));
      void showAlert(`✅ Backup saved to:\n${dst}`);
    } catch (e: any) {
      void showAlert("❌ Backup failed:\n" + (e?.message || e));
    }
  }

  async function cloudBackupNow() {
    try {
      // Persist current edits first so the backup uses the current recipient/SMTP values.
      await setSettingsBulk(s as Record<string, string>);
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
      void showAlert(`✅ Backup emailed to ${res.recipient}\n(${(res.bytes / 1024).toFixed(1)} KB)`);
    } catch (e: any) {
      void showAlert("❌ Cloud backup failed:\n" + (e?.message || e));
    }
  }

  async function restoreFromFile() {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "SQLite database / encrypted backup", extensions: ["db", "sqlite", "sqlite3", "enc"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      const isEncrypted = picked.toLowerCase().endsWith(".enc");
      let passphrase: string | undefined;
      if (isEncrypted) {
        const entered = await showPrompt(
          "This looks like an encrypted backup (.enc). Enter the backup passphrase to decrypt it:"
        );
        if (entered == null) return; // user cancelled
        passphrase = entered.trim();
      } else {
        void showAlert(
          "⚠️ This file is not an encrypted (.enc) backup. If it's a pre-v1.6 cloud backup email " +
          "attachment (plaintext .db), it will still be restored as-is, but new cloud backups are " +
          "encrypted — set a backup passphrase in this tab to protect future backups.",
          { kind: "warning" }
        );
      }
      const ok = await showConfirm(
        `⚠️  This will REPLACE your current database with:\n\n${picked}\n\n` +
        `A safety copy of your current data will be saved to the Backups folder first. ` +
        `The app will close and reopen automatically.\n\nProceed?`
      );
      if (!ok) return;
      const pending = await invoke<string>("stage_restore", { srcPath: picked, passphrase });
      void showAlert(`✅ Restore staged.\n${pending}\n\nThe app will now restart to apply the restore.`);
      await invoke("restart_app");
    } catch (e: any) {
      void showAlert("❌ Restore failed:\n" + (e?.message || e));
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

  const { tab: tabParam } = useParams<{ tab?: string }>();
  const nav = useNavigate();
  const activeTab = tabParam || "identity";

  const TABS: { key: string; label: string }[] = [
    { key: "identity", label: "Identity" },
    { key: "email", label: "Receipts & Email" },
    { key: "folders", label: "Folders" },
    { key: "staff", label: "Staff" },
    { key: "backups", label: "Backups" },
    { key: "notifications", label: "Notifications" },
    { key: "waitlist", label: "Waitlist" },
    { key: "about", label: "About" },
  ];

  const SaveBar = (
    <div style={{ marginTop: 20, display: "flex", gap: 10, alignItems: "center" }}>
      <button className="btn" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Settings"}</button>
      <small style={{ color: "var(--muted)" }}>Saved changes apply across all tabs.</small>
    </div>
  );

  function renderIdentity() {
    return (
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

      </div>
    );
  }

  function renderReceiptsEmail() {
    return (
      <div className="card">
        <SectionHead title="Receipt defaults" sub="Starting values when creating a new receipt." />
        <div className="row">
          <Field s={s} setS={setS} k="default_fee" label="Default Fee ($)" placeholder="485" />
          <Field s={s} setS={setS} k="next_receipt_no" label="Next Receipt #" placeholder="1001" />
        </div>
        <Field s={s} setS={setS} k="business_number"
          label="Business Number (BN)"
          placeholder="12345 6789 RC0001"
          hint="Required on CRA annual tax receipts."
          tip="Your 15-character CRA Business Number (BN) — looks like '123456789 RC0001'. Parents need this on the tax receipt to claim the daycare deduction." />

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
        <SectionHead title="Financial reporting year" sub="Which 12-month period the Reports screen aggregates by. CRA annual tax receipts always use calendar year regardless." />
        <div className="field">
          <label>Reporting Year</label>
          <select
            value={s.reporting_year_mode || "fiscal_sep_aug"}
            onChange={(e) => setS({ ...s, reporting_year_mode: e.target.value })}
          >
            <option value="fiscal_sep_aug">Fiscal Year (Sep 1 – Aug 31) — recommended for daycare books</option>
            <option value="calendar">Calendar Year (Jan 1 – Dec 31)</option>
          </select>
          <small style={{ color: "var(--muted)" }}>
            Sets the default view on the Reports screen. You can still toggle per-view from the Reports toolbar.
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
                <label>CCFRI Monthly Reduction ($)<HelpTip text="Child Care Fee Reduction Initiative — the BC government pays this directly to your daycare each month to lower parent fees. Check the current rate for your category (e.g. Group Care 30mo-to-school-age) at gov.bc.ca/CCFRI." /></label>
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
          <label>App Password<HelpTip text="NOT your regular email password. An App Password is a one-time 16-character code your email provider gives you specifically for third-party apps. Required because Gmail/Outlook block direct password sign-in." /> {hasStoredPassword && <span className="badge ok" style={{ marginLeft: 8 }}>Saved</span>}</label>
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
            Tokens: {"{{receipt_no}} {{student}} {{description}} {{amount}} {{amount_label}} {{pending}} {{pending_line}} {{date}} {{daycare_name}} {{contact_email}} {{contact_phone}}"}
          </small>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button className="btn secondary" onClick={runTest} disabled={testing}>
            {testing ? "Sending…" : "Send Test Email to Myself"}
          </button>
        </div>
      </div>
    );
  }

  function renderBackups() {
    return (
      <div className="card">
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
        <h3 style={{ margin: "0 0 4px" }}>
          Backup encryption {hasBackupPassphrase && <span className="badge ok" style={{ marginLeft: 8 }}>Set</span>}
        </h3>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          Cloud backups are encrypted with a passphrase before they're emailed — the plaintext database
          never leaves this computer. Set a passphrase here; it's stored securely in this computer's OS
          keychain (not emailed, not in the database). <strong>Write it down somewhere safe</strong> — if you
          lose it, encrypted backups cannot be recovered.
        </p>
        <div className="row">
          <div className="field">
            <label>{hasBackupPassphrase ? "New passphrase (leave blank to keep current)" : "Backup passphrase"}</label>
            <input type="password" value={backupPassphrase} onChange={(e) => setBackupPassphrase(e.target.value)}
              placeholder="At least 8 characters" />
          </div>
          <div className="field">
            <label>Confirm passphrase</label>
            <input type="password" value={backupPassphraseConfirm} onChange={(e) => setBackupPassphraseConfirm(e.target.value)}
              placeholder="Re-type to confirm" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={saveBackupPassphrase}>
            {hasBackupPassphrase ? "Change passphrase" : "Set passphrase"}
          </button>
          {hasBackupPassphrase && (
            <>
              <button className="btn secondary" onClick={testDecryptLastBackup}>Test decrypt with current DB</button>
              <button className="btn danger" onClick={clearBackupPassphraseHandler}>Remove passphrase</button>
            </>
          )}
        </div>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "20px 0" }} />
        <h3 style={{ margin: "0 0 4px" }}>Restore from a backup</h3>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          Replace this computer's data with a backup file — an encrypted <code>.db.enc</code> attachment
          from a cloud backup email (v1.6+), or a legacy plaintext <code>.db</code> file from an older backup
          or the local <code>Backups/</code> folder. A safety copy of the current database is saved first,
          and the app restarts to apply the restore.
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
      </div>
    );
  }

  function renderStaff() {
    return (
      <div className="card">
        <h3 style={{ margin: "0 0 4px" }}>Optional features</h3>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          Turn on extra tools you'd like to use. They stay hidden when off.
        </p>

        <div className="field" style={{ marginBottom: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={s.feature_staff_hours_enabled === "1"}
              onChange={(e) => setS({ ...s, feature_staff_hours_enabled: e.target.checked ? "1" : "" })}
            />
            <strong>Staff Hours</strong> &nbsp;<span style={{ color: "var(--muted)", fontWeight: 400 }}>
              — Upload a monthly sign-in sheet and let AI extract teacher in/out times, then export the hours to Excel.
            </span>
          </label>
        </div>

        {/* Azure AI key lives outside the staff toggle — it also powers
            the Student attendance sheet OCR and the Visa statement import. */}
        <div className="field" style={{ marginBottom: 14 }}>
          <label>Azure AI Foundry key<HelpTip text="Required for AI features: staff sign-in sheet OCR, student attendance sheet OCR, and Visa/credit-card statement import. Stored in the macOS keychain — never in the database or any backup email." /></label>
          <input
            type="password"
            placeholder={hasAzureKey ? "•••••••• (stored in OS keychain) — enter a new key to replace" : "Paste your Azure AI Foundry key"}
            value={azureKey}
            onChange={(e) => setAzureKey(e.target.value)}
            autoComplete="off"
          />
          <small style={{ color: "var(--muted)" }}>
            Enables 3-model consensus (Mistral Document AI + GPT-5.4 + Mistral OCR) for staff sign-in sheets, plus single-model extraction for student attendance and Visa statement imports. Stored in the OS keychain, never in the database.
            {hasAzureKey && (
              <> &nbsp;<a href="#" onClick={(e) => { e.preventDefault(); clearAzureKey(); }} style={{ color: "var(--danger)" }}>Remove stored key</a></>
            )}
          </small>
        </div>

        {/* ── Voice capture (Whisper) — v1.8.0 ─────────────────────────── */}
        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
        <div className="field" style={{ marginBottom: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={s.voice_organizer_enabled !== "0"}
              onChange={(e) => setS({ ...s, voice_organizer_enabled: e.target.checked ? "1" : "0" })}
            />
            <strong>Voice capture in Organizer</strong>&nbsp;
            <span style={{ color: "var(--muted)", fontWeight: 400 }}>
              — Tap the mic in Organizer and dictate a meeting, follow-up, or action item. Whisper transcribes, GPT-4.1 parses; you confirm the draft before it saves.
            </span>
          </label>
        </div>

        {s.voice_organizer_enabled !== "0" && (
          <div style={{ paddingLeft: 24, borderLeft: "2px solid var(--border)", marginBottom: 14 }}>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Azure Whisper endpoint URL<HelpTip text="Full deployment URL from Azure OpenAI Studio, including api-version. Example: https://<resource>.cognitiveservices.azure.com/openai/deployments/whisper/audio/translations?api-version=2024-06-01" /></label>
              <input
                type="text"
                placeholder="https://<resource>.cognitiveservices.azure.com/openai/deployments/whisper/audio/translations?api-version=2024-06-01"
                value={s.azure_whisper_endpoint || ""}
                onChange={(e) => setS({ ...s, azure_whisper_endpoint: e.target.value })}
              />
              <small style={{ color: "var(--muted)" }}>
                Stored in the settings table. Endpoint URLs aren't secrets — the API key below is.
              </small>
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Azure Whisper key</label>
              <input
                type="password"
                placeholder={hasWhisperKey ? "•••••••• (stored in OS keychain) — enter a new key to replace" : "Paste your Whisper API key"}
                value={whisperKey}
                onChange={(e) => setWhisperKey(e.target.value)}
                autoComplete="off"
              />
              <small style={{ color: "var(--muted)" }}>
                Stored in the OS keychain, never in the database or backups. Same tenant as your Azure OpenAI resource — the parse step piggy-backs on the Azure AI Foundry key above.
                {hasWhisperKey && (
                  <> &nbsp;<a href="#" onClick={(e) => { e.preventDefault(); clearWhisperKey(); }} style={{ color: "var(--danger)" }}>Remove stored key</a></>
                )}
              </small>
            </div>
            <div className="field" style={{ marginBottom: 6 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={s.organizer_ai_store_transcripts === "1"}
                  onChange={(e) => setS({ ...s, organizer_ai_store_transcripts: e.target.checked ? "1" : "" })}
                />
                <strong>Store full transcripts in the audit log</strong>&nbsp;
                <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                  — By default only a sha256 hash of the transcript is kept in <code>organizer_ai_events</code>. Enable this to retain raw text for review; auto-purged after 180 days regardless.
                </span>
              </label>
            </div>
          </div>
        )}

        {s.feature_staff_hours_enabled === "1" && (
          <div style={{ paddingLeft: 24, borderLeft: "2px solid var(--border)", marginBottom: 14 }}>
            <Field s={s} setS={setS} k="staff_default_hourly_rate" label="Default hourly rate (optional)" placeholder="e.g. 28.50" hint="Used only as a starting point when you add a new staff member." />
            <Field s={s} setS={setS} k="staff_cred_alert_days" label="Credential warning window (days)" placeholder="60" hint="Home alerts trigger when a credential expires within this many days. Default 60." tip="How many days before expiry should the Home screen warn you? 60 days is enough time to book a First Aid renewal or order a new Criminal Record Check." />
          </div>
        )}

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />

        <div className="field" style={{ marginBottom: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={s.agm_ai_enabled === "1"}
              onChange={(e) => setS({ ...s, agm_ai_enabled: e.target.checked ? "1" : "0" })}
            />
            <strong>AGM Minutes AI drafting</strong>&nbsp;
            <span style={{ color: "var(--muted)", fontWeight: 400 }}>
              — When on, per-section ✨ buttons and "Draft with AI" appear in the AGM Minutes editor. Every prompt + response is logged to <code>agm_ai_events</code> for board audit. Requires the Azure key above.
            </span>
          </label>
        </div>
        {s.agm_ai_enabled === "1" && (
          <div className="field" style={{ marginBottom: 8, paddingLeft: 24, borderLeft: "2px solid var(--border)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={s.agm_ai_redact !== "0"}
                onChange={(e) => setS({ ...s, agm_ai_redact: e.target.checked ? "1" : "0" })}
              />
              <strong>Redact staff names in AI prompts</strong>&nbsp;
              <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                — Replaces individual staff names with <code>Staff #1</code>, <code>Staff #2</code>, etc. before sending prompts to Azure. Roles, credential types and expiry dates still travel. Default on.
              </span>
            </label>
          </div>
        )}
      </div>
    );
  }

  function renderAbout() {
    return (
      <div className="card">
        <h3 style={{ margin: "0 0 4px" }}>About Echelon Receipts</h3>
        <p className="subtitle" style={{ marginBottom: 16 }}>
          A purpose-built receipts &amp; records app for Echelon Daycare.
        </p>
        <div className="field">
          <label>Version</label>
          <div>{appVersion ? `v${appVersion}` : "unknown"}</div>
        </div>
        <div className="field">
          <label>Database location</label>
          <div style={{ fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, monospace", color: "var(--muted)" }}>
            ~/Library/Application Support/org.echelondaycare.receipts/echelon.db (macOS)<br />
            %APPDATA%\org.echelondaycare.receipts\echelon.db (Windows)
          </div>
        </div>
        <div className="field">
          <label>Links</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <a href="https://github.com/EchelonDayCare/echelon-receipts" target="_blank" rel="noreferrer">GitHub repository</a>
            <a href="https://github.com/EchelonDayCare/echelon-receipts/releases" target="_blank" rel="noreferrer">Download the latest DMG</a>
            <a href="https://www2.gov.bc.ca/gov/content/family-social-supports/caring-for-young-children" target="_blank" rel="noreferrer">BC Childcare programs</a>
          </div>
        </div>
        <p className="subtitle" style={{ marginTop: 16, fontSize: 12 }}>
          Built by Echelon Daycare with GitHub Copilot. Your data stays on this computer
          (and in your monthly cloud-backup email) — nothing is sent to a third-party server
          except optional Azure Document AI for OCR (child attendance sheets, staff sign-in sheets,
          Visa statement imports), if enabled.
        </p>
        <div className="field" style={{ marginTop: 16 }}>
          <label>Error log</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" type="button" onClick={async () => {
              const [t, p] = await Promise.all([readErrorLog(), errorLogPath()]);
              setErrorLogText(t || "(empty)");
              setErrorLogPathStr(p);
              setShowErrorLog(true);
            }}>View error log</button>
            <button className="btn" type="button" onClick={async () => {
              await clearErrorLog();
              setErrorLogText("");
              setShowErrorLog(false);
            }}>Clear log</button>
          </div>
          {showErrorLog && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>{errorLogPathStr}</div>
              <pre style={{
                maxHeight: 240, overflow: "auto", background: "var(--bg2, #111)",
                color: "var(--text)", padding: 8, borderRadius: 6, fontSize: 11,
                whiteSpace: "pre-wrap", wordBreak: "break-word"
              }}>{errorLogText}</pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderFolders() {
    return (
      <div className="card">
        <SectionHead title="Reports folder" sub="Root folder where the app files every generated report (AGM Minutes, Attendance, Aging, etc.). Subfolders are created automatically per report type." />
        <div className="field">
          <label>Reports Folder</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ flex: 1 }}
              value={s.reports_folder || ""}
              onChange={(e) => setS({ ...s, reports_folder: e.target.value })}
              placeholder="(none — pick a folder to enable one-click report generation)" />
            <button className="btn secondary" onClick={async () => {
              const picked = await open({ directory: true, multiple: false });
              if (picked && !Array.isArray(picked)) setS({ ...s, reports_folder: picked });
            }}>Choose…</button>
            {s.reports_folder && <button className="btn ghost" onClick={() => setS({ ...s, reports_folder: "" })}>Clear</button>}
          </div>
          <small style={{ color: "var(--muted)" }}>
            e.g. AGM Minutes go to <code>&lt;folder&gt;/AGM Minutes/AGM-YYYY-YY.docx</code>. Other report types will use their own subfolders.
          </small>
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
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ marginBottom: 4 }}>Configuration</h1>
      <p className="subtitle" style={{ marginTop: 0 }}>Settings are grouped into tabs. Use Save Settings to apply changes from any tab.</p>

      <HealthCheck settings={s} />

      <nav className="settings-tabs" style={{ display: "flex", gap: 4, margin: "16px 0", borderBottom: "1px solid var(--border)" }}>
        {TABS.map((t) => (
          <NavLink
            key={t.key}
            to={`/config/${t.key}`}
            className={() => "settings-tab" + (t.key === activeTab ? " active" : "")}
            style={({ isActive }) => ({
              padding: "8px 14px",
              borderRadius: "8px 8px 0 0",
              textDecoration: "none",
              color: (t.key === activeTab || isActive) ? "var(--text)" : "var(--muted)",
              borderBottom: (t.key === activeTab) ? "2px solid var(--accent)" : "2px solid transparent",
              fontWeight: (t.key === activeTab) ? 600 : 400,
              marginBottom: -1,
            })}
            onClick={(e) => { e.preventDefault(); nav(`/config/${t.key}`); }}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      {activeTab === "identity" && renderIdentity()}
      {activeTab === "email" && renderReceiptsEmail()}
      {activeTab === "folders" && renderFolders()}
      {activeTab === "staff" && renderStaff()}
      {activeTab === "backups" && renderBackups()}
      {activeTab === "notifications" && <NotificationsSettingsSection />}
      {activeTab === "waitlist" && <WaitlistSettings />}
      {activeTab === "about" && renderAbout()}

      {activeTab !== "about" && activeTab !== "notifications" && activeTab !== "waitlist" && SaveBar}
    </div>
  );
}
