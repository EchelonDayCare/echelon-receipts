import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  websiteAiEditContent,
  websiteCheckDraftStaleness,
  websiteListPointers,
  websiteLoadContent,
  websiteRestoreRevision,
  websiteSaveDraft,
  websiteReplaceAboutPhoto,
  websiteReplaceHomeGalleryPhoto,
  websiteReplaceHomeHeroBanner,
  websiteWorkingCopyStatus,
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
  "gallery-videos": "Gallery Videos",
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
  // Pointer for the current file — used to decide whether to show
  // "Revert to published" and what revision to revert to.
  const [lastPushedRev, setLastPushedRev] = useState<number | null>(null);
  const [revertBusy, setRevertBusy] = useState(false);
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pointers = await websiteListPointers();
        if (cancelled) return;
        const p = pointers.find((x) => x.file === file);
        setLastPushedRev(p?.last_pushed_rev ?? null);
      } catch { /* silent — button just hides */ }
    })();
    return () => { cancelled = true; };
  }, [file, content]);
  async function doRevertToPublished() {
    if (!lastPushedRev) return;
    setRevertBusy(true);
    setErr(null);
    try {
      await websiteRestoreRevision(lastPushedRev);
      const c = await websiteLoadContent(file);
      setContent(c);
      setText(tryPrettyJson(c.content_json));
      setDirty(false);
      setSaved("Reverted to the last published version.");
    } catch (e: any) {
      setErr(`Revert failed: ${String(e?.message ?? e)}`);
    } finally {
      setRevertBusy(false);
      setRevertConfirmOpen(false);
    }
  }

  // Warn on browser close / refresh with unsaved edits. In Tauri the
  // window-close still fires `beforeunload`, so this catches ⌘Q as
  // well as the sidebar Cmd-click that swaps pages. We register the
  // listener unconditionally and gate inside the handler on a ref
  // that tracks ANY dirty form (raw JSON textarea OR any structured
  // form) — prior code only tracked the raw-JSON `dirty` and let
  // users close with unsaved structured-form edits silently lost.
  const anyDirtyRef = useRef(false);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!anyDirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Block react-router navigation (sidebar clicks, back/preview/history
  // buttons) while there are unsaved edits. We can't use `useBlocker`
  // here because the app mounts a non-data `HashRouter`; instead we
  // intercept anchor clicks in the capture phase and confirm with the
  // user before allowing the hash to change.
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      if (!anyDirtyRef.current) return;
      if (ev.defaultPrevented || ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (!href.startsWith("#/")) return;
      const currentHash = window.location.hash || "#/";
      if (href === currentHash) return;
      if (!window.confirm("You have unsaved edits. Discard and leave this page?")) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Programmatic navigation guard for header buttons (← Website,
  // Preview →, version history, Manage videos, etc.) — these fire
  // `nav()` directly and bypass the anchor-click interceptor above.
  // Wrapping them in `guardedNav` ensures unsaved-edit confirmation
  // for every code path, not just anchor clicks.
  const guardedNav = useCallback((path: string) => {
    if (anyDirtyRef.current) {
      if (!window.confirm("You have unsaved edits. Discard and leave this page?")) {
        return;
      }
    }
    nav(path);
  }, [nav]);

  // AI edit state — only rendered when the current page supports it.
  const AI_EDIT_PAGES: EditableFile[] = ["about", "careers", "tour", "contact", "services", "seo", "home", "site", "gallery-videos"];
  const aiEnabled = AI_EDIT_PAGES.includes(file);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiProposed, setAiProposed] = useState<{
    text: string;
    site_text: string | null;
    summary: string;
    model: string;
  } | null>(null);

  // Draft-staleness banner. Set on load when the working-copy
  // version of this file has moved since the current active draft
  // was saved — e.g. a publish from another machine, or a
  // `rayfin sync` — so the user can decide whether to discard the
  // stale draft before overwriting the upstream changes.
  const [staleDraft, setStaleDraft] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setErr(null);
    setSaved(null);
    setDirty(false);
    setStaleDraft(false);
    (async () => {
      try {
        const c = await websiteLoadContent(file);
        if (cancelled) return;
        setContent(c);
        setText(tryPrettyJson(c.content_json));
        if (c.source === "draft") {
          try {
            const stale = await websiteCheckDraftStaleness(file);
            if (!cancelled) setStaleDraft(stale);
          } catch {
            // best-effort — pre-migration DB or missing working copy
          }
        }
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
      // Pre-parse locally so a syntax error surfaces as a friendly
      // "Not valid JSON — {msg}" instead of bubbling up through the
      // Tauri command (which still refuses but gives a less
      // actionable error, and the text area's cursor position is
      // lost by the time the round-trip completes).
      try {
        JSON.parse(text);
      } catch (parseErr: any) {
        setErr(`Not valid JSON — ${String(parseErr?.message ?? parseErr)}`);
        setBusy(false);
        return;
      }
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
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
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
      setContactPhone(String(s?.phone?.display ?? ""));
      setContactEmail(String(s?.email ?? ""));
    } catch {
      setContactAddress(currentContact?.address ?? "");
      setContactFacebookUrl("");
      setContactPhone("");
      setContactEmail("");
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
    let currentPhone = "";
    let currentEmail = "";
    try {
      const s = JSON.parse(siteContent?.content_json ?? "{}");
      currentFb = String(s?.socials?.facebook ?? "");
      currentAddrDisplay = String(s?.address?.display ?? "");
      currentPhone = String(s?.phone?.display ?? "");
      currentEmail = String(s?.email ?? "");
    } catch { /* ignore */ }
    const aChanged = (contactAddress || "") !== currentAddrDisplay;
    const fbChanged = (contactFacebookUrl || "") !== currentFb;
    const pChanged = (contactPhone || "") !== currentPhone;
    const eChanged = (contactEmail || "") !== currentEmail;
    return hChanged || aChanged || fbChanged || pChanged || eChanged;
  }, [file, contactHeading, contactAddress, contactFacebookUrl, contactPhone, contactEmail, currentContact, siteContent]);

  async function submitContactForm() {
    if (!content) return;
    const heading = contactHeading.trim();
    const address = contactAddress.trim();
    const fbUrl = contactFacebookUrl.trim();
    const phone = contactPhone.trim();
    const email = contactEmail.trim();
    if (!heading) { setContactErr("Page heading can't be empty."); return; }
    if (!address) { setContactErr("Address can't be empty."); return; }
    if (fbUrl && !/^https?:\/\//i.test(fbUrl)) {
      setContactErr("Facebook link must start with http:// or https://");
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setContactErr("Email doesn't look valid.");
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
        const oldPhoneDisplay = String(siteObj?.phone?.display ?? "");
        if (phone !== oldPhoneDisplay) {
          // Phone renders on Contact page + footer + JSON-LD. Auto-derive
          // tel_href from the display value by stripping every non-digit
          // (keeps `+` if the user typed it) so `tel:` links stay valid.
          const telHref = phone
            ? "tel:" + phone.replace(/[^\d+]/g, "")
            : "";
          siteObj.phone = {
            ...(siteObj.phone ?? {}),
            display: phone,
            tel_href: telHref,
          };
          siteChanged = true;
        }
        const oldEmail = String(siteObj?.email ?? "");
        if (email !== oldEmail) {
          siteObj.email = email;
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

  // ─────────────────────────────────────────────────────────────────
  // About: structured field form (v3.24.2). Mirrors Contact pattern —
  // load about.json, expose heading + intro + vision/mission/team/why
  // as individual inputs, save the reconstructed JSON on Submit.
  //
  // The user sees plain text everywhere: HTML tags in intro_html are
  // stripped for display and re-applied on save. The daycare name in
  // the intro stays wrapped in <span class="highlight"> automatically.
  // Extra whitespace from JSON indentation is collapsed to single
  // spaces so paragraphs read naturally in the textarea.
  // ─────────────────────────────────────────────────────────────────
  type CustomSectionType = "paragraph" | "bullets";
  type CustomSection = {
    heading: string;
    type: CustomSectionType;
    paragraph: string;
    bullets: string; // one bullet per line (edit UX)
  };
  type AboutForm = {
    heading: string;
    intro_html: string;
    vision_heading: string;
    vision_paragraph: string;
    mission_heading: string;
    mission_bullets: string;   // one bullet per line
    team_heading: string;
    team_paragraph: string;
    why_heading: string;
    why_bullets: string;       // one bullet per line
    custom_sections: CustomSection[];
  };
  const stripToPlain = (s: string): string => {
    // Remove HTML tags, decode a small set of common entities, and
    // collapse runs of whitespace so JSON-indented copy renders as
    // clean sentences instead of a jagged column.
    const noTags = s.replace(/<[^>]+>/g, "");
    const decoded = noTags
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&ndash;/g, "–")
      .replace(/&mdash;/g, "—");
    return decoded.replace(/\s+/g, " ").trim();
  };
  const extractHighlightTerm = (html: string): string => {
    const m = html.match(/<span[^>]*class=["'][^"']*highlight[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    if (!m) return "";
    return stripToPlain(m[1]);
  };
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const applyHighlight = (plainText: string, term: string): string => {
    // Case-insensitively wrap the first occurrence of `term` in
    // <span class="highlight">…</span>, escaping HTML in the surrounding
    // text so a user typing "<" doesn't accidentally emit markup.
    if (!term) return escapeHtml(plainText);
    const idx = plainText.toLowerCase().indexOf(term.toLowerCase());
    if (idx < 0) return escapeHtml(plainText);
    const before = plainText.slice(0, idx);
    const match = plainText.slice(idx, idx + term.length);
    const after = plainText.slice(idx + term.length);
    return `${escapeHtml(before)}<span class="highlight">${escapeHtml(match)}</span>${escapeHtml(after)}`;
  };
  const parseAbout = (raw: string): AboutForm => {
    try {
      const p = JSON.parse(raw);
      return {
        heading: String(p?.heading ?? ""),
        intro_html: stripToPlain(String(p?.intro_html ?? "")),
        vision_heading: String(p?.vision?.heading ?? ""),
        vision_paragraph: stripToPlain(String(p?.vision?.paragraph ?? "")),
        mission_heading: String(p?.mission?.heading ?? ""),
        mission_bullets: Array.isArray(p?.mission?.bullets)
          ? p.mission.bullets.map((b: unknown) => String(b)).join("\n")
          : "",
        team_heading: String(p?.team?.heading ?? ""),
        team_paragraph: stripToPlain(String(p?.team?.paragraph ?? "")),
        why_heading: String(p?.why_choose_us?.heading ?? ""),
        why_bullets: Array.isArray(p?.why_choose_us?.bullets)
          ? p.why_choose_us.bullets.map((b: unknown) => String(b)).join("\n")
          : "",
        custom_sections: Array.isArray(p?.custom_sections)
          ? p.custom_sections.map((s: any): CustomSection => {
              const t: CustomSectionType = s?.type === "bullets" ? "bullets" : "paragraph";
              return {
                heading: String(s?.heading ?? ""),
                type: t,
                paragraph: stripToPlain(String(s?.paragraph ?? "")),
                bullets: Array.isArray(s?.bullets)
                  ? s.bullets.map((b: unknown) => String(b)).join("\n")
                  : "",
              };
            })
          : [],
      };
    } catch {
      return {
        heading: "", intro_html: "",
        vision_heading: "", vision_paragraph: "",
        mission_heading: "", mission_bullets: "",
        team_heading: "", team_paragraph: "",
        why_heading: "", why_bullets: "",
        custom_sections: [],
      };
    }
  };
  const currentAbout = useMemo<AboutForm | null>(() => {
    if (file !== "about" || !content) return null;
    return parseAbout(content.content_json);
  }, [file, content]);

  // Highlight term detected from the raw JSON — kept alongside form
  // state so Submit can re-wrap it in the intro even after the user
  // has rewritten the sentence.
  const highlightTerm = useMemo<string>(() => {
    if (file !== "about" || !content) return "";
    try {
      const p = JSON.parse(content.content_json);
      return extractHighlightTerm(String(p?.intro_html ?? ""));
    } catch { return ""; }
  }, [file, content]);

  const [aboutForm, setAboutForm] = useState<AboutForm>(() => parseAbout(""));
  const [aboutSubmitBusy, setAboutSubmitBusy] = useState(false);
  const [aboutMsg, setAboutMsg] = useState<string | null>(null);
  const [aboutErr, setAboutErr] = useState<string | null>(null);
  const [photoRepoRoot, setPhotoRepoRoot] = useState<string | null>(null);
  const [photoBusySlot, setPhotoBusySlot] = useState<1 | 2 | 3 | null>(null);
  const [photoBust, setPhotoBust] = useState(0);

  useEffect(() => {
    if (file !== "about") return;
    void (async () => {
      try {
        const wc = await websiteWorkingCopyStatus();
        setPhotoRepoRoot(wc.root);
      } catch { /* ignore — repo lookup is only for thumbnail preview */ }
    })();
  }, [file]);

  async function pickAndReplaceAboutPhoto(slot: 1 | 2 | 3) {
    // Set busy BEFORE open() so a rapid double-click can't spawn
    // two file dialogs. photoBusySlot doubles as the ref for
    // disabling the button synchronously.
    if (photoBusySlot != null) return;
    setPhotoBusySlot(slot);
    setAboutErr(null);
    setAboutMsg(null);
    const picked = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "heic", "webp", "avif"] }],
    });
    if (!picked || typeof picked !== "string") { setPhotoBusySlot(null); return; }
    try {
      await websiteReplaceAboutPhoto(slot, picked);
      setPhotoBust((n) => n + 1);
      setAboutMsg(`Photo ${slot} replaced. Preview to check, then Publish.`);
    } catch (e: any) {
      setAboutErr(`Photo ${slot} replace failed: ${String(e?.message ?? e)}`);
    } finally {
      setPhotoBusySlot(null);
    }
  }

  function aboutPhotoThumbUrl(slot: 1 | 2 | 3): string | null {
    if (!photoRepoRoot) return null;
    const abs = `${photoRepoRoot}/repo/assets/img/photo${slot}.jpg`;
    return `${convertFileSrc(abs)}?bust=${photoBust}`;
  }

  useEffect(() => {
    if (file !== "about" || !currentAbout) return;
    setAboutForm(currentAbout);
  }, [file, currentAbout]);

  useEffect(() => {
    setAboutMsg(null);
    setAboutErr(null);
  }, [file]);

  const aboutDirty = useMemo(() => {
    if (file !== "about" || !currentAbout) return false;
    const scalarKeys: (keyof AboutForm)[] = [
      "heading", "intro_html",
      "vision_heading", "vision_paragraph",
      "mission_heading", "mission_bullets",
      "team_heading", "team_paragraph",
      "why_heading", "why_bullets",
    ];
    if (scalarKeys.some((k) => aboutForm[k] !== currentAbout[k])) return true;
    const a = aboutForm.custom_sections;
    const b = currentAbout.custom_sections;
    if (a.length !== b.length) return true;
    return a.some((sec, i) => (
      sec.heading !== b[i].heading ||
      sec.type !== b[i].type ||
      sec.paragraph !== b[i].paragraph ||
      sec.bullets !== b[i].bullets
    ));
  }, [file, aboutForm, currentAbout]);

  function setAboutField<K extends keyof AboutForm>(key: K, value: AboutForm[K]) {
    setAboutForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submitAboutForm() {
    if (!content) return;
    const heading = aboutForm.heading.trim();
    if (!heading) { setAboutErr("Page heading can't be empty."); return; }
    setAboutSubmitBusy(true);
    setAboutErr(null);
    setAboutMsg(null);
    try {
      const obj = JSON.parse(content.content_json);
      obj.heading = heading;
      obj.intro_html = applyHighlight(aboutForm.intro_html.trim(), highlightTerm);
      obj.vision = {
        ...(obj.vision ?? {}),
        heading: aboutForm.vision_heading.trim(),
        paragraph: aboutForm.vision_paragraph.trim(),
      };
      const missionBullets = aboutForm.mission_bullets
        .split("\n").map((s) => s.trim()).filter(Boolean);
      obj.mission = {
        ...(obj.mission ?? {}),
        heading: aboutForm.mission_heading.trim(),
        bullets: missionBullets,
      };
      obj.team = {
        ...(obj.team ?? {}),
        heading: aboutForm.team_heading.trim(),
        paragraph: aboutForm.team_paragraph.trim(),
      };
      const whyBullets = aboutForm.why_bullets
        .split("\n").map((s) => s.trim()).filter(Boolean);
      obj.why_choose_us = {
        ...(obj.why_choose_us ?? {}),
        heading: aboutForm.why_heading.trim(),
        bullets: whyBullets,
      };
      // Custom sections — filter out empty entries so a half-typed row
      // doesn't render as an empty <h3> on the live page.
      obj.custom_sections = aboutForm.custom_sections
        .map((sec) => {
          const heading = sec.heading.trim();
          if (!heading) return null;
          if (sec.type === "bullets") {
            const bullets = sec.bullets
              .split("\n").map((s) => s.trim()).filter(Boolean);
            if (bullets.length === 0) return null;
            return { heading, type: "bullets" as const, bullets };
          }
          const paragraph = sec.paragraph.trim();
          if (!paragraph) return null;
          return { heading, type: "paragraph" as const, paragraph };
        })
        .filter((s): s is Exclude<typeof s, null> => s !== null);
      const rev = await websiteSaveDraft({
        file: "about",
        content_json: JSON.stringify(obj, null, 2) + "\n",
      });
      const c = await websiteLoadContent("about");
      setContent(c);
      setText(tryPrettyJson(c.content_json));
      setDirty(false);
      setAboutMsg(
        `Saved — about draft rev #${rev.revision_id}. Click Preview to see it, then Publish to go live.`
      );
    } catch (e: any) {
      setAboutErr(String(e?.message ?? e));
    } finally {
      setAboutSubmitBusy(false);
    }
  }

  // ─── Services (Programs & Waiting List) structured editor ──────────
  type ServicesForm = {
    program_heading: string;
    program_paragraphs: string[];        // one string per paragraph
    brochure_path: string;
    brochure_link_label: string;
    waiting_heading: string;
    waiting_form_url: string;
    waiting_placeholder: string;
    waiting_form_height: string;
    schema_name: string;
    schema_service_type: string;
    schema_min_age: string;              // kept as string for input; parsed to number on submit
    schema_max_age: string;
    schema_description: string;
  };
  const parseServices = (raw: string): ServicesForm => {
    try {
      const p = JSON.parse(raw);
      const dp = p?.daycare_program ?? {};
      const wl = p?.waiting_list ?? {};
      const ss = p?.service_schema ?? {};
      const paras = Array.isArray(dp?.paragraphs)
        ? dp.paragraphs.map((s: unknown) => stripToPlain(String(s ?? "")))
        : [];
      return {
        program_heading: String(dp?.heading ?? ""),
        program_paragraphs: paras.length > 0 ? paras : [""],
        brochure_path: String(dp?.brochure_path ?? ""),
        brochure_link_label: stripToPlain(String(dp?.brochure_link_label ?? "")),
        waiting_heading: String(wl?.heading ?? ""),
        waiting_form_url: String(wl?.form_url ?? ""),
        waiting_placeholder: String(wl?.form_placeholder_text ?? ""),
        waiting_form_height: String(wl?.form_height ?? ""),
        schema_name: String(ss?.name ?? ""),
        schema_service_type: String(ss?.service_type ?? ""),
        schema_min_age: ss?.audience_min_age === undefined || ss?.audience_min_age === null
          ? "" : String(ss.audience_min_age),
        schema_max_age: ss?.audience_max_age === undefined || ss?.audience_max_age === null
          ? "" : String(ss.audience_max_age),
        schema_description: stripToPlain(String(ss?.description ?? "")),
      };
    } catch {
      return {
        program_heading: "",
        program_paragraphs: [""],
        brochure_path: "",
        brochure_link_label: "",
        waiting_heading: "",
        waiting_form_url: "",
        waiting_placeholder: "",
        waiting_form_height: "",
        schema_name: "",
        schema_service_type: "",
        schema_min_age: "",
        schema_max_age: "",
        schema_description: "",
      };
    }
  };
  const currentServices = useMemo<ServicesForm | null>(() => {
    if (file !== "services" || !content) return null;
    return parseServices(content.content_json);
  }, [file, content]);

  const [servicesForm, setServicesForm] = useState<ServicesForm>(() => parseServices(""));
  const [servicesSubmitBusy, setServicesSubmitBusy] = useState(false);
  const [servicesMsg, setServicesMsg] = useState<string | null>(null);
  const [servicesErr, setServicesErr] = useState<string | null>(null);

  useEffect(() => {
    if (file !== "services" || !currentServices) return;
    setServicesForm(currentServices);
  }, [file, currentServices]);
  useEffect(() => {
    setServicesMsg(null);
    setServicesErr(null);
  }, [file]);

  const servicesDirty = useMemo(() => {
    if (file !== "services" || !currentServices) return false;
    const scalarKeys: (keyof ServicesForm)[] = [
      "program_heading", "brochure_path", "brochure_link_label",
      "waiting_heading", "waiting_form_url", "waiting_placeholder", "waiting_form_height",
      "schema_name", "schema_service_type", "schema_min_age", "schema_max_age", "schema_description",
    ];
    if (scalarKeys.some((k) => servicesForm[k] !== currentServices[k])) return true;
    const a = servicesForm.program_paragraphs;
    const b = currentServices.program_paragraphs;
    if (a.length !== b.length) return true;
    return a.some((p, i) => p !== b[i]);
  }, [file, servicesForm, currentServices]);

  function setServicesField<K extends keyof ServicesForm>(key: K, value: ServicesForm[K]) {
    setServicesForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submitServicesForm() {
    if (!content) return;
    const heading = servicesForm.program_heading.trim();
    if (!heading) { setServicesErr("Program heading can't be empty."); return; }
    setServicesSubmitBusy(true);
    setServicesErr(null);
    setServicesMsg(null);
    try {
      const obj = JSON.parse(content.content_json);
      // daycare_program
      obj.daycare_program = {
        ...(obj.daycare_program ?? {}),
        heading,
        paragraphs: servicesForm.program_paragraphs
          .map((s) => s.trim())
          .filter(Boolean),
        brochure_path: servicesForm.brochure_path.trim(),
        brochure_link_label: servicesForm.brochure_link_label.trim(),
      };
      // waiting_list
      obj.waiting_list = {
        ...(obj.waiting_list ?? {}),
        heading: servicesForm.waiting_heading.trim(),
        form_url: servicesForm.waiting_form_url.trim(),
        form_placeholder_text: servicesForm.waiting_placeholder.trim(),
        form_height: servicesForm.waiting_form_height.trim(),
      };
      // service_schema (SEO — audience ages parsed to numbers when
      // possible, otherwise dropped so we don't emit NaN into JSON).
      const parseAge = (s: string): number | null => {
        const t = s.trim();
        if (!t) return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
      };
      const minAge = parseAge(servicesForm.schema_min_age);
      const maxAge = parseAge(servicesForm.schema_max_age);
      obj.service_schema = {
        ...(obj.service_schema ?? {}),
        name: servicesForm.schema_name.trim(),
        service_type: servicesForm.schema_service_type.trim(),
        description: servicesForm.schema_description.trim(),
      };
      if (minAge !== null) obj.service_schema.audience_min_age = minAge;
      else delete obj.service_schema.audience_min_age;
      if (maxAge !== null) obj.service_schema.audience_max_age = maxAge;
      else delete obj.service_schema.audience_max_age;

      const rev = await websiteSaveDraft({
        file: "services",
        content_json: JSON.stringify(obj, null, 2) + "\n",
      });
      const c = await websiteLoadContent("services");
      setContent(c);
      setText(tryPrettyJson(c.content_json));
      setDirty(false);
      setServicesMsg(
        `Saved — services draft rev #${rev.revision_id}. Click Preview to see it, then Publish to go live.`
      );
    } catch (e: any) {
      setServicesErr(String(e?.message ?? e));
    } finally {
      setServicesSubmitBusy(false);
    }
  }

  // ─── SEO structured editor ────────────────────────────────────────
  type SeoPageFields = {
    title: string;
    description: string;
    og_title: string;
    og_description: string;
  };
  type SeoForm = {
    selected: string;                                 // active page slug
    pages: Record<string, SeoPageFields>;             // slug → editable fields
  };
  const SEO_PAGE_LABELS: Record<string, string> = {
    index: "Home",
    about: "About",
    services: "Programs & Waiting List",
    gallery: "Gallery",
    "gallery-photos": "Gallery — Photos",
    "gallery-videos": "Gallery — Videos",
    contact: "Contact",
    tour: "Virtual Tour",
    careers: "Careers",
    not_found: "404 Not Found",
  };
  const parseSeo = (raw: string): SeoForm => {
    try {
      const p = JSON.parse(raw);
      const pagesRaw = (p?.pages && typeof p.pages === "object") ? p.pages : {};
      const pages: Record<string, SeoPageFields> = {};
      for (const slug of Object.keys(pagesRaw)) {
        const pg = pagesRaw[slug] ?? {};
        pages[slug] = {
          title: String(pg?.title ?? ""),
          description: String(pg?.description ?? ""),
          og_title: String(pg?.og_title ?? ""),
          og_description: String(pg?.og_description ?? ""),
        };
      }
      const slugs = Object.keys(pages);
      const selected = slugs.includes("index") ? "index" : (slugs[0] ?? "");
      return { selected, pages };
    } catch {
      return { selected: "", pages: {} };
    }
  };
  const currentSeo = useMemo<SeoForm | null>(() => {
    if (file !== "seo" || !content) return null;
    return parseSeo(content.content_json);
  }, [file, content]);

  const [seoForm, setSeoForm] = useState<SeoForm>(() => ({ selected: "", pages: {} }));
  const [seoSubmitBusy, setSeoSubmitBusy] = useState(false);
  const [seoMsg, setSeoMsg] = useState<string | null>(null);
  const [seoErr, setSeoErr] = useState<string | null>(null);

  useEffect(() => {
    if (file !== "seo" || !currentSeo) return;
    // Preserve the user's current page selection across reloads if it
    // still exists; otherwise fall back to whatever parseSeo chose.
    setSeoForm((prev) => {
      const selected = prev.selected && currentSeo.pages[prev.selected]
        ? prev.selected
        : currentSeo.selected;
      return { selected, pages: currentSeo.pages };
    });
  }, [file, currentSeo]);
  useEffect(() => {
    setSeoMsg(null);
    setSeoErr(null);
  }, [file]);

  const seoDirty = useMemo(() => {
    if (file !== "seo" || !currentSeo) return false;
    const cur = currentSeo.pages;
    const draft = seoForm.pages;
    const curSlugs = Object.keys(cur);
    if (curSlugs.length !== Object.keys(draft).length) return true;
    return curSlugs.some((slug) => {
      const a = draft[slug];
      const b = cur[slug];
      if (!a || !b) return true;
      return a.title !== b.title
        || a.description !== b.description
        || a.og_title !== b.og_title
        || a.og_description !== b.og_description;
    });
  }, [file, seoForm, currentSeo]);

  function setSeoField<K extends keyof SeoPageFields>(slug: string, key: K, value: SeoPageFields[K]) {
    setSeoForm((prev) => {
      const cur = prev.pages[slug] ?? { title: "", description: "", og_title: "", og_description: "" };
      return {
        ...prev,
        pages: { ...prev.pages, [slug]: { ...cur, [key]: value } },
      };
    });
  }

  async function submitSeoForm() {
    if (!content) return;
    setSeoSubmitBusy(true);
    setSeoErr(null);
    setSeoMsg(null);
    try {
      const obj = JSON.parse(content.content_json);
      if (!obj.pages || typeof obj.pages !== "object") obj.pages = {};
      for (const slug of Object.keys(seoForm.pages)) {
        const f = seoForm.pages[slug];
        const orig = obj.pages[slug] ?? {};
        // Keep path/canonical_url/breadcrumb/robots and any other keys
        // the site or template depends on. Only overwrite the 4 fields
        // the owner can edit.
        obj.pages[slug] = {
          ...orig,
          title: f.title.trim(),
          description: f.description.trim(),
          og_title: f.og_title.trim(),
          og_description: f.og_description.trim(),
        };
      }
      const rev = await websiteSaveDraft({
        file: "seo",
        content_json: JSON.stringify(obj, null, 2) + "\n",
      });
      const c = await websiteLoadContent("seo");
      setContent(c);
      setText(tryPrettyJson(c.content_json));
      setDirty(false);
      setSeoMsg(
        `Saved — seo draft rev #${rev.revision_id}. Click Preview to see it, then Publish to go live.`
      );
    } catch (e: any) {
      setSeoErr(String(e?.message ?? e));
    } finally {
      setSeoSubmitBusy(false);
    }
  }

  // ─── Home structured editor ───────────────────────────────────────
  type HomeGalleryItem = { id: string; src: string; alt: string };
  type HomeFaqItem = { id: string; question: string; answer: string };
  type HomeForm = {
    hero_heading: string;
    hero_subtext: string;
    hero_cta_label: string;
    hero_cta_href: string;
    gallery_heading: string;
    gallery_items: HomeGalleryItem[];   // alt-text editable, src/id preserved
    stats: string[];
    faq_heading: string;
    faq_items: HomeFaqItem[];
  };
  const parseHome = (raw: string): HomeForm => {
    try {
      const p = JSON.parse(raw);
      const hero = p?.hero ?? {};
      const gp = p?.gallery_preview ?? {};
      const faq = p?.faq ?? {};
      return {
        hero_heading: String(hero?.heading ?? ""),
        hero_subtext: stripToPlain(String(hero?.subtext ?? "")),
        hero_cta_label: String(hero?.cta_label ?? ""),
        hero_cta_href: String(hero?.cta_href ?? ""),
        gallery_heading: String(gp?.heading ?? ""),
        gallery_items: Array.isArray(gp?.items)
          ? gp.items.map((it: any): HomeGalleryItem => ({
              id: String(it?.id ?? ""),
              src: String(it?.src ?? ""),
              alt: String(it?.alt ?? ""),
            }))
          : [],
        stats: Array.isArray(p?.stats)
          ? p.stats.map((s: unknown) => String(s ?? ""))
          : [],
        faq_heading: String(faq?.heading ?? ""),
        faq_items: Array.isArray(faq?.items)
          ? faq.items.map((it: any): HomeFaqItem => ({
              id: String(it?.id ?? ""),
              question: String(it?.question ?? ""),
              answer: stripToPlain(String(it?.answer ?? "")),
            }))
          : [],
      };
    } catch {
      return {
        hero_heading: "", hero_subtext: "", hero_cta_label: "", hero_cta_href: "",
        gallery_heading: "", gallery_items: [],
        stats: [],
        faq_heading: "", faq_items: [],
      };
    }
  };
  const currentHome = useMemo<HomeForm | null>(() => {
    if (file !== "home" || !content) return null;
    return parseHome(content.content_json);
  }, [file, content]);

  const [homeForm, setHomeForm] = useState<HomeForm>(() => parseHome(""));
  const [homeSubmitBusy, setHomeSubmitBusy] = useState(false);
  const [homeMsg, setHomeMsg] = useState<string | null>(null);
  const [homeErr, setHomeErr] = useState<string | null>(null);
  const [homePhotoBusy, setHomePhotoBusy] = useState<string | null>(null);
  const [homePhotoBust, setHomePhotoBust] = useState(0);

  // Reuse photoRepoRoot for home too — resolved once on entry.
  useEffect(() => {
    if (file !== "home") return;
    void (async () => {
      try {
        const wc = await websiteWorkingCopyStatus();
        setPhotoRepoRoot(wc.root);
      } catch { /* preview thumbs are best-effort */ }
    })();
  }, [file]);

  function homeGalleryThumbUrl(src: string): string | null {
    if (!photoRepoRoot || !src) return null;
    const abs = `${photoRepoRoot}/repo/${src}`;
    return `${convertFileSrc(abs)}?bust=${homePhotoBust}`;
  }

  async function pickAndReplaceHomeHeroBanner() {
    if (homePhotoBusy) return;
    setHomePhotoBusy("__hero_banner__");
    setHomeErr(null);
    setHomeMsg(null);
    const picked = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "heic", "webp", "avif"] }],
    });
    if (!picked || typeof picked !== "string") { setHomePhotoBusy(null); return; }
    try {
      await websiteReplaceHomeHeroBanner(picked);
      setHomePhotoBust((n) => n + 1);
      setHomeMsg(`Banner replaced. Click Preview to see it, then Publish.`);
    } catch (e: any) {
      setHomeErr(`Banner replace failed: ${String(e?.message ?? e)}`);
    } finally {
      setHomePhotoBusy(null);
    }
  }

  async function pickAndReplaceHomeGalleryPhoto(idx: number, itemId: string) {
    if (homePhotoBusy) return;
    setHomePhotoBusy(itemId);
    setHomeErr(null);
    setHomeMsg(null);
    const picked = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "heic", "webp", "avif"] }],
    });
    if (!picked || typeof picked !== "string") { setHomePhotoBusy(null); return; }
    try {
      const rel = await websiteReplaceHomeGalleryPhoto(itemId, picked);
      const next = homeForm.gallery_items.slice();
      next[idx] = { ...next[idx], src: rel };
      setHomeField("gallery_items", next);
      setHomePhotoBust((n) => n + 1);
      setHomeMsg(`Photo updated. Click Submit to save, then Preview.`);
    } catch (e: any) {
      setHomeErr(`Photo replace failed: ${String(e?.message ?? e)}`);
    } finally {
      setHomePhotoBusy(null);
    }
  }

  async function pickAndAddHomeGalleryPhoto() {
    if (homePhotoBusy) return;
    const newId = `home_g_${Date.now().toString(36)}`;
    setHomePhotoBusy(newId);
    setHomeErr(null);
    setHomeMsg(null);
    const picked = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "heic", "webp", "avif"] }],
    });
    if (!picked || typeof picked !== "string") { setHomePhotoBusy(null); return; }
    try {
      const rel = await websiteReplaceHomeGalleryPhoto(newId, picked);
      setHomeField("gallery_items", [
        ...homeForm.gallery_items,
        { id: newId, src: rel, alt: "" },
      ]);
      setHomePhotoBust((n) => n + 1);
      setHomeMsg(`Photo added. Add an alt description, click Submit, then Preview.`);
    } catch (e: any) {
      setHomeErr(`Add photo failed: ${String(e?.message ?? e)}`);
    } finally {
      setHomePhotoBusy(null);
    }
  }

  useEffect(() => {
    if (file !== "home" || !currentHome) return;
    setHomeForm(currentHome);
  }, [file, currentHome]);
  useEffect(() => {
    setHomeMsg(null);
    setHomeErr(null);
  }, [file]);

  const homeDirty = useMemo(() => {
    if (file !== "home" || !currentHome) return false;
    const scalarKeys: (keyof HomeForm)[] = [
      "hero_heading", "hero_subtext", "hero_cta_label", "hero_cta_href",
      "gallery_heading", "faq_heading",
    ];
    if (scalarKeys.some((k) => homeForm[k] !== currentHome[k])) return true;
    if (homeForm.stats.length !== currentHome.stats.length) return true;
    if (homeForm.stats.some((s, i) => s !== currentHome.stats[i])) return true;
    if (homeForm.gallery_items.length !== currentHome.gallery_items.length) return true;
    if (homeForm.gallery_items.some((g, i) => (
      g.id !== currentHome.gallery_items[i].id
      || g.src !== currentHome.gallery_items[i].src
      || g.alt !== currentHome.gallery_items[i].alt
    ))) return true;
    if (homeForm.faq_items.length !== currentHome.faq_items.length) return true;
    return homeForm.faq_items.some((f, i) => (
      f.id !== currentHome.faq_items[i].id
      || f.question !== currentHome.faq_items[i].question
      || f.answer !== currentHome.faq_items[i].answer
    ));
  }, [file, homeForm, currentHome]);

  function setHomeField<K extends keyof HomeForm>(key: K, value: HomeForm[K]) {
    setHomeForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submitHomeForm() {
    if (!content) return;
    if (!homeForm.hero_heading.trim()) {
      setHomeErr("Hero heading can't be empty.");
      return;
    }
    setHomeSubmitBusy(true);
    setHomeErr(null);
    setHomeMsg(null);
    try {
      const obj = JSON.parse(content.content_json);
      obj.hero = {
        ...(obj.hero ?? {}),
        heading: homeForm.hero_heading.trim(),
        subtext: homeForm.hero_subtext.trim(),
        cta_label: homeForm.hero_cta_label.trim(),
        cta_href: homeForm.hero_cta_href.trim(),
      };
      obj.gallery_preview = {
        ...(obj.gallery_preview ?? {}),
        heading: homeForm.gallery_heading.trim(),
        items: homeForm.gallery_items.map((g) => ({
          id: g.id,
          src: g.src,
          alt: g.alt.trim(),
        })),
      };
      obj.stats = homeForm.stats.map((s) => s.trim()).filter(Boolean);
      // FAQ — filter out empty entries so a half-typed row doesn't
      // render as an empty accordion on the live page.
      obj.faq = {
        ...(obj.faq ?? {}),
        heading: homeForm.faq_heading.trim(),
        items: homeForm.faq_items
          .map((f) => ({
            id: f.id.trim(),
            question: f.question.trim(),
            answer: f.answer.trim(),
          }))
          .filter((f) => f.question && f.answer),
      };
      const rev = await websiteSaveDraft({
        file: "home",
        content_json: JSON.stringify(obj, null, 2) + "\n",
      });
      const c = await websiteLoadContent("home");
      setContent(c);
      setText(tryPrettyJson(c.content_json));
      setDirty(false);
      setHomeMsg(
        `Saved — home draft rev #${rev.revision_id}. Click Preview to see it, then Publish to go live.`
      );
    } catch (e: any) {
      setHomeErr(String(e?.message ?? e));
    } finally {
      setHomeSubmitBusy(false);
    }
  }

  // ─── Site (global) structured editor ─────────────────────────────
  type SiteNavItem = { label: string; path: string; key: string };
  type SiteAreaItem = { type: string; name: string };
  type SiteForm = {
    name: string;
    tagline: string;
    brand_color: string;
    brand_color_strong: string;
    theme_color: string;
    hire_label: string;
    sticky_call_label: string;
    footer_copyright_holder: string;
    footer_rights: string;
    footer_contact_link_label: string;
    nav: SiteNavItem[];
    area_served: SiteAreaItem[];
  };
  const parseSite = (raw: string): SiteForm => {
    try {
      const p = JSON.parse(raw);
      return {
        name: String(p?.name ?? ""),
        tagline: String(p?.tagline ?? ""),
        brand_color: String(p?.brand?.brand_color ?? ""),
        brand_color_strong: String(p?.brand?.brand_color_strong ?? ""),
        theme_color: String(p?.brand?.theme_color ?? ""),
        hire_label: String(p?.hire_link?.label ?? ""),
        sticky_call_label: String(p?.sticky_call?.label ?? ""),
        footer_copyright_holder: String(p?.footer?.copyright_holder ?? ""),
        footer_rights: String(p?.footer?.rights ?? ""),
        footer_contact_link_label: String(p?.footer?.contact_link_label ?? ""),
        nav: Array.isArray(p?.nav)
          ? p.nav.map((n: any): SiteNavItem => ({
              label: String(n?.label ?? ""),
              path: String(n?.path ?? ""),
              key: String(n?.key ?? ""),
            }))
          : [],
        area_served: Array.isArray(p?.area_served)
          ? p.area_served.map((a: any): SiteAreaItem => ({
              type: String(a?.type ?? "Neighborhood"),
              name: String(a?.name ?? ""),
            }))
          : [],
      };
    } catch {
      return {
        name: "", tagline: "",
        brand_color: "", brand_color_strong: "", theme_color: "",
        hire_label: "", sticky_call_label: "",
        footer_copyright_holder: "", footer_rights: "", footer_contact_link_label: "",
        nav: [], area_served: [],
      };
    }
  };
  const currentSite = useMemo<SiteForm | null>(() => {
    if (file !== "site" || !content) return null;
    return parseSite(content.content_json);
  }, [file, content]);

  const [siteForm, setSiteForm] = useState<SiteForm>(() => parseSite(""));
  const [siteSubmitBusy, setSiteSubmitBusy] = useState(false);
  const [siteMsg, setSiteMsg] = useState<string | null>(null);
  const [siteErr, setSiteErr] = useState<string | null>(null);

  useEffect(() => {
    if (file !== "site" || !currentSite) return;
    setSiteForm(currentSite);
  }, [file, currentSite]);
  useEffect(() => {
    setSiteMsg(null);
    setSiteErr(null);
  }, [file]);

  const siteDirty = useMemo(() => {
    if (file !== "site" || !currentSite) return false;
    const keys: (keyof SiteForm)[] = [
      "name", "tagline", "brand_color", "brand_color_strong", "theme_color",
      "hire_label", "sticky_call_label",
      "footer_copyright_holder", "footer_rights", "footer_contact_link_label",
    ];
    if (keys.some((k) => siteForm[k] !== currentSite[k])) return true;
    if (siteForm.nav.length !== currentSite.nav.length) return true;
    if (siteForm.nav.some((n, i) => (
      n.label !== currentSite.nav[i].label
      || n.path !== currentSite.nav[i].path
      || n.key !== currentSite.nav[i].key
    ))) return true;
    if (siteForm.area_served.length !== currentSite.area_served.length) return true;
    return siteForm.area_served.some((a, i) => (
      a.type !== currentSite.area_served[i].type
      || a.name !== currentSite.area_served[i].name
    ));
  }, [file, siteForm, currentSite]);

  function setSiteField<K extends keyof SiteForm>(key: K, value: SiteForm[K]) {
    setSiteForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submitSiteForm() {
    if (!content) return;
    if (!siteForm.name.trim()) {
      setSiteErr("Site name can't be empty.");
      return;
    }
    setSiteSubmitBusy(true);
    setSiteErr(null);
    setSiteMsg(null);
    try {
      const obj = JSON.parse(content.content_json);
      obj.name = siteForm.name.trim();
      obj.tagline = siteForm.tagline;
      obj.brand = {
        ...(obj.brand ?? {}),
        brand_color: siteForm.brand_color.trim(),
        brand_color_strong: siteForm.brand_color_strong.trim(),
        theme_color: siteForm.theme_color.trim(),
      };
      obj.hire_link = {
        ...(obj.hire_link ?? {}),
        label: siteForm.hire_label.trim(),
      };
      obj.sticky_call = {
        ...(obj.sticky_call ?? {}),
        label: siteForm.sticky_call_label.trim(),
      };
      obj.footer = {
        ...(obj.footer ?? {}),
        copyright_holder: siteForm.footer_copyright_holder.trim(),
        rights: siteForm.footer_rights.trim(),
        contact_link_label: siteForm.footer_contact_link_label.trim(),
      };
      // Nav — preserve any keys we don't know about (belt & braces).
      const existingNav = Array.isArray(obj.nav) ? obj.nav : [];
      obj.nav = siteForm.nav.map((n, i) => ({
        ...(existingNav[i] ?? {}),
        label: n.label.trim(),
        path: n.path.trim(),
        key: n.key.trim(),
      }));
      obj.area_served = siteForm.area_served
        .map((a) => ({ type: a.type.trim() || "Neighborhood", name: a.name.trim() }))
        .filter((a) => a.name);

      const rev = await websiteSaveDraft({
        file: "site",
        content_json: JSON.stringify(obj, null, 2) + "\n",
      });
      const c = await websiteLoadContent("site");
      setContent(c);
      setText(tryPrettyJson(c.content_json));
      setDirty(false);
      setSiteMsg(
        `Saved — site draft rev #${rev.revision_id}. Click Preview to see it, then Publish to go live.`
      );
    } catch (e: any) {
      setSiteErr(String(e?.message ?? e));
    } finally {
      setSiteSubmitBusy(false);
    }
  }

  // ─── Gallery Videos structured editor (heading + intro only) ─────
  // The videos[] array itself is managed in the /website/gallery-videos
  // media screen — this form just edits the page's section labels.
  type GalleryVideosForm = { heading: string; intro: string };
  const parseGalleryVideos = (raw: string): GalleryVideosForm => {
    try {
      const p = JSON.parse(raw);
      return {
        heading: String(p?.heading ?? ""),
        intro: stripToPlain(String(p?.intro ?? "")),
      };
    } catch {
      return { heading: "", intro: "" };
    }
  };
  const currentGalleryVideos = useMemo<GalleryVideosForm | null>(() => {
    if (file !== "gallery-videos" || !content) return null;
    return parseGalleryVideos(content.content_json);
  }, [file, content]);

  const [galleryVideosForm, setGalleryVideosForm] = useState<GalleryVideosForm>(() => parseGalleryVideos(""));
  const [galleryVideosSubmitBusy, setGalleryVideosSubmitBusy] = useState(false);
  const [galleryVideosMsg, setGalleryVideosMsg] = useState<string | null>(null);
  const [galleryVideosErr, setGalleryVideosErr] = useState<string | null>(null);

  useEffect(() => {
    if (file !== "gallery-videos" || !currentGalleryVideos) return;
    setGalleryVideosForm(currentGalleryVideos);
  }, [file, currentGalleryVideos]);
  useEffect(() => {
    setGalleryVideosMsg(null);
    setGalleryVideosErr(null);
  }, [file]);

  const galleryVideosDirty = useMemo(() => {
    if (file !== "gallery-videos" || !currentGalleryVideos) return false;
    return (
      galleryVideosForm.heading !== currentGalleryVideos.heading
      || galleryVideosForm.intro !== currentGalleryVideos.intro
    );
  }, [file, galleryVideosForm, currentGalleryVideos]);

  // Aggregate every dirty gate here so the beforeunload + click-block
  // effects registered at mount can gate on a single ref. Any new
  // structured form MUST be added to this list or its edits will be
  // silently discarded on a sidebar/preview/history click.
  useEffect(() => {
    anyDirtyRef.current =
      dirty
      || aboutDirty
      || contactDirty
      || servicesDirty
      || seoDirty
      || homeDirty
      || siteDirty
      || galleryVideosDirty;
  }, [
    dirty,
    aboutDirty,
    contactDirty,
    servicesDirty,
    seoDirty,
    homeDirty,
    siteDirty,
    galleryVideosDirty,
  ]);

  async function submitGalleryVideosForm() {
    if (!content) return;
    setGalleryVideosSubmitBusy(true);
    setGalleryVideosErr(null);
    setGalleryVideosMsg(null);
    try {
      const obj = JSON.parse(content.content_json);
      obj.heading = galleryVideosForm.heading.trim();
      obj.intro = galleryVideosForm.intro.trim();
      const rev = await websiteSaveDraft({
        file: "gallery-videos",
        content_json: JSON.stringify(obj, null, 2) + "\n",
      });
      const c = await websiteLoadContent("gallery-videos");
      setContent(c);
      setText(tryPrettyJson(c.content_json));
      setDirty(false);
      setGalleryVideosMsg(
        `Saved — gallery-videos draft rev #${rev.revision_id}. Click Preview to see it, then Publish to go live.`
      );
    } catch (e: any) {
      setGalleryVideosErr(String(e?.message ?? e));
    } finally {
      setGalleryVideosSubmitBusy(false);
    }
  }

  useEffect(() => {
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
      const sitePretty =
        res.site_proposed_json && res.site_proposed_json.trim()
          ? tryPrettyJson(res.site_proposed_json)
          : null;
      // Do not touch the working copy or the draft store — the user
      // reviews the proposal against the current content, then Accept
      // saves it as a draft revision or Reject discards it.
      setAiProposed({
        text: pretty,
        site_text: sitePretty,
        summary: res.summary,
        model: res.model,
      });
    } catch (e: any) {
      setAiErr(String(e?.message ?? e));
    } finally {
      setAiBusy(false);
    }
  }

  async function onAiAccept() {
    if (!aiProposed) return;
    // If the user has unsaved edits in the raw JSON pane or any
    // structured form, accepting an AI proposal would silently
    // overwrite those local edits. Guard with an explicit confirm so
    // an accidental Accept-then-lose-work is impossible. anyDirtyRef
    // tracks every form's dirty state (see beforeunload effect).
    if (anyDirtyRef.current) {
      if (!window.confirm(
        "You have unsaved edits that will be discarded by the AI proposal. Accept anyway?"
      )) {
        return;
      }
    }
    setAiBusy(true);
    setAiErr(null);
    setSaved(null);
    try {
      const saveRes = await websiteSaveDraft({
        file,
        content_json: aiProposed.text,
      });
      let siteSaveRev: number | null = null;
      if (aiProposed.site_text) {
        const siteSave = await websiteSaveDraft({
          file: "site",
          content_json: aiProposed.site_text,
        });
        siteSaveRev = siteSave.revision_id;
        if (file === "contact") {
          setSiteContent(await websiteLoadContent("site"));
        }
      }
      setText(aiProposed.text);
      setDirty(false);
      setContent(await websiteLoadContent(file));
      setSaved(
        `Accepted — saved as revision #${saveRes.revision_id}` +
          (siteSaveRev !== null ? ` (site draft rev #${siteSaveRev})` : ""),
      );
      setAiProposed(null);
      setAiPrompt("");
      // Ensure the confirmation banner at the top of the page is
      // visible — otherwise users clicking Accept at the bottom of a
      // long form never see it.
      try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch {}
    } catch (e: any) {
      setAiErr(String(e?.message ?? e));
    } finally {
      setAiBusy(false);
    }
  }

  function onAiDiscard() {
    setAiProposed(null);
    setAiErr(null);
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn link" onClick={() => guardedNav("/website")} style={{ padding: 0 }}>
          ← Website
        </button>
        <h1 style={{ margin: 0 }}>{FILE_LABELS[file]}</h1>
        {content?.source === "draft" && lastPushedRev != null && lastPushedRev !== content.active_draft_rev && (
          <button
            className="btn"
            onClick={() => setRevertConfirmOpen(true)}
            style={{ marginLeft: 8, fontSize: 12, padding: "5px 10px", background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" }}
            title={`Discard current draft and restore rev #${lastPushedRev} (the last published version)`}
            disabled={revertBusy}
          >
            ↺ Revert to published
          </button>
        )}
        <button
          className="btn"
          onClick={() => guardedNav(`/website/preview?page=${file}`)}
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
              onClick={() => guardedNav(`/website/history?file=${file}`)}
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
              onClick={() => guardedNav(`/website/history?file=${file}`)}
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
      {staleDraft && (
        <div
          className="home-alert tone-warning"
          style={{
            margin: "12px 0",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>
            ⚠ The live site has been updated since this draft was saved.
            Saving now may overwrite those changes. Consider discarding
            the draft and re-editing on top of the current version.
          </span>
          <button
            className="btn"
            style={{ marginLeft: "auto", fontSize: 13, padding: "4px 12px" }}
            onClick={() => guardedNav(`/website/history?file=${file}`)}
          >
            Open version history
          </button>
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
          {file === "about" && (
            <div
              style={{
                border: "1px solid rgba(0,0,0,0.1)",
                background: "white",
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <b style={{ fontSize: 14, color: "#1d3557" }}>Edit About page</b>
              <p style={{ margin: "4px 0 14px", fontSize: 12, color: "#64748b" }}>
                Edit any field and click <b>Submit</b> to save a draft.
                Bullets: one per line. Preview shows exactly how the live
                page will look.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", columnGap: 12, rowGap: 10, fontSize: 13 }}>
                <label htmlFor="about-heading" style={{ color: "#64748b", alignSelf: "center" }}>Page heading</label>
                <input
                  id="about-heading"
                  type="text"
                  value={aboutForm.heading}
                  onChange={(e) => setAboutField("heading", e.target.value)}
                  disabled={aboutSubmitBusy}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />

                <label htmlFor="about-intro" style={{ color: "#64748b", alignSelf: "start", marginTop: 8 }}>Intro paragraph</label>
                <textarea
                  id="about-intro"
                  value={aboutForm.intro_html}
                  onChange={(e) => setAboutField("intro_html", e.target.value)}
                  disabled={aboutSubmitBusy}
                  rows={4}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical" }}
                />

                <label htmlFor="about-vision-h" style={{ color: "#64748b", alignSelf: "center" }}>Vision heading</label>
                <input
                  id="about-vision-h"
                  type="text"
                  value={aboutForm.vision_heading}
                  onChange={(e) => setAboutField("vision_heading", e.target.value)}
                  disabled={aboutSubmitBusy}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
                <label htmlFor="about-vision-p" style={{ color: "#64748b", alignSelf: "start", marginTop: 8 }}>Vision paragraph</label>
                <textarea
                  id="about-vision-p"
                  value={aboutForm.vision_paragraph}
                  onChange={(e) => setAboutField("vision_paragraph", e.target.value)}
                  disabled={aboutSubmitBusy}
                  rows={3}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical" }}
                />

                <label htmlFor="about-mission-h" style={{ color: "#64748b", alignSelf: "center" }}>Mission heading</label>
                <input
                  id="about-mission-h"
                  type="text"
                  value={aboutForm.mission_heading}
                  onChange={(e) => setAboutField("mission_heading", e.target.value)}
                  disabled={aboutSubmitBusy}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
                <label htmlFor="about-mission-b" style={{ color: "#64748b", alignSelf: "start", marginTop: 8 }}>Mission bullets<br/><span style={{ fontSize: 11, color: "#94a3b8" }}>one per line</span></label>
                <textarea
                  id="about-mission-b"
                  value={aboutForm.mission_bullets}
                  onChange={(e) => setAboutField("mission_bullets", e.target.value)}
                  disabled={aboutSubmitBusy}
                  rows={4}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical" }}
                />

                <label htmlFor="about-team-h" style={{ color: "#64748b", alignSelf: "center" }}>Team heading</label>
                <input
                  id="about-team-h"
                  type="text"
                  value={aboutForm.team_heading}
                  onChange={(e) => setAboutField("team_heading", e.target.value)}
                  disabled={aboutSubmitBusy}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
                <label htmlFor="about-team-p" style={{ color: "#64748b", alignSelf: "start", marginTop: 8 }}>Team paragraph</label>
                <textarea
                  id="about-team-p"
                  value={aboutForm.team_paragraph}
                  onChange={(e) => setAboutField("team_paragraph", e.target.value)}
                  disabled={aboutSubmitBusy}
                  rows={3}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical" }}
                />

                <label htmlFor="about-why-h" style={{ color: "#64748b", alignSelf: "center" }}>“Why choose us” heading</label>
                <input
                  id="about-why-h"
                  type="text"
                  value={aboutForm.why_heading}
                  onChange={(e) => setAboutField("why_heading", e.target.value)}
                  disabled={aboutSubmitBusy}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
                <label htmlFor="about-why-b" style={{ color: "#64748b", alignSelf: "start", marginTop: 8 }}>“Why choose us” bullets<br/><span style={{ fontSize: 11, color: "#94a3b8" }}>one per line</span></label>
                <textarea
                  id="about-why-b"
                  value={aboutForm.why_bullets}
                  onChange={(e) => setAboutField("why_bullets", e.target.value)}
                  disabled={aboutSubmitBusy}
                  rows={4}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical" }}
                />
              </div>

              {/* Three-photo grid slots — overwrite assets/img/photoN.jpg
                  in the working copy. Filenames stay fixed so about.json
                  never needs re-pointing. Publish autostash picks up the
                  file change. */}
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px dashed rgba(0,0,0,0.15)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
                  <b style={{ fontSize: 13, color: "#1d3557" }}>Photo grid</b>
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>
                    Three landscape photos shown after Why choose us. Replace any slot with a new picture.
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                  {[1, 2, 3].map((n) => {
                    const slot = n as 1 | 2 | 3;
                    const thumb = aboutPhotoThumbUrl(slot);
                    const busy = photoBusySlot === slot;
                    return (
                      <div key={slot} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{
                          width: "100%",
                          aspectRatio: "1400 / 900",
                          border: "1px solid rgba(0,0,0,0.15)",
                          borderRadius: 6,
                          background: "#f8fafc",
                          overflow: "hidden",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}>
                          {thumb ? (
                            <img
                              src={thumb}
                              alt={`About photo slot ${slot}`}
                              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                            />
                          ) : (
                            <span style={{ fontSize: 11, color: "#94a3b8" }}>Slot {slot}</span>
                          )}
                        </div>
                        <button
                          className="btn"
                          onClick={() => void pickAndReplaceAboutPhoto(slot)}
                          disabled={busy || aboutSubmitBusy}
                          style={{ fontSize: 12, padding: "6px 10px" }}
                        >
                          {busy ? "Uploading…" : `Replace photo ${slot}`}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <p style={{ margin: "8px 0 0", fontSize: 11, color: "#94a3b8" }}>
                  Photos are auto-cropped to 1400×900 landscape (matches the site grid). Any format works (JPG, PNG, HEIC, WebP, AVIF).
                </p>
              </div>

              {/* Custom sections — user-defined headings that render on the
                  live page after Why choose us, in the order shown here. */}
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px dashed rgba(0,0,0,0.15)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
                  <b style={{ fontSize: 13, color: "#1d3557" }}>Extra sections</b>
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>
                    Add your own headings (e.g. Business Hours, Awards) — they render below Why choose us.
                  </span>
                </div>
                {aboutForm.custom_sections.length === 0 && (
                  <p style={{ fontSize: 12, color: "#94a3b8", margin: "0 0 8px" }}>
                    No extra sections yet. Click <b>+ Add section</b> to create one.
                  </p>
                )}
                {aboutForm.custom_sections.map((sec, idx) => (
                  <div
                    key={idx}
                    style={{
                      border: "1px solid rgba(0,0,0,0.12)",
                      borderRadius: 8,
                      padding: 12,
                      marginBottom: 10,
                      background: "#f8fafc",
                    }}
                  >
                    <div style={{ display: "grid", gridTemplateColumns: "120px 1fr auto", columnGap: 10, rowGap: 8, fontSize: 13, alignItems: "center" }}>
                      <label style={{ color: "#64748b" }}>Heading</label>
                      <input
                        type="text"
                        value={sec.heading}
                        onChange={(e) => setAboutForm((prev) => {
                          const next = [...prev.custom_sections];
                          next[idx] = { ...next[idx], heading: e.target.value };
                          return { ...prev, custom_sections: next };
                        })}
                        disabled={aboutSubmitBusy}
                        placeholder="e.g. Business hours"
                        style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                      />
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setAboutForm((prev) => {
                            if (idx === 0) return prev;
                            const next = [...prev.custom_sections];
                            [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                            return { ...prev, custom_sections: next };
                          })}
                          disabled={aboutSubmitBusy || idx === 0}
                          title="Move up"
                          style={{ padding: "4px 8px", fontSize: 12 }}
                        >↑</button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setAboutForm((prev) => {
                            if (idx === prev.custom_sections.length - 1) return prev;
                            const next = [...prev.custom_sections];
                            [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
                            return { ...prev, custom_sections: next };
                          })}
                          disabled={aboutSubmitBusy || idx === aboutForm.custom_sections.length - 1}
                          title="Move down"
                          style={{ padding: "4px 8px", fontSize: 12 }}
                        >↓</button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setAboutForm((prev) => ({
                            ...prev,
                            custom_sections: prev.custom_sections.filter((_, i) => i !== idx),
                          }))}
                          disabled={aboutSubmitBusy}
                          title="Remove section"
                          style={{ padding: "4px 10px", fontSize: 12 }}
                        >Remove</button>
                      </div>

                      <label style={{ color: "#64748b" }}>Format</label>
                      <div style={{ display: "flex", gap: 14, fontSize: 13 }}>
                        <label style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
                          <input
                            type="radio"
                            checked={sec.type === "paragraph"}
                            onChange={() => setAboutForm((prev) => {
                              const next = [...prev.custom_sections];
                              next[idx] = { ...next[idx], type: "paragraph" };
                              return { ...prev, custom_sections: next };
                            })}
                            disabled={aboutSubmitBusy}
                          />
                          Paragraph
                        </label>
                        <label style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
                          <input
                            type="radio"
                            checked={sec.type === "bullets"}
                            onChange={() => setAboutForm((prev) => {
                              const next = [...prev.custom_sections];
                              next[idx] = { ...next[idx], type: "bullets" };
                              return { ...prev, custom_sections: next };
                            })}
                            disabled={aboutSubmitBusy}
                          />
                          Bullet list
                        </label>
                      </div>
                      <span />

                      <label style={{ color: "#64748b", alignSelf: "start", marginTop: 6 }}>
                        {sec.type === "bullets" ? (<>Bullets<br/><span style={{ fontSize: 11, color: "#94a3b8" }}>one per line</span></>) : "Paragraph"}
                      </label>
                      <textarea
                        value={sec.type === "bullets" ? sec.bullets : sec.paragraph}
                        onChange={(e) => setAboutForm((prev) => {
                          const next = [...prev.custom_sections];
                          if (next[idx].type === "bullets") {
                            next[idx] = { ...next[idx], bullets: e.target.value };
                          } else {
                            next[idx] = { ...next[idx], paragraph: e.target.value };
                          }
                          return { ...prev, custom_sections: next };
                        })}
                        disabled={aboutSubmitBusy}
                        rows={sec.type === "bullets" ? 4 : 3}
                        placeholder={sec.type === "bullets"
                          ? "Best Daycare 2025\nBC Family Choice Award\n…"
                          : "Open Monday to Friday, 8 AM to 9 PM."}
                        style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical" }}
                      />
                      <span />
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn"
                  onClick={() => setAboutForm((prev) => ({
                    ...prev,
                    custom_sections: [
                      ...prev.custom_sections,
                      { heading: "", type: "paragraph", paragraph: "", bullets: "" },
                    ],
                  }))}
                  disabled={aboutSubmitBusy}
                  style={{ fontSize: 13, padding: "6px 14px" }}
                >
                  + Add section
                </button>
              </div>

              {aboutErr && (
                <div style={{ marginTop: 12, padding: "8px 10px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, color: "#b91c1c", fontSize: 12 }}>
                  {aboutErr}
                </div>
              )}
              {aboutMsg && (
                <div style={{ marginTop: 12, padding: "8px 10px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, color: "#166534", fontSize: 12 }}>
                  {aboutMsg}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
                <button
                  className="btn"
                  onClick={submitAboutForm}
                  disabled={!aboutDirty || aboutSubmitBusy}
                  style={{
                    background: aboutDirty ? "#1d5fa3" : undefined,
                    color: aboutDirty ? "white" : undefined,
                    fontSize: 13,
                    padding: "8px 18px",
                  }}
                >
                  {aboutSubmitBusy ? "Saving…" : "Submit"}
                </button>
                <button
                  className="btn"
                  onClick={() => guardedNav(`/website/preview?page=about`)}
                  disabled={aboutSubmitBusy}
                  style={{ fontSize: 13, padding: "8px 18px" }}
                >
                  Preview →
                </button>
              </div>
              <p style={{ margin: "14px 0 0", fontSize: 12, color: "#94a3b8" }}>
                For photo grid, neighbourhoods copy, or layout tweaks, use the
                AI prompt below.
              </p>
            </div>
          )}
          {file === "services" && (
            <div
              style={{
                border: "1px solid rgba(0,0,0,0.1)",
                background: "white",
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <b style={{ fontSize: 14, color: "#1d3557" }}>Edit Programs &amp; Waiting List</b>
              <p style={{ margin: "4px 0 14px", fontSize: 12, color: "#64748b" }}>
                Edit any field and click <b>Submit</b> to save a draft.
                Preview shows exactly how the live page will look.
              </p>

              {/* Daycare program */}
              <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", columnGap: 12, rowGap: 10, fontSize: 13 }}>
                <label htmlFor="svc-prog-h" style={{ color: "#64748b", alignSelf: "center" }}>Program heading</label>
                <input
                  id="svc-prog-h"
                  type="text"
                  value={servicesForm.program_heading}
                  onChange={(e) => setServicesField("program_heading", e.target.value)}
                  disabled={servicesSubmitBusy}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                  <b style={{ fontSize: 13, color: "#1d3557" }}>Program description paragraphs</b>
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>
                    Each entry renders as its own paragraph on the live page.
                  </span>
                </div>
                {servicesForm.program_paragraphs.map((para, idx) => (
                  <div key={idx} style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: "#94a3b8", width: 22, paddingTop: 8 }}>{idx + 1}.</span>
                    <textarea
                      value={para}
                      onChange={(e) => setServicesForm((prev) => {
                        const next = [...prev.program_paragraphs];
                        next[idx] = e.target.value;
                        return { ...prev, program_paragraphs: next };
                      })}
                      disabled={servicesSubmitBusy}
                      rows={3}
                      style={{ flex: 1, padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical" }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <button
                        type="button"
                        className="btn"
                        title="Move up"
                        onClick={() => setServicesForm((prev) => {
                          if (idx === 0) return prev;
                          const next = [...prev.program_paragraphs];
                          [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                          return { ...prev, program_paragraphs: next };
                        })}
                        disabled={servicesSubmitBusy || idx === 0}
                        style={{ padding: "2px 8px", fontSize: 11 }}
                      >↑</button>
                      <button
                        type="button"
                        className="btn"
                        title="Move down"
                        onClick={() => setServicesForm((prev) => {
                          if (idx === prev.program_paragraphs.length - 1) return prev;
                          const next = [...prev.program_paragraphs];
                          [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
                          return { ...prev, program_paragraphs: next };
                        })}
                        disabled={servicesSubmitBusy || idx === servicesForm.program_paragraphs.length - 1}
                        style={{ padding: "2px 8px", fontSize: 11 }}
                      >↓</button>
                      <button
                        type="button"
                        className="btn"
                        title="Remove paragraph"
                        onClick={() => setServicesForm((prev) => ({
                          ...prev,
                          program_paragraphs: prev.program_paragraphs.length > 1
                            ? prev.program_paragraphs.filter((_, i) => i !== idx)
                            : [""],
                        }))}
                        disabled={servicesSubmitBusy}
                        style={{ padding: "2px 8px", fontSize: 11 }}
                      >×</button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn"
                  onClick={() => setServicesForm((prev) => ({
                    ...prev,
                    program_paragraphs: [...prev.program_paragraphs, ""],
                  }))}
                  disabled={servicesSubmitBusy}
                  style={{ fontSize: 12, padding: "6px 12px" }}
                >+ Add paragraph</button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", columnGap: 12, rowGap: 10, fontSize: 13, marginTop: 14 }}>
                <label htmlFor="svc-broch-label" style={{ color: "#64748b", alignSelf: "center" }}>Brochure link text</label>
                <input
                  id="svc-broch-label"
                  type="text"
                  value={servicesForm.brochure_link_label}
                  onChange={(e) => setServicesField("brochure_link_label", e.target.value)}
                  disabled={servicesSubmitBusy}
                  placeholder="📄 Download Program Brochure (PDF)"
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
                <label htmlFor="svc-broch-path" style={{ color: "#64748b", alignSelf: "center" }}>Brochure file path</label>
                <input
                  id="svc-broch-path"
                  type="text"
                  value={servicesForm.brochure_path}
                  onChange={(e) => setServicesField("brochure_path", e.target.value)}
                  disabled={servicesSubmitBusy}
                  placeholder="assets/docs/Brochure.pdf"
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "monospace" }}
                />
              </div>

              {/* Waiting list block intentionally removed from the editor —
                  the app's Waitlist module is the source of truth. The
                  waiting_list keys in services.json are still honoured by
                  the live template; edit them via the AI prompt or version
                  history if the parent-facing Google Form ever needs
                  updating. */}

              {/* Service schema (SEO) */}
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px dashed rgba(0,0,0,0.15)" }}>
                <b style={{ fontSize: 13, color: "#1d3557" }}>Service info (for search engines)</b>
                <p style={{ margin: "4px 0 10px", fontSize: 11, color: "#94a3b8" }}>
                  Used by Google to describe your program in search results. Not visible on the site itself.
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", columnGap: 12, rowGap: 10, fontSize: 13 }}>
                  <label htmlFor="svc-schema-name" style={{ color: "#64748b", alignSelf: "center" }}>Program name</label>
                  <input
                    id="svc-schema-name"
                    type="text"
                    value={servicesForm.schema_name}
                    onChange={(e) => setServicesField("schema_name", e.target.value)}
                    disabled={servicesSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                  <label htmlFor="svc-schema-type" style={{ color: "#64748b", alignSelf: "center" }}>Service type</label>
                  <input
                    id="svc-schema-type"
                    type="text"
                    value={servicesForm.schema_service_type}
                    onChange={(e) => setServicesField("schema_service_type", e.target.value)}
                    disabled={servicesSubmitBusy}
                    placeholder="Licensed daycare program (ages 30 months to 5 years)"
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                  <label style={{ color: "#64748b", alignSelf: "center" }}>Age range</label>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={servicesForm.schema_min_age}
                      onChange={(e) => setServicesField("schema_min_age", e.target.value.replace(/[^0-9.]/g, ""))}
                      disabled={servicesSubmitBusy}
                      placeholder="2.5"
                      style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", width: 80, fontFamily: "monospace" }}
                    />
                    <span style={{ color: "#94a3b8" }}>to</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={servicesForm.schema_max_age}
                      onChange={(e) => setServicesField("schema_max_age", e.target.value.replace(/[^0-9.]/g, ""))}
                      disabled={servicesSubmitBusy}
                      placeholder="5"
                      style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", width: 80, fontFamily: "monospace" }}
                    />
                    <span style={{ color: "#94a3b8", fontSize: 12 }}>years</span>
                  </div>
                  <label htmlFor="svc-schema-desc" style={{ color: "#64748b", alignSelf: "start", marginTop: 8 }}>Description</label>
                  <textarea
                    id="svc-schema-desc"
                    value={servicesForm.schema_description}
                    onChange={(e) => setServicesField("schema_description", e.target.value)}
                    disabled={servicesSubmitBusy}
                    rows={3}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical" }}
                  />
                </div>
              </div>

              {servicesErr && (
                <div style={{ marginTop: 12, padding: "8px 10px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, color: "#b91c1c", fontSize: 12 }}>
                  {servicesErr}
                </div>
              )}
              {servicesMsg && (
                <div style={{ marginTop: 12, padding: "8px 10px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, color: "#166534", fontSize: 12 }}>
                  {servicesMsg}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
                <button
                  className="btn"
                  onClick={submitServicesForm}
                  disabled={!servicesDirty || servicesSubmitBusy}
                  style={{
                    background: servicesDirty ? "#1d5fa3" : undefined,
                    color: servicesDirty ? "white" : undefined,
                    fontSize: 13,
                    padding: "8px 18px",
                  }}
                >
                  {servicesSubmitBusy ? "Saving…" : "Submit"}
                </button>
                <button
                  className="btn"
                  onClick={() => guardedNav(`/website/preview?page=services`)}
                  disabled={servicesSubmitBusy}
                  style={{ fontSize: 13, padding: "8px 18px" }}
                >
                  Preview →
                </button>
              </div>
              <p style={{ margin: "14px 0 0", fontSize: 12, color: "#94a3b8" }}>
                For anything the form doesn't cover, use the AI prompt below.
              </p>
            </div>
          )}
          {file === "seo" && (
            <div
              style={{
                border: "1px solid rgba(0,0,0,0.1)",
                background: "white",
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <b style={{ fontSize: 14, color: "#1d3557" }}>Edit page SEO</b>
              <p style={{ margin: "4px 0 14px", fontSize: 12, color: "#64748b" }}>
                What shows up in Google search results and social share
                previews. Pick a page, edit its title and description, and
                click <b>Submit</b> to save a draft.
              </p>

              {Object.keys(seoForm.pages).length === 0 ? (
                <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>
                  No pages found in seo.json. Try <i>Reload from disk</i>.
                </p>
              ) : (() => {
                const slug = seoForm.selected;
                const f = seoForm.pages[slug];
                const titleLen = f?.title?.length ?? 0;
                const descLen = f?.description?.length ?? 0;
                const ogTitleLen = f?.og_title?.length ?? 0;
                const ogDescLen = f?.og_description?.length ?? 0;
                const lenColor = (n: number, min: number, max: number) =>
                  n === 0 ? "#94a3b8" : n < min ? "#b45309" : n > max ? "#b91c1c" : "#166534";
                return (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", columnGap: 12, rowGap: 10, fontSize: 13, marginBottom: 6 }}>
                      <label htmlFor="seo-page" style={{ color: "#64748b", alignSelf: "center" }}>Page</label>
                      <select
                        id="seo-page"
                        value={slug}
                        onChange={(e) => setSeoForm((prev) => ({ ...prev, selected: e.target.value }))}
                        disabled={seoSubmitBusy}
                        style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                      >
                        {Object.keys(seoForm.pages).map((s) => (
                          <option key={s} value={s}>{SEO_PAGE_LABELS[s] ?? s}</option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", columnGap: 12, rowGap: 10, fontSize: 13, marginTop: 12 }}>
                      <label htmlFor="seo-title" style={{ color: "#64748b", alignSelf: "start", marginTop: 8 }}>Page title</label>
                      <div>
                        <input
                          id="seo-title"
                          type="text"
                          value={f?.title ?? ""}
                          onChange={(e) => setSeoField(slug, "title", e.target.value)}
                          disabled={seoSubmitBusy}
                          style={{ width: "100%", padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", boxSizing: "border-box" }}
                        />
                        <div style={{ fontSize: 11, marginTop: 4, color: lenColor(titleLen, 30, 60) }}>
                          {titleLen} chars {titleLen > 60 ? "— Google may truncate above 60" : titleLen > 0 && titleLen < 30 ? "— aim for 30–60" : "(ideal 30–60)"}
                        </div>
                      </div>

                      <label htmlFor="seo-desc" style={{ color: "#64748b", alignSelf: "start", marginTop: 8 }}>Meta description</label>
                      <div>
                        <textarea
                          id="seo-desc"
                          value={f?.description ?? ""}
                          onChange={(e) => setSeoField(slug, "description", e.target.value)}
                          disabled={seoSubmitBusy}
                          rows={3}
                          style={{ width: "100%", padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
                        />
                        <div style={{ fontSize: 11, marginTop: 4, color: lenColor(descLen, 70, 160) }}>
                          {descLen} chars {descLen > 160 ? "— Google may truncate above 160" : descLen > 0 && descLen < 70 ? "— aim for 70–160" : "(ideal 70–160)"}
                        </div>
                      </div>
                    </div>

                    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px dashed rgba(0,0,0,0.15)" }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
                        <b style={{ fontSize: 13, color: "#1d3557" }}>Social share preview</b>
                        <span style={{ fontSize: 11, color: "#94a3b8" }}>
                          What appears when someone shares the link on Facebook, LinkedIn, WhatsApp etc.
                        </span>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setSeoForm((prev) => {
                            const cur = prev.pages[slug];
                            if (!cur) return prev;
                            return {
                              ...prev,
                              pages: {
                                ...prev.pages,
                                [slug]: { ...cur, og_title: cur.title, og_description: cur.description },
                              },
                            };
                          })}
                          disabled={seoSubmitBusy}
                          style={{ fontSize: 11, padding: "4px 10px", marginLeft: "auto" }}
                        >Copy from above</button>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", columnGap: 12, rowGap: 10, fontSize: 13 }}>
                        <label htmlFor="seo-ogt" style={{ color: "#64748b", alignSelf: "start", marginTop: 8 }}>Social title</label>
                        <div>
                          <input
                            id="seo-ogt"
                            type="text"
                            value={f?.og_title ?? ""}
                            onChange={(e) => setSeoField(slug, "og_title", e.target.value)}
                            disabled={seoSubmitBusy}
                            style={{ width: "100%", padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", boxSizing: "border-box" }}
                          />
                          <div style={{ fontSize: 11, marginTop: 4, color: "#94a3b8" }}>
                            {ogTitleLen} chars
                          </div>
                        </div>
                        <label htmlFor="seo-ogd" style={{ color: "#64748b", alignSelf: "start", marginTop: 8 }}>Social description</label>
                        <div>
                          <textarea
                            id="seo-ogd"
                            value={f?.og_description ?? ""}
                            onChange={(e) => setSeoField(slug, "og_description", e.target.value)}
                            disabled={seoSubmitBusy}
                            rows={3}
                            style={{ width: "100%", padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
                          />
                          <div style={{ fontSize: 11, marginTop: 4, color: "#94a3b8" }}>
                            {ogDescLen} chars
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}

              {seoErr && (
                <div style={{ marginTop: 12, padding: "8px 10px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, color: "#b91c1c", fontSize: 12 }}>
                  {seoErr}
                </div>
              )}
              {seoMsg && (
                <div style={{ marginTop: 12, padding: "8px 10px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, color: "#166534", fontSize: 12 }}>
                  {seoMsg}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
                <button
                  className="btn"
                  onClick={submitSeoForm}
                  disabled={!seoDirty || seoSubmitBusy}
                  style={{
                    background: seoDirty ? "#1d5fa3" : undefined,
                    color: seoDirty ? "white" : undefined,
                    fontSize: 13,
                    padding: "8px 18px",
                  }}
                >
                  {seoSubmitBusy ? "Saving…" : "Submit"}
                </button>
                <button
                  className="btn"
                  onClick={() => guardedNav(`/website/preview`)}
                  disabled={seoSubmitBusy}
                  style={{ fontSize: 13, padding: "8px 18px" }}
                >
                  Preview →
                </button>
              </div>
              <p style={{ margin: "14px 0 0", fontSize: 12, color: "#94a3b8" }}>
                Page paths, canonical URLs and breadcrumbs stay unchanged
                — you only edit what shows up in Google and social previews.
              </p>
            </div>
          )}
          {file === "home" && (
            <div
              style={{
                border: "1px solid rgba(0,0,0,0.1)",
                background: "white",
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <b style={{ fontSize: 14, color: "#1d3557" }}>Edit the home page</b>
              <p style={{ margin: "4px 0 14px", fontSize: 12, color: "#64748b" }}>
                Hero, stats strip, and frequently asked questions. Edit any
                field and click <b>Submit</b> to save a draft.
              </p>

              {/* ── Banner image ─────────────────────────────────────── */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1d3557", marginBottom: 4 }}>Banner image</div>
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "#64748b" }}>
                  The wide photo behind the heading at the top of the page.
                  Landscape photos work best — will be cropped to 12:5 (2400×1000).
                </p>
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <div
                    style={{
                      width: 180,
                      height: 75,
                      borderRadius: 6,
                      background: "#e2e8f0",
                      overflow: "hidden",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10,
                      color: "#94a3b8",
                    }}
                  >
                    {homeGalleryThumbUrl("assets/img/hero-bg.jpg") ? (
                      <img
                        src={homeGalleryThumbUrl("assets/img/hero-bg.jpg")!}
                        alt="Current hero banner"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <span>no preview</span>
                    )}
                  </div>
                  <div>
                    <button
                      type="button"
                      className="btn"
                      onClick={pickAndReplaceHomeHeroBanner}
                      disabled={homeSubmitBusy || homePhotoBusy !== null}
                      style={{ fontSize: 12, padding: "6px 14px" }}
                    >
                      {homePhotoBusy === "__hero_banner__" ? "Working…" : "Replace banner"}
                    </button>
                    <p style={{ margin: "6px 0 0", fontSize: 11, color: "#94a3b8" }}>
                      Saved directly to <code>assets/img/hero-bg.jpg</code>.
                      Click <b>Preview →</b> after to see the change.
                    </p>
                  </div>
                </div>
              </div>

              {/* ── Hero ─────────────────────────────────────────────── */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1d3557", marginBottom: 8 }}>Hero (top of the page)</div>
                <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", columnGap: 12, rowGap: 10, fontSize: 13 }}>
                  <label htmlFor="home-hero-heading" style={{ color: "#64748b", alignSelf: "center" }}>Heading</label>
                  <input
                    id="home-hero-heading"
                    type="text"
                    value={homeForm.hero_heading}
                    onChange={(e) => setHomeField("hero_heading", e.target.value)}
                    disabled={homeSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                  <label htmlFor="home-hero-sub" style={{ color: "#64748b", alignSelf: "start", paddingTop: 8 }}>Subtext</label>
                  <textarea
                    id="home-hero-sub"
                    value={homeForm.hero_subtext}
                    onChange={(e) => setHomeField("hero_subtext", e.target.value)}
                    disabled={homeSubmitBusy}
                    rows={3}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical" }}
                  />
                  <label htmlFor="home-hero-cta" style={{ color: "#64748b", alignSelf: "center" }}>Button label</label>
                  <input
                    id="home-hero-cta"
                    type="text"
                    value={homeForm.hero_cta_label}
                    onChange={(e) => setHomeField("hero_cta_label", e.target.value)}
                    disabled={homeSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                  <label htmlFor="home-hero-href" style={{ color: "#64748b", alignSelf: "center" }}>Button link</label>
                  <input
                    id="home-hero-href"
                    type="text"
                    value={homeForm.hero_cta_href}
                    onChange={(e) => setHomeField("hero_cta_href", e.target.value)}
                    disabled={homeSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "ui-monospace, Menlo, monospace" }}
                  />
                </div>
                <p style={{ margin: "6px 0 0 162px", fontSize: 11, color: "#94a3b8" }}>
                  The button link is usually <code>pages/services.html#waiting-list</code>. Only change it if the destination has moved.
                </p>
              </div>

              {/* ── Stats strip ─────────────────────────────────────── */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1d3557", marginBottom: 8 }}>Stats strip</div>
                <p style={{ margin: "0 0 8px", fontSize: 12, color: "#64748b" }}>
                  Short claims shown in a row (e.g. "1000+ Happy Families"). Keep them terse — 3–6 words each.
                </p>
                {homeForm.stats.map((s, idx) => (
                  <div key={`stat-${idx}`} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                    <input
                      type="text"
                      value={s}
                      onChange={(e) => {
                        const next = homeForm.stats.slice();
                        next[idx] = e.target.value;
                        setHomeField("stats", next);
                      }}
                      disabled={homeSubmitBusy}
                      style={{ flex: 1, padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        const next = homeForm.stats.slice();
                        next.splice(idx, 1);
                        setHomeField("stats", next);
                      }}
                      disabled={homeSubmitBusy}
                      style={{ fontSize: 12, padding: "6px 12px" }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn"
                  onClick={() => setHomeField("stats", [...homeForm.stats, ""])}
                  disabled={homeSubmitBusy}
                  style={{ fontSize: 12, padding: "6px 14px" }}
                >
                  + Add stat
                </button>
              </div>

              {/* ── Gallery preview alt text ────────────────────────── */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1d3557", marginBottom: 4 }}>Gallery preview</div>
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "#64748b" }}>
                  The 6 photos shown on the home page hero grid. Replace,
                  remove, or add new ones directly here.
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", columnGap: 12, rowGap: 10, fontSize: 13, marginBottom: 10 }}>
                  <label htmlFor="home-gp-heading" style={{ color: "#64748b", alignSelf: "center" }}>Section heading</label>
                  <input
                    id="home-gp-heading"
                    type="text"
                    value={homeForm.gallery_heading}
                    onChange={(e) => setHomeField("gallery_heading", e.target.value)}
                    disabled={homeSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                </div>
                {homeForm.gallery_items.map((g, idx) => {
                  const thumb = homeGalleryThumbUrl(g.src);
                  const rowBusy = homePhotoBusy === g.id;
                  const stableId = g.id || `home_g_${idx + 1}`;
                  return (
                    <div
                      key={g.id || `gp-${idx}`}
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "flex-start",
                        marginBottom: 12,
                        padding: 10,
                        border: "1px solid rgba(0,0,0,0.08)",
                        borderRadius: 8,
                        background: "#fafafa",
                      }}
                    >
                      <div
                        style={{
                          width: 96,
                          height: 64,
                          borderRadius: 6,
                          background: "#e2e8f0",
                          overflow: "hidden",
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 10,
                          color: "#94a3b8",
                        }}
                      >
                        {thumb ? (
                          <img
                            src={thumb}
                            alt={g.alt}
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <span>no preview</span>
                        )}
                      </div>
                      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                        <input
                          type="text"
                          value={g.alt}
                          onChange={(e) => {
                            const next = homeForm.gallery_items.slice();
                            next[idx] = { ...next[idx], alt: e.target.value };
                            setHomeField("gallery_items", next);
                          }}
                          disabled={homeSubmitBusy || rowBusy}
                          placeholder="Short description of what's in the photo"
                          style={{ padding: "6px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 12, background: "white" }}
                        />
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => pickAndReplaceHomeGalleryPhoto(idx, stableId)}
                            disabled={homeSubmitBusy || rowBusy}
                            style={{ fontSize: 11, padding: "4px 10px" }}
                          >
                            {rowBusy ? "Working…" : "Replace photo"}
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => {
                              const next = homeForm.gallery_items.slice();
                              next.splice(idx, 1);
                              setHomeField("gallery_items", next);
                            }}
                            disabled={homeSubmitBusy || rowBusy}
                            style={{ fontSize: 11, padding: "4px 10px" }}
                          >
                            Remove
                          </button>
                          <span style={{ fontSize: 10, color: "#94a3b8", fontFamily: "ui-monospace, Menlo, monospace" }}>
                            {g.src}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="btn"
                  onClick={pickAndAddHomeGalleryPhoto}
                  disabled={homeSubmitBusy || homePhotoBusy !== null}
                  style={{ fontSize: 12, padding: "6px 14px" }}
                >
                  {homePhotoBusy && homePhotoBusy.startsWith("home_g_") ? "Adding…" : "+ Add photo"}
                </button>
                <p style={{ margin: "6px 0 0", fontSize: 11, color: "#94a3b8" }}>
                  Photos are cropped to 3:2 (1200×800) and saved into the site's assets. Remember to click <b>Submit</b> after changes.
                </p>
              </div>

              {/* ── FAQ ─────────────────────────────────────────────── */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1d3557", marginBottom: 8 }}>Frequently asked questions</div>
                <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", columnGap: 12, rowGap: 10, fontSize: 13, marginBottom: 12 }}>
                  <label htmlFor="home-faq-heading" style={{ color: "#64748b", alignSelf: "center" }}>Section heading</label>
                  <input
                    id="home-faq-heading"
                    type="text"
                    value={homeForm.faq_heading}
                    onChange={(e) => setHomeField("faq_heading", e.target.value)}
                    disabled={homeSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                </div>
                {homeForm.faq_items.map((f, idx) => (
                  <div
                    key={f.id || `faq-${idx}`}
                    style={{
                      border: "1px solid rgba(0,0,0,0.08)",
                      borderRadius: 8,
                      padding: 12,
                      marginBottom: 10,
                      background: "#fafafa",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: "#64748b" }}>FAQ {idx + 1}</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            if (idx === 0) return;
                            const next = homeForm.faq_items.slice();
                            [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                            setHomeField("faq_items", next);
                          }}
                          disabled={homeSubmitBusy || idx === 0}
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            if (idx === homeForm.faq_items.length - 1) return;
                            const next = homeForm.faq_items.slice();
                            [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
                            setHomeField("faq_items", next);
                          }}
                          disabled={homeSubmitBusy || idx === homeForm.faq_items.length - 1}
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            const next = homeForm.faq_items.slice();
                            next.splice(idx, 1);
                            setHomeField("faq_items", next);
                          }}
                          disabled={homeSubmitBusy}
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    <input
                      type="text"
                      value={f.question}
                      onChange={(e) => {
                        const next = homeForm.faq_items.slice();
                        next[idx] = { ...next[idx], question: e.target.value };
                        setHomeField("faq_items", next);
                      }}
                      disabled={homeSubmitBusy}
                      placeholder="Question"
                      style={{ width: "100%", padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", marginBottom: 8, boxSizing: "border-box" }}
                    />
                    <textarea
                      value={f.answer}
                      onChange={(e) => {
                        const next = homeForm.faq_items.slice();
                        next[idx] = { ...next[idx], answer: e.target.value };
                        setHomeField("faq_items", next);
                      }}
                      disabled={homeSubmitBusy}
                      placeholder="Answer (1–3 sentences)"
                      rows={3}
                      style={{ width: "100%", padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const nextId = `faq_${Date.now().toString(36)}`;
                    setHomeField("faq_items", [
                      ...homeForm.faq_items,
                      { id: nextId, question: "", answer: "" },
                    ]);
                  }}
                  disabled={homeSubmitBusy}
                  style={{ fontSize: 12, padding: "6px 14px" }}
                >
                  + Add FAQ
                </button>
              </div>

              {homeErr && (
                <div style={{ marginTop: 12, padding: 10, background: "#fee2e2", color: "#7f1d1d", borderRadius: 6, fontSize: 12 }}>
                  {homeErr}
                </div>
              )}
              {homeMsg && (
                <div style={{ marginTop: 12, padding: 10, background: "#dcfce7", color: "#166534", borderRadius: 6, fontSize: 12 }}>
                  {homeMsg}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center" }}>
                <button
                  className="btn"
                  onClick={submitHomeForm}
                  disabled={homeSubmitBusy || !homeDirty || !homeForm.hero_heading.trim()}
                  style={{ background: "#1d5fa3", color: "white", fontSize: 13, padding: "8px 18px" }}
                >
                  {homeSubmitBusy ? "Saving…" : "Submit"}
                </button>
                <button
                  className="btn"
                  onClick={() => guardedNav(`/website/preview?page=home`)}
                  disabled={homeSubmitBusy}
                  style={{ fontSize: 13, padding: "8px 18px" }}
                >
                  Preview →
                </button>
              </div>
              <p style={{ margin: "14px 0 0", fontSize: 12, color: "#94a3b8" }}>
                For anything the form doesn't cover (adding new sections, layout
                tweaks, gallery photo swaps), use the AI prompt below.
              </p>
            </div>
          )}
          {file === "site" && (
            <div
              style={{
                border: "1px solid rgba(0,0,0,0.1)",
                background: "white",
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <b style={{ fontSize: 14, color: "#1d3557" }}>Edit site-wide settings</b>
              <p style={{ margin: "4px 0 14px", fontSize: 12, color: "#64748b" }}>
                Business name, brand colors, navigation labels, service areas,
                and footer text. Address / phone / email / Facebook are
                edited on the <b>Contact</b> page.
              </p>

              {/* ── Basics ──────────────────────────────────────────── */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1d3557", marginBottom: 8 }}>Business basics</div>
                <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", columnGap: 12, rowGap: 10, fontSize: 13 }}>
                  <label htmlFor="site-name" style={{ color: "#64748b", alignSelf: "center" }}>Business name</label>
                  <input
                    id="site-name"
                    type="text"
                    value={siteForm.name}
                    onChange={(e) => setSiteField("name", e.target.value)}
                    disabled={siteSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                  <label htmlFor="site-tagline" style={{ color: "#64748b", alignSelf: "center" }}>Tagline</label>
                  <input
                    id="site-tagline"
                    type="text"
                    value={siteForm.tagline}
                    onChange={(e) => setSiteField("tagline", e.target.value)}
                    disabled={siteSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                </div>
              </div>

              {/* ── Brand colors ────────────────────────────────────── */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1d3557", marginBottom: 4 }}>Brand colors</div>
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "#64748b" }}>
                  The primary blue used on buttons, links, and the theme color
                  browsers show on the address bar. Strong is a visibly darker
                  variant used on hover/active states.
                </p>
                {([
                  ["brand_color", "Primary"],
                  ["brand_color_strong", "Primary (strong)"],
                  ["theme_color", "Theme (browser bar)"],
                ] as const).map(([key, label]) => (
                  <div key={key} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                    <label htmlFor={`site-${key}`} style={{ width: 160, fontSize: 13, color: "#64748b" }}>{label}</label>
                    <input
                      id={`site-${key}`}
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(siteForm[key]) ? siteForm[key] : "#2e7dd1"}
                      onChange={(e) => setSiteField(key, e.target.value)}
                      disabled={siteSubmitBusy}
                      style={{ width: 44, height: 30, padding: 0, border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, background: "white", cursor: "pointer" }}
                    />
                    <input
                      type="text"
                      value={siteForm[key]}
                      onChange={(e) => setSiteField(key, e.target.value)}
                      disabled={siteSubmitBusy}
                      placeholder="#2e7dd1"
                      style={{ width: 120, padding: "6px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 12, background: "white", fontFamily: "ui-monospace, Menlo, monospace" }}
                    />
                  </div>
                ))}
              </div>

              {/* ── Navigation labels ───────────────────────────────── */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1d3557", marginBottom: 4 }}>Top navigation</div>
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "#64748b" }}>
                  What visitors see in the header menu. Only labels are
                  editable — the underlying page each link goes to is fixed.
                </p>
                {siteForm.nav.map((n, idx) => (
                  <div key={n.key || `nav-${idx}`} style={{ display: "grid", gridTemplateColumns: "160px 1fr", columnGap: 12, rowGap: 4, fontSize: 12, marginBottom: 6, alignItems: "center" }}>
                    <div style={{ color: "#94a3b8", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 }}>{n.path}</div>
                    <input
                      type="text"
                      value={n.label}
                      onChange={(e) => {
                        const next = siteForm.nav.slice();
                        next[idx] = { ...next[idx], label: e.target.value };
                        setSiteField("nav", next);
                      }}
                      disabled={siteSubmitBusy}
                      style={{ padding: "6px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 12, background: "white" }}
                    />
                  </div>
                ))}
              </div>

              {/* ── Areas served ────────────────────────────────────── */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1d3557", marginBottom: 4 }}>Areas served</div>
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "#64748b" }}>
                  Cities and neighborhoods listed for local SEO. Add the
                  neighborhoods where families you serve typically live.
                </p>
                {siteForm.area_served.map((a, idx) => (
                  <div key={`area-${idx}`} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <select
                      value={a.type}
                      onChange={(e) => {
                        const next = siteForm.area_served.slice();
                        next[idx] = { ...next[idx], type: e.target.value };
                        setSiteField("area_served", next);
                      }}
                      disabled={siteSubmitBusy}
                      style={{ width: 140, padding: "6px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 12, background: "white" }}
                    >
                      <option value="City">City</option>
                      <option value="Neighborhood">Neighborhood</option>
                    </select>
                    <input
                      type="text"
                      value={a.name}
                      onChange={(e) => {
                        const next = siteForm.area_served.slice();
                        next[idx] = { ...next[idx], name: e.target.value };
                        setSiteField("area_served", next);
                      }}
                      disabled={siteSubmitBusy}
                      placeholder="e.g. Kitsilano, Vancouver"
                      style={{ flex: 1, padding: "6px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 12, background: "white" }}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        const next = siteForm.area_served.slice();
                        next.splice(idx, 1);
                        setSiteField("area_served", next);
                      }}
                      disabled={siteSubmitBusy}
                      style={{ fontSize: 11, padding: "4px 10px" }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn"
                  onClick={() => setSiteField("area_served", [
                    ...siteForm.area_served,
                    { type: "Neighborhood", name: "" },
                  ])}
                  disabled={siteSubmitBusy}
                  style={{ fontSize: 12, padding: "6px 14px" }}
                >
                  + Add area
                </button>
              </div>

              {/* ── Header/footer misc labels ───────────────────────── */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1d3557", marginBottom: 8 }}>Header &amp; footer labels</div>
                <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", columnGap: 12, rowGap: 10, fontSize: 13 }}>
                  <label htmlFor="site-hire" style={{ color: "#64748b", alignSelf: "center" }}>Careers button label</label>
                  <input
                    id="site-hire"
                    type="text"
                    value={siteForm.hire_label}
                    onChange={(e) => setSiteField("hire_label", e.target.value)}
                    disabled={siteSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                  <label htmlFor="site-sticky" style={{ color: "#64748b", alignSelf: "center" }}>Sticky call button</label>
                  <input
                    id="site-sticky"
                    type="text"
                    value={siteForm.sticky_call_label}
                    onChange={(e) => setSiteField("sticky_call_label", e.target.value)}
                    disabled={siteSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                  <label htmlFor="site-copy" style={{ color: "#64748b", alignSelf: "center" }}>Footer © holder</label>
                  <input
                    id="site-copy"
                    type="text"
                    value={siteForm.footer_copyright_holder}
                    onChange={(e) => setSiteField("footer_copyright_holder", e.target.value)}
                    disabled={siteSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                  <label htmlFor="site-rights" style={{ color: "#64748b", alignSelf: "center" }}>Footer rights text</label>
                  <input
                    id="site-rights"
                    type="text"
                    value={siteForm.footer_rights}
                    onChange={(e) => setSiteField("footer_rights", e.target.value)}
                    disabled={siteSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                  <label htmlFor="site-flabel" style={{ color: "#64748b", alignSelf: "center" }}>Footer Contact link label</label>
                  <input
                    id="site-flabel"
                    type="text"
                    value={siteForm.footer_contact_link_label}
                    onChange={(e) => setSiteField("footer_contact_link_label", e.target.value)}
                    disabled={siteSubmitBusy}
                    style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                  />
                </div>
              </div>

              {siteErr && (
                <div style={{ marginTop: 12, padding: 10, background: "#fee2e2", color: "#7f1d1d", borderRadius: 6, fontSize: 12 }}>
                  {siteErr}
                </div>
              )}
              {siteMsg && (
                <div style={{ marginTop: 12, padding: 10, background: "#dcfce7", color: "#166534", borderRadius: 6, fontSize: 12 }}>
                  {siteMsg}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center" }}>
                <button
                  className="btn"
                  onClick={submitSiteForm}
                  disabled={siteSubmitBusy || !siteDirty || !siteForm.name.trim()}
                  style={{ background: "#1d5fa3", color: "white", fontSize: 13, padding: "8px 18px" }}
                >
                  {siteSubmitBusy ? "Saving…" : "Submit"}
                </button>
                <button
                  className="btn"
                  onClick={() => guardedNav(`/website/preview?page=home`)}
                  disabled={siteSubmitBusy}
                  style={{ fontSize: 13, padding: "8px 18px" }}
                >
                  Preview →
                </button>
              </div>
              <p style={{ margin: "14px 0 0", fontSize: 12, color: "#94a3b8" }}>
                Address, phone, email and Facebook are edited on the Contact
                page (they're shared everywhere). For anything else the form
                doesn't cover, use the AI prompt below.
              </p>
            </div>
          )}
          {file === "gallery-videos" && (
            <div
              style={{
                border: "1px solid rgba(0,0,0,0.1)",
                background: "white",
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <b style={{ fontSize: 14, color: "#1d3557" }}>Edit the Gallery videos section</b>
              <p style={{ margin: "4px 0 14px", fontSize: 12, color: "#64748b" }}>
                Heading and short intro shown above the video playlist on the
                Gallery page. To upload, reorder, or delete the actual videos,
                use the <b>Manage videos</b> screen linked below.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", columnGap: 12, rowGap: 10, fontSize: 13 }}>
                <label htmlFor="gv-heading" style={{ color: "#64748b", alignSelf: "center" }}>Section heading</label>
                <input
                  id="gv-heading"
                  type="text"
                  value={galleryVideosForm.heading}
                  onChange={(e) => setGalleryVideosForm((p) => ({ ...p, heading: e.target.value }))}
                  disabled={galleryVideosSubmitBusy}
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
                <label htmlFor="gv-intro" style={{ color: "#64748b", alignSelf: "start", paddingTop: 8 }}>Short intro</label>
                <textarea
                  id="gv-intro"
                  value={galleryVideosForm.intro}
                  onChange={(e) => setGalleryVideosForm((p) => ({ ...p, intro: e.target.value }))}
                  disabled={galleryVideosSubmitBusy}
                  rows={3}
                  placeholder="Optional — 1–2 lines shown under the heading."
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white", fontFamily: "inherit", resize: "vertical" }}
                />
              </div>

              {galleryVideosErr && (
                <div style={{ marginTop: 12, padding: 10, background: "#fee2e2", color: "#7f1d1d", borderRadius: 6, fontSize: 12 }}>
                  {galleryVideosErr}
                </div>
              )}
              {galleryVideosMsg && (
                <div style={{ marginTop: 12, padding: 10, background: "#dcfce7", color: "#166534", borderRadius: 6, fontSize: 12 }}>
                  {galleryVideosMsg}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  className="btn"
                  onClick={submitGalleryVideosForm}
                  disabled={galleryVideosSubmitBusy || !galleryVideosDirty}
                  style={{ background: "#1d5fa3", color: "white", fontSize: 13, padding: "8px 18px" }}
                >
                  {galleryVideosSubmitBusy ? "Saving…" : "Submit"}
                </button>
                <button
                  className="btn"
                  onClick={() => guardedNav(`/website/preview?page=gallery-videos`)}
                  disabled={galleryVideosSubmitBusy}
                  style={{ fontSize: 13, padding: "8px 18px" }}
                >
                  Preview →
                </button>
                <button
                  className="btn"
                  onClick={() => guardedNav("/website/gallery-videos")}
                  style={{ fontSize: 13, padding: "8px 18px", marginLeft: "auto" }}
                >
                  🎬 Manage videos →
                </button>
              </div>
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
                <label htmlFor="contact-phone" style={{ color: "#64748b", alignSelf: "center" }}>Phone</label>
                <input
                  id="contact-phone"
                  type="tel"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  disabled={contactSubmitBusy || !siteContent}
                  placeholder="+1 604-874-4010"
                  style={{ padding: "8px 10px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, fontSize: 13, background: "white" }}
                />
                <label htmlFor="contact-email" style={{ color: "#64748b", alignSelf: "center" }}>Email</label>
                <input
                  id="contact-email"
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  disabled={contactSubmitBusy || !siteContent}
                  placeholder="hello@echelondaycare.com"
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
                  onClick={() => guardedNav(`/website/preview?page=contact`)}
                  disabled={contactSubmitBusy}
                  style={{ fontSize: 13, padding: "8px 18px" }}
                >
                  Preview →
                </button>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>
                  Address updates map + iframe title. Phone / email / Facebook
                  are site-wide (footer + header + JSON-LD).
                </span>
              </div>
              <p style={{ margin: "14px 0 0", fontSize: 12, color: "#94a3b8" }}>
                For anything not shown here (map aria label, socials other than
                Facebook, layout tweaks), use the AI prompt below.
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
                onClick={() => guardedNav("/website/tour-videos")}
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
                <>
                  <button
                    className="btn"
                    onClick={onAiAccept}
                    style={{
                      marginLeft: "auto",
                      background: "#059669",
                      color: "white",
                      fontSize: 14,
                      padding: "8px 20px",
                    }}
                    title="Save the AI proposal as a draft revision"
                  >
                    Accept & save draft
                  </button>
                  <button
                    className="btn"
                    onClick={onAiDiscard}
                    style={{ fontSize: 14, padding: "8px 20px" }}
                    title="Discard this proposal — working copy is unchanged"
                  >
                    Reject
                  </button>
                </>
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
            {saved && !aiProposed && !aiErr && (
              <div
                style={{
                  marginTop: 14,
                  padding: "10px 14px",
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: 8,
                  color: "#166534",
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span style={{ fontSize: 16 }}>✓</span>
                <div>
                  <b>{saved}</b>
                  <div style={{ marginTop: 4, color: "#166534" }}>
                    Nothing is live yet. Click <b>Preview →</b> at the top-right
                    to see how it looks, then open <b>Publish…</b> in the
                    sidebar to send it to your live website.
                  </div>
                </div>
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
                  <span style={{ color: "#059669", fontSize: 16 }}>✎</span>
                  <b style={{ fontSize: 14 }}>Proposed change (not yet saved)</b>
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
            <button className="btn" onClick={() => guardedNav("/website/preview")}>
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
      {revertConfirmOpen && (
        <RevertModal
          fileLabel={FILE_LABELS[file]}
          lastPushedRev={lastPushedRev}
          busy={revertBusy}
          onCancel={() => setRevertConfirmOpen(false)}
          onConfirm={doRevertToPublished}
        />
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

// Revert-to-published modal, extracted so we can hook focus
// management: on open, capture the previously-focused element,
// autofocus Cancel, trap Tab within the two buttons, close on Esc,
// and restore focus to the trigger on unmount. Prior version was
// keyboard-inaccessible (Tab escaped to the underlying page, Esc did
// nothing) which failed WCAG 2.1.2/2.4.3.
function RevertModal({
  fileLabel,
  lastPushedRev,
  busy,
  onCancel,
  onConfirm,
}: {
  fileLabel: string;
  lastPushedRev: number | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocusRef.current = (document.activeElement as HTMLElement) || null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Tab") {
        const first = cancelRef.current;
        const last = confirmRef.current;
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      returnFocusRef.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  return (
    <div
      onClick={() => !busy && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="revert-modal-heading"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 14,
          maxWidth: 460,
          width: "100%",
          padding: 24,
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ fontSize: 30, marginBottom: 8 }}>↺</div>
        <h2 id="revert-modal-heading" style={{ margin: "0 0 8px", fontSize: 20, color: "#0f172a" }}>
          Revert to last published?
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 14, color: "#475569", lineHeight: 1.55 }}>
          This will discard your current <b>{fileLabel}</b> draft
          and restore the version that's currently live on the site
          (revision #{lastPushedRev}).
          <br />
          <br />
          Your draft will still be available in <b>Version history</b> if
          you change your mind.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            ref={cancelRef}
            className="btn"
            onClick={onCancel}
            disabled={busy}
            style={{ fontSize: 13, padding: "8px 16px" }}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            className="btn"
            onClick={onConfirm}
            disabled={busy}
            style={{ fontSize: 13, padding: "8px 16px", background: "#dc2626", color: "white" }}
          >
            {busy ? "Reverting…" : "Yes, revert"}
          </button>
        </div>
      </div>
    </div>
  );
}