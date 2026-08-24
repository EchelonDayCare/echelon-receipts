import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  websitePublish,
  websiteListPublications,
  websitePatStatus,
  websiteListPointers,
  websiteHasPendingMedia,
  type PublicationRow,
  type PipelineOutcome,
  type PointerRow,
} from "../../lib/website";

// Publish screen. Shows what's about to go out (which pages have new
// drafts), lets the user choose commit message + dry-run mode, and
// shows a live log of the state machine progressing.
export default function Publish() {
  const nav = useNavigate();
  const [pointers, setPointers] = useState<PointerRow[]>([]);
  const [publications, setPublications] = useState<PublicationRow[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [commitMsg, setCommitMsg] = useState<string>("CMS content update");
  const [author, setAuthor] = useState<string>("");
  const [dryRun, setDryRun] = useState<boolean>(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PipelineOutcome | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingMedia, setPendingMedia] = useState(false);

  async function reload() {
    try {
      const [p, pubs, pat, media] = await Promise.all([
        websiteListPointers(),
        websiteListPublications(20),
        websitePatStatus(),
        websiteHasPendingMedia().catch(() => false),
      ]);
      setPointers(p);
      setPublications(pubs);
      setConnected(pat.connected);
      setPendingMedia(media);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  // Block navigation while a publish is in-flight — the pipeline runs
  // in the Rust worker regardless of what the UI does, so navigating
  // away mid-publish leaves the user without the progress indicator
  // and can double-fire the button on return.
  useEffect(() => {
    if (!busy) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onAnchorClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (!href.startsWith("#/")) return;
      const currentHash = window.location.hash || "#/";
      if (href === currentHash) return;
      if (!window.confirm("A publish is in progress. Leave anyway?")) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onAnchorClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onAnchorClick, true);
    };
  }, [busy]);

  async function onPublish() {
    setBusy(true);
    setErr(null);
    setOutcome(null);
    try {
      const o = await websitePublish({
        commit_message: commitMsg.trim() || "CMS content update",
        author_display: author.trim() || undefined,
        dry_run: dryRun,
      });
      setOutcome(o);
      await reload();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function onPublishClick() {
    if (!dryRun) {
      setConfirmOpen(true);
      return;
    }
    void onPublish();
  }

  const pendingFiles = pointers.filter(
    (p) => p.active_draft_rev != null && p.active_draft_rev !== p.last_pushed_rev,
  );

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn link" onClick={() => nav("/website")} style={{ padding: 0 }}>
          ← Website
        </button>
        <h1 style={{ margin: 0 }}>Publish</h1>
      </div>

      {connected === false && !dryRun && (
        <div className="home-alert tone-danger" style={{ margin: "12px 0" }}>
          You haven't connected a GitHub token yet.{" "}
          <button className="btn link" onClick={() => nav("/website/settings")}>
            Connect one →
          </button>
        </div>
      )}

      <section style={panelStyle}>
        <h3 style={{ marginTop: 0 }}>Pending changes</h3>
        {pendingFiles.length === 0 && !pendingMedia ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#166534" }}>
            <span style={{ fontSize: 22 }}>✅</span>
            <div style={{ fontSize: 13 }}>
              Everything is up to date. There are no draft changes waiting to publish.
            </div>
          </div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
            {pendingFiles.map((p) => (
              <li key={p.file}>
                <b>{p.file}</b> — draft rev {p.active_draft_rev} · last pushed {p.last_pushed_rev ?? "never"}
              </li>
            ))}
            {pendingMedia && (
              <li key="__media__">
                <b>Photos &amp; assets</b> — uncommitted media in the working copy
              </li>
            )}
          </ul>
        )}
      </section>

      <section style={panelStyle}>
        <h3 style={{ marginTop: 0 }}>Publish options</h3>
        <label style={{ display: "block", marginBottom: 8, fontSize: 13 }}>
          Commit message
          <input
            type="text"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "block", marginBottom: 8, fontSize: 13 }}>
          Author (optional)
          <input
            type="text"
            placeholder="e.g. Alok M."
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, padding: 10, background: dryRun ? "#f1f5f9" : "#fef3c7", borderRadius: 6 }}>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <b>{dryRun ? "Dry run (safe)" : "Real publish (LIVE)"}</b>
            <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
              {dryRun
                ? "Render and commit locally only — nothing is pushed to GitHub. Use this to check the build before going live."
                : "Push to GitHub and update the live site at echelondaycare.com. Visitors will see the changes."}
            </div>
          </span>
        </label>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button
            className="btn"
            onClick={onPublishClick}
            disabled={busy}
            style={!dryRun ? { background: "#1d5fa3", color: "white" } : undefined}
          >
            {busy ? "Publishing…" : dryRun ? "Run dry publish" : "Publish to live site →"}
          </button>
        </div>
      </section>

      {err && (
        <div className="home-alert tone-danger" style={{ margin: "12px 0" }}>
          ⚠ {err}
        </div>
      )}

      {outcome && (
        <section style={panelStyle}>
          <h3 style={{ marginTop: 0 }}>Last publish</h3>
          <div style={{ fontSize: 13 }}>
            <div>Publication #{outcome.publication_id}</div>
            <div>
              State:{" "}
              <b>
                {outcome.final_state === "verified_live"
                  ? "✅ Published — site is live"
                  : outcome.final_state === "dry_run_complete"
                    ? "🧪 Dry run complete — nothing was pushed"
                    : outcome.final_state === "no_changes"
                      ? "ℹ Nothing to publish — everything is already live"
                      : outcome.final_state}
              </b>
            </div>
            {outcome.commit_sha && <div>Commit: <code>{outcome.commit_sha}</code></div>}
            {outcome.verified_url && <div>Verified URL: {outcome.verified_url}</div>}
            {outcome.error && (
              <div style={{ color: "#b91c1c", marginTop: 8 }}>Error: {outcome.error}</div>
            )}
            <div style={{ marginTop: 8 }}>Pages written: {outcome.pages_written.join(", ") || "(none)"}</div>
          </div>
        </section>
      )}

      <section style={panelStyle}>
        <h3 style={{ marginTop: 0 }}>Recent publications</h3>
        {publications.length === 0 ? (
          <div style={{ color: "var(--muted, #64748b)", fontSize: 13 }}>Nothing yet.</div>
        ) : (
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>ID</th>
                <th style={th}>Started</th>
                <th style={th}>State</th>
                <th style={th}>Commit</th>
                <th style={th}>Error</th>
              </tr>
            </thead>
            <tbody>
              {publications.map((p) => (
                <tr key={p.id}>
                  <td style={td}>{p.id}</td>
                  <td style={td}>{p.started_at}</td>
                  <td style={td}><StateChip state={p.state} error={p.error} /></td>
                  <td style={td}>{p.commit_sha ? p.commit_sha.slice(0, 8) : "—"}</td>
                  <td style={td}>{p.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {confirmOpen && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}
          onClick={() => !busy && setConfirmOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white", borderRadius: 12, padding: 24,
              maxWidth: 520, width: "90%", boxShadow: "0 25px 50px -12px rgba(0,0,0,0.4)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 28 }}>🚀</span>
              <h2 style={{ margin: 0, fontSize: 18 }}>Publish to the live site?</h2>
            </div>
            <p style={{ fontSize: 13, color: "#475569", marginTop: 0 }}>
              This will commit your draft changes to GitHub and update{" "}
              <b>echelondaycare.com</b> within a minute or two. Visitors will
              see the new content immediately.
            </p>

            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                {pendingFiles.length === 0 && !pendingMedia
                  ? "No pending changes"
                  : `${pendingFiles.length}${pendingMedia ? " + media" : ""} change${pendingFiles.length === 1 && !pendingMedia ? "" : "s"} will publish:`}
              </div>
              {(pendingFiles.length > 0 || pendingMedia) && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#475569" }}>
                  {pendingFiles.map((p) => <li key={p.file}><b>{p.file}</b></li>)}
                  {pendingMedia && <li key="__media__"><b>Photos &amp; assets</b></li>}
                </ul>
              )}
              <div style={{ marginTop: 10, fontSize: 12, color: "#64748b" }}>
                Commit message: <i>{commitMsg.trim() || "CMS content update"}</i>
              </div>
            </div>

            {!connected && (
              <div className="home-alert tone-danger" style={{ marginTop: 12, fontSize: 12 }}>
                ⚠ No GitHub token connected — publish will fail. Connect one from Settings first.
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <button className="btn" disabled={busy} onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
              <button
                className="btn"
                disabled={busy || !connected}
                onClick={async () => {
                  // Keep the confirm modal mounted while the pipeline
                  // runs so the user can watch state progress and
                  // cannot accidentally re-trigger publish via the
                  // outer button. The modal auto-closes only after
                  // onPublish resolves (or the user cancels post-run).
                  await onPublish();
                  setConfirmOpen(false);
                }}
                style={{ background: "#1d5fa3", color: "white" }}
              >
                {busy ? "Publishing…" : "Yes, publish to live site"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StateChip({ state, error }: { state: string; error: string | null }) {
  const color = error ? "#b91c1c"
    : state === "verified_live" ? "#166534"
    : state === "dry_run_complete" ? "#7c3aed"
    : state === "no_changes" ? "#334155"
    : "#334155";
  const bg = error ? "#fee2e2"
    : state === "verified_live" ? "#dcfce7"
    : state === "dry_run_complete" ? "#ede9fe"
    : "#f1f5f9";
  const label = error ? "failed"
    : state === "verified_live" ? "live"
    : state === "dry_run_complete" ? "dry run"
    : state === "no_changes" ? "no changes"
    : state;
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 999,
      fontSize: 11, fontWeight: 600, color, background: bg,
    }}>{label}</span>
  );
}

const panelStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  borderRadius: 10,
  border: "1px solid rgba(0,0,0,0.1)",
  background: "white",
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  marginTop: 4,
  fontSize: 14,
  borderRadius: 6,
  border: "1px solid rgba(0,0,0,0.15)",
};

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  borderBottom: "1px solid rgba(0,0,0,0.1)",
  fontWeight: 600,
};

const td: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid rgba(0,0,0,0.05)",
  verticalAlign: "top",
};
