import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SetupPinModal } from "./AppGate";

// v2.0.0 device security settings tile — drop into Settings.tsx.
//
// Shows current envelope state (not set up / plaintext / encrypted +
// unlocked) and offers the three user actions: Enable security, Change
// PIN, Lock now.

type V2State = { isSetUp: boolean; isUnlocked: boolean; migrationState: string };

export default function SecuritySettingsSection() {
  const [state, setState] = useState<V2State | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);

  const refresh = () => {
    invoke<V2State>("v2_state").then(setState).catch((e) =>
      console.warn("[security] v2_state:", e)
    );
  };
  useEffect(refresh, []);

  if (!state) return null;

  const lock = async () => {
    if (!confirm("Lock the app now? You'll need to enter your PIN to continue.")) return;
    try {
      await invoke("v2_lock");
      // Reload to trigger AppGate to show the lock screen.
      window.location.reload();
    } catch (e) {
      alert(`Lock failed: ${e}`);
    }
  };

  return (
    <div style={box}>
      <div style={header}>Device security</div>
      <div style={sub}>
        {state.isSetUp
          ? "Your database is encrypted on this device."
          : "Not enabled. Your database is currently unencrypted on disk."}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        {!state.isSetUp && (
          <button style={btnPrimary} onClick={() => setWizardOpen(true)}>
            Enable device security…
          </button>
        )}
        {state.isSetUp && (
          <>
            <button style={btn} onClick={() => setChangeOpen(true)}>Change PIN…</button>
            <button style={btn} onClick={lock}>Lock now</button>
          </>
        )}
      </div>
      {wizardOpen && (
        <SetupPinModal
          onDone={() => { setWizardOpen(false); refresh(); }}
          onCancel={() => setWizardOpen(false)}
        />
      )}
      {changeOpen && (
        <ChangePinModal
          onDone={() => { setChangeOpen(false); refresh(); }}
          onCancel={() => setChangeOpen(false)}
        />
      )}
    </div>
  );
}

function ChangePinModal({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canSubmit = oldPin.length >= 4 && newPin.length >= 6 && newPin === confirm && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setErr(null);
    try {
      await invoke("v2_change_pin", { oldPin, newPin });
      onDone();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setErr(/wrong pin/i.test(msg) ? "Current PIN is wrong." : msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={overlay}>
      <form onSubmit={submit} style={card}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Change PIN</div>
        <label style={label}>Current PIN</label>
        <input type="password" value={oldPin} onChange={(e) => { setOldPin(e.target.value); setErr(null); }} style={input} autoFocus />
        <label style={label}>New PIN (6+ chars)</label>
        <input type="password" value={newPin} onChange={(e) => { setNewPin(e.target.value); setErr(null); }} style={input} />
        <label style={label}>Confirm new PIN</label>
        <input type="password" value={confirm} onChange={(e) => { setConfirm(e.target.value); setErr(null); }} style={input} />
        {newPin && confirm && newPin !== confirm && <div style={errStyle}>New PINs don't match</div>}
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button type="button" onClick={onCancel} style={{ ...btn, flex: 1 }}>Cancel</button>
          <button type="submit" disabled={!canSubmit} style={{ ...btnPrimary, flex: 1 }}>
            {busy ? "Saving…" : "Change PIN"}
          </button>
        </div>
      </form>
    </div>
  );
}

const box: React.CSSProperties = {
  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
  padding: 16, marginBottom: 16,
};
const header: React.CSSProperties = { fontSize: 16, fontWeight: 600, marginBottom: 4 };
const sub: React.CSSProperties = { fontSize: 13, color: "#666" };
const btn: React.CSSProperties = {
  padding: "8px 14px", border: "1px solid #ccc", background: "#f5f5f5",
  borderRadius: 6, cursor: "pointer", fontSize: 13,
};
const btnPrimary: React.CSSProperties = {
  padding: "8px 14px", border: "none", background: "#2c5282", color: "#fff",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500,
};
const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
};
const card: React.CSSProperties = {
  background: "#fff", padding: 24, borderRadius: 10, minWidth: 320,
  display: "flex", flexDirection: "column", gap: 8,
};
const label: React.CSSProperties = { fontSize: 12, color: "#555", marginTop: 4 };
const input: React.CSSProperties = {
  padding: "8px 12px", fontSize: 15, border: "1px solid #ccc", borderRadius: 6,
  letterSpacing: 4, fontFamily: "monospace",
};
const errStyle: React.CSSProperties = { color: "#c00", fontSize: 13 };
