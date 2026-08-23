import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  websitePublish,
  websiteListPublications,
  websitePatStatus,
  websiteListPointers,
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

  async function reload() {
    try {
      const [p, pubs, pat] = await Promise.all([
        websiteListPointers(),
        websiteListPublications(20),
        websitePatStatus(),
      ]);
      setPointers(p);
      setPublications(pubs);
      setConnected(pat.connected);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

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
        {pendingFiles.length === 0 ? (
          <div style={{ color: "var(--muted, #64748b)", fontSize: 13 }}>
            No draft changes are ahead of the last published revision.
          </div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
            {pendingFiles.map((p) => (
              <li key={p.file}>
                <b>{p.file}</b> — draft rev {p.active_draft_rev} · last pushed {p.last_pushed_rev ?? "never"}
              </li>
            ))}
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
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <span>
            <b>Dry run</b> — render & commit locally but DO NOT push to GitHub. Recommended for
            PR 2 until you have manually confirmed the workflow.
          </span>
        </label>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button className="btn" onClick={onPublish} disabled={busy}>
            {busy ? "Publishing…" : dryRun ? "Run dry publish" : "Publish for real"}
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
            <div>State: <b>{outcome.final_state}</b></div>
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
                  <td style={td}>{p.state}</td>
                  <td style={td}>{p.commit_sha ? p.commit_sha.slice(0, 8) : "—"}</td>
                  <td style={td}>{p.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
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
