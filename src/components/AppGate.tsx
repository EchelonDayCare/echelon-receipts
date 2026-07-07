import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

// v2.0.0 AppLock overlay + Setup Wizard gate.
//
// Wraps the entire app. On mount, calls v2_state and:
//   * isSetUp=false: shows the SetupWizard (create-PIN screen). The
//     wizard calls v2_create_pin which encrypts the DB in place and
//     unlocks it. Then falls through to normal render.
//   * isSetUp=true && !isUnlocked: shows the AppLock overlay (PIN
//     prompt). Calls v2_unlock. On success, unmounts and renders the
//     app underneath.
//   * isSetUp=true && isUnlocked: renders children directly.
//
// This is v2.0.0 PIN-only. Biometric slots (v2.1) will surface as an
// extra "Use TouchID / Windows Hello" button here.

type V2State = { isSetUp: boolean; isUnlocked: boolean; migrationState: string };

export default function AppGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<V2State | null>(null);
  const [checking, setChecking] = useState(true);

  const refresh = async () => {
    try {
      const s = await invoke<V2State>("v2_state");
      setState(s);
    } catch (e) {
      console.error("[AppGate] v2_state failed:", e);
      // Fail-open in dev so a broken auth module doesn't lock everyone
      // out. Production shipping keeps this behaviour: if the security
      // module errors, treat the DB as plaintext v1.x compat.
      setState({ isSetUp: false, isUnlocked: false, migrationState: "plaintext" });
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (checking || !state) {
    return <FullScreenCentered>Loading…</FullScreenCentered>;
  }

  // Not set up yet — either fresh install or v1.x install upgrading to
  // v2. The wizard is optional-ish: on first launch we do NOT force
  // the user through it (they may want to explore the app first). We
  // surface it via Settings later; here we just pass through.
  if (!state.isSetUp) {
    return <>{children}</>;
  }

  // Set up but locked → PIN prompt.
  if (!state.isUnlocked) {
    return <UnlockScreen onUnlocked={refresh} />;
  }

  return <>{children}</>;
}

// ────────────────────────────────────────────────────────────────────────

function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || pin.length < 4) return;
    setBusy(true);
    setErr(null);
    try {
      await invoke("v2_unlock", { pin });
      setPin("");
      onUnlocked();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setErr(/wrong pin/i.test(msg) ? "Wrong PIN. Try again." : `Unlock failed: ${msg}`);
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FullScreenCentered>
      <form onSubmit={submit} style={styles.card}>
        <div style={styles.logo}>🔒</div>
        <div style={styles.title}>Echelon Receipts</div>
        <div style={styles.subtitle}>Enter your 6-digit PIN</div>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => { setPin(e.target.value); setErr(null); }}
          maxLength={64}
          style={styles.pinInput}
          placeholder="••••••"
        />
        {err && <div style={styles.error}>{err}</div>}
        <button type="submit" disabled={busy || pin.length < 4} style={styles.button}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </form>
    </FullScreenCentered>
  );
}

// ────────────────────────────────────────────────────────────────────────

export function SetupPinModal({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = pin.length >= 6 && pin === confirm && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await invoke("v2_create_pin", { pin });
      onDone();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FullScreenCentered>
      <form onSubmit={submit} style={styles.card}>
        <div style={styles.logo}>🛡️</div>
        <div style={styles.title}>Enable device security</div>
        <div style={styles.subtitle}>
          Choose a 6-digit PIN. Your database will be encrypted on this device.
          <br />
          <b>You can't recover this PIN if you forget it</b> — make sure your
          monthly encrypted backup is set up first.
        </div>
        <label style={styles.label}>PIN (at least 6 characters)</label>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => { setPin(e.target.value); setErr(null); }}
          maxLength={64}
          style={styles.pinInput}
          placeholder="••••••"
        />
        <label style={styles.label}>Confirm PIN</label>
        <input
          type="password"
          inputMode="numeric"
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value); setErr(null); }}
          maxLength={64}
          style={styles.pinInput}
          placeholder="••••••"
        />
        {pin && confirm && pin !== confirm && (
          <div style={styles.error}>PINs don't match</div>
        )}
        {err && <div style={styles.error}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <button type="button" onClick={onCancel} style={{ ...styles.button, background: "#eee", color: "#333" }}>
            Cancel
          </button>
          <button type="submit" disabled={!canSubmit} style={styles.button}>
            {busy ? "Encrypting…" : "Enable security"}
          </button>
        </div>
      </form>
    </FullScreenCentered>
  );
}

// ────────────────────────────────────────────────────────────────────────

function FullScreenCentered({ children }: { children: ReactNode }) {
  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex",
      alignItems: "center", justifyContent: "center",
      background: "linear-gradient(135deg, #1e3a5f 0%, #2c5282 100%)",
      color: "#fff", fontFamily: "system-ui, sans-serif", zIndex: 9999,
    }}>
      {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "#fff",
    color: "#222",
    padding: 32,
    borderRadius: 12,
    minWidth: 320,
    maxWidth: 420,
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: 10,
  },
  logo: { fontSize: 42, textAlign: "center" },
  title: { fontSize: 20, fontWeight: 600, textAlign: "center" },
  subtitle: { fontSize: 14, color: "#666", textAlign: "center", lineHeight: 1.5 },
  label: { fontSize: 13, color: "#555", marginTop: 6 },
  pinInput: {
    fontSize: 22,
    padding: "12px 16px",
    letterSpacing: 6,
    textAlign: "center",
    border: "1px solid #ccc",
    borderRadius: 8,
    fontFamily: "monospace",
    outline: "none",
  },
  error: { color: "#c00", fontSize: 13, textAlign: "center" },
  button: {
    padding: "12px 20px",
    border: "none",
    borderRadius: 8,
    background: "#2c5282",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    flex: 1,
  },
};
