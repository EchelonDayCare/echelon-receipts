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
  const AI_EDIT_PAGES: EditableFile[] = ["careers", "tour", "contact"];
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

  // Careers: current-jobs list with multi-select delete (v3.22.1).
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const [jobsBusy, setJobsBusy] = useState(false);
  const [deleteJobsPending, setDeleteJobsPending] = useState(false);
  const currentJobs: Array<{ id: string; title: string; type?: string; location?: string; category?: string }> = useMemo(() => {
    if (file !== "careers" || !content) return [];
    try {
      const parsed = JSON.parse(content.content_json);
      const arr = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      return arr.map((j: any) => ({
        id: String(j.id ?? ""),
        title: String(j.title ?? "Untitled"),
        type: j.type ? String(j.type) : undefined,
        location: j.location ? String(j.location) : undefined,
        category: j.category ? String(j.category) : undefined,
      }));
    } catch {
      return [];
    }
  }, [file, content]);

  // Contact: readable summary of current published fields (v3.22.2).
  const currentContact: {
    heading?: string;
    address?: string;
    map_embed_url?: string;
    facebook_aria_label?: string;
  } | null = useMemo(() => {
    if (file !== "contact" || !content) return null;
    try {
      const p = JSON.parse(content.content_json);
      const title = String(p?.map_iframe_title ?? "");
      const address = title.replace(/^Map of\s*/i, "").trim() || undefined;
      return {
        heading: p?.heading ? String(p.heading) : undefined,
        address,
        map_embed_url: p?.map_embed_url ? String(p.map_embed_url) : undefined,
        facebook_aria_label: p?.facebook_aria_label ? String(p.facebook_aria_label) : undefined,
      };
    } catch {
      return null;
    }
  }, [file, content]);

  // Contact: inline edit form for heading + address + Facebook URL (v3.22.3).
  // Facebook URL is stored in site.socials.facebook, so we load site.json
  // alongside contact.json and save two drafts on Submit.
  const [siteContent, setSiteContent] = useState<ContentFile | null>(null);
  const [contactHeading, setContactHeading] = useState("");
  const [contactAddress, setContactAddress] = useState("");
  const [contactFacebookUrl, setContactFacebookUrl] = useState("");
  const [contactSubmitBusy, setContactSubmitBusy] = useState(false);
  const [contactMsg, setContactMsg] = useState<string | null>(null);
  const [contactErr, setContactErr] = useState<string | null>(null);

  useEffect(() => {
    if (file !== "contact") { setSiteContent(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const s = await websiteLoadContent("site");
        if (!cancelled) setSiteContent(s);
      } catch {
        if (!cancelled) setSiteContent(null);
      }
    })();
    return () => { cancelled = true; };
  }, [file]);

  // Seed the form when content loads or reverts. Keep this separate from
  // status messages so a successful save doesn't clear its own toast.
  useEffect(() => {
    if (file !== "contact") return;
    setContactHeading(currentContact?.heading ?? "");
    try {
      const s = siteContent ? JSON.parse(siteContent.content_json) : null;
      setContactAddress(String(s?.address?.display ?? currentContact?.address ?? ""));
      setContactFacebookUrl(String(s?.socials?.facebook ?? ""));
    } catch {
      setContactAddress(currentContact?.address ?? "");
      setContactFacebookUrl("");
    }
  }, [file, currentContact, siteContent]);

  // Clear contact status only when switching files.
  useEffect(() => {
    setContactMsg(null);
    setContactErr(null);
  }, [file]);

  const contactDirty = useMemo(() => {
    if (file !== "contact") return false;
    const hChanged = (contactHeading || "") !== (currentContact?.heading ?? "");
    let currentFb = "";
    let currentAddrDisplay = "";
    try {
      const s = JSON.parse(siteContent?.content_json ?? "{}");
      currentFb = String(s?.socials?.facebook ?? "");
      currentAddrDisplay = String(s?.address?.display ?? "");
    } catch { /* ignore */ }
    // Compare address against site.address.display (what the site actually
    // renders) — the contact.json map_iframe_title is derived, not authoritative.
    const aChanged = (contactAddress || "") !== currentAddrDisplay;
    const fbChanged = (contactFacebookUrl || "") !== currentFb;
    return hChanged || aChanged || fbChanged;
  }, [file, contactHeading, contactAddress, contactFacebookUrl, currentContact, siteContent]);

  async function submitContactForm() {
    if (!content) return;
    const heading = contactHeading.trim();
    const address = contactAddress.trim();
    const fbUrl = contactFacebookUrl.trim();
    if (!heading) { setContactErr("Page heading can't be empty."); return; }
    if (!address) { setContactErr("Address can't be empty."); return; }
    if (fbUrl && !/^https?:\/\//i.test(fbUrl)) {
      setContactErr("Facebook link must start with http:// or https://");
      return;
    }
    setContactSubmitBusy(true);
    setContactErr(null);
    setContactMsg(null);
    try {
      // Rewrite contact.json: heading + derived map fields.
      const contactObj = JSON.parse(content.content_json);
      contactObj.heading = heading;
      contactObj.map_iframe_title = `Map of ${address}`;
      const encoded = encodeURIComponent(address).replace(/%20/g, "+");
      contactObj.map_embed_url = `https://www.google.com/maps?q=${encoded}&output=embed`;
      const contactRev = await websiteSaveDraft({
        file: "contact",
        content_json: JSON.stringify(contactObj, null, 2) + "\n",
      });
      let siteRev: number | null = null;
      if (siteContent) {
        const siteObj = JSON.parse(siteContent.content_json);
        const oldFb = String(siteObj?.socials?.facebook ?? "");
        const oldDisplay = String(siteObj?.address?.display ?? "");
        let siteChanged = false;
        if (fbUrl !== oldFb) {
          siteObj.socials = { ...(siteObj.socials ?? {}), facebook: fbUrl };
          if (Array.isArray(siteObj.same_as)) {
            siteObj.same_as = siteObj.same_as.map((u: string) => (u === oldFb ? fbUrl : u));
            if (fbUrl && !siteObj.same_as.includes(fbUrl)) siteObj.same_as.push(fbUrl);
          }
          siteChanged = true;
        }
        if (address !== oldDisplay) {
          // Address is what visitors actually see (Contact page + footer +
          // schema.org). Update display + footer_display verbatim from the
          // form. The structured street/locality/region/postal fields are
          // left as-is (they feed JSON-LD only); use the AI prompt to
          // rewrite those if precise SEO markup matters.
          siteObj.address = {
            ...(siteObj.address ?? {}),
            display: address,
            footer_display: address,
          };
          siteChanged = true;
        }
        if (siteChanged) {
          const r = await websiteSaveDraft({
            file: "site",
            content_json: JSON.stringify(siteObj, null, 2) + "\n",
          });
          siteRev = r.revision_id;
          setSiteContent(await websiteLoadContent("site"));
        }
      }
      const c = await websiteLoadContent("contact");
      setContent(c);
      setText(tryPrettyJson(c.content_json));
      setDirty(false);
      setContactMsg(
        `Saved — contact draft rev #${contactRev.revision_id}` +
        (siteRev !== null ? `, site draft rev #${siteRev}` : "") +
        ". Click Preview to see it, then Publish to go live."
      );
    } catch (e: any) {
      setContactErr(String(e?.message ?? e));
    } finally {
      setContactSubmitBusy(false);
    }
  }

  useEffect(() => {
    // Prune stale selections when jobs list changes (e.g. after AI edit).
    setSelectedJobIds((prev) => {
      const ids = new Set(currentJobs.map((j) => j.id));
      const next = new Set<string>();
      prev.forEach((id) => { if (ids.has(id)) next.add(id); });
      return next;
    });
  }, [currentJobs]);

  const allJobsSelected = currentJobs.length > 0 && selectedJobIds.size === currentJobs.length;

  function toggleJob(id: string) {
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllJobs() {
    if (allJobsSelected) setSelectedJobIds(new Set());
    else setSelectedJobIds(new Set(currentJobs.map((j) => j.id)));
  }

  async function performDeleteJobs() {
    if (!content || selectedJobIds.size === 0) return;
    setJobsBusy(true);
    setErr(null);
    setSaved(null);
    try {
      const parsed = JSON.parse(content.content_json);
      const kept = Array.isArray(parsed.jobs)
        ? parsed.jobs.filter((j: any) => !selectedJobIds.has(String(j.id ?? "")))
        : [];
      parsed.jobs = kept;
      const nextJson = JSON.stringify(parsed, null, 2) + "\n";
      const res = await websiteSaveDraft({ file: "careers", content_json: nextJson });
      setSaved(`Deleted ${selectedJobIds.size} job${selectedJobIds.size === 1 ? "" : "s"} — draft rev #${res.revision_id}`);
      setSelectedJobIds(new Set());
      setDeleteJobsPending(false);
      const c = await websiteLoadContent("careers");
      setContent(c);
      setText(tryPrettyJson(c.content_json));
      setDirty(false);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setJobsBusy(false);
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
      // Contact-page prompts may also affect site.json (socials, address,
      // phone, email). When the AI returns a site_proposed_json, save it
      // as a second draft so Preview renders both changes together.
      let siteSaveRev: number | null = null;
      if (res.site_proposed_json && res.site_proposed_json.trim()) {
        const sitePretty = tryPrettyJson(res.site_proposed_json);
        const siteSave = await websiteSaveDraft({
          file: "site",
          content_json: sitePretty,
        });
        siteSaveRev = siteSave.revision_id;
        if (file === "contact") {
          setSiteContent(await websiteLoadContent("site"));
        }
      }
      setText(pretty);
      setDirty(false);
      setContent(await websiteLoadContent(file));
      setAiProposed({
        text: pretty,
        summary: res.summary,
        model: res.model,
      });
      setSaved(
        `Draft saved as revision #${saveRes.revision_id}` +
        (siteSaveRev !== null ? ` (site draft rev #${siteSaveRev})` : "")
      );
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
        <button
          className="btn"
          onClick={() => nav(`/website/preview?page=${file}`)}
          style={{ marginLeft: "auto", fontSize: 13, padding: "6px 14px" }}
          title={`Preview the ${FILE_LABELS[file]} page with pending drafts`}
        >
          Preview →
        </button>
        <span
          style={{
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
          {file === "careers" && currentJobs.length > 0 && (
            <div
              style={{
                border: "1px solid rgba(0,0,0,0.1)",
                background: "white",
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={allJobsSelected}
                    onChange={toggleAllJobs}
                    disabled={jobsBusy}
                  />
                  <b>Current job postings ({currentJobs.length})</b>
                </label>
                <span style={{ fontSize: 12, color: "#64748b" }}>
                  {selectedJobIds.size > 0 ? `${selectedJobIds.size} selected` : "Select to delete"}
                </span>
                <button
                  className="btn"
                  onClick={() => setDeleteJobsPending(true)}
                  disabled={selectedJobIds.size === 0 || jobsBusy}
                  style={{
                    marginLeft: "auto",
                    background: selectedJobIds.size > 0 ? "#dc2626" : undefined,
                    color: selectedJobIds.size > 0 ? "white" : undefined,
                    fontSize: 13,
                    padding: "6px 14px",
                  }}
                >
                  {jobsBusy ? "Deleting…" : `Delete selected${selectedJobIds.size > 0 ? ` (${selectedJobIds.size})` : ""}`}
                </button>
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                {currentJobs.map((j) => {
                  const checked = selectedJobIds.has(j.id);
                  return (
                    <li
                      key={j.id || j.title}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 12px",
                        border: "1px solid rgba(0,0,0,0.08)",
                        background: checked ? "#fef2f2" : "#f8fafc",
                        borderRadius: 8,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleJob(j.id)}
                        disabled={jobsBusy}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: "#1d3557", fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {j.title}
                        </div>
                        <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                          {[j.type, j.category, j.location].filter(Boolean).join(" · ") || "\u00a0"}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>{j.id}</span>
                    </li>
                  );
                })}
              </ul>
              <p style={{ margin: "12px 0 0", fontSize: 12, color: "#94a3b8" }}>
                Tip: to add or edit a posting, use the AI prompt below.
              </p>
            </div>
          )}
          {file === "contact" && (
            <div
              style={{
                border: "1px solid rgba(0,0,0,0.1)",
                background: "white",
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <b style={{ fontSize: 14, color: "#1d3557" }}>Current contact details</b>
              <p style={{ margin: "4px 0 14px", fontSize: 12, color: "#64748b" }}>
                Edit any field and click <b>Submit</b> to save a draft. Preview
                and Publish work the same as everywhere else.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", columnGap: 12, rowGap: 10, fontSize: 13 }}>
                <label htmlFor="contact-heading" style={{ color: "#64748b", alignSelf: "center" }}>Page heading</label>
                <input
                  id="contact-heading"
                  type="text"
                  value={contactHeading}
                  onChange={(e) => setContactHeading(e.target.value)}
                  disabled={contactSubmitBusy}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
                <label htmlFor="contact-address" style={{ color: "#64748b", alignSelf: "center" }}>Address</label>
                <input
                  id="contact-address"
                  type="text"
                  value={contactAddress}
                  onChange={(e) => setContactAddress(e.target.value)}
                  disabled={contactSubmitBusy}
                  placeholder="575 W 8th Ave, Vancouver, BC"
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
                <label htmlFor="contact-facebook" style={{ color: "#64748b", alignSelf: "center" }}>Facebook link</label>
                <input
                  id="contact-facebook"
                  type="url"
                  value={contactFacebookUrl}
                  onChange={(e) => setContactFacebookUrl(e.target.value)}
                  disabled={contactSubmitBusy || !siteContent}
                  placeholder="https://www.facebook.com/echelon.daycare.5"
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
              </div>
              {contactErr && (
                <div style={{ marginTop: 12, padding: "8px 10px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, color: "#b91c1c", fontSize: 12 }}>
                  {contactErr}
                </div>
              )}
              {contactMsg && (
                <div style={{ marginTop: 12, padding: "8px 10px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, color: "#166534", fontSize: 12 }}>
                  {contactMsg}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
                <button
                  className="btn"
                  onClick={submitContactForm}
                  disabled={!contactDirty || contactSubmitBusy}
                  style={{
                    background: contactDirty ? "#1d5fa3" : undefined,
                    color: contactDirty ? "white" : undefined,
                    fontSize: 13,
                    padding: "8px 18px",
                  }}
                >
                  {contactSubmitBusy ? "Saving…" : "Submit"}
                </button>
                <button
                  className="btn"
                  onClick={() => nav(`/website/preview?page=contact`)}
                  disabled={contactSubmitBusy}
                  style={{ fontSize: 13, padding: "8px 18px" }}
                >
                  Preview →
                </button>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>
                  Address updates map + iframe title automatically. Facebook
                  link is stored site-wide.
                </span>
              </div>
              <p style={{ margin: "14px 0 0", fontSize: 12, color: "#94a3b8" }}>
                Phone number and email live on the <b>Site (global)</b> page. For
                anything not shown here (map aria label, layout tweaks), use the
                AI prompt below.
              </p>
            </div>
          )}
          {file === "tour" && (
            <div
              style={{
                border: "1px solid rgba(29,95,163,0.25)",
                background: "rgba(29,95,163,0.05)",
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 22 }}>🎬</span>
              <div style={{ flex: 1 }}>
                <b style={{ fontSize: 14 }}>Upload or manage tour videos</b>
                <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
                  Add MP4 / MOV files, reorder, or delete. Posters are extracted
                  automatically from the first frame.
                </div>
              </div>
              <button
                className="btn"
                onClick={() => nav("/website/tour-videos")}
                style={{ background: "#1d5fa3", color: "white" }}
              >
                Manage videos →
              </button>
            </div>
          )}
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
              <b style={{ fontSize: 16 }}>Ask AI to update the {FILE_LABELS[file]} page</b>
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
                file === "tour"
                  ? "e.g. Change the intro to emphasise our outdoor play area. Rename the classroom video to 'Toddler classroom walk-through'."
                  : file === "contact"
                  ? "e.g. Move us to 620 W 10th Ave, Vancouver, BC V5Z 4E6 and update the map."
                  : "e.g. Post a Friday-only Cook role, casual, $22-25/hr. Also change the hiring email to careers@echelondaycare.com and remove the Cleaner posting."
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
      {deleteJobsPending && (
        <div
          onClick={() => setDeleteJobsPending(false)}
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
            <h3 style={{ margin: "0 0 12px" }}>
              Delete {selectedJobIds.size} job posting{selectedJobIds.size === 1 ? "" : "s"}?
            </h3>
            <p style={{ margin: "0 0 20px", color: "#475569" }}>
              This creates a draft revision — the change goes live only after
              Publish. You can restore any prior version from the version
              history screen.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setDeleteJobsPending(false)}>
                Cancel
              </button>
              <button
                className="btn"
                onClick={performDeleteJobs}
                disabled={jobsBusy}
                style={{ background: "#dc2626", color: "white" }}
              >
                {jobsBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
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
