import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { showAlert, showConfirm } from "../lib/dialogs";

type V2State = { isSetUp: boolean; isUnlocked: boolean; hasRecovery: boolean };

// Manual lock button. Mirrors the "Lock now" action in
// SecuritySettingsSection so a manager stepping away from the machine
// doesn't have to wait for the idle-lock timeout.
// Hidden when PIN security isn't set up (nothing to lock into).
export default function LockButton({ size = 40 }: { size?: number }) {
  const [isSetUp, setIsSetUp] = useState<boolean | null>(null);

  useEffect(() => {
    invoke<V2State>("v2_state")
      .then((s) => setIsSetUp(!!s?.isSetUp))
      .catch(() => setIsSetUp(false));
  }, []);

  const onClick = async () => {
    if (isSetUp === false) {
      void showAlert(
        "PIN security isn't set up yet. Open Settings → Device security to enable it.",
        { kind: "info" },
      );
      return;
    }
    if (!(await showConfirm("Lock the app now? You'll need to enter your PIN to continue."))) return;
    try {
      await invoke("v2_lock");
      window.location.reload();
    } catch (e) {
      void showAlert(`Lock failed: ${e}`, { kind: "error" });
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Lock the app"
      title={isSetUp === false ? "PIN not configured" : "Lock app"}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        border: "1px solid #e3e6ee",
        background: "#fff",
        color: isSetUp === false ? "#9aa3b2" : "#1a1f36",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 1px 3px rgba(15,23,42,0.08)",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#f6f7fb"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#fff"; }}
    >
      <svg
        width={Math.round(size * 0.5)}
        height={Math.round(size * 0.5)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
    </button>
  );
}
