import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SetupPinModal } from "./AppGate";
import { emailRecoveryCode } from "../lib/emailRecovery";

// v2.0.0 device security settings tile — drop into Settings.tsx.
//
// Shows current envelope state and offers: Enable / Change PIN / Lock now
// / Show recovery kit.

type V2State = {
  isSetUp: boolean;
  isUnlocked: boolean;
  migrationState: string;
  envelopeError: string | null;
  hasRecovery: boolean;
  rateLimitedSecs: number;
};

export default function SecuritySettingsSection() {
  const [state, setState] = useState<V2State | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

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
      window.location.reload();
    } catch (e) {
      alert(`Lock failed: ${e}`);
    }
  };

  const generateRecovery = async () => {
    const warning = state.hasRecovery
      ? "You already have a recovery code. Generating a new one INVALIDATES the previous one. Continue?"
      : "You will see a 48-character recovery code. Anyone with this code can decrypt your data — store it OFFLINE (printed, in a safe). Continue?";
    if (!confirm(warning)) return;
    try {
      const code = await invoke<string>("v2_generate_recovery");
      setRecoveryCode(code);
      setRecoveryOpen(true);
      refresh();
    } catch (e) {
      alert(`Recovery generation failed: ${e}`);
    }
  };

  return (
    <div style={box}>
      <div style={header}>Device security</div>
      <div style={sub}>
        {state.isSetUp
          ? "Your database is encrypted on this device."
          : "Not enabled. Your database is currently unencrypted on disk."}
        {state.isSetUp && !state.hasRecovery && (
          <div style={{ color: "#c62828", marginTop: 6, fontSize: 12 }}>
            ⚠ You have no recovery code. If you forget your PIN or lose this
            machine's keychain, your data will be permanently unrecoverable.
          </div>
        )}
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
            <button
              style={state.hasRecovery ? btn : btnPrimary}
              onClick={generateRecovery}
            >
              {state.hasRecovery ? "Regenerate recovery code…" : "Create recovery code…"}
            </button>
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
      {recoveryOpen && recoveryCode && (
        <RecoveryCodeModal
          code={recoveryCode}
          onDone={() => { setRecoveryOpen(false); setRecoveryCode(null); }}
        />
      )}
    </div>
  );
}

function RecoveryCodeModal({ code, onDone }: { code: string; onDone: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [emailStatus, setEmailStatus] = useState<"idle" | "sending" | "sent" | "err">("idle");
  const [emailMsg, setEmailMsg] = useState<string | null>(null);

  const doEmail = async () => {
    setEmailStatus("sending"); setEmailMsg(null);
    const r = await emailRecoveryCode(code);
    if (r.ok) {
      setEmailStatus("sent");
      setEmailMsg(`Sent to ${r.recipient}. Keep this email — it's your worst-case escape hatch.`);
    } else {
      setEmailStatus("err");
      setEmailMsg(r.error);
    }
  };

  return (
    <div style={overlay}>
      <div style={{ ...card, minWidth: 480, maxWidth: 560 }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: "#c62828" }}>
          Your recovery code
        </div>
        <div style={{ fontSize: 13, color: "#555", lineHeight: 1.5 }}>
          Write this down and store it somewhere safe (a locked drawer, a
          safety deposit box). <b>Anyone with this code can decrypt your
          database on any machine</b> — treat it like a spare house key.
          <br /><br />
          This is the <b>only</b> time you'll see this code. If you lose it,
          generate a new one from Settings.
        </div>
        <pre style={{
          background: "#f5f5f5", padding: 16, borderRadius: 8,
          fontSize: 16, fontFamily: "ui-monospace, monospace",
          textAlign: "center", letterSpacing: 2, wordBreak: "break-all",
          whiteSpace: "pre-wrap", border: "2px dashed #999",
        }}>{code}</pre>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            style={{ ...btn, flex: 1 }}
            onClick={async () => {
              try { await navigator.clipboard.writeText(code); setCopied(true); }
              catch { alert("Copy failed — write it down manually."); }
            }}
          >
            {copied ? "Copied ✓" : "Copy to clipboard"}
          </button>
          <button
            type="button"
            style={{ ...btn, flex: 1 }}
            onClick={() => window.print()}
          >
            Print
          </button>
          <button
            type="button"
            style={{ ...btn, flex: 1 }}
            onClick={doEmail}
            disabled={emailStatus === "sending" || emailStatus === "sent"}
            title="Send this code to the daycare email as a fallback safety net"
          >
            {emailStatus === "sending" ? "Sending…" : emailStatus === "sent" ? "Emailed ✓" : "Email to me"}
          </button>
        </div>
        {emailMsg && (
          <div style={{
            fontSize: 12, padding: 8, borderRadius: 6, marginTop: 4,
            background: emailStatus === "sent" ? "#dcfce7" : "#fee2e2",
            color: emailStatus === "sent" ? "#166534" : "#991b1b",
            border: emailStatus === "sent" ? "1px solid #86efac" : "1px solid #fca5a5",
          }}>{emailMsg}</div>
        )}
        <label style={{ fontSize: 13, color: "#333", marginTop: 12, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          I have securely stored this code offline. I understand it will not
          be shown again.
        </label>
        <button
          type="button"
          disabled={!confirmed}
          onClick={onDone}
          style={{
            ...btnPrimary,
            opacity: confirmed ? 1 : 0.4,
            cursor: confirmed ? "pointer" : "not-allowed",
            marginTop: 8,
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function ChangePinModal({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Set an initial PIN without knowing the old one — only allowed while
  // the app is already unlocked (i.e. after unlocking via recovery code).
  const [forgotOld, setForgotOld] = useState(false);
  const canSubmit = (forgotOld || oldPin.length >= 4) && newPin.length >= 6 && newPin === confirm && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setErr(null);
    try {
      if (forgotOld) {
        await invoke("v2_reset_pin", { newPin });
      } else {
        await invoke("v2_change_pin", { oldPin, newPin });
      }
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
        {!forgotOld && (
          <>
            <label style={label}>Current PIN</label>
            <input type="password" value={oldPin} onChange={(e) => { setOldPin(e.target.value); setErr(null); }} style={input} autoFocus />
            <button
              type="button"
              onClick={() => { setForgotOld(true); setOldPin(""); setErr(null); }}
              style={{ background: "none", border: "none", color: "#2c5282", fontSize: 12, textAlign: "left", padding: 0, marginTop: 4, cursor: "pointer" }}
            >
              I don't remember the current PIN
            </button>
          </>
        )}
        {forgotOld && (
          <div style={{ padding: 10, background: "#fef3c7", border: "1px solid #fbbf24", borderRadius: 6, fontSize: 12, color: "#92400e" }}>
            You're already unlocked, so we can set a fresh PIN without the old one. This rewraps the same encrypted database under your new PIN.
            <button
              type="button"
              onClick={() => setForgotOld(false)}
              style={{ background: "none", border: "none", color: "#92400e", fontSize: 12, textDecoration: "underline", cursor: "pointer", padding: 0, marginLeft: 6 }}
            >
              Undo
            </button>
          </div>
        )}
        <label style={label}>New PIN (6+ chars)</label>
        <input type="password" value={newPin} onChange={(e) => { setNewPin(e.target.value); setErr(null); }} style={input} autoFocus={forgotOld} />
        <label style={label}>Confirm new PIN</label>
        <input type="password" value={confirm} onChange={(e) => { setConfirm(e.target.value); setErr(null); }} style={input} />
        {newPin && confirm && newPin !== confirm && <div style={errStyle}>New PINs don't match</div>}
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button type="button" onClick={onCancel} style={{ ...btn, flex: 1 }}>Cancel</button>
          <button type="submit" disabled={!canSubmit} style={{ ...btnPrimary, flex: 1 }}>
            {busy ? "Saving…" : forgotOld ? "Set new PIN" : "Change PIN"}
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
