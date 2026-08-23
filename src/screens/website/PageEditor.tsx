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
    setSaved(null);
    try {
      const res = await websiteAiEditContent(file, aiPrompt.trim());
      const pretty = tryPrettyJson(res.proposed_json);
      // Simplified flow: auto-save the proposal as a draft revision so
      // the Preview screen immediately renders the AI's version. The
      // JSON textarea (advanced view) picks it up too.
      const saveRes = await websiteSaveDraft({
        file,
        content_json: pretty,
      });
      setText(pretty);
      setDirty(false);
      setContent(await websiteLoadContent(file));
      setAiProposed({
        text: pretty,
        summary: res.summary,
        model: res.model,
      });
      setSaved(`Draft saved as revision #${saveRes.revision_id}`);
    } catch (e: any) {
      setAiErr(String(e?.message ?? e));
    } finally {
      setAiBusy(false);
    }
  }

  function onAiDiscard() {
    setAiProposed(null);
  }
  void onAiDiscard;

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
        {aiEnabled ? (
          <>
            Describe every change you want in one prompt. AI prepares the
            content, you preview, then publish. Every save is an immutable
            revision — restore an older one from the{" "}
            <button
              className="btn link"
              style={{ padding: 0, fontSize: 13 }}
              onClick={() => nav(`/website/history?file=${file}`)}
            >
              version history
            </button>{" "}
            screen.
          </>
        ) : (
          <>
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
          </>
        )}
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

      {aiEnabled ? (
        <div>
          <div
            style={{
              border: "1px solid rgba(99,102,241,0.35)",
              background:
                "linear-gradient(180deg, rgba(99,102,241,0.06), rgba(99,102,241,0.02))",
              borderRadius: 12,
              padding: 20,
              marginBottom: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 20 }}>✨</span>
              <b style={{ fontSize: 16 }}>Ask AI to update the Careers page</b>
              <span
                style={{
                  fontSize: 11,
                  color: "#64748b",
                  marginLeft: "auto",
                }}
              >
                Azure OpenAI · gpt-5.4
              </span>
            </div>
            <p
              style={{
                fontSize: 13,
                color: "#475569",
                margin: "0 0 12px",
              }}
            >
              Describe every change you want — one prompt, one submit. The AI
              will restructure the page for you. Then click <b>Preview</b> to
              see it, and <b>Publish</b> to send it live.
            </p>
            <textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder={
                "e.g. Post a Friday-only Cook role, casual, $22-25/hr. Also change the hiring email to careers@echelondaycare.com and remove the Cleaner posting."
              }
              disabled={aiBusy}
              rows={5}
              style={{
                width: "100%",
                minHeight: 120,
                padding: 12,
                border: "1px solid rgba(0,0,0,0.15)",
                borderRadius: 8,
                fontSize: 14,
                fontFamily: "inherit",
                background: "white",
                lineHeight: 1.5,
              }}
            />
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 12,
                alignItems: "center",
              }}
            >
              <button
                className="btn"
                onClick={onAiPropose}
                disabled={aiBusy || !aiPrompt.trim()}
                style={{
                  background:
                    aiBusy || !aiPrompt.trim() ? undefined : "#6366f1",
                  color:
                    aiBusy || !aiPrompt.trim() ? undefined : "white",
                  fontSize: 14,
                  padding: "8px 20px",
                }}
              >
                {aiBusy ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <Spinner /> Processing…
                  </span>
                ) : (
                  "Submit"
                )}
              </button>
              {aiPrompt && !aiBusy && !aiProposed && (
                <button
                  className="btn"
                  onClick={() => setAiPrompt("")}
                >
                  Clear
                </button>
              )}
              {aiProposed && !aiBusy && (
                <button
                  className="btn"
                  onClick={() => nav(`/website/preview?page=${file}`)}
                  style={{
                    marginLeft: "auto",
                    background: "#059669",
                    color: "white",
                    fontSize: 14,
                    padding: "8px 20px",
                  }}
                >
                  Preview →
                </button>
              )}
            </div>
            {aiErr && (
              <div
                className="home-alert tone-danger"
                style={{ marginTop: 12, fontSize: 13 }}
              >
                ⚠ {aiErr}
              </div>
            )}
            {aiProposed && !aiErr && (
              <div
                style={{
                  marginTop: 14,
                  padding: 14,
                  background: "white",
                  border: "1px solid rgba(5,150,105,0.35)",
                  borderRadius: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <span style={{ color: "#059669", fontSize: 16 }}>✓</span>
                  <b style={{ fontSize: 14 }}>Ready to preview</b>
                </div>
                <p
                  style={{
                    fontSize: 13,
                    color: "#334155",
                    margin: 0,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {aiProposed.summary}
                </p>
              </div>
            )}
          </div>
          <details>
            <summary
              style={{
                cursor: "pointer",
                fontSize: 12,
                color: "#64748b",
                padding: "6px 0",
              }}
            >
              Advanced: edit JSON directly
            </summary>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              style={{
                width: "100%",
                minHeight: 360,
                marginTop: 8,
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
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 12,
                flexWrap: "wrap",
              }}
            >
              <button
                className="btn"
                onClick={onSave}
                disabled={busy || !dirty}
              >
                {busy ? "Saving…" : dirty ? "Save draft" : "No changes"}
              </button>
              <button
                className="btn"
                onClick={() => setText(tryPrettyJson(text))}
                disabled={busy}
              >
                Reformat JSON
              </button>
              <button
                className="btn"
                onClick={onReload}
                disabled={busy}
              >
                Reload from disk
              </button>
            </div>
          </details>
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        border: "2px solid rgba(255,255,255,0.35)",
        borderTopColor: "white",
        borderRadius: "50%",
        animation: "echSpin 0.7s linear infinite",
      }}
    >
      <style>{`@keyframes echSpin{to{transform:rotate(360deg)}}`}</style>
    </span>
  );
}
