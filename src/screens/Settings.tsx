import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getSettings, setSetting } from "../lib/db";
import { sendTestEmail, SMTP_PRESETS } from "../lib/email";
import type { SettingsMap } from "../types";

const FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "daycare_name", label: "Daycare Name" },
  { key: "daycare_address", label: "Address" },
  { key: "contact_email", label: "Contact Email" },
  { key: "contact_phone", label: "Contact Phone" },
  { key: "default_fee", label: "Default Fee ($)" },
  { key: "next_receipt_no", label: "Next Receipt #" },
];

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

      <div className="card">
        {FIELDS.map((f) => (
          <div key={f.key} className="field">
            <label>{f.label}</label>
            <input value={s[f.key] || ""} onChange={(e) => setS({ ...s, [f.key]: e.target.value })} />
          </div>
        ))}

        <div className="row">
          <div className="field">
            <label>Logo</label>
            {s.logo_data_url
              ? <img src={s.logo_data_url} style={{ width: 80, height: 80, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border)" }} />
              : <div style={{ width: 80, height: 80, borderRadius: "50%", background: "#bae6fd" }} />}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button className="btn secondary" onClick={() => pickImage("logo_data_url")}>Choose…</button>
              {s.logo_data_url && <button className="btn ghost" onClick={() => setS({ ...s, logo_data_url: "" })}>Clear</button>}
            </div>
          </div>
          <div className="field">
            <label>Signature (Received by)</label>
            {s.signature_data_url
              ? <img src={s.signature_data_url} style={{ height: 50, border: "1px solid var(--border)", background: "#fff", padding: 4 }} />
              : <div style={{ height: 50, width: 200, border: "1px dashed var(--border)" }} />}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button className="btn secondary" onClick={() => pickImage("signature_data_url")}>Choose…</button>
              {s.signature_data_url && <button className="btn ghost" onClick={() => setS({ ...s, signature_data_url: "" })}>Clear</button>}
            </div>
          </div>
        </div>

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
            <label>SMTP Username (usually same as sender)</label>
            <input value={s.smtp_user || ""} placeholder="leave blank to use Sender Email"
              onChange={(e) => setS({ ...s, smtp_user: e.target.value })} />
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label>SMTP Host</label>
            <input value={s.smtp_host || ""} onChange={(e) => setS({ ...s, smtp_host: e.target.value })} />
          </div>
          <div className="field">
            <label>SMTP Port</label>
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
        <button className="btn" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Settings"}</button>
      </div>
    </div>
  );
}
