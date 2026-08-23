import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  websiteWorkingCopyStatus,
  websiteWorkingCopyInit,
  websiteWorkingCopyPull,
  websitePatStatus,
  type WorkingCopyStatus,
} from "../lib/website";

// Landing page for the Website module. Shows working-copy state and
// PAT connection status, plus quick links into each editor. The
// per-page editors live under src/screens/website/*.
export default function Website() {
  const nav = useNavigate();
  const [status, setStatus] = useState<WorkingCopyStatus | null>(null);
  const [patConnected, setPatConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pullMsg, setPullMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setStatus(await websiteWorkingCopyStatus());
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      }
      try {
        const p = await websitePatStatus();
        setPatConnected(p.connected);
      } catch {
        setPatConnected(false);
      }
    })();
  }, []);

  async function onInit() {
    setBusy(true);
    setErr(null);
    try {
      setStatus(await websiteWorkingCopyInit());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function onPull() {
    setBusy(true);
    setErr(null);
    setPullMsg(null);
    try {
      const sha = await websiteWorkingCopyPull();
      setPullMsg(`Fast-forwarded to ${sha.slice(0, 7)}`);
      setStatus(await websiteWorkingCopyStatus());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const editors = [
    { key: "site", label: "Site (brand, nav, contact)", desc: "Global brand, nav labels, phone, email, address." },
    { key: "home", label: "Home", desc: "Hero heading, gallery preview, stats, FAQ." },
    { key: "about", label: "About", desc: "Vision, mission, team, neighborhoods." },
    { key: "services", label: "Programs & waiting list", desc: "Daycare program copy, brochure link, waiting-list form." },
    { key: "contact", label: "Contact", desc: "Heading, map iframe, social labels." },
    { key: "tour", label: "Virtual tour", desc: "Video source, poster, fallback text." },
    { key: "careers", label: "Careers", desc: "Hiring banner, job postings, apply modal copy." },
    { key: "seo", label: "SEO", desc: "Per-page title / description / canonical." },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4 }}>Website</h1>
      <p style={{ color: "var(--muted, #64748b)", marginTop: 0 }}>
        Edit the Echelon Day Care site content, preview locally, and publish to GitHub Pages.
      </p>

      {err && (
        <div className="home-alert tone-danger" style={{ margin: "16px 0" }}>
          ⚠ {err}
        </div>
      )}
      {pullMsg && (
        <div className="home-alert tone-info" style={{ margin: "16px 0" }}>
          {pullMsg}
        </div>
      )}

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>
        <div style={panelStyle}>
          <h3 style={{ marginTop: 0 }}>Working copy</h3>
          <div style={{ fontSize: 12, color: "var(--muted, #64748b)", wordBreak: "break-all" }}>
            {status?.root || "…"}
          </div>
          <ul style={{ margin: "12px 0 16px", padding: 0, listStyle: "none", fontSize: 14 }}>
            <li>Cloned: <b>{yesNo(status?.cloned)}</b></li>
            <li>content/ present: <b>{yesNo(status?.content_present)}</b></li>
            <li>templates/ present: <b>{yesNo(status?.templates_present)}</b></li>
            <li>HEAD: <b>{status?.head_sha ? status.head_sha.slice(0, 12) : "—"}</b></li>
          </ul>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!status?.cloned && (
              <button className="btn" disabled={busy} onClick={onInit}>
                {busy ? "Cloning…" : "Set up working copy"}
              </button>
            )}
            {status?.cloned && (
              <button className="btn" disabled={busy} onClick={onPull}>
                {busy ? "Pulling…" : "Pull latest from GitHub"}
              </button>
            )}
          </div>
        </div>

        <div style={panelStyle}>
          <h3 style={{ marginTop: 0 }}>Publish credentials</h3>
          <div style={{ fontSize: 14, marginBottom: 12 }}>
            GitHub PAT status:{" "}
            <b>
              {patConnected === null ? "…" : patConnected ? "Connected ✓" : "Not connected"}
            </b>
          </div>
          <p style={{ fontSize: 12, color: "var(--muted, #64748b)", marginTop: 0 }}>
            The token is stored in your OS keychain and never leaves this
            machine. Required only for real (non-dry-run) publishes.
          </p>
          <button className="btn" onClick={() => nav("/website/settings")}>
            Manage token…
          </button>
        </div>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ marginBottom: 8 }}>Pages</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {editors.map((e) => (
            <button
              key={e.key}
              onClick={() => nav(`/website/${e.key}`)}
              style={{
                textAlign: "left",
                padding: 16,
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.1)",
                background: "white",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 15 }}>{e.label}</div>
              <div style={{ fontSize: 12, color: "var(--muted, #64748b)", marginTop: 4 }}>{e.desc}</div>
            </button>
          ))}
          <div
            style={{
              padding: 16,
              borderRadius: 10,
              border: "1px dashed rgba(0,0,0,0.15)",
              background: "rgba(0,0,0,0.02)",
              color: "var(--muted, #64748b)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 15 }}>Gallery & media</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Coming in the media module (PR 3).</div>
          </div>
        </div>
      </section>

      <section style={{ marginTop: 28 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => nav("/website/preview")}>
            Preview site locally
          </button>
          <button className="btn" onClick={() => nav("/website/history")}>
            Version history
          </button>
          <button className="btn" onClick={() => nav("/website/publish")}>
            Publish…
          </button>
        </div>
      </section>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  padding: 16,
  borderRadius: 10,
  border: "1px solid rgba(0,0,0,0.1)",
  background: "white",
};

function yesNo(v: boolean | undefined): string {
  if (v === undefined) return "…";
  return v ? "yes" : "no";
}
