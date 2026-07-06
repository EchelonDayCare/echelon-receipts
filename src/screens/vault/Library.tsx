// Document Vault — Library screen. Filter panel + table + bulk actions.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  listDocuments, listAllTags, recordEvent,
  DOC_CATEGORIES, type DocCategory, type Document, type DocFilter, type LinkedKind,
} from "../../repo/documentsRepo";
import UploadModal, { type UploadIntent } from "./UploadModal";
import DetailDrawer from "./DetailDrawer";

type Preset = "all" | "30" | "60" | "90" | "expired";

export default function VaultLibrary() {
  const [params] = useSearchParams();
  const [docs, setDocs] = useState<Document[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [intent, setIntent] = useState<UploadIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const initialExpiring = params.get("expiring");
  const initialCategory = params.get("category") as DocCategory | null;

  const [category, setCategory] = useState<DocCategory | "">(initialCategory ?? "");
  const [linkedKind, setLinkedKind] = useState<LinkedKind | "">("");
  const [preset, setPreset] = useState<Preset>(initialExpiring === "60" ? "60" : "all");
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [includeOldVersions, setIncludeOldVersions] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  const filter = useMemo<DocFilter>(() => {
    const f: DocFilter = { includeOldVersions };
    if (category) f.category = category;
    if (linkedKind) f.linkedKind = linkedKind;
    if (search.trim()) f.search = search.trim();
    if (tagFilter.length) f.tags = tagFilter;
    if (showDeleted) f.onlyDeleted = true;
    if (preset !== "all") {
      const days = preset === "expired" ? 0 : parseInt(preset, 10);
      f.expiringWithinDays = days;
    }
    return f;
  }, [category, linkedKind, preset, search, tagFilter, includeOldVersions, showDeleted]);

  const refresh = async () => {
    try {
      const [list, allTags] = await Promise.all([listDocuments(filter), listAllTags()]);
      setDocs(list);
      setTags(allTags);
      setSelected((cur) => new Set([...cur].filter((id) => list.some((d) => d.id === id))));
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  const toggleTag = (t: string) => setTagFilter((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  const toggleSelected = (id: string) => setSelected((cur) => {
    const nx = new Set(cur); nx.has(id) ? nx.delete(id) : nx.add(id); return nx;
  });

  async function exportZip() {
    if (selected.size === 0) { setErr("Select at least one document."); return; }
    setBusy(true); setErr(null);
    try {
      const dest = await saveDialog({ defaultPath: `documents-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: "ZIP", extensions: ["zip"] }] });
      if (!dest) return;
      const chosen = docs.filter((d) => selected.has(d.id));
      const entries = chosen.map((d) => {
        const ext = (d.fileName.split(".").pop() || "bin").toLowerCase();
        const safe = d.title.replace(/[<>:"/\\|?*]/g, "_");
        return { blob_key: d.blobKey, path_in_zip: `${d.category}/${safe}__v${d.versionNo}.${ext}` };
      });
      const bytesWritten = await invoke<number>("documents_export_zip", { entries, destPath: dest });
      for (const doc of chosen) await recordEvent(doc.id, "exported", { path: dest });
      alert(`Wrote ${chosen.length} files, ${(bytesWritten / 1024).toFixed(1)} KB total.`);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Document Vault</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {selected.size > 0 && (
            <button className="btn" onClick={exportZip} disabled={busy}>
              Export ZIP ({selected.size})
            </button>
          )}
          <button className="btn primary" onClick={() => setIntent({ mode: "new" })}>+ Upload</button>
        </div>
      </div>

      {err && <div style={errorBoxStyle}>{err}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 20 }}>
        <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={panelLabelStyle}>Search</div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title, issuer, notes…" style={{ width: "100%" }} />
          </div>
          <div>
            <div style={panelLabelStyle}>Category</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              <ChipButton active={!category} onClick={() => setCategory("")}>All</ChipButton>
              {DOC_CATEGORIES.map((c) => (
                <ChipButton key={c.value} active={category === c.value} onClick={() => setCategory(c.value)}>{c.label}</ChipButton>
              ))}
            </div>
          </div>
          <div>
            <div style={panelLabelStyle}>Linked to</div>
            <select value={linkedKind} onChange={(e) => setLinkedKind(e.target.value as LinkedKind | "")} style={{ width: "100%" }}>
              <option value="">All</option>
              <option value="student">Student</option>
              <option value="staff">Staff</option>
              <option value="vendor">Vendor</option>
            </select>
          </div>
          <div>
            <div style={panelLabelStyle}>Expiring within</div>
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} style={{ width: "100%" }}>
              <option value="all">Any time</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
              <option value="expired">Already expired</option>
            </select>
          </div>
          {tags.length > 0 && (
            <div>
              <div style={panelLabelStyle}>Tags</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {tags.map((t) => (
                  <ChipButton key={t} active={tagFilter.includes(t)} onClick={() => toggleTag(t)}>{t}</ChipButton>
                ))}
              </div>
            </div>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={includeOldVersions} onChange={(e) => setIncludeOldVersions(e.target.checked)} />
            Show older versions
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
            Show deleted (restore within 30 days)
          </label>
        </aside>

        <div>
          {docs.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", border: "1px dashed var(--border, #334155)", borderRadius: 8, color: "var(--muted)" }}>
              No documents match. {docs.length === 0 && !search && !category && "Upload your first."}
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--muted)", fontWeight: 500 }}>
                  <th style={{ padding: 8, width: 32 }}>
                    <input type="checkbox"
                      checked={selected.size === docs.length && docs.length > 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(docs.map((d) => d.id)) : new Set())}
                    />
                  </th>
                  <th style={{ padding: 8 }}>Title</th>
                  <th style={{ padding: 8 }}>Category</th>
                  <th style={{ padding: 8 }}>Linked</th>
                  <th style={{ padding: 8 }}>Issued</th>
                  <th style={{ padding: 8 }}>Expires</th>
                  <th style={{ padding: 8, textAlign: "right" }}>Size</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => {
                  const expired = doc.expiryDate && doc.expiryDate < today;
                  const soon = doc.expiryDate && !expired && Date.parse(doc.expiryDate + "T00:00:00") - Date.now() < 60 * 86400000;
                  const rowColor = expired ? "rgba(220,38,38,.08)" : soon ? "rgba(217, 119, 6, .08)" : undefined;
                  return (
                    <tr key={doc.id}
                      style={{ borderTop: "1px solid var(--border, #1e293b)", background: rowColor, cursor: "pointer" }}
                      onClick={() => setOpenId(doc.id)}
                    >
                      <td style={{ padding: 8 }} onClick={(e) => { e.stopPropagation(); toggleSelected(doc.id); }}>
                        <input type="checkbox" checked={selected.has(doc.id)} onChange={() => toggleSelected(doc.id)} />
                      </td>
                      <td style={{ padding: 8 }}>
                        <div><b>{doc.title}</b>{!doc.isCurrent && <span style={{ color: "var(--muted)", marginLeft: 6, fontSize: 11 }}>v{doc.versionNo} (old)</span>}</div>
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>{doc.fileName}</div>
                      </td>
                      <td style={{ padding: 8 }}>{doc.category}</td>
                      <td style={{ padding: 8 }}>{doc.linkedKind ? `${doc.linkedKind} #${doc.linkedId}` : "—"}</td>
                      <td style={{ padding: 8 }}>{doc.issuedDate || "—"}</td>
                      <td style={{ padding: 8, color: expired ? "#dc2626" : soon ? "#d97706" : undefined }}>{doc.expiryDate || "—"}</td>
                      <td style={{ padding: 8, textAlign: "right" }}>{(doc.sizeBytes / 1024).toFixed(1)} KB</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {intent && (
        <UploadModal
          intent={intent}
          onClose={() => setIntent(null)}
          onSaved={async () => { setIntent(null); await refresh(); }}
        />
      )}

      <DetailDrawer
        id={openId}
        onClose={() => setOpenId(null)}
        onEdit={(doc) => setIntent({ mode: "edit-metadata", doc })}
        onNewVersion={(doc) => setIntent({ mode: "new-version", docId: doc.id, existingTitle: doc.title })}
        onChanged={refresh}
      />
    </div>
  );
}

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      style={{
        padding: "4px 10px", borderRadius: 999, fontSize: 12,
        border: "1px solid " + (active ? "#2563eb" : "var(--border, #334155)"),
        background: active ? "rgba(37,99,235,.15)" : "transparent",
        color: active ? "#60a5fa" : "inherit",
        cursor: "pointer",
      }}
    >{children}</button>
  );
}

const panelLabelStyle: React.CSSProperties = { fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 };
const errorBoxStyle: React.CSSProperties = {
  padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5",
  border: "1px solid rgba(220,38,38,.35)", marginBottom: 12,
};
