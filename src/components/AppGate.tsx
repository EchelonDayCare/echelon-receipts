import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

// v2.0.0 AppLock overlay + Setup Wizard gate.
//
// Wraps the entire app. On mount, calls v2_state and:
//   * envelopeError !== null: FAIL CLOSED. Renders an error screen and
//     refuses to render children. This distinguishes "envelope missing"
//     (legitimate v1.x compat, safe to open plaintext) from "envelope
//     exists but corrupted" (never silently downgrade to plaintext).
//   * isSetUp=false: shows the SetupPinModal (create-PIN screen). User
//     may "Skip for now" and continue with a red banner + re-prompt on
//     next launch.
//   * isSetUp=true && !isUnlocked: shows the AppLock overlay (PIN
//     prompt or recovery-code prompt).
//   * isSetUp=true && isUnlocked: renders children with an idle
//     auto-lock timer wrapped around them.

type V2State = {
  isSetUp: boolean;
  isUnlocked: boolean;
  migrationState: string;
  envelopeError: string | null;
  hasRecovery: boolean;
  rateLimitedSecs: number;
};

const IDLE_LOCK_MS_DEFAULT = 15 * 60 * 1000; // 15 minutes
const SKIP_SETUP_SESSION_KEY = "security_setup_skipped_v1";

export default function AppGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<V2State | null>(null);
  const [checking, setChecking] = useState(true);
  const [gateError, setGateError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<V2State>("v2_state");
      setState(s);
      setGateError(null);
    } catch (e) {
      // v2_state itself failed (Rust panic, missing command, etc). Fail
      // closed: don't render the app. Show an error screen instead.
      console.error("[AppGate] v2_state failed:", e);
      setGateError(String((e as { message?: string })?.message ?? e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (checking || (!state && !gateError)) {
    return <FullScreenCentered>Loading…</FullScreenCentered>;
  }

  // Hard failure: v2_state Tauri command errored (e.g. Rust panic).
  if (gateError) {
    return <FailClosedScreen title="Security check failed" detail={gateError} />;
  }

  // Soft failure: envelope file present but unreadable / unsupported
  // version. Never fall through to plaintext — that would be a silent
  // security downgrade.
  if (state!.envelopeError) {
    return (
      <FailClosedScreen
        title="Security configuration unreadable"
        detail={state!.envelopeError}
      />
    );
  }

  // Set up but locked → PIN prompt (or recovery flow).
  if (state!.isSetUp && !state!.isUnlocked) {
    return (
      <UnlockScreen
        hasRecovery={state!.hasRecovery}
        rateLimitedSecs={state!.rateLimitedSecs}
        onUnlocked={refresh}
      />
    );
  }

  // Not set up: prompt user to enable security. Non-blocking:
  // "Skip for now" respects autonomy but re-prompts next launch.
  const skipped = typeof sessionStorage !== "undefined"
    && sessionStorage.getItem(SKIP_SETUP_SESSION_KEY) === "1";
  if (!state!.isSetUp && !skipped && !showSetup) {
    return (
      <EnableSecurityPrompt
        onEnable={() => setShowSetup(true)}
        onSkip={() => {
          try { sessionStorage.setItem(SKIP_SETUP_SESSION_KEY, "1"); } catch {}
          void refresh();
        }}
      />
    );
  }
  if (!state!.isSetUp && showSetup) {
    return (
      <SetupPinModal
        onDone={() => {
          setShowSetup(false);
          void refresh();
        }}
        onCancel={() => setShowSetup(false)}
      />
    );
  }

  // Unlocked (or !isSetUp && skipped for this session).
  return (
    <>
      {!state!.isSetUp && skipped && <UnprotectedBanner />}
      <IdleLockWrapper
        enabled={state!.isSetUp && state!.isUnlocked}
        timeoutMs={IDLE_LOCK_MS_DEFAULT}
        onIdle={async () => {
          try { await invoke("v2_lock"); } catch (e) { console.warn(e); }
          void refresh();
        }}
      >
        {children}
      </IdleLockWrapper>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Idle auto-lock

function IdleLockWrapper({
  enabled,
  timeoutMs,
  onIdle,
  children,
}: {
  enabled: boolean;
  timeoutMs: number;
  onIdle: () => void;
  children: ReactNode;
}) {
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const reset = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => onIdle(), timeoutMs);
    };
    const events: Array<keyof WindowEventMap> = [
      "mousemove", "keydown", "pointerdown", "wheel", "touchstart", "focus",
    ];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true } as AddEventListenerOptions));
    document.addEventListener("visibilitychange", reset);
    reset();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      events.forEach((e) => window.removeEventListener(e, reset));
      document.removeEventListener("visibilitychange", reset);
    };
  }, [enabled, timeoutMs, onIdle]);

  return <>{children}</>;
}

// ────────────────────────────────────────────────────────────────────────
// Fail-closed error screen

function FailClosedScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <FullScreenCentered>
      <div style={{ ...styles.card, borderTop: "6px solid #c62828" }}>
        <div style={{ ...styles.logo, color: "#c62828" }}>⚠️</div>
        <div style={styles.title}>{title}</div>
        <div style={styles.subtitle}>
          Your encrypted database is safe, but the security metadata could
          not be read. To recover, either:
          <ul style={{ textAlign: "left", fontSize: 13, marginTop: 8, lineHeight: 1.6 }}>
            <li>Restore your most recent encrypted backup, or</li>
            <li>Use your printed recovery code (if you have one), or</li>
            <li>Contact support.</li>
          </ul>
          <div style={{ fontSize: 11, color: "#999", marginTop: 8, wordBreak: "break-all" }}>
            Technical detail: {detail}
          </div>
        </div>
      </div>
    </FullScreenCentered>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Enable-security prompt shown on first launch of a not-yet-set-up install.

function EnableSecurityPrompt({
  onEnable,
  onSkip,
}: {
  onEnable: () => void;
  onSkip: () => void;
}) {
  return (
    <FullScreenCentered>
      <div style={styles.card}>
        <div style={styles.logo}>🛡️</div>
        <div style={styles.title}>Protect your data</div>
        <div style={styles.subtitle}>
          Set a PIN to encrypt your database on this device. If your laptop
          is lost or stolen, your daycare records stay safe.
          <br /><br />
          You can skip this and enable it later from Settings → Security.
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <button
            type="button"
            onClick={onSkip}
            style={{ ...styles.button, background: "#eee", color: "#333" }}
          >
            Skip for now
          </button>
          <button type="button" onClick={onEnable} style={styles.button}>
            Enable security
          </button>
        </div>
      </div>
    </FullScreenCentered>
  );
}

function UnprotectedBanner() {
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0,
      background: "#fff3cd", color: "#664d03",
      padding: "6px 12px", fontSize: 12, textAlign: "center",
      borderBottom: "1px solid #ffecb5", zIndex: 9998,
      fontFamily: "system-ui, sans-serif",
    }}>
      🔓 Device security is off — enable it in Settings → Security.
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────

function UnlockScreen({
  onUnlocked,
  hasRecovery,
  rateLimitedSecs,
}: {
  onUnlocked: () => void;
  hasRecovery: boolean;
  rateLimitedSecs: number;
}) {
  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"pin" | "recovery">("pin");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [cooldown, setCooldown] = useState(rateLimitedSecs);

  useEffect(() => {
    setCooldown(rateLimitedSecs);
  }, [rateLimitedSecs]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => window.clearInterval(t);
  }, [cooldown]);

  const disabled = busy || cooldown > 0;

  const submitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || pin.length < 4) return;
    setBusy(true);
    setErr(null);
    try {
      await invoke("v2_unlock", { pin });
      setPin("");
      onUnlocked();
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? e);
      const match = msg.match(/retry after (\d+)/i);
      if (match) {
        setCooldown(parseInt(match[1], 10));
        setErr(`Too many attempts. Wait ${match[1]}s before trying again.`);
      } else {
        setErr(/wrong pin/i.test(msg) ? "Wrong PIN. Try again." : `Unlock failed: ${msg}`);
      }
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  const submitRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || recoveryCode.trim().length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      await invoke("v2_unlock_with_recovery", { code: recoveryCode });
      setRecoveryCode("");
      onUnlocked();
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? e);
      const match = msg.match(/retry after (\d+)/i);
      if (match) {
        setCooldown(parseInt(match[1], 10));
        setErr(`Too many attempts. Wait ${match[1]}s.`);
      } else {
        setErr(`Recovery failed: ${msg}`);
      }
    } finally {
      setBusy(false);
    }
  };

  if (mode === "recovery") {
    return (
      <FullScreenCentered>
        <form onSubmit={submitRecovery} style={styles.card}>
          <div style={styles.logo}>🔑</div>
          <div style={styles.title}>Recovery code</div>
          <div style={styles.subtitle}>
            Enter the 48-character recovery code printed when you set up
            security. Dashes and case don't matter.
          </div>
          <textarea
            value={recoveryCode}
            onChange={(e) => { setRecoveryCode(e.target.value); setErr(null); }}
            rows={3}
            autoFocus
            style={{ ...styles.pinInput, letterSpacing: 2, fontSize: 15, textAlign: "left", padding: 10 }}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-..."
          />
          {err && <div style={styles.error}>{err}</div>}
          {cooldown > 0 && <div style={styles.error}>Locked out for {cooldown}s</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
            <button type="button" onClick={() => { setMode("pin"); setErr(null); }} style={{ ...styles.button, background: "#eee", color: "#333" }}>
              Back to PIN
            </button>
            <button type="submit" disabled={disabled || recoveryCode.trim().length === 0} style={styles.button}>
              {busy ? "Unlocking…" : "Unlock"}
            </button>
          </div>
        </form>
      </FullScreenCentered>
    );
  }

  return (
    <FullScreenCentered>
      <form onSubmit={submitPin} style={styles.card}>
        <div style={styles.logo}>🔒</div>
        <div style={styles.title}>Echelon Receipts</div>
        <div style={styles.subtitle}>Enter your PIN</div>
        <div style={{ position: "relative", width: "100%" }}>
          <input
            type={showPin ? "text" : "password"}
            inputMode="text"
            autoFocus
            value={pin}
            onChange={(e) => { setPin(e.target.value); setErr(null); }}
            maxLength={64}
            style={{ ...styles.pinInput, paddingRight: 56, letterSpacing: showPin ? "0.2em" : styles.pinInput.letterSpacing }}
            placeholder="••••••"
            disabled={disabled}
          />
          <button
            type="button"
            onClick={() => setShowPin((v) => !v)}
            aria-label={showPin ? "Hide PIN" : "Show PIN"}
            title={showPin ? "Hide PIN" : "Show PIN"}
            style={{
              position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
              background: "none", border: "none", cursor: "pointer",
              padding: "6px 10px", fontSize: 18, lineHeight: 1, color: "#4a5568",
            }}
            tabIndex={-1}
          >
            {showPin ? "🙈" : "👁"}
          </button>
        </div>
        {err && <div style={styles.error}>{err}</div>}
        {cooldown > 0 && <div style={styles.error}>Locked out for {cooldown}s</div>}
        <button type="submit" disabled={disabled || pin.length < 4} style={styles.button}>
          {busy ? "Unlocking…" : cooldown > 0 ? `Wait ${cooldown}s` : "Unlock"}
        </button>
        {hasRecovery && (
          <button
            type="button"
            onClick={() => { setMode("recovery"); setErr(null); }}
            style={{ background: "none", border: "none", color: "#2c5282", fontSize: 13, marginTop: 6, cursor: "pointer" }}
          >
            Forgot PIN? Use recovery code
          </button>
        )}
        {hasRecovery && (
          <div style={{ fontSize: 11, color: "#999", marginTop: 4, textAlign: "center", lineHeight: 1.4 }}>
            Tip: check your email inbox for "Echelon Recovery Code" if you didn't save the printed copy.
          </div>
        )}
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
  const [phase, setPhase] = useState<"pin" | "recovery">("pin");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const canSubmit = pin.length >= 6 && pin === confirm && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await invoke("v2_create_pin", { pin });
      // Mandatory: generate recovery code immediately so the user cannot
      // complete setup without seeing (and acknowledging) it.
      const code = await invoke<string>("v2_generate_recovery");
      setRecoveryCode(code);
      setPhase("recovery");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (phase === "recovery" && recoveryCode) {
    return <MandatoryRecoveryStep code={recoveryCode} onDone={onDone} />;
  }

  return (
    <FullScreenCentered>
      <form onSubmit={submit} style={styles.card}>
        <div style={styles.logo}>🛡️</div>
        <div style={styles.title}>Enable device security</div>
        <div style={styles.subtitle}>
          Choose a 6-digit PIN. Your database will be encrypted on this device.
          <br />
          After you set your PIN, you'll get a <b>recovery code</b> to save —
          keep it somewhere safe in case you forget your PIN.
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

function MandatoryRecoveryStep({ code, onDone }: { code: string; onDone: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <FullScreenCentered>
      <div style={{ ...styles.card, minWidth: 480, maxWidth: 560 }}>
        <div style={styles.logo}>🔑</div>
        <div style={styles.title}>Save your recovery code</div>
        <div style={{ ...styles.subtitle, textAlign: "left" }}>
          This is the <b>only</b> way to get back into your data if you forget
          your PIN, replace your device, or reinstall the OS.
          <br /><br />
          Write it down or print it and store it somewhere safe (a locked
          drawer, a safe). <b>Anyone with this code can decrypt your database
          on any machine</b> — treat it like a spare house key.
          <br /><br />
          You will <b>not</b> see this code again.
        </div>
        <pre style={{
          background: "#f5f5f5", color: "#111", padding: 16, borderRadius: 8,
          fontSize: 16, fontFamily: "ui-monospace, monospace",
          textAlign: "center", letterSpacing: 2, wordBreak: "break-all",
          whiteSpace: "pre-wrap", border: "2px dashed #999", margin: "12px 0",
        }}>{code}</pre>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            style={{ ...styles.button, flex: 1, background: "#eee", color: "#333" }}
            onClick={async () => {
              try { await navigator.clipboard.writeText(code); setCopied(true); }
              catch { alert("Copy failed — write it down manually."); }
            }}
          >
            {copied ? "Copied ✓" : "Copy to clipboard"}
          </button>
          <button
            type="button"
            style={{ ...styles.button, flex: 1, background: "#eee", color: "#333" }}
            onClick={() => window.print()}
          >
            Print
          </button>
        </div>
        <label style={{ fontSize: 13, color: "#fff", marginTop: 14, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          I have saved this recovery code somewhere safe. I understand it will
          not be shown again.
        </label>
        <button
          type="button"
          disabled={!confirmed}
          onClick={onDone}
          style={{
            ...styles.button,
            opacity: confirmed ? 1 : 0.4,
            cursor: confirmed ? "pointer" : "not-allowed",
            marginTop: 10,
          }}
        >
          Continue
        </button>
      </div>
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
