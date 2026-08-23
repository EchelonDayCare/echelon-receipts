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
      const win = rel.split("/").join("\\");
      const absPath = `${repoRoot}\\repo\\${win}`;
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
