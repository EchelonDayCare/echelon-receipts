import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  websiteDeleteMedia,
  websiteEditMedia,
  websiteEmergencyRemove,
  websiteListMedia,
  websiteReorderGallery,
  websiteUploadPhotos,
  websiteWorkingCopyStatus,
  type MediaRecord,
} from "../../lib/website";

// Gallery editor screen (v3.20.0 PR 3).
//
// UX:
//   • Drop-zone at the top for batched uploads. Native HTML5 drag-drop
//     from Explorer works — the file objects hand us absolute paths on
//     Windows and macOS 12+ so we can pass them straight to the Rust
//     `website_upload_photos` command.
//   • Grid of JPG w=400 thumbnails from the working copy on disk.
//   • Drag a thumbnail to reorder; drop finalises the order via
//     `website_reorder_gallery`.
//   • Click a thumbnail to open an inline edit sidebar (caption, alt,
//     focal-point picker) — Save issues `website_edit_media`.
//   • Delete button per-thumb with confirm modal → `website_delete_media`.
//   • Emergency-remove button inside the edit sidebar — separate
//     "history-rewrite required" confirmation → `website_emergency_remove`.

type PickerFocal = { x: number; y: number } | null;

function pickThumbnail(rec: MediaRecord): string | null {
  const preferred =
    rec.variants.find(
      (v) => v.format === "jpg" && v.width === 400,
    ) ??
    rec.variants.find((v) => v.format === "jpg") ??
    rec.variants[0];
  return preferred?.filename ?? null;
}

export default function Gallery() {
  const nav = useNavigate();
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [items, setItems] = useState<MediaRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [uploadDragActive, setUploadDragActive] = useState(false);
  const [selected, setSelected] = useState<MediaRecord | null>(null);
  const [deletePending, setDeletePending] = useState<MediaRecord | null>(null);
  const [emergencyPending, setEmergencyPending] = useState<MediaRecord | null>(
    null,
  );
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchDeletePending, setBatchDeletePending] = useState<
    "selected" | "all" | null
  >(null);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [wc, list] = await Promise.all([
        websiteWorkingCopyStatus(),
        websiteListMedia("photo"),
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

  const thumbUrl = useCallback(
    (rec: MediaRecord): string | null => {
      if (!repoRoot) return null;
      const filename = pickThumbnail(rec);
      if (!filename) return null;
      // repoRoot is e.g. "…\website" — the git working copy lives under repoRoot\repo\.
      const absPath = `${repoRoot}\\repo\\assets\\img\\gallery\\${filename}`;
      // Tauri v2 asset scheme.
      return convertFileSrc(absPath);
    },
    [repoRoot],
  );

  async function onUploadFromDialog() {
    setBusy(true);
    setErr(null);
    try {
      const picked = await open({
        multiple: true,
        filters: [
          {
            name: "Images",
            extensions: ["jpg", "jpeg", "png", "webp", "heic", "heif"],
          },
        ],
      });
      const paths = pathsFromDialog(picked);
      if (paths.length === 0) return;
      await websiteUploadPhotos(paths);
      setMsg(`Uploaded ${paths.length} photo${paths.length === 1 ? "" : "s"}`);
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function onDropUpload(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setUploadDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    // Tauri fills `path` on file objects only when the drop happened
    // over the WebView with the fs plugin loaded. On strict WebViews
    // we fall back to the file-open dialog.
    const paths = files
      .map((f) => (f as unknown as { path?: string }).path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    if (paths.length === 0) {
      setErr(
        "Could not read dropped file paths. Click 'Browse for photos' to pick them from a dialog instead.",
      );
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await websiteUploadPhotos(paths);
      setMsg(`Uploaded ${paths.length} photo${paths.length === 1 ? "" : "s"}`);
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function commitReorder(order: MediaRecord[]) {
    setItems(order);
    try {
      await websiteReorderGallery(order.map((r) => r.id));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      // If the server disagrees, re-sync from disk.
      await refresh();
    }
  }

  async function onConfirmDelete() {
    if (!deletePending) return;
    const id = deletePending.id;
    setDeletePending(null);
    setBusy(true);
    setErr(null);
    try {
      await websiteDeleteMedia(id);
      setMsg("Photo deleted.");
      if (selected?.id === id) setSelected(null);
      setSelectedIds((s) => {
        if (!s.has(id)) return s;
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function toggleSelectId(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(items.map((it) => it.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function onConfirmBatchDelete() {
    if (!batchDeletePending) return;
    const targets =
      batchDeletePending === "all"
        ? items.map((it) => it.id)
        : items.filter((it) => selectedIds.has(it.id)).map((it) => it.id);
    setBatchDeletePending(null);
    if (targets.length === 0) return;
    setBusy(true);
    setErr(null);
    let ok = 0;
    let fail = 0;
    for (const id of targets) {
      try {
        await websiteDeleteMedia(id);
        ok += 1;
      } catch (e: any) {
        fail += 1;
        setErr(String(e?.message ?? e));
      }
    }
    setSelectedIds(new Set());
    setSelected(null);
    setMsg(
      fail === 0
        ? `Deleted ${ok} photo${ok === 1 ? "" : "s"}.`
        : `Deleted ${ok}, failed ${fail}. See error above.`,
    );
    await refresh();
    setBusy(false);
  }

  const modal = selected;
  const selectedThumb = useMemo(
    () => (modal ? thumbUrl(modal) : null),
    [modal, thumbUrl],
  );

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn link" onClick={() => nav("/website")} style={{ padding: 0 }}>
          ← Website
        </button>
        <h1 style={{ margin: 0 }}>Gallery</h1>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted, #64748b)" }}>
          {items.length} photo{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <p style={{ color: "var(--muted, #64748b)", marginTop: 8 }}>
        Drop images here (JPG / PNG / WebP / HEIC). The desktop app strips
        EXIF, re-encodes to AVIF + WebP + JPG at 3 widths, and adds the
        photo to <code>content/gallery.json</code>. Publish to push the
        changes to GitHub Pages.
      </p>

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

      {items.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            background: "rgba(0,0,0,0.03)",
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 10,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={
                selectedIds.size > 0 && selectedIds.size === items.length
              }
              ref={(el) => {
                if (el)
                  el.indeterminate =
                    selectedIds.size > 0 && selectedIds.size < items.length;
              }}
              onChange={(e) =>
                e.target.checked ? selectAll() : clearSelection()
              }
            />
            <span>
              {selectedIds.size === 0
                ? "Select all"
                : `${selectedIds.size} of ${items.length} selected`}
            </span>
          </label>
          <button
            className="btn"
            onClick={() => setBatchDeletePending("selected")}
            disabled={busy || selectedIds.size === 0}
            style={{
              background: selectedIds.size > 0 ? "#dc2626" : undefined,
              color: selectedIds.size > 0 ? "white" : undefined,
              opacity: selectedIds.size === 0 ? 0.5 : 1,
            }}
          >
            Delete selected ({selectedIds.size})
          </button>
          <button
            className="btn"
            onClick={() => setBatchDeletePending("all")}
            disabled={busy}
            style={{ marginLeft: "auto" }}
            title="Remove every photo from the gallery"
          >
            Delete all {items.length}
          </button>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (dragIndex !== null) return;
          setUploadDragActive(true);
        }}
        onDragLeave={() => setUploadDragActive(false)}
        onDrop={onDropUpload}
        style={{
          border: `2px dashed ${uploadDragActive ? "#0891b2" : "rgba(0,0,0,0.2)"}`,
          background: uploadDragActive ? "rgba(8,145,178,0.05)" : "rgba(0,0,0,0.02)",
          borderRadius: 12,
          padding: 22,
          textAlign: "center",
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 24, marginBottom: 6 }}>📸</div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          Drop photos here to upload
        </div>
        <div style={{ fontSize: 12, color: "var(--muted, #64748b)", marginBottom: 10 }}>
          or
        </div>
        <button className="btn" onClick={onUploadFromDialog} disabled={busy}>
          {busy ? "Uploading…" : "Browse for photos…"}
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 12,
        }}
      >
        {items.map((it, idx) => {
          const src = thumbUrl(it);
          const isDragging = dragIndex === idx;
          const isDropTarget = dragOverIndex === idx && dragIndex !== null && dragIndex !== idx;
          return (
            <div
              key={it.id}
              draggable={!busy}
              onDragStart={(e) => {
                if (busy) return;
                setDragIndex(idx);
                e.dataTransfer.effectAllowed = "move";
                try {
                  e.dataTransfer.setData("text/plain", String(idx));
                } catch {
                  /* ignore */
                }
              }}
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverIndex(idx);
              }}
              onDragLeave={() => {
                if (dragOverIndex === idx) setDragOverIndex(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null && dragIndex !== idx) {
                  const next = items.slice();
                  const [moved] = next.splice(dragIndex, 1);
                  next.splice(idx, 0, moved);
                  void commitReorder(next);
                }
                setDragIndex(null);
                setDragOverIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setDragOverIndex(null);
              }}
              style={{
                position: "relative",
                background: "white",
                borderRadius: 10,
                border: `1px solid ${isDropTarget ? "#0891b2" : "rgba(0,0,0,0.1)"}`,
                overflow: "hidden",
                cursor: "grab",
                opacity: isDragging ? 0.4 : 1,
                boxShadow: isDropTarget ? "0 0 0 3px rgba(8,145,178,0.15)" : "none",
              }}
              onClick={() => setSelected(it)}
              title={it.source_filename}
            >
              {src ? (
                <img
                  src={src}
                  alt={it.alt ?? ""}
                  style={{ width: "100%", height: 180, objectFit: "cover", display: "block" }}
                />
              ) : (
                <div
                  style={{
                    width: "100%",
                    height: 180,
                    background: "#f1f5f9",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#64748b",
                    fontSize: 13,
                  }}
                >
                  no preview
                </div>
              )}
              <div style={{ padding: "8px 10px" }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.caption || <span style={{ color: "#94a3b8" }}>no caption</span>}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#94a3b8",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.alt || "no alt text"}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeletePending(it);
                }}
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  background: "rgba(220,38,38,0.9)",
                  color: "white",
                  border: 0,
                  borderRadius: 6,
                  padding: "4px 8px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
                title="Delete this photo"
              >
                Delete
              </button>
              <div
                style={{
                  position: "absolute",
                  top: 8,
                  left: 8,
                  background: "rgba(0,0,0,0.55)",
                  color: "white",
                  padding: "3px 6px",
                  borderRadius: 6,
                  fontSize: 11,
                  cursor: "grab",
                }}
                title="Drag to reorder"
              >
                ☰
              </div>
              <label
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  top: 6,
                  left: 40,
                  background: "rgba(255,255,255,0.92)",
                  padding: "3px 6px",
                  borderRadius: 6,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                }}
                title="Select"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(it.id)}
                  onChange={() => toggleSelectId(it.id)}
                  style={{ margin: 0, cursor: "pointer" }}
                />
              </label>
            </div>
          );
        })}
        {items.length === 0 && (
          <div
            style={{
              gridColumn: "1 / -1",
              padding: 32,
              textAlign: "center",
              color: "#64748b",
              border: "1px dashed rgba(0,0,0,0.15)",
              borderRadius: 10,
            }}
          >
            No photos yet. Drop some above or click "Browse for photos…" to get started.
          </div>
        )}
      </div>

      {modal && (
        <EditPanel
          rec={modal}
          thumb={selectedThumb}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            await refresh();
            setSelected(null);
          }}
          onEmergencyRemove={() => setEmergencyPending(modal)}
          onError={setErr}
        />
      )}

      {deletePending && (
        <ConfirmModal
          title="Delete this photo?"
          body={
            <>
              <p>
                <b>{deletePending.source_filename}</b> will be removed from the
                gallery and the on-disk working copy files will be swept on
                the next publish.
              </p>
              <p style={{ color: "#64748b", fontSize: 13 }}>
                Prior git history still contains the file. Use{" "}
                <b>Emergency remove</b> instead if a parent revoked consent.
              </p>
            </>
          }
          confirmLabel="Delete"
          onCancel={() => setDeletePending(null)}
          onConfirm={onConfirmDelete}
        />
      )}

      {batchDeletePending && (
        <ConfirmModal
          title={
            batchDeletePending === "all"
              ? `Delete all ${items.length} photos?`
              : `Delete ${selectedIds.size} selected photo${selectedIds.size === 1 ? "" : "s"}?`
          }
          body={
            <>
              <p>
                {batchDeletePending === "all"
                  ? `Every photo in the gallery will be removed.`
                  : `The ${selectedIds.size} selected photo${selectedIds.size === 1 ? "" : "s"} will be removed.`}{" "}
                On-disk working copy files are swept on the next publish.
              </p>
              <p style={{ color: "#64748b", fontSize: 13 }}>
                Prior git history still contains the files. Use{" "}
                <b>Emergency remove</b> per-photo if a parent revoked consent.
              </p>
            </>
          }
          confirmLabel={
            batchDeletePending === "all" ? "Delete all" : "Delete selected"
          }
          onCancel={() => setBatchDeletePending(null)}
          onConfirm={onConfirmBatchDelete}
        />
      )}

      {emergencyPending && (
        <EmergencyRemoveModal
          rec={emergencyPending}
          onCancel={() => setEmergencyPending(null)}
          onDone={async () => {
            setEmergencyPending(null);
            setSelected(null);
            setMsg(
              "Emergency-remove request logged. History rewrite will run on next publish.",
            );
            await refresh();
          }}
          onError={setErr}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Edit panel — caption / alt / focal point
// ─────────────────────────────────────────────────────────────────────

function EditPanel({
  rec,
  thumb,
  onClose,
  onSaved,
  onEmergencyRemove,
  onError,
}: {
  rec: MediaRecord;
  thumb: string | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onEmergencyRemove: () => void;
  onError: (e: string) => void;
}) {
  const [caption, setCaption] = useState<string>(rec.caption ?? "");
  const [alt, setAlt] = useState<string>(rec.alt ?? "");
  const [focal, setFocal] = useState<PickerFocal>(
    rec.focal_x !== null && rec.focal_y !== null
      ? { x: rec.focal_x, y: rec.focal_y }
      : null,
  );
  const [saving, setSaving] = useState(false);

  async function onSave() {
    setSaving(true);
    try {
      await websiteEditMedia(
        rec.id,
        caption || undefined,
        alt || undefined,
        focal ? [focal.x, focal.y] : null,
      );
      await onSaved();
    } catch (e: any) {
      onError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  function pickFocalOnImage(e: React.MouseEvent<HTMLDivElement>) {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setFocal({
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    });
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "white",
          borderRadius: 12,
          width: "min(720px, 92vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Edit photo</h2>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: 0,
              fontSize: 22,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
          {rec.source_filename} · base_hash {rec.base_hash}
        </div>

        <div
          onClick={pickFocalOnImage}
          style={{
            position: "relative",
            borderRadius: 10,
            overflow: "hidden",
            border: "1px solid rgba(0,0,0,0.1)",
            cursor: "crosshair",
            marginBottom: 12,
          }}
          title="Click to set the focal point"
        >
          {thumb ? (
            <img
              src={thumb}
              alt={alt}
              style={{ display: "block", width: "100%", height: "auto" }}
            />
          ) : (
            <div
              style={{
                width: "100%",
                aspectRatio: "16 / 9",
                background: "#f1f5f9",
              }}
            />
          )}
          {focal && (
            <div
              style={{
                position: "absolute",
                left: `${focal.x * 100}%`,
                top: `${focal.y * 100}%`,
                width: 20,
                height: 20,
                marginLeft: -10,
                marginTop: -10,
                borderRadius: "50%",
                border: "3px solid white",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
                background: "rgba(8,145,178,0.85)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
        {focal && (
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
            Focal point: ({focal.x.toFixed(2)}, {focal.y.toFixed(2)}){" "}
            <button
              className="btn link"
              onClick={() => setFocal(null)}
              style={{ padding: 0, fontSize: 12 }}
            >
              Clear
            </button>
          </div>
        )}

        <label
          style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 8 }}
        >
          Caption
        </label>
        <input
          type="text"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Optional caption visible in the site UI"
          style={inputStyle}
        />

        <label
          style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 12 }}
        >
          Alt text (for accessibility)
        </label>
        <textarea
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          placeholder="Describe the photo for screen readers"
          rows={3}
          style={{ ...inputStyle, fontFamily: "inherit" }}
        />

        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <button className="btn" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            onClick={onEmergencyRemove}
            style={{
              marginLeft: "auto",
              background: "#dc2626",
              color: "white",
              border: 0,
              borderRadius: 6,
              padding: "8px 12px",
              cursor: "pointer",
            }}
          >
            Emergency remove…
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────

function ConfirmModal({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "white",
          borderRadius: 12,
          width: "min(480px, 92vw)",
          padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: 0, marginBottom: 8 }}>{title}</h2>
        <div style={{ fontSize: 14 }}>{body}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              background: "#dc2626",
              color: "white",
              border: 0,
              borderRadius: 6,
              padding: "8px 12px",
              cursor: "pointer",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmergencyRemoveModal({
  rec,
  onCancel,
  onDone,
  onError,
}: {
  rec: MediaRecord;
  onCancel: () => void;
  onDone: () => void | Promise<void>;
  onError: (e: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit() {
    if (!ack) return;
    if (reason.trim().length < 3) {
      onError("Reason required — a brief description of why the photo must be expunged.");
      return;
    }
    setSubmitting(true);
    try {
      await websiteEmergencyRemove(rec.id, reason.trim());
      await onDone();
    } catch (e: any) {
      onError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1200,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "white",
          borderRadius: 12,
          width: "min(560px, 92vw)",
          padding: 22,
          border: "2px solid #dc2626",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: 0, marginBottom: 8, color: "#b91c1c" }}>
          Emergency remove
        </h2>
        <p style={{ fontSize: 14, margin: 0 }}>
          You're marking <b>{rec.source_filename}</b> for a full history
          rewrite. This is a special takedown flow used when a parent
          revokes consent. Regular deletes should use the normal Delete
          button.
        </p>
        <div
          style={{
            background: "#fff7ed",
            border: "1px solid #fed7aa",
            padding: 10,
            borderRadius: 8,
            fontSize: 13,
            margin: "12px 0",
          }}
        >
          ⚠ This flags the photo for a git history rewrite the next time
          the site is published. Previous commits still contain the
          image until then.
        </div>

        <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 8 }}>
          Reason (recorded in the audit log)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. Parent revoked consent 2026-08-23"
          style={{ ...inputStyle, fontFamily: "inherit" }}
        />
        <label
          style={{
            display: "flex",
            gap: 8,
            marginTop: 12,
            fontSize: 13,
            alignItems: "center",
          }}
        >
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          <span>
            I understand this triggers a git history rewrite on next publish.
          </span>
        </label>

        <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={!ack || submitting}
            style={{
              background: ack ? "#dc2626" : "#e2e8f0",
              color: ack ? "white" : "#94a3b8",
              border: 0,
              borderRadius: 6,
              padding: "8px 12px",
              cursor: ack ? "pointer" : "not-allowed",
            }}
          >
            {submitting ? "Submitting…" : "Emergency remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

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

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: 8,
  border: "1px solid rgba(0,0,0,0.15)",
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
  marginTop: 4,
};
