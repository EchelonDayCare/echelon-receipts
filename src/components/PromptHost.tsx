import { useEffect, useRef, useState } from "react";
import { _bindPromptHost } from "../lib/dialogs";

// Global overlay that services showPrompt() calls. Mounted once at the app
// root so any screen can await user text input without relying on
// window.prompt() (which opens behind the main window on Tauri/WebView2).
export default function PromptHost() {
  const [req, setReq] = useState<{
    message: string;
    defaultValue: string;
    resolve: (v: string | null) => void;
  } | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    _bindPromptHost((r) => {
      setReq(r);
      setValue(r.defaultValue || "");
      // Focus after the modal is on screen.
      setTimeout(() => inputRef.current?.focus(), 0);
    });
    return () => _bindPromptHost(null);
  }, []);

  if (!req) return null;

  function submit(ok: boolean) {
    const r = req!;
    setReq(null);
    r.resolve(ok ? value : null);
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) submit(false); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: 120, zIndex: 2000,
      }}
    >
      <div className="card" style={{ width: "min(480px, 92vw)", margin: 0 }}>
        <div style={{ whiteSpace: "pre-wrap", marginBottom: 12 }}>{req.message}</div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(true);
            else if (e.key === "Escape") submit(false);
          }}
          style={{ width: "100%", marginBottom: 12 }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn secondary" onClick={() => submit(false)}>Cancel</button>
          <button className="btn" onClick={() => submit(true)}>OK</button>
        </div>
      </div>
    </div>
  );
}
