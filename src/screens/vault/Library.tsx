// Document Vault — Library screen.
// v1.4.1 UX pass: horizontal filter bar (was 260px sidebar), popover for
// less-used filters, friendly empty states (no-docs-yet vs no-matches).
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { showAlert } from "../../lib/dialogs";
import {
  listDocuments, listAllTags, recordEvent, resolveLinkedNames,
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
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // "Ever-had-docs?" — distinguishes empty-because-filtered from empty-because-first-use.
  const [totalDocs, setTotalDocs] = useState<number | null>(null);
  const [linkedNames, setLinkedNames] = useState<Map<string, string>>(new Map());

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

  const filtersActive =
    !!category || !!linkedKind || preset !== "all" ||
    !!search.trim() || tagFilter.length > 0 || includeOldVersions || showDeleted;

  const clearFilters = () => {
    setCategory(""); setLinkedKind(""); setPreset("all"); setSearch("");
    setTagFilter([]); setIncludeOldVersions(false); setShowDeleted(false);
  };

  const refresh = async () => {
    try {
      const [list, allTags] = await Promise.all([listDocuments(filter), listAllTags()]);
      setDocs(list);
      setTags(allTags);
      setSelected((cur) => new Set([...cur].filter((id) => list.some((d) => d.id === id))));
      // Cache the ever-had-docs flag once (cheap: totalDocs stays truthy once ≥1 doc exists).
      if (totalDocs == null || (totalDocs === 0 && list.length > 0)) {
        const all = await listDocuments({ includeOldVersions: true });
        setTotalDocs(all.length);
      }
      resolveLinkedNames(list.map((d) => ({ kind: d.linkedKind, id: d.linkedId })))
        .then(setLinkedNames)
        .catch(() => {});
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  // Keep state in sync with URL params so sidebar links (which change the
  // URL but don't remount this component) actually apply their filter.
  useEffect(() => {
    const exp = params.get("expiring");
    const nextPreset: Preset =
      exp === "30" ? "30" :
      exp === "60" ? "60" :
      exp === "90" ? "90" :
      exp === "expired" || exp === "0" ? "expired" :
      "all";
    setPreset(nextPreset);
    const cat = params.get("category") as DocCategory | null;
    setCategory(cat ?? "");
  }, [params]);

  // Close "More filters" popover on outside click.
  useEffect(() => {
    if (!moreOpen) return;
    const onClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [moreOpen]);

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
      void showAlert(`Wrote ${chosen.length} files, ${(bytesWritten / 1024).toFixed(1)} KB total.`);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  const today = new Date().toISOString().slice(0, 10);
  const activeChipCount =
    (category ? 1 : 0) + (linkedKind ? 1 : 0) + (preset !== "all" ? 1 : 0) +
    (search.trim() ? 1 : 0) + tagFilter.length + (includeOldVersions ? 1 : 0) + (showDeleted ? 1 : 0);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
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
      <p className="subtitle" style={{ marginTop: 4 }}>
        Licenses, insurance, staff records, board minutes — hashed, versioned, and
        searchable in one place.
      </p>

      {err && <div style={errorBoxStyle}>{err}</div>}

      {/* Compact filter bar — single row, wraps only on very narrow windows. */}
      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, issuer, notes…"
            style={{ flex: "1 1 240px", minWidth: 200 }}
          />
          <select value={category} onChange={(e) => setCategory(e.target.value as DocCategory | "")} style={selStyle} title="Category">
            <option value="">All categories</option>
            {DOC_CATEGORIES.map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
          </select>
          <select value={linkedKind} onChange={(e) => setLinkedKind(e.target.value as LinkedKind | "")} style={selStyle} title="Linked to">
            <option value="">Any link</option>
            <option value="student">Student</option>
            <option value="staff">Staff</option>
            <option value="vendor">Vendor</option>
          </select>
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} style={selStyle} title="Expiring within">
            <option value="all">Any expiry</option>
            <option value="30">Expires ≤ 30 d</option>
            <option value="60">Expires ≤ 60 d</option>
            <option value="90">Expires ≤ 90 d</option>
            <option value="expired">Already expired</option>
          </select>
          <div ref={moreRef} style={{ position: "relative" }}>
            <button
              className="btn"
              onClick={() => setMoreOpen((v) => !v)}
              style={{ position: "relative" }}
              title="More filters"
            >
              More filters
              {(tagFilter.length + (includeOldVersions ? 1 : 0) + (showDeleted ? 1 : 0)) > 0 && (
                <span style={badgeStyle}>{tagFilter.length + (includeOldVersions ? 1 : 0) + (showDeleted ? 1 : 0)}</span>
              )}
            </button>
            {moreOpen && (
              <div style={popoverStyle}>
                <label style={cbStyle}>
                  <input type="checkbox" checked={includeOldVersions} onChange={(e) => setIncludeOldVersions(e.target.checked)} />
                  Show older versions
                </label>
                <label style={cbStyle}>
                  <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
                  Show deleted (restore within 30 d)
                </label>
                {tags.length > 0 && (
                  <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                    <div style={panelLabelStyle}>Tags</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {tags.map((t) => (
                        <ChipButton key={t} active={tagFilter.includes(t)} onClick={() => toggleTag(t)}>{t}</ChipButton>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          {filtersActive && (
            <button className="btn ghost" onClick={clearFilters} style={{ fontSize: 12 }} title="Reset all filters">
              ✕ Clear ({activeChipCount})
            </button>
          )}
          <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
            {docs.length} document{docs.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      {docs.length === 0 ? (
        totalDocs === 0 ? <FirstRunEmpty onUpload={() => setIntent({ mode: "new" })} />
                       : <NoMatchesEmpty onClear={clearFilters} onUpload={() => setIntent({ mode: "new" })} filtersActive={filtersActive} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f8fafc", textAlign: "left", color: "var(--muted)", fontWeight: 500 }}>
                <th style={{ padding: 10, width: 32 }}>
                  <input type="checkbox"
                    checked={selected.size === docs.length && docs.length > 0}
                    onChange={(e) => setSelected(e.target.checked ? new Set(docs.map((d) => d.id)) : new Set())}
                  />
                </th>
                <th style={{ padding: 10 }}>Title</th>
                <th style={{ padding: 10 }}>Category</th>
                <th style={{ padding: 10 }}>Linked</th>
                <th style={{ padding: 10 }}>Issued</th>
                <th style={{ padding: 10 }}>Expires</th>
                <th style={{ padding: 10, textAlign: "right" }}>Size</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => {
                const expired = doc.expiryDate && doc.expiryDate < today;
                const soon = doc.expiryDate && !expired && Date.parse(doc.expiryDate + "T00:00:00") - Date.now() < 60 * 86400000;
                const rowColor = expired ? "rgba(220,38,38,.08)" : soon ? "rgba(217, 119, 6, .08)" : undefined;
                return (
                  <tr key={doc.id}
                    style={{ borderTop: "1px solid var(--border)", background: rowColor, cursor: "pointer" }}
                    onClick={() => setOpenId(doc.id)}
                  >
                    <td style={{ padding: 10 }} onClick={(e) => { e.stopPropagation(); toggleSelected(doc.id); }}>
                      <input type="checkbox" checked={selected.has(doc.id)} onChange={() => toggleSelected(doc.id)} />
                    </td>
                    <td style={{ padding: 10 }}>
                      <div><b>{doc.title}</b>{!doc.isCurrent && <span style={{ color: "var(--muted)", marginLeft: 6, fontSize: 11 }}>v{doc.versionNo} (old)</span>}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>{doc.fileName}</div>
                    </td>
                    <td style={{ padding: 10 }}>{doc.category}</td>
                    <td style={{ padding: 10 }} onClick={(e) => { if (doc.linkedKind && doc.linkedId) e.stopPropagation(); }}>
                      {linkedEntityCell(doc.linkedKind, doc.linkedId, linkedNames)}
                    </td>
                    <td style={{ padding: 10 }}>{doc.issuedDate || "—"}</td>
                    <td style={{ padding: 10, color: expired ? "#dc2626" : soon ? "#d97706" : undefined }}>{doc.expiryDate || "—"}</td>
                    <td style={{ padding: 10, textAlign: "right" }}>{(doc.sizeBytes / 1024).toFixed(1)} KB</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

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

// M-16: linked-entity cell — was a plain "student:abc123" string; now a
// clickable Link with a human-readable name from the bulk resolver map.
function linkedEntityCell(
  kind: LinkedKind | null, id: string | null, names: Map<string, string>,
): React.ReactNode {
  if (!kind || !id) return "—";
  const label = names.get(`${kind}:${id}`) ?? `${kind} #${id}`;
  if (kind === "student") return <Link to={`/students/roster?highlight=${id}`} onClick={(e) => e.stopPropagation()}>{label}</Link>;
  if (kind === "staff") return <Link to={`/staff/hours?highlight=${id}`} onClick={(e) => e.stopPropagation()}>{label}</Link>;
  return label; // vendor — freeform, no dedicated screen to link to yet
}

function FirstRunEmpty({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="card" style={{ padding: "48px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 42, marginBottom: 10 }}>🗂️</div>
      <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>Your vault is empty</h2>
      <div style={{ color: "var(--muted)", fontSize: 14, maxWidth: 480, margin: "0 auto 18px" }}>
        Upload licences, insurance policies, staff records, incident reports, board minutes,
        vendor contracts. Files are content-hashed so re-uploads dedupe automatically, and
        expiry dates surface on the Home dashboard.
      </div>
      <button className="btn primary" onClick={onUpload} style={{ padding: "10px 20px", fontSize: 14 }}>
        + Upload your first document
      </button>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 14 }}>
        Accepts PDF, PNG, JPG, DOCX, XLSX and anything else — no format lock-in.
      </div>
    </div>
  );
}

function NoMatchesEmpty({ onClear, onUpload, filtersActive }: {
  onClear: () => void; onUpload: () => void; filtersActive: boolean;
}) {
  return (
    <div className="card" style={{ padding: "40px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 30, marginBottom: 8 }}>🔍</div>
      <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>No documents match these filters</h2>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
        Try broadening the category, expiry range, or search text.
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        {filtersActive && <button className="btn" onClick={onClear}>✕ Clear filters</button>}
        <button className="btn primary" onClick={onUpload}>+ Upload</button>
      </div>
    </div>
  );
}

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      style={{
        padding: "4px 10px", borderRadius: 999, fontSize: 12,
        border: "1px solid " + (active ? "var(--accent)" : "var(--border)"),
        background: active ? "rgba(37,99,235,.15)" : "transparent",
        color: active ? "var(--accent)" : "inherit",
        cursor: "pointer",
      }}
    >{children}</button>
  );
}

const panelLabelStyle: React.CSSProperties = { fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 };
const errorBoxStyle: React.CSSProperties = {
  padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#991b1b",
  border: "1px solid rgba(220,38,38,.35)", marginBottom: 12,
};
const selStyle: React.CSSProperties = { minWidth: 150, fontSize: 13 };
const cbStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, fontSize: 13,
  padding: "4px 0", cursor: "pointer",
};
const popoverStyle: React.CSSProperties = {
  position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 20,
  minWidth: 260, background: "var(--panel)", border: "1px solid var(--border)",
  borderRadius: 8, boxShadow: "0 8px 24px rgba(15,23,42,.15)", padding: 12,
};
const badgeStyle: React.CSSProperties = {
  marginLeft: 6, background: "var(--accent)", color: "#fff",
  fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 999,
};
