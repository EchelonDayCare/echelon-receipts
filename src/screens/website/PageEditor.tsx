import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  websiteAiEditContent,
  websiteLoadContent,
  websiteSaveDraft,
  tryPrettyJson,
  EDITABLE_FILES,
  type EditableFile,
  type ContentFile,
} from "../../lib/website";

const FILE_LABELS: Record<EditableFile, string> = {
  site: "Site (global)",
  home: "Home",
  about: "About",
  services: "Programs & Waiting List",
  contact: "Contact",
  tour: "Virtual Tour",
  careers: "Careers",
  seo: "SEO",
};

// One editor screen per content file. Uses a JSON textarea today —
// PR 3 replaces the raw editor with page-specific field forms once
// the media module lands and we can share the "editable-field"
// component design across text and image fields.
export default function PageEditor() {
  const { file: rawFile = "site" } = useParams();
  const nav = useNavigate();
  const file = useMemo<EditableFile>(() => {
    return (EDITABLE_FILES.includes(rawFile as EditableFile)
      ? (rawFile as EditableFile)
      : "site") as EditableFile;
  }, [rawFile]);

  const [content, setContent] = useState<ContentFile | null>(null);
  const [text, setText] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // AI edit state — only rendered when the current page supports it.
  const AI_EDIT_PAGES: EditableFile[] = ["careers"];
  const aiEnabled = AI_EDIT_PAGES.includes(file);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiProposed, setAiProposed] = useState<{
    text: string;
    summary: string;
    model: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setErr(null);
    setSaved(null);
    setDirty(false);
    (async () => {
      try {
        const c = await websiteLoadContent(file);
        if (cancelled) return;
        setContent(c);
        setText(tryPrettyJson(c.content_json));
      } catch (e: any) {
        if (cancelled) return;
        setErr(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  async function onSave() {
    setBusy(true);
    setErr(null);
    setSaved(null);
    try {
      const res = await websiteSaveDraft({
        file,
        content_json: text,
      });
      setSaved(`Saved as revision #${res.revision_id}`);
      setDirty(false);
      const c = await websiteLoadContent(file);
      setContent(c);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function onReload() {
    if (dirty && !confirm("Discard current edits and reload from the working copy?")) return;
    setBusy(true);
    setErr(null);
    try {
      const c = await websiteLoadContent(file);
      setContent(c);
      setText(tryPrettyJson(c.content_json));
      setDirty(false);
    } finally {
      setBusy(false);
    }
  }

  async function onAiPropose() {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    setAiErr(null);
    setAiProposed(null);
    try {
      const res = await websiteAiEditContent(file, aiPrompt.trim());
      setAiProposed({
        text: tryPrettyJson(res.proposed_json),
        summary: res.summary,
        model: res.model,
      });
    } catch (e: any) {
      setAiErr(String(e?.message ?? e));
    } finally {
      setAiBusy(false);
    }
  }

  function onAiApply() {
    if (!aiProposed) return;
    setText(aiProposed.text);
    setDirty(true);
    setAiProposed(null);
    setAiPrompt("");
    setSaved(null);
  }

  function onAiDiscard() {
    setAiProposed(null);
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn link" onClick={() => nav("/website")} style={{ padding: 0 }}>
          ← Website
        </button>
        <h1 style={{ margin: 0 }}>{FILE_LABELS[file]}</h1>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 12,
            padding: "3px 8px",
            borderRadius: 6,
            background: content?.source === "draft" ? "#dbeafe" : "#f1f5f9",
            color: content?.source === "draft" ? "#1e40af" : "#334155",
          }}
        >
          {content?.source === "draft"
            ? `Draft (rev #${content.active_draft_rev})`
            : "Working copy"}
        </span>
      </div>
      <p style={{ color: "var(--muted, #64748b)", marginTop: 8 }}>
        Edit the underlying JSON directly. Every save creates an immutable
        revision. Restore an older version from the{" "}
        <button
          className="btn link"
          style={{ padding: 0, fontSize: 13 }}
          onClick={() => nav(`/website/history?file=${file}`)}
        >
          version history
        </button>{" "}
        screen.
      </p>

      {err && (
        <div className="home-alert tone-danger" style={{ margin: "12px 0" }}>
          ⚠ {err}
        </div>
      )}
      {saved && (
        <div className="home-alert tone-info" style={{ margin: "12px 0" }}>
          ✓ {saved}
        </div>
      )}

      {aiEnabled && (
        <div
          style={{
            border: "1px solid rgba(99,102,241,0.35)",
            background: "linear-gradient(180deg, rgba(99,102,241,0.06), rgba(99,102,241,0.02))",
            borderRadius: 12,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 18 }}>✨</span>
            <b style={{ fontSize: 15 }}>Ask AI to edit this page</b>
            <span style={{ fontSize: 11, color: "#64748b", marginLeft: "auto" }}>
              Azure OpenAI · gpt-5.4
            </span>
          </div>
          <p style={{ fontSize: 13, color: "#475569", margin: "0 0 10px" }}>
            Describe the change in plain English. Examples:{" "}
            <i>“Add a Friday-only cook role, casual, $22-25/hr.”</i> ·{" "}
            <i>“Change the hiring email to careers@echelondaycare.com.”</i> ·{" "}
            <i>“Remove the Warehouse Assistant posting.”</i>
          </p>
          <textarea
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="Describe your change…"
            disabled={aiBusy}
            style={{
              width: "100%",
              minHeight: 72,
              padding: 10,
              border: "1px solid rgba(0,0,0,0.15)",
              borderRadius: 8,
              fontSize: 13,
              fontFamily: "inherit",
              background: "white",
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="btn"
              onClick={onAiPropose}
              disabled={aiBusy || !aiPrompt.trim()}
              style={{
                background: aiBusy || !aiPrompt.trim() ? undefined : "#6366f1",
                color: aiBusy || !aiPrompt.trim() ? undefined : "white",
              }}
            >
              {aiBusy ? "Thinking…" : "Propose edit"}
            </button>
            {aiPrompt && !aiBusy && (
              <button className="btn" onClick={() => setAiPrompt("")}>
                Clear
              </button>
            )}
          </div>
          {aiErr && (
            <div
              className="home-alert tone-danger"
              style={{ marginTop: 10, fontSize: 13 }}
            >
              ⚠ {aiErr}
            </div>
          )}
          {aiProposed && (
            <div
              style={{
                marginTop: 12,
                padding: 12,
                border: "1px solid rgba(0,0,0,0.12)",
                borderRadius: 8,
                background: "white",
              }}
            >
              <div style={{ fontSize: 13, marginBottom: 6 }}>
                <b>Proposed change ({aiProposed.model})</b>
              </div>
              <p
                style={{
                  fontSize: 13,
                  margin: "0 0 10px",
                  color: "#334155",
                  whiteSpace: "pre-wrap",
                }}
              >
                {aiProposed.summary}
              </p>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 12, color: "#64748b" }}>
                  Show proposed JSON
                </summary>
                <pre
                  style={{
                    marginTop: 8,
                    padding: 10,
                    background: "#0f172a",
                    color: "#e2e8f0",
                    borderRadius: 6,
                    fontSize: 12,
                    maxHeight: 320,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {aiProposed.text}
                </pre>
              </details>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  className="btn"
                  onClick={onAiApply}
                  style={{ background: "#059669", color: "white" }}
                >
                  Apply to editor
                </button>
                <button className="btn" onClick={onAiDiscard}>
                  Discard
                </button>
                <span
                  style={{
                    fontSize: 12,
                    color: "#64748b",
                    alignSelf: "center",
                    marginLeft: "auto",
                  }}
                >
                  Applying loads the JSON below — you still need to Save + Publish.
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 480,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: 13,
          padding: 12,
          border: "1px solid rgba(0,0,0,0.15)",
          borderRadius: 8,
          background: "white",
          color: "#0f172a",
          lineHeight: 1.5,
        }}
      />

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button className="btn" onClick={onSave} disabled={busy || !dirty}>
          {busy ? "Saving…" : dirty ? "Save draft" : "No changes"}
        </button>
        <button
          className="btn"
          onClick={() => setText(tryPrettyJson(text))}
          disabled={busy}
        >
          Reformat JSON
        </button>
        <button className="btn" onClick={onReload} disabled={busy}>
          Reload from disk
        </button>
        <button className="btn" onClick={() => nav("/website/preview")}>
          Preview →
        </button>
      </div>
    </div>
  );
}
