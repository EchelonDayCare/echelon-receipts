import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  websiteListRevisions,
  websiteLoadRevision,
  websiteRestoreRevision,
  websiteListPointers,
  EDITABLE_FILES,
  type EditableFile,
  type RevisionRow,
  type PointerRow,
} from "../../lib/website";

// Version history screen. Lets the user pick a page, browse its
// revision timeline, preview an old revision's JSON, and restore any
// prior version as a new draft.
export default function History() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const initialFile = (params.get("file") ?? "site") as EditableFile;
  const [file, setFile] = useState<EditableFile>(
    EDITABLE_FILES.includes(initialFile) ? initialFile : "site",
  );
  const [rows, setRows] = useState<RevisionRow[]>([]);
  const [pointers, setPointers] = useState<PointerRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedJson, setSelectedJson] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const pointer = useMemo(
    () => pointers.find((p) => p.file === file) ?? null,
    [pointers, file],
  );

  async function loadList() {
    setBusy(true);
    setErr(null);
    try {
      const [r, p] = await Promise.all([
        websiteListRevisions(file, 100),
        websiteListPointers(),
      ]);
      setRows(r);
      setPointers(p);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setSelected(null);
    setSelectedJson(null);
    setMsg(null);
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  async function onSelect(id: number) {
    setSelected(id);
    setSelectedJson(null);
    setErr(null);
    try {
      const raw = await websiteLoadRevision(id);
      try {
        setSelectedJson(JSON.stringify(JSON.parse(raw), null, 2));
      } catch {
        setSelectedJson(raw);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  async function onRestore(id: number) {
    if (!confirm(`Restore revision #${id} as a new draft? Your current draft will be preserved in history.`)) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const newId = await websiteRestoreRevision(id);
      setMsg(`Restored as new revision #${newId}. Open the editor to save changes.`);
      await loadList();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn link" onClick={() => nav("/website")} style={{ padding: 0 }}>
          ← Website
        </button>
        <h1 style={{ margin: 0 }}>Version history</h1>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
        <label style={{ fontSize: 13 }}>Page:</label>
        <select
          value={file}
          onChange={(e) => {
            const next = e.target.value as EditableFile;
            setFile(next);
            setParams({ file: next });
          }}
          style={{ padding: 6, fontSize: 14, borderRadius: 6, border: "1px solid rgba(0,0,0,0.15)" }}
        >
          {EDITABLE_FILES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void loadList()} disabled={busy} style={{ marginLeft: "auto" }}>
          Refresh
        </button>
      </div>

      {pointer && (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted, #64748b)" }}>
          Active draft rev: <b>{pointer.active_draft_rev ?? "—"}</b> · last pushed:{" "}
          <b>{pointer.last_pushed_rev ?? "—"}</b> · last verified live:{" "}
          <b>{pointer.last_verified_live_rev ?? "—"}</b>
        </div>
      )}

      {err && (
        <div className="home-alert tone-danger" style={{ margin: "12px 0" }}>
          ⚠ {err}
        </div>
      )}
      {msg && (
        <div className="home-alert tone-info" style={{ margin: "12px 0" }}>
          ✓ {msg}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16, marginTop: 12 }}>
        <div style={{ maxHeight: "70vh", overflow: "auto", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 8 }}>
          {rows.length === 0 && !busy && (
            <div style={{ padding: 16, color: "var(--muted, #64748b)", fontSize: 13 }}>
              No revisions yet. Save a draft to create the first one.
            </div>
          )}
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => void onSelect(r.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: 10,
                borderBottom: "1px solid rgba(0,0,0,0.05)",
                background: selected === r.id ? "#eff6ff" : "white",
                border: 0,
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <b>#{r.id}</b>
                {pointer?.active_draft_rev === r.id && (
                  <span style={{ fontSize: 10, background: "#dbeafe", color: "#1e40af", padding: "1px 6px", borderRadius: 4 }}>
                    active draft
                  </span>
                )}
                {pointer?.last_pushed_rev === r.id && (
                  <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 4 }}>
                    last pushed
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted, #64748b)" }}>
                {r.created_at} {r.author ? `— ${r.author}` : ""}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted, #64748b)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.preview}
              </div>
            </button>
          ))}
        </div>
        <div>
          {selected == null && (
            <div style={{ color: "var(--muted, #64748b)", fontSize: 13 }}>Pick a revision to preview.</div>
          )}
          {selected != null && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Revision #{selected}</span>
                <button className="btn" onClick={() => void onRestore(selected)} disabled={busy} style={{ marginLeft: "auto" }}>
                  Restore this version as new draft
                </button>
              </div>
              <textarea
                readOnly
                value={selectedJson ?? "Loading…"}
                style={{
                  width: "100%",
                  minHeight: 500,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                  fontSize: 12,
                  padding: 12,
                  border: "1px solid rgba(0,0,0,0.15)",
                  borderRadius: 8,
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
