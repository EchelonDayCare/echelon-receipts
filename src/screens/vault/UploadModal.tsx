// Vault Upload Modal — 3-step wizard: file → duplicate check → metadata.
//
// Metadata-only mode reuses the same wizard for "update metadata" against
// an existing duplicate; the file / duplicate steps are skipped.
import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  DOC_CATEGORIES, createDocument, ensureBlob, findDuplicateByHash,
  updateDocumentMetadata, uploadNewVersion,
  type DocCategory, type Document, type LinkedKind,
} from "../../repo/documentsRepo";
import { sha256Hex } from "../../repo/ids";
import { db } from "../../lib/db";

const MAX_BYTES = 25 * 1024 * 1024;

type LinkOption = { kind: LinkedKind; id: string; label: string };

export type UploadIntent =
  | { mode: "new" }
  | { mode: "new-version"; docId: string; existingTitle: string }
  | { mode: "edit-metadata"; doc: Document };

export default function UploadModal({
  intent, onClose, onSaved,
}: {
  intent: UploadIntent;
  onClose: () => void;
  onSaved: (doc: Document) => void;
}) {
  const [step, setStep] = useState<"file" | "duplicate" | "meta">(
    intent.mode === "edit-metadata" ? "meta" : "file",
  );
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState("");
  const [mimeType, setMimeType] = useState("application/octet-stream");
  const [duplicate, setDuplicate] = useState<Document | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Metadata form state — seeded from the edit-metadata doc when relevant.
  const seed = intent.mode === "edit-metadata" ? intent.doc : null;
  const [title, setTitle] = useState(seed?.title ?? "");
  const [category, setCategory] = useState<DocCategory>(seed?.category ?? "other");
  const [linkedKind, setLinkedKind] = useState<LinkedKind | "">(seed?.linkedKind ?? "");
  const [linkedId, setLinkedId] = useState<string>(seed?.linkedId ?? "");
  const [issuedDate, setIssuedDate] = useState(seed?.issuedDate ?? "");
  const [expiryDate, setExpiryDate] = useState(seed?.expiryDate ?? "");
  const [issuer, setIssuer] = useState(seed?.issuer ?? "");
  const [referenceNo, setReferenceNo] = useState(seed?.referenceNo ?? "");
  const [notes, setNotes] = useState(seed?.notes ?? "");
  const [tagsInput, setTagsInput] = useState((seed?.tags ?? []).join(", "));

  // Options for the "Linked to" dropdown. Loaded lazily when a kind picked.
  const [linkOptions, setLinkOptions] = useState<LinkOption[]>([]);
  useEffect(() => {
    if (!linkedKind) { setLinkOptions([]); return; }
    (async () => {
      const d = await db();
      if (linkedKind === "student") {
        const rows = await d.select<{ id: number; name: string; year: number }[]>(
          "SELECT id, name, year FROM students WHERE active = 1 ORDER BY year DESC, name",
        );
        setLinkOptions(rows.map((r) => ({ kind: "student", id: String(r.id), label: `${r.name} (${r.year})` })));
      } else if (linkedKind === "staff") {
        const rows = await d.select<{ id: number; name: string }[]>(
          "SELECT id, name FROM staff WHERE active = 1 ORDER BY name",
        );
        setLinkOptions(rows.map((r) => ({ kind: "staff", id: String(r.id), label: r.name })));
      } else {
        // Vendors: no dedicated table yet; keep freeform. Show a note.
        setLinkOptions([]);
      }
    })().catch(() => setLinkOptions([]));
  }, [linkedKind]);

  const showExpiryProminent = ["license", "insurance", "policy", "staff", "child"].includes(category);

  async function pickFile() {
    setErr(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [
          { name: "Documents", extensions: ["pdf", "png", "jpg", "jpeg", "webp", "doc", "docx", "xls", "xlsx", "csv", "txt"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (!picked || Array.isArray(picked)) return;
      const path = picked as string;
      const data = await readFile(path);
      if (data.length > MAX_BYTES) {
        setErr(`File is ${(data.length / 1024 / 1024).toFixed(1)} MB — max is 25 MB.`);
        return;
      }
      const name = path.split(/[\\/]/).pop() || "document";
      setBytes(data);
      setFileName(name);
      setMimeType(guessMime(name));
      setTitle((t) => t || stripExt(name));

      // Duplicate check.
      const hash = await sha256Hex(data);
      const dup = await findDuplicateByHash(hash);
      if (dup) { setDuplicate(dup); setStep("duplicate"); }
      else { setStep("meta"); }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  async function onBrowserFile(f: File) {
    setErr(null);
    if (f.size > MAX_BYTES) {
      setErr(`File is ${(f.size / 1024 / 1024).toFixed(1)} MB — max is 25 MB.`);
      return;
    }
    const buf = new Uint8Array(await f.arrayBuffer());
    setBytes(buf); setFileName(f.name); setMimeType(f.type || guessMime(f.name));
    setTitle((t) => t || stripExt(f.name));
    const hash = await sha256Hex(buf);
    const dup = await findDuplicateByHash(hash);
    if (dup) { setDuplicate(dup); setStep("duplicate"); }
    else { setStep("meta"); }
  }

  async function save() {
    if (busy) return;   // double-submit guard
    setBusy(true); setErr(null);
    try {
      const tags = tagsInput.split(",").map((s) => s.trim()).filter(Boolean);
      const commonPatch = {
        title: title.trim(), category,
        linkedKind: linkedKind || null,
        linkedId: linkedKind ? (linkedId || null) : null,
        issuedDate: issuedDate || null,
        expiryDate: expiryDate || null,
        issuer: issuer || null,
        referenceNo: referenceNo || null,
        notes: notes || null,
        tags,
      };

      if (intent.mode === "edit-metadata") {
        const updated = await updateDocumentMetadata(intent.doc.id, commonPatch, intent.doc.version);
        onSaved(updated); return;
      }

      if (intent.mode === "new-version") {
        if (!bytes) { setErr("Pick a file first."); return; }
        const nv = await uploadNewVersion(intent.docId, bytes, fileName, mimeType);
        // Also apply metadata patch on the new version if the user changed anything.
        const patched = await updateDocumentMetadata(nv.id, commonPatch, nv.version);
        onSaved(patched); return;
      }

      // new
      if (!bytes) { setErr("Pick a file first."); return; }
      const { blobKey, sizeBytes } = await ensureBlob(bytes, mimeType);
      const created = await createDocument({
        ...commonPatch,
        blobKey, fileName, mimeType, sizeBytes,
      });
      onSaved(created);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(false); }
  }

  const canSave = title.trim().length > 0 && (intent.mode === "edit-metadata" || bytes != null);

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>
            {intent.mode === "edit-metadata" ? "Edit document"
              : intent.mode === "new-version" ? `New version of "${intent.existingTitle}"`
              : "Upload document"}
          </h2>
          <button className="btn" onClick={onClose}>✕</button>
        </div>

        {err && <div style={errorBoxStyle}>{err}</div>}

        {step === "file" && (
          <div
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void onBrowserFile(f);
            }}
            style={dropZoneStyle}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
            <div style={{ marginBottom: 12 }}>Drop file here, or</div>
            <button className="btn primary" onClick={pickFile}>Choose file…</button>
            <input
              ref={fileInputRef} type="file" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onBrowserFile(f); }}
            />
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
              PDF, image, or office document. Max 25 MB.
            </div>
          </div>
        )}

        {step === "duplicate" && duplicate && (
          <div>
            <p>
              This file already exists as <b>{duplicate.title}</b>{" "}
              (uploaded {new Date(duplicate.createdAt).toLocaleDateString()}).
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className="btn primary" onClick={() => {
                // Update-metadata flow: re-enter meta step with duplicate seeded.
                setTitle(duplicate.title); setCategory(duplicate.category);
                setLinkedKind(duplicate.linkedKind ?? "");
                setLinkedId(duplicate.linkedId ?? "");
                setIssuedDate(duplicate.issuedDate ?? "");
                setExpiryDate(duplicate.expiryDate ?? "");
                setIssuer(duplicate.issuer ?? ""); setReferenceNo(duplicate.referenceNo ?? "");
                setNotes(duplicate.notes ?? ""); setTagsInput(duplicate.tags.join(", "));
                // Mutate the intent locally by swapping the modal's state to
                // an "edit-metadata" path without unmounting.
                (window as any).__vault_edit_id = duplicate.id;
                setStep("meta");
              }}>Update metadata</button>
              <button className="btn" onClick={() => { setDuplicate(null); setStep("meta"); }}>
                Upload as new anyway
              </button>
              <button className="btn" onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}

        {step === "meta" && (
          <div style={{ display: "grid", gap: 10 }}>
            <label style={labelStyle}>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={labelStyle}>
                Category
                <select value={category} onChange={(e) => setCategory(e.target.value as DocCategory)}>
                  {DOC_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </label>
              <label style={labelStyle}>
                Linked to
                <select value={linkedKind} onChange={(e) => { setLinkedKind(e.target.value as LinkedKind | ""); setLinkedId(""); }}>
                  <option value="">— None —</option>
                  <option value="student">Student</option>
                  <option value="staff">Staff</option>
                  <option value="vendor">Vendor</option>
                </select>
              </label>
            </div>
            {linkedKind && linkedKind !== "vendor" && (
              <label style={labelStyle}>
                {linkedKind === "student" ? "Student" : "Staff member"}
                <select value={linkedId} onChange={(e) => setLinkedId(e.target.value)}>
                  <option value="">— Choose —</option>
                  {linkOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </label>
            )}
            {linkedKind === "vendor" && (
              <label style={labelStyle}>
                Vendor name
                <input value={linkedId} onChange={(e) => setLinkedId(e.target.value)} placeholder="Freeform for now" />
              </label>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={labelStyle}>
                Issued date
                <input type="date" value={issuedDate} onChange={(e) => setIssuedDate(e.target.value)} />
              </label>
              <label style={{ ...labelStyle, ...(showExpiryProminent ? highlightStyle : {}) }}>
                Expiry date {showExpiryProminent && <span style={{ color: "#dc2626" }}> ★</span>}
                <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
              </label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={labelStyle}>
                Issuer
                <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="e.g. BC Ministry of Education" />
              </label>
              <label style={labelStyle}>
                Reference #
                <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="Policy / licence #" />
              </label>
            </div>
            <label style={labelStyle}>
              Tags (comma-separated)
              <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="e.g. renewal, urgent" />
            </label>
            <label style={labelStyle}>
              Notes
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </label>
            {bytes && (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                File: {fileName} · {(bytes.length / 1024).toFixed(1)} KB
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn primary" onClick={save} disabled={!canSave || busy}>
                {busy ? "Saving…" : intent.mode === "edit-metadata" ? "Save changes" : "Save document"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function stripExt(name: string) { return name.replace(/\.[^./\\]+$/, ""); }
function guessMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv", txt: "text/plain",
  };
  return map[ext] || "application/octet-stream";
}

const backdropStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.5)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
};
const modalStyle: React.CSSProperties = {
  background: "var(--panel, #0b1220)", border: "1px solid var(--border, #1e293b)",
  borderRadius: 12, padding: 20, width: "min(640px, 92vw)", maxHeight: "90vh", overflowY: "auto",
  color: "inherit",
};
const dropZoneStyle: React.CSSProperties = {
  border: "2px dashed var(--border, #334155)", borderRadius: 12,
  padding: 40, textAlign: "center",
};
const labelStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--muted)",
};
const highlightStyle: React.CSSProperties = {
  padding: 8, background: "rgba(220, 38, 38, .05)", borderRadius: 8,
};
const errorBoxStyle: React.CSSProperties = {
  padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5",
  border: "1px solid rgba(220,38,38,.35)", marginBottom: 12,
};
