import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { showAlert } from "../lib/dialogs";

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
    try {
      await invoke("v2_lock");
      window.location.reload();
    } catch (e) {
      void showAlert(`Lock failed: ${e}`, { kind: "error" });
    }
  };

  const padding = Math.max(8, Math.round(size * 0.55));

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Lock the app"
      title={isSetUp === false ? "PIN not configured" : "Lock app"}
      style={{
        background: "var(--panel, #fff)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: `${padding}px ${padding + 2}px`,
        color: isSetUp === false ? "#9aa3b2" : "#1a1f36",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        boxShadow: "0 6px 20px -8px rgba(15, 23, 42, 0.35)",
        transition: "transform 160ms ease-out, box-shadow 160ms ease-out",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-2px)";
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          "0 10px 24px -8px rgba(15, 23, 42, 0.45)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "translateY(0)";
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          "0 6px 20px -8px rgba(15, 23, 42, 0.35)";
      }}
    >
      <span aria-hidden style={{ fontSize: size, lineHeight: 1, opacity: isSetUp === false ? 0.45 : 1 }}>🔒</span>
    </button>
  );
}
