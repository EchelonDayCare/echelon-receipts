import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { showAlert } from "../lib/dialogs";
import { printHtmlDocument } from "../lib/print";

// v2.6.4 (Codex R3 HIGH): produce a self-contained minimal print
// document for the master recovery code. This route means: (a) if
// in-app native print works, the dialog opens as expected; (b) if
// native silently no-ops on WebView2, we escalate to a browser tab
// that contains ONLY the code + a heading (no other DOM leakage);
// (c) errors bubble up so the caller can showAlert instead of the
// user thinking they printed something they didn't.
function recoveryCodePrintHtml(code: string): string {
  const escaped = code.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]!,
  );
  const now = new Date().toLocaleString();
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Echelon Recovery Code</title>
<style>
  body { font-family: system-ui, sans-serif; color: #000; background: #fff; padding: 32px; margin: 0; }
  h1 { font-size: 22px; margin: 0 0 12px 0; }
  .code { font-family: ui-monospace, "Courier New", monospace; font-size: 20px;
          letter-spacing: 2px; padding: 20px; border: 2px dashed #333;
          text-align: center; word-break: break-all; white-space: pre-wrap; margin: 20px 0; }
  .warn { color: #b45309; font-size: 13px; margin-top: 12px; }
  .meta { color: #666; font-size: 12px; margin-top: 24px; }
  @page { margin: 0.75in; }
</style></head>
<body>
  <h1>Echelon Daycare — Master Recovery Code</h1>
  <p>Store this somewhere safe. This is the ONLY way to unlock your database if you forget your PIN. It will not be shown again.</p>
  <div class="code">${escaped}</div>
  <p class="warn">⚠ Anyone with this code can decrypt your daycare records. Keep it private.</p>
  <p class="meta">Printed ${now}</p>
</body></html>`;
}

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

  const submitPin = useCallback(async (pinValue: string) => {
    if (disabled || pinValue.length < 6) return;
    setBusy(true);
    setErr(null);
    try {
      await invoke("v2_unlock", { pin: pinValue });
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
  }, [disabled, onUnlocked]);

  const onSubmitForm = (e: React.FormEvent) => {
    e.preventDefault();
    void submitPin(pin);
  };

  // v3.0.3: auto-unlock 350ms after the user stops typing (once PIN is 6+
  // chars). Removes the extra Enter/Submit tap for the common case where
  // the PIN they typed is correct. If they're still typing a longer PIN,
  // the timer resets on each keystroke. On wrong PIN the input is cleared
  // and they can retype — same as the manual submit flow.
  useEffect(() => {
    if (pin.length < 6 || disabled) return;
    const t = window.setTimeout(() => { void submitPin(pin); }, 350);
    return () => window.clearTimeout(t);
  }, [pin, disabled, submitPin]);


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
      <form onSubmit={onSubmitForm} style={styles.winShell}>
        <div style={styles.winAvatar} aria-hidden>
          <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
            <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
            <circle cx="12" cy="15.4" r="1.1" fill="currentColor" stroke="none" />
          </svg>
        </div>
        <div style={styles.winName}>Echelon</div>
        <div style={styles.winDotsRow} aria-hidden>
          <span style={styles.winDot} /><span style={styles.winDot} /><span style={styles.winDot} />
          <span style={styles.winDot} /><span style={styles.winDot} /><span style={styles.winDot} />
        </div>
        <div style={styles.winHint}>Enter your PIN</div>
        <div style={styles.winInputWrap}>
          <input
            type={showPin ? "text" : "password"}
            inputMode="text"
            autoFocus
            value={pin}
            onChange={(e) => { setPin(e.target.value); setErr(null); }}
            maxLength={64}
            style={styles.winInput}
            className="echelon-win-pin"
            placeholder="PIN"
            disabled={disabled}
            aria-label="PIN"
          />
          <button
            type="submit"
            disabled={disabled || pin.length < 6}
            aria-label="Unlock"
            title="Unlock"
            style={{
              ...styles.winSubmitBtn,
              opacity: (disabled || pin.length < 6) ? 0.35 : 1,
              cursor: (disabled || pin.length < 6) ? "default" : "pointer",
            }}
          >
            {busy
              ? <span style={styles.winSpinner} />
              : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              )}
          </button>
          <button
            type="button"
            onClick={() => setShowPin((v) => !v)}
            aria-label={showPin ? "Hide PIN" : "Show PIN"}
            title={showPin ? "Hide PIN" : "Show PIN"}
            tabIndex={-1}
            style={styles.winEyeBtn}
          >
            {showPin
              ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.7 20.7 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a20.9 20.9 0 0 1-3.16 4.19M1 1l22 22" />
                  <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                </svg>
              )
              : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
          </button>
        </div>
        {err && <div style={styles.winError}>{err}</div>}
        {cooldown > 0 && <div style={styles.winError}>Locked out for {cooldown}s</div>}
        {hasRecovery && (
          <button
            type="button"
            onClick={() => { setMode("recovery"); setErr(null); }}
            style={styles.winLink}
            className="echelon-win-link"
          >
            I forgot my PIN
          </button>
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
      // complete setup without seeing (and acknowledging) it. Since
      // v2.1.1 v2_generate_recovery requires a step-up proof; the PIN we
      // just wrapped the MDK with satisfies both the unwrap and the
      // MDK-binding check.
      const code = await invoke<string>("v2_generate_recovery", {
        proof: { kind: "pin", pin },
      });
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
              catch { void showAlert("Copy failed — write it down manually.", { kind: "warning" }); }
            }}
          >
            {copied ? "Copied ✓" : "Copy to clipboard"}
          </button>
          <button
            type="button"
            style={{ ...styles.button, flex: 1, background: "#eee", color: "#333" }}
            onClick={async () => {
              try {
                await printHtmlDocument(recoveryCodePrintHtml(code));
              } catch (e) {
                await showAlert(
                  `Print failed: ${String((e as any)?.message ?? e)}.\n\n` +
                  `Please use "Copy to clipboard" and paste into a text editor, or write the code down before continuing.`,
                  { kind: "error" },
                );
              }
            }}
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
      background:
        "radial-gradient(1200px 800px at 30% 20%, #2c5282 0%, transparent 60%)," +
        "radial-gradient(900px 700px at 75% 80%, #4c1d95 0%, transparent 55%)," +
        "linear-gradient(160deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)",
      color: "#fff", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", zIndex: 9999,
    }}>
      <style>{`
        @keyframes echelon-spin { to { transform: rotate(360deg); } }
        input.echelon-win-pin::placeholder { color: rgba(255,255,255,0.55); letter-spacing: 0.5px; font-weight: 400; }
        input.echelon-win-pin:focus { outline: none; }
        button.echelon-win-link:hover { color: #fff; text-decoration: underline; }
      `}</style>
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
    width: "100%",
    boxSizing: "border-box",
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
  // ---- Windows 11-style unlock screen ----
  winShell: {
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: 0, padding: 0, background: "transparent",
    width: 340, color: "#fff",
  },
  winAvatar: {
    width: 128, height: 128, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(255,255,255,0.10)",
    border: "1px solid rgba(255,255,255,0.18)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    color: "#fff",
    boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
  },
  winName: {
    marginTop: 22, fontSize: 28, fontWeight: 600,
    letterSpacing: 0.2, textAlign: "center",
    textShadow: "0 1px 2px rgba(0,0,0,0.35)",
  },
  winDotsRow: {
    marginTop: 18, display: "grid",
    gridTemplateColumns: "repeat(3, 6px)", gap: 6,
    justifyContent: "center",
  },
  winDot: {
    width: 6, height: 6, borderRadius: "50%",
    background: "rgba(255,255,255,0.85)",
  },
  winHint: {
    marginTop: 14, fontSize: 15, textAlign: "center",
    color: "rgba(255,255,255,0.9)", fontWeight: 400,
  },
  winInputWrap: {
    marginTop: 18, width: 280, position: "relative",
    display: "flex", alignItems: "center",
    background: "rgba(0,0,0,0.35)",
    borderRadius: 4,
    borderBottom: "2px solid #b78af7",
    boxShadow: "0 0 0 1px rgba(255,255,255,0.08) inset",
  },
  winInput: {
    flex: 1, minWidth: 0,
    background: "transparent", color: "#fff",
    border: "none", outline: "none",
    fontSize: 15, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    padding: "9px 12px", letterSpacing: 2,
    caretColor: "#fff",
  },
  winEyeBtn: {
    background: "transparent", border: "none", color: "rgba(255,255,255,0.75)",
    cursor: "pointer", padding: "4px 8px",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  winSubmitBtn: {
    background: "transparent", border: "none", color: "#fff",
    padding: "0 10px", height: 32,
    display: "flex", alignItems: "center", justifyContent: "center",
    borderLeft: "1px solid rgba(255,255,255,0.15)",
  },
  winSpinner: {
    display: "inline-block", width: 14, height: 14, borderRadius: "50%",
    border: "2px solid rgba(255,255,255,0.35)", borderTopColor: "#fff",
    animation: "echelon-spin 0.7s linear infinite",
  },
  winError: {
    marginTop: 12, fontSize: 12, textAlign: "center",
    color: "#fecaca",
    textShadow: "0 1px 2px rgba(0,0,0,0.35)",
    maxWidth: 300,
  },
  winLink: {
    marginTop: 22, background: "transparent", border: "none",
    color: "rgba(255,255,255,0.85)", fontSize: 13, cursor: "pointer",
    padding: 6,
  },
};
