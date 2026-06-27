import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getSettings, setSetting } from "../lib/db";
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

  useEffect(() => { (async () => setS(await getSettings()))(); }, []);

  async function save() {
    setSaving(true);
    for (const [k, v] of Object.entries(s)) await setSetting(k, v ?? "");
    setSaving(false);
    alert("Settings saved.");
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

        <button className="btn" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Settings"}</button>
      </div>
    </div>
  );
}
