import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  websiteWorkingCopyStatus,
  websiteWorkingCopyInit,
  websiteWorkingCopyPull,
  websitePatStatus,
  websiteListPointers,
  websiteListPublications,
  websiteHasPendingMedia,
  type WorkingCopyStatus,
  type PointerRow,
  type PublicationRow,
} from "../lib/website";

// Landing page for the Website module. Shows working-copy state and
// PAT connection status, plus quick links into each editor. The
// per-page editors live under src/screens/website/*.
export default function Website() {
  const nav = useNavigate();
  const [status, setStatus] = useState<WorkingCopyStatus | null>(null);
  const [patConnected, setPatConnected] = useState<boolean | null>(null);
  const [pointers, setPointers] = useState<PointerRow[]>([]);
  const [lastPub, setLastPub] = useState<PublicationRow | null>(null);
  const [pendingMedia, setPendingMedia] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pullMsg, setPullMsg] = useState<string | null>(null);

  async function refreshAll() {
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
    try {
      setPointers(await websiteListPointers());
    } catch { setPointers([]); }
    try {
      const pubs = await websiteListPublications(1);
      setLastPub(pubs[0] ?? null);
    } catch { setLastPub(null); }
    try {
      setPendingMedia(await websiteHasPendingMedia());
    } catch { setPendingMedia(false); }
  }

  useEffect(() => {
    void refreshAll();
  }, []);

  async function onInit() {
    setBusy(true);
    setErr(null);
    try {
      setStatus(await websiteWorkingCopyInit());
      await refreshAll();
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
      await refreshAll();
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

  // Pages that are ahead of what's live on GitHub. Includes a synthetic
  // "media" bucket when the working copy has un-pushed asset edits so
  // the Overview banner and Publish button reflect photo/logo changes,
  // not just JSON draft rows.
  const pendingFiles = useMemo(() => {
    const pageRows = pointers.filter(
      (p) => p.active_draft_rev != null && p.active_draft_rev !== p.last_pushed_rev,
    );
    if (pendingMedia) {
      return [
        ...pageRows,
        { file: "media", active_draft_rev: null, last_pushed_rev: null, updated_at: "" } as unknown as PointerRow,
      ];
    }
    return pageRows;
  }, [pointers, pendingMedia]);

  // Map file key → true for the tile badges.
  const pendingByFile = useMemo(() => {
    const m: Record<string, true> = {};
    for (const p of pendingFiles) m[p.file] = true;
    return m;
  }, [pendingFiles]);

  const pubStateLabel = lastPub
    ? lastPub.state === "verified_live" ? "Live on GitHub Pages"
    : lastPub.state === "dry_run_complete" ? "Dry run only"
    : lastPub.state === "no_changes" ? "No changes"
    : lastPub.state
    : "—";
  const pubStateColor = lastPub?.state === "verified_live" ? "#166534"
    : lastPub?.state === "dry_run_complete" ? "#7c3aed"
    : lastPub?.state === "no_changes" ? "#334155"
    : lastPub?.error ? "#b91c1c"
    : "#334155";

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

      {/* ─── Needs your attention ─────────────────────────────────── */}
      {status?.cloned && (
        <section
          style={{
            marginTop: 20,
            padding: 18,
            borderRadius: 12,
            border: pendingFiles.length > 0 ? "1px solid #fed7aa" : "1px solid #bbf7d0",
            background: pendingFiles.length > 0
              ? "linear-gradient(180deg, rgba(254,215,170,0.35), rgba(254,215,170,0.10))"
              : "linear-gradient(180deg, rgba(187,247,208,0.35), rgba(187,247,208,0.10))",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 22 }}>{pendingFiles.length > 0 ? "📝" : "✅"}</span>
            <b style={{ fontSize: 16, color: "#0f172a" }}>
              {pendingFiles.length > 0
                ? `${pendingFiles.length} page${pendingFiles.length === 1 ? "" : "s"} waiting to publish`
                : "Everything is published"}
            </b>
          </div>
          {pendingFiles.length > 0 ? (
            <>
              <div style={{ fontSize: 13, color: "#475569", marginBottom: 12 }}>
                These pages have draft edits that haven't been pushed live yet:
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {pendingFiles.map((p) => (
                  <button
                    key={p.file}
                    onClick={() => nav(p.file === "media" ? "/website/gallery" : `/website/${p.file}`)}
                    style={{
                      fontSize: 12,
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: "1px solid #fed7aa",
                      background: "white",
                      color: "#9a3412",
                      cursor: "pointer",
                    }}
                  >
                    {editorLabel(p.file)}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => nav("/website/preview")} style={{ fontSize: 13 }}>
                  Preview site →
                </button>
                <button
                  className="btn"
                  onClick={() => nav("/website/publish")}
                  style={{ fontSize: 13, background: "#1d5fa3", color: "white" }}
                >
                  Publish {pendingFiles.length} change{pendingFiles.length === 1 ? "" : "s"} →
                </button>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: "#166534" }}>
              No pending drafts. Every page is in sync with what's live on the site.
            </div>
          )}
        </section>
      )}

      {/* ─── At-a-glance status strip ─────────────────────────────── */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 16 }}>
        {/* Last publish */}
        <div style={panelStyle}>
          <div style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Last publish</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: pubStateColor }}>{pubStateLabel}</div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
            {lastPub?.ended_at ?? lastPub?.started_at ?? "No publishes yet"}
          </div>
          {lastPub?.commit_sha && (
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2, fontFamily: "ui-monospace, Menlo, monospace" }}>
              {lastPub.commit_sha.slice(0, 8)}
            </div>
          )}
          {lastPub?.error && (
            <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 6 }}>{lastPub.error}</div>
          )}
        </div>

        {/* PAT connection */}
        <div style={panelStyle}>
          <div style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>GitHub connection</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: patConnected ? "#166534" : "#b45309" }}>
            {patConnected === null ? "…" : patConnected ? "Connected ✓" : "Not connected"}
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
            {patConnected
              ? "Ready to publish."
              : "Add a GitHub token to publish real changes."}
          </div>
          <button
            className="btn"
            onClick={() => nav("/website/settings")}
            style={{ fontSize: 12, padding: "5px 12px", marginTop: 8 }}
          >
            {patConnected ? "Manage token" : "Connect now →"}
          </button>
        </div>

        {/* Working copy */}
        <div style={panelStyle}>
          <div style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Working copy</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: status?.cloned ? "#166534" : "#b45309" }}>
            {status ? (status.cloned ? "Ready" : "Not set up") : "…"}
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 4, fontFamily: "ui-monospace, Menlo, monospace" }}>
            {status?.head_sha ? `HEAD ${status.head_sha.slice(0, 8)}` : "—"}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {!status?.cloned && (
              <button className="btn" disabled={busy} onClick={onInit} style={{ fontSize: 12, padding: "5px 12px" }}>
                {busy ? "Cloning…" : "Set up"}
              </button>
            )}
            {status?.cloned && (
              <button className="btn" disabled={busy} onClick={onPull} style={{ fontSize: 12, padding: "5px 12px" }}>
                {busy ? "Pulling…" : "Pull from GitHub"}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ─── Start here (first-time guide, only if nothing is happening) ── */}
      {status?.cloned && pendingFiles.length === 0 && !lastPub && (
        <section style={{ ...panelStyle, marginTop: 16, background: "linear-gradient(180deg, rgba(226,232,240,0.4), white)" }}>
          <b style={{ fontSize: 14 }}>Start here</b>
          <ol style={{ margin: "8px 0 0", paddingLeft: 20, fontSize: 13, color: "#475569", lineHeight: 1.7 }}>
            <li>Pick a page below to <b>edit</b>.</li>
            <li>Click <b>Preview</b> at the top of the editor to see your changes.</li>
            <li>Come back here and click <b>Publish</b> to push them to the live site.</li>
          </ol>
        </section>
      )}

      <section style={{ marginTop: 28 }}>
        <h2 style={{ marginBottom: 8 }}>Edit pages</h2>
        {status && !status.cloned && (
          <div className="home-alert tone-info" style={{ marginBottom: 12 }}>
            Set up the working copy first — the page tiles unlock once
            the site content has finished downloading.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {editors.map((e) => {
            const isPending = pendingByFile[e.key];
            return (
              <button
                key={e.key}
                onClick={() => nav(`/website/${e.key}`)}
                disabled={!status?.cloned}
                style={{
                  textAlign: "left",
                  padding: 16,
                  borderRadius: 10,
                  border: isPending ? "1px solid #fdba74" : "1px solid rgba(0,0,0,0.1)",
                  background: isPending ? "linear-gradient(180deg, rgba(254,215,170,0.20), white)" : "white",
                  cursor: status?.cloned ? "pointer" : "not-allowed",
                  opacity: status?.cloned ? 1 : 0.5,
                  position: "relative",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{e.label}</div>
                  {isPending && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "#fed7aa", color: "#9a3412" }}>
                      DRAFT
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted, #64748b)", marginTop: 4 }}>{e.desc}</div>
              </button>
            );
          })}
          <button
            onClick={() => nav("/website/gallery")}
            disabled={!status?.cloned}
            style={{
              textAlign: "left", padding: 16, borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.1)", background: "white",
              cursor: status?.cloned ? "pointer" : "not-allowed",
              opacity: status?.cloned ? 1 : 0.5,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 15 }}>Gallery</div>
            <div style={{ fontSize: 12, color: "var(--muted, #64748b)", marginTop: 4 }}>
              Manage photos and videos shown on the site's gallery page.
            </div>
          </button>
          <button
            onClick={() => nav("/website/assets")}
            disabled={!status?.cloned}
            style={{
              textAlign: "left", padding: 16, borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.1)", background: "white",
              cursor: status?.cloned ? "pointer" : "not-allowed",
              opacity: status?.cloned ? 1 : 0.5,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 15 }}>Logo &amp; icons</div>
            <div style={{ fontSize: 12, color: "var(--muted, #64748b)", marginTop: 4 }}>
              Logo, favicons (auto-regenerated), and Open Graph image.
            </div>
          </button>
        </div>
      </section>

      <section style={{ marginTop: 28 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button
            className="btn"
            onClick={() => nav("/website/preview")}
            disabled={!status?.cloned}
            title={status?.cloned ? "" : "Working copy not cloned yet"}
          >
            Preview site
          </button>
          <button
            className="btn"
            onClick={() => nav("/website/history")}
            disabled={!status?.cloned}
            title={status?.cloned ? "" : "Working copy not cloned yet"}
          >
            Version history
          </button>
          <button
            className="btn"
            onClick={() => nav("/website/publish")}
            disabled={!status?.cloned}
            title={status?.cloned ? "" : "Working copy not cloned yet"}
            style={pendingFiles.length > 0 ? { background: "#1d5fa3", color: "white" } : undefined}
          >
            Publish{pendingFiles.length > 0 ? ` (${pendingFiles.length})` : "…"}
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

function editorLabel(file: string): string {
  switch (file) {
    case "site": return "Site (global)";
    case "home": return "Home";
    case "about": return "About";
    case "services": return "Programs & Waiting List";
    case "contact": return "Contact";
    case "tour": return "Virtual Tour";
    case "careers": return "Careers";
    case "seo": return "SEO";
    case "gallery-videos": return "Gallery videos";
    case "media": return "Photos & assets";
    default: return file;
  }
}
