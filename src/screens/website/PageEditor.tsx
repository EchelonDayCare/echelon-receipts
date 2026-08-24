import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  websiteAiEditContent,
  websiteCheckDraftStaleness,
  websiteLoadContent,
  websiteSaveDraft,
  websiteReplaceAboutPhoto,
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

  // Warn on browser close / refresh with unsaved edits. In Tauri the
  // window-close still fires `beforeunload`, so this catches ⌘Q as
  // well as the sidebar Cmd-click that swaps pages.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Block react-router navigation (sidebar clicks, back/preview/history
  // buttons) while there are unsaved edits. We can't use `useBlocker`
  // here because the app mounts a non-data `HashRouter`; instead we
  // intercept anchor clicks in the capture phase and confirm with the
  // user before allowing the hash to change.
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      if (!dirtyRef.current) return;
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

  // AI edit state — only rendered when the current page supports it.
  const AI_EDIT_PAGES: EditableFile[] = ["about", "careers", "tour", "contact"];
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
    setAboutErr(null);
    setAboutMsg(null);
    const picked = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "heic", "webp", "avif"] }],
    });
    if (!picked || typeof picked !== "string") return;
    setPhotoBusySlot(slot);
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
            onClick={() => nav(`/website/history?file=${file}`)}
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
                  onClick={() => nav(`/website/preview?page=about`)}
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
                  onClick={() => nav(`/website/preview?page=contact`)}
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
