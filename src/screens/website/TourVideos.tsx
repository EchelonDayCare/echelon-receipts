import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  websiteTourAddVideos,
  websiteTourDeleteVideo,
  websiteTourListVideos,
  websiteTourReorderVideos,
  websiteWorkingCopyStatus,
  type TourVideo,
} from "../../lib/website";

// Tour videos editor (v3.22.0). Same UX pattern as Gallery:
//  • Upload button (multiple videos at a time) — ffmpeg extracts the
//    first-frame poster on the backend.
//  • Drag-drop reorder — first video plays by default on the live page.
//  • Delete button per video.
//  • Poster thumbnails render off the working-copy via convertFileSrc().
export default function TourVideos() {
  const nav = useNavigate();
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [items, setItems] = useState<TourVideo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TourVideo | null>(null);
  // Multi-select delete (v3.22.4) — parity with Careers jobs list.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [wc, list] = await Promise.all([
        websiteWorkingCopyStatus(),
        websiteTourListVideos(),
      ]);
      setRepoRoot(wc.root);
      setItems(list);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const posterUrl = useCallback(
    (rel: string): string | null => {
      if (!repoRoot || !rel) return null;
      const absPath = `${repoRoot}/repo/${rel}`;
      return convertFileSrc(absPath);
    },
    [repoRoot],
  );

  async function onUpload() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const picked = await open({
        multiple: true,
        filters: [
          {
            name: "Videos",
            extensions: ["mp4", "mov", "m4v", "webm"],
          },
        ],
      });
      const paths = pathsFromDialog(picked);
      if (paths.length === 0) return;
      const res = await websiteTourAddVideos(paths);
      setMsg(
        `Added ${res.added.length} video${res.added.length === 1 ? "" : "s"} — draft rev #${res.revision_id}`,
      );
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setBusy(true);
    setErr(null);
    try {
      const rev = await websiteTourDeleteVideo(pendingDelete.id);
      setMsg(`Deleted "${pendingDelete.title}" — draft rev #${rev}`);
      setPendingDelete(null);
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const allSelected = items.length > 0 && selectedIds.size === items.length;
  function toggleAllSelected() {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(items.map((v) => v.id)));
  }
  async function performBulkDelete() {
    if (selectedIds.size === 0) return;
    setBusy(true);
    setErr(null);
    try {
      let lastRev = 0;
      // Delete sequentially so each save_draft sees the previous state.
      for (const id of Array.from(selectedIds)) {
        const rev = await websiteTourDeleteVideo(id);
        lastRev = rev;
      }
      setMsg(`Deleted ${selectedIds.size} video${selectedIds.size === 1 ? "" : "s"} — draft rev #${lastRev}`);
      setSelectedIds(new Set());
      setBulkPending(false);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      // Always refresh, even on a partial-success bulk delete —
      // otherwise the UI keeps showing rows the backend already
      // removed, and the next click 404s.
      await refresh();
      setBusy(false);
    }
  }
  // Prune stale selections when the list changes (e.g. after a bulk delete
  // or an AI edit).
  useEffect(() => {
    setSelectedIds((prev) => {
      const ids = new Set(items.map((v) => v.id));
      const next = new Set<string>();
      prev.forEach((id) => { if (ids.has(id)) next.add(id); });
      return next;
    });
  }, [items]);

  async function commitReorder(next: TourVideo[]) {
    setItems(next);
    try {
      const rev = await websiteTourReorderVideos(next.map((v) => v.id));
      setMsg(`Reordered — draft rev #${rev}`);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      void refresh();
    }
  }

  function onDragStart(i: number) {
    return () => setDragIndex(i);
  }
  function onDragOver(i: number) {
    return (e: React.DragEvent) => {
      e.preventDefault();
      setDragOverIndex(i);
    };
  }
  function onDrop(i: number) {
    return (e: React.DragEvent) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === i) {
        setDragIndex(null);
        setDragOverIndex(null);
        return;
      }
      const next = items.slice();
      const [moved] = next.splice(dragIndex, 1);
      next.splice(i, 0, moved);
      setDragIndex(null);
      setDragOverIndex(null);
      void commitReorder(next);
    };
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button className="btn link" onClick={() => nav("/website")} style={{ padding: 0 }}>
          ← Website
        </button>
        <h1 style={{ margin: 0 }}>Tour videos</h1>
        <span style={{ color: "var(--muted, #64748b)", fontSize: 13 }}>
          {items.length} video{items.length === 1 ? "" : "s"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => nav("/website/preview?page=tour")}>
            Preview →
          </button>
          <button
            className="btn"
            onClick={onUpload}
            disabled={busy}
            style={{ background: "#1d5fa3", color: "white" }}
          >
            {busy ? "Working…" : "Upload videos"}
          </button>
        </div>
      </div>

      {err && (
        <div className="home-alert tone-danger" style={{ marginBottom: 12 }}>
          ⚠ {err}
        </div>
      )}
      {msg && (
        <div className="home-alert tone-success" style={{ marginBottom: 12 }}>
          ✓ {msg}
        </div>
      )}

      {items.length === 0 ? (
        <div
          style={{
            padding: 40,
            background: "#f8fafc",
            border: "2px dashed #cbd5e1",
            borderRadius: 12,
            textAlign: "center",
            color: "#64748b",
          }}
        >
          <p style={{ margin: "0 0 12px", fontSize: 15 }}>
            No videos yet. Click <b>Upload videos</b> to add MP4 / MOV files —
            posters are extracted automatically from the first frame.
          </p>
        </div>
      ) : (
        <>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            background: "white",
            border: "1px solid rgba(0,0,0,0.1)",
            borderRadius: 10,
            marginBottom: 12,
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAllSelected}
              disabled={busy}
            />
            <b>Select all</b>
          </label>
          <span style={{ fontSize: 12, color: "#64748b" }}>
            {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Tick a video to include it in bulk delete"}
          </span>
          <button
            className="btn"
            onClick={() => setBulkPending(true)}
            disabled={selectedIds.size === 0 || busy}
            style={{
              marginLeft: "auto",
              background: selectedIds.size > 0 ? "#dc2626" : undefined,
              color: selectedIds.size > 0 ? "white" : undefined,
              fontSize: 13,
              padding: "6px 14px",
            }}
          >
            {busy ? "Working…" : `Delete selected${selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}`}
          </button>
        </div>
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 16,
          }}
        >
          {items.map((v, i) => {
            const isDragTarget = dragOverIndex === i && dragIndex !== null && dragIndex !== i;
            return (
              <li
                key={v.id}
                draggable
                onDragStart={onDragStart(i)}
                onDragOver={onDragOver(i)}
                onDrop={onDrop(i)}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
                style={{
                  background: "white",
                  border: isDragTarget ? "2px solid #1d5fa3" : "1px solid rgba(0,0,0,0.1)",
                  borderRadius: 10,
                  overflow: "hidden",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
                  cursor: "grab",
                }}
              >
                <div
                  style={{
                    aspectRatio: "16/9",
                    background: "#0f172a",
                    backgroundImage: posterUrl(v.poster)
                      ? `url("${posterUrl(v.poster)}")`
                      : undefined,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    position: "relative",
                  }}
                >
                  {i === 0 && (
                    <span
                      style={{
                        position: "absolute",
                        top: 8,
                        left: 8,
                        background: "#059669",
                        color: "white",
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: 0.3,
                      }}
                    >
                      PLAYS FIRST
                    </span>
                  )}
                  <label
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: "absolute",
                      top: 8,
                      right: 8,
                      background: "rgba(255,255,255,0.95)",
                      borderRadius: 6,
                      padding: "3px 6px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      cursor: "pointer",
                      boxShadow: "0 2px 4px rgba(0,0,0,0.15)",
                      fontSize: 12,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(v.id)}
                      onChange={() => toggleSelected(v.id)}
                      onClick={(e) => e.stopPropagation()}
                      disabled={busy}
                    />
                  </label>
                </div>
                <div style={{ padding: 12 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      color: "#1d3557",
                      fontSize: 14,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={v.title}
                  >
                    {v.title}
                  </div>
                  {v.description && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "#64748b",
                        marginTop: 4,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {v.description}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 11,
                      color: "#94a3b8",
                      marginTop: 6,
                      fontFamily: "monospace",
                    }}
                  >
                    {v.id} · {v.src.replace("assets/video/", "")}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button
                      className="btn"
                      onClick={() => setPendingDelete(v)}
                      disabled={busy}
                      style={{
                        background: "#fee2e2",
                        color: "#991b1b",
                        fontSize: 12,
                        padding: "4px 10px",
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        </>
      )}

      <p
        style={{
          marginTop: 24,
          fontSize: 12,
          color: "#94a3b8",
          textAlign: "center",
        }}
      >
        Tip: to rename a video or change its description, use{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            nav("/website/edit/tour");
          }}
          style={{ color: "#6366f1" }}
        >
          Ask AI to update the tour page
        </a>
        . Click <b>Preview</b> to see the playlist as visitors will.
      </p>

      {pendingDelete && (
        <div
          onClick={() => setPendingDelete(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.5)",
            display: "grid",
            placeItems: "center",
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              padding: 24,
              borderRadius: 12,
              maxWidth: 420,
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
          >
            <h3 style={{ margin: "0 0 12px" }}>Delete this video?</h3>
            <p style={{ margin: "0 0 20px", color: "#475569" }}>
              <b>{pendingDelete.title}</b> will be removed from the tour page and
              the underlying files will be deleted from your working copy. This
              creates a draft revision — the change goes live only after Publish.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setPendingDelete(null)}>
                Cancel
              </button>
              <button
                className="btn"
                onClick={confirmDelete}
                disabled={busy}
                style={{ background: "#dc2626", color: "white" }}
              >
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkPending && (
        <div
          onClick={() => setBulkPending(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.5)",
            display: "grid",
            placeItems: "center",
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              padding: 24,
              borderRadius: 12,
              maxWidth: 460,
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
          >
            <h3 style={{ margin: "0 0 12px" }}>Delete {selectedIds.size} video{selectedIds.size === 1 ? "" : "s"}?</h3>
            <p style={{ margin: "0 0 16px", color: "#475569" }}>
              The following videos will be removed from the tour page and their
              files deleted from your working copy. This creates a draft
              revision — the change goes live only after Publish.
            </p>
            <ul style={{ margin: "0 0 20px", padding: "0 0 0 18px", color: "#1d3557", fontSize: 13, maxHeight: 160, overflow: "auto" }}>
              {items.filter((v) => selectedIds.has(v.id)).map((v) => (
                <li key={v.id}>{v.title} <span style={{ color: "#94a3b8", fontFamily: "monospace" }}>({v.id})</span></li>
              ))}
            </ul>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setBulkPending(false)}>
                Cancel
              </button>
              <button
                className="btn"
                onClick={performBulkDelete}
                disabled={busy}
                style={{ background: "#dc2626", color: "white" }}
              >
                {busy ? "Deleting…" : `Delete ${selectedIds.size}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function pathsFromDialog(picked: unknown): string[] {
  if (picked == null) return [];
  if (Array.isArray(picked)) {
    return picked
      .map((p) => (typeof p === "string" ? p : (p as { path?: string }).path))
      .filter((p): p is string => typeof p === "string");
  }
  if (typeof picked === "string") return [picked];
  const single = (picked as { path?: string }).path;
  return typeof single === "string" ? [single] : [];
}
