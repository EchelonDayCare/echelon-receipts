// Vault document detail drawer — inline preview, metadata, version history,
// audit log, soft delete + restore.
import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { showConfirm } from "../../lib/dialogs";
import {
  getDocument, getBlob, getVersionHistory, listDocumentEvents,
  softDeleteDocument, restoreDocument, recordEvent,
  type Document, type DocEvent,
} from "../../repo/documentsRepo";

export default function DetailDrawer({
  id, onClose, onEdit, onNewVersion, onChanged,
}: {
  id: string | null;
  onClose: () => void;
  onEdit: (doc: Document) => void;
  onNewVersion: (doc: Document) => void;
  onChanged: () => void;
}) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [preview, setPreview] = useState<{ url: string; mime: string } | null>(null);
  const [versions, setVersions] = useState<Document[]>([]);
  const [events, setEvents] = useState<DocEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) { setDoc(null); setPreview(null); setVersions([]); setEvents([]); return; }
    (async () => {
      const d = await getDocument(id);
      setDoc(d);
      if (d) {
        const [vh, ev] = await Promise.all([
          getVersionHistory(id),
          listDocumentEvents(id),
        ]);
        setVersions(vh);
        setEvents(ev);
        // Only auto-preview PDFs and images inline. Everything else -> download.
        if (d.mimeType === "application/pdf" || d.mimeType.startsWith("image/")) {
          const blob = await getBlob(d.blobKey);
          if (blob) {
            const mime = blob.mimeType || d.mimeType;
            // PDFs: use a data: URL because Windows PDF handlers (Edge) reject
            // blob: URLs in Tauri webviews with "We can't open this file".
            // Images: blob: is fine and cheaper — browser renders them directly.
            let url: string;
            if (mime === "application/pdf") {
              url = `data:${mime};base64,${bytesToBase64(blob.bytes)}`;
            } else {
              url = URL.createObjectURL(new Blob([new Uint8Array(blob.bytes)], { type: mime }));
            }
            setPreview({ url, mime });
          }
        } else {
          setPreview(null);
        }
      }
    })().catch((e) => setErr(String(e?.message ?? e)));

    return () => {
      // Free blob URL when the drawer closes or switches docs. data: URLs
      // are garbage-collected with the string ref, no revoke needed.
      setPreview((cur) => {
        if (cur && cur.url.startsWith("blob:")) URL.revokeObjectURL(cur.url);
        return null;
      });
    };
  }, [id]);

  async function download() {
    if (!doc) return;
    try {
      const dest = await saveDialog({ defaultPath: doc.fileName });
      if (!dest) return;
      const blob = await getBlob(doc.blobKey);
      if (!blob) throw new Error("Blob missing for this document.");
      await writeFile(dest, blob.bytes);
      await recordEvent(doc.id, "downloaded", { path: dest });
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  async function del() {
    if (!doc) return;
    if (!(await showConfirm(`Delete "${doc.title}"? You can restore it from the Deleted filter within 30 days.`, { kind: "warning" }))) return;
    setBusy(true);
    try {
      await softDeleteDocument(doc.id);
      onChanged();
      onClose();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function restore() {
    if (!doc) return;
    setBusy(true);
    try {
      await restoreDocument(doc.id);
      onChanged();
      onClose();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  if (!id) return null;
  if (!doc) return null;

  const expired = doc.expiryDate && doc.expiryDate < new Date().toISOString().slice(0, 10);
  const soon = doc.expiryDate && !expired && daysUntil(doc.expiryDate) <= 60;

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={drawerStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>{doc.title}</h2>
            <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={chipStyle(catColor(doc.category))}>{doc.category}</span>
              {expired && <span style={chipStyle("#dc2626")}>Expired</span>}
              {soon && <span style={chipStyle("#d97706")}>Expiring soon</span>}
              {doc.deletedAt && <span style={chipStyle("#6b7280")}>Deleted</span>}
              <span style={{ fontSize: 12, color: "var(--muted)" }}>v{doc.versionNo}</span>
            </div>
          </div>
          <button className="btn" onClick={onClose}>✕</button>
        </div>

        {err && <div style={errorBoxStyle}>{err}</div>}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, marginTop: 16 }}>
          <div>
            {preview?.mime === "application/pdf" && (
              <iframe src={preview.url} title="preview" style={{ width: "100%", height: 520, border: "1px solid var(--border, #1e293b)", borderRadius: 8, background: "#fff" }} />
            )}
            {preview?.mime.startsWith("image/") && (
              <img src={preview.url} alt={doc.title} style={{ maxWidth: "100%", maxHeight: 520, borderRadius: 8 }} />
            )}
            {!preview && (
              <div style={{ padding: 40, border: "1px dashed var(--border, #334155)", borderRadius: 8, textAlign: "center", color: "var(--muted)" }}>
                No inline preview for {doc.mimeType || "this file type"}.
              </div>
            )}
            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" onClick={download}>Download</button>
              <button className="btn" onClick={() => onEdit(doc)}>Edit metadata</button>
              <button className="btn" onClick={() => onNewVersion(doc)}>Upload new version</button>
              {isDeleted(doc)
                ? <button className="btn" onClick={restore} disabled={busy}>Restore</button>
                : <button className="btn" onClick={del} disabled={busy} style={{ color: "#fca5a5" }}>Delete</button>}
            </div>
          </div>

          <aside style={{ display: "flex", flexDirection: "column", gap: 12 }}>            <MetaField label="File name" value={doc.fileName} />
            <MetaField label="Size" value={`${(doc.sizeBytes / 1024).toFixed(1)} KB`} />
            <MetaField label="Issued" value={doc.issuedDate || "—"} />
            <MetaField label="Expires" value={doc.expiryDate || "—"} />
            <MetaField label="Issuer" value={doc.issuer || "—"} />
            <MetaField label="Reference" value={doc.referenceNo || "—"} />
            <MetaField label="Linked" value={doc.linkedKind ? `${doc.linkedKind} #${doc.linkedId}` : "—"} />
            {doc.tags.length > 0 && (
              <div>
                <div style={metaLabelStyle}>Tags</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {doc.tags.map((t) => <span key={t} style={chipStyle("#64748b")}>{t}</span>)}
                </div>
              </div>
            )}
            {doc.notes && (
              <div>
                <div style={metaLabelStyle}>Notes</div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{doc.notes}</div>
              </div>
            )}

            {versions.length > 1 && (
              <details>
                <summary style={{ cursor: "pointer" }}>Version history ({versions.length})</summary>
                <ul style={{ margin: "8px 0 0 0", padding: 0, listStyle: "none", fontSize: 13 }}>
                  {versions.map((v) => (
                    <li key={v.id} style={{ padding: "4px 0", borderTop: "1px solid var(--border, #1e293b)" }}>
                      <b>v{v.versionNo}</b> · {new Date(v.createdAt).toLocaleDateString()} · {v.fileName}
                      {v.id === doc.id && <span style={{ marginLeft: 6, color: "#22c55e" }}>current</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <details>
              <summary style={{ cursor: "pointer" }}>Audit log ({events.length})</summary>
              <ul style={{ margin: "8px 0 0 0", padding: 0, listStyle: "none", fontSize: 12, color: "var(--muted)" }}>
                {events.map((e) => (
                  <li key={e.id} style={{ padding: "4px 0", borderTop: "1px solid var(--border, #1e293b)" }}>
                    {new Date(e.createdAt).toLocaleString()} · <b>{e.eventType}</b>
                  </li>
                ))}
              </ul>
            </details>
          </aside>
        </div>
      </div>
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={metaLabelStyle}>{label}</div>
      <div style={{ fontSize: 13 }}>{value}</div>
    </div>
  );
}

function daysUntil(dateStr: string): number {
  const t = Date.parse(dateStr + "T00:00:00");
  return Math.ceil((t - Date.now()) / 86_400_000);
}
function isDeleted(doc: Document): boolean {
  return doc.deletedAt != null;
}

// Chunked base64 encoding — btoa() alone chokes on long binary strings and
// String.fromCharCode(...array) blows the arg-list limit for big PDFs.
function bytesToBase64(bytes: number[] | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 0x8000; // 32 KB per fromCharCode call
  let bin = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

function catColor(cat: string): string {
  const m: Record<string, string> = {
    license: "#0ea5e9", insurance: "#8b5cf6", policy: "#14b8a6",
    staff: "#f97316", child: "#ec4899", vendor: "#6366f1",
    financial: "#22c55e", incident: "#dc2626", board: "#64748b", other: "#94a3b8",
  };
  return m[cat] || "#64748b";
}

const chipStyle = (bg: string): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", padding: "2px 8px",
  fontSize: 11, borderRadius: 999, background: `${bg}22`, color: bg, border: `1px solid ${bg}55`,
});
const metaLabelStyle: React.CSSProperties = { fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 };
const backdropStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.5)",
  display: "flex", alignItems: "center", justifyContent: "flex-end", zIndex: 100,
};
const drawerStyle: React.CSSProperties = {
  background: "var(--panel, #0b1220)", borderLeft: "1px solid var(--border, #1e293b)",
  padding: 20, width: "min(920px, 96vw)", height: "100vh", overflowY: "auto",
};
const errorBoxStyle: React.CSSProperties = {
  padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5",
  border: "1px solid rgba(220,38,38,.35)", marginTop: 12,
};
