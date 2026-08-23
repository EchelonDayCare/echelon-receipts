import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  websiteStartPreview,
  websiteStopPreview,
  type PreviewInfo,
} from "../../lib/website";

// Live preview of the rendered site inside an iframe pointing at the
// tiny_http server the backend started. Clicking "Refresh" re-renders
// from the current drafts + working copy and reloads the iframe.
export default function Preview() {
  const nav = useNavigate();
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  async function refresh() {
    setBusy(true);
    setErr(null);
    try {
      const p = await websiteStartPreview();
      setInfo(p);
      // Force iframe reload with a cache-buster because tiny_http
      // sets no-store but browsers still cache aggressively.
      if (iframeRef.current) {
        iframeRef.current.src = `${p.url}?t=${Date.now()}`;
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    // Stop the server when leaving the screen.
    return () => {
      void websiteStopPreview();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header
        style={{
          padding: "12px 20px",
          borderBottom: "1px solid rgba(0,0,0,0.1)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button className="btn link" onClick={() => nav("/website")} style={{ padding: 0 }}>
          ← Website
        </button>
        <h1 style={{ margin: 0, fontSize: 18 }}>Preview</h1>
        <span style={{ marginLeft: 8, color: "var(--muted, #64748b)", fontSize: 12 }}>
          {info ? `${info.url} — ${info.pages.length} pages` : "…"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn" onClick={refresh} disabled={busy}>
            {busy ? "Rendering…" : "Refresh preview"}
          </button>
        </div>
      </header>
      {err && (
        <div className="home-alert tone-danger" style={{ margin: "12px 20px" }}>
          ⚠ {err}
        </div>
      )}
      <div style={{ flex: 1, background: "#111827" }}>
        {info && (
          <iframe
            ref={iframeRef}
            src={info.url}
            title="Site preview"
            style={{ width: "100%", height: "100%", border: 0, background: "white" }}
          />
        )}
      </div>
    </div>
  );
}
