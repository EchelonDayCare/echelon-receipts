import { useEffect, useState } from "react";
import { listTemplates, upsertTemplate, deleteTemplate, type MessageTemplate } from "../../lib/comms";
import { showAlert, showConfirm } from "../../lib/dialogs";

const KINDS = ["general", "closure", "newsletter", "reminder", "fees", "forms"];

export default function Templates() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [editing, setEditing] = useState<MessageTemplate | null>(null);

  const refresh = () => listTemplates().then(setTemplates);
  useEffect(() => { refresh(); }, []);

  async function onSave(t: MessageTemplate) {
    if (!t.name.trim()) { await showAlert("Name is required.", { kind: "warning" }); return; }
    await upsertTemplate(t);
    setEditing(null);
    await refresh();
  }

  async function onDelete(t: MessageTemplate) {
    if (t.is_builtin) { await showAlert("Built-in templates can't be deleted, but you can duplicate and edit them."); return; }
    if (!(await showConfirm(`Delete template "${t.name}"?`, { kind: "warning" }))) return;
    await deleteTemplate(t.id);
    await refresh();
  }

  function duplicate(t: MessageTemplate) {
    setEditing({
      ...t,
      id: 0 as any,
      name: `${t.name} (copy)`,
      is_builtin: 0,
    });
  }

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ marginTop: 0 }}>Message Templates</h1>
        <button className="btn" onClick={() => setEditing({ id: 0 as any, name: "", subject: "", body: "", kind: "general", is_builtin: 0, created_at: "", updated_at: "" })}>+ New template</button>
      </div>
      <p style={{ color: "var(--muted)", marginTop: -8 }}>
        Reusable subject + body for group emails.
        <br />
        Built-in starters are always available. Templates support the same merge tokens as Compose.
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
        <thead>
          <tr style={{ background: "#f8fafc", textAlign: "left" }}>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Kind</th>
            <th style={{ padding: 8 }}>Subject</th>
            <th style={{ padding: 8, width: 200 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>
                {t.name}
                {t.is_builtin ? <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 6 }}>built-in</span> : null}
              </td>
              <td style={{ padding: 8 }}>{t.kind}</td>
              <td style={{ padding: 8, color: "var(--muted)" }}>{t.subject}</td>
              <td style={{ padding: 8 }}>
                <button className="btn link" onClick={() => setEditing(t)}>{t.is_builtin ? "View" : "Edit"}</button>
                <button className="btn link" onClick={() => duplicate(t)}>Duplicate</button>
                {!t.is_builtin && <button className="btn link danger" onClick={() => onDelete(t)}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <div onClick={() => setEditing(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", padding: 24, borderRadius: 8, width: "90%", maxWidth: 700, maxHeight: "90vh", overflow: "auto" }}>
            <h2 style={{ marginTop: 0 }}>{editing.id ? (editing.is_builtin ? "View" : "Edit") : "New"} template</h2>
            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Name</label>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} readOnly={!!editing.is_builtin} style={{ width: "100%", padding: 8, marginBottom: 12 }} />

            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Kind</label>
            <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })} disabled={!!editing.is_builtin} style={{ marginBottom: 12 }}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>

            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Subject</label>
            <input value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} readOnly={!!editing.is_builtin} style={{ width: "100%", padding: 8, marginBottom: 12 }} />

            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Body</label>
            <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} readOnly={!!editing.is_builtin} rows={14} style={{ width: "100%", padding: 8, fontFamily: "inherit" }} />

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
              {!editing.is_builtin && <button className="btn" onClick={() => onSave(editing)}>Save</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
