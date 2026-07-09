import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getSettings, listStudents, listYears } from "../../lib/db";
import type { Student, SettingsMap } from "../../types";
import {
  listTemplates, resolveRecipients, sendGroupEmail, fileToAttachment,
  renderCommsTemplate, buildMergeContext,
  type MessageTemplate, type CommAttachment, type RecipientFilter, type GroupSendProgress,
} from "../../lib/comms";
import { parseRecipients } from "../../lib/email";
import { showAlert, showConfirm } from "../../lib/dialogs";

type Mode = "all_active" | "year" | "students" | "adhoc";

type AdhocRecipient = { name: string; email: string; label?: string };

export default function Compose() {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [mode, setMode] = useState<Mode>("all_active");
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<CommAttachment[]>([]);
  const [bccSelf, setBccSelf] = useState(true);
  const [adhoc, setAdhoc] = useState<AdhocRecipient[]>([]);

  const [searchParams, setSearchParams] = useSearchParams();

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<GroupSendProgress[]>([]);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    (async () => {
      const [s, t, ys] = await Promise.all([getSettings(), listTemplates(), listYears()]);
      setSettings(s);
      setTemplates(t);
      setYears(ys.length ? ys : [new Date().getFullYear()]);
      if (ys.length) setYear(ys[0]);
      setBccSelf(s.bcc_self === "1");
    })();
  }, []);

  // Ad-hoc entry: /communications/compose?to=<email>&name=<parent>&child=<childName>&subject=...
  // Used by the Waitlist detail drawer so a message to a not-yet-a-Student
  // parent still flows through Comms and gets logged in Message History.
  useEffect(() => {
    const to = searchParams.get("to");
    if (!to) return;
    const name = searchParams.get("name") || "";
    const child = searchParams.get("child") || "";
    const subj = searchParams.get("subject") || (child ? `Regarding ${child}'s waitlist application` : "");
    setMode("adhoc");
    setAdhoc([{ name: name || "Parent", email: to, label: child || name || "Recipient" }]);
    if (subj) setSubject(subj);
    // Clear the params so a refresh doesn't re-trigger.
    const nx = new URLSearchParams(searchParams);
    ["to", "name", "child", "subject"].forEach((k) => nx.delete(k));
    setSearchParams(nx, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Preserve "students" mode selection when the user tabs to another mode
  // and back (e.g. flips to "year" to check a count, then returns). Keyed
  // by year because rosters differ by year. Only relevant to "students"
  // mode; other modes derive their recipient list from filters.
  const savedSelections = useRef<Map<number, Set<number>>>(new Map());
  const prevKey = useRef<string>("");

  useEffect(() => {
    (async () => {
      const list = mode === "all_active"
        ? await listStudents(undefined, true)
        : await listStudents(year, false);
      setStudents(list);
    })();
    const key = `${mode}|${year}`;
    // Stash the outgoing "students|<year>" selection before we swap it out.
    if (prevKey.current.startsWith("students|")) {
      const prevYear = parseInt(prevKey.current.split("|")[1] ?? "0", 10);
      if (selectedIds.size > 0) savedSelections.current.set(prevYear, new Set(selectedIds));
      else savedSelections.current.delete(prevYear);
    }
    prevKey.current = key;
    // Restore prior selection for this (students, year) pair; otherwise empty.
    if (mode === "students") {
      setSelectedIds(new Set(savedSelections.current.get(year) ?? []));
    } else {
      setSelectedIds(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, year]);

  const filteredStudents = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) => s.name.toLowerCase().includes(q));
  }, [students, search]);

  const filter: RecipientFilter = useMemo(() => {
    if (mode === "all_active") return { mode: "all_active" };
    if (mode === "year") return { mode: "year", year };
    if (mode === "adhoc") return { mode: "adhoc", recipients: adhoc };
    return { mode: "students", studentIds: Array.from(selectedIds) };
  }, [mode, year, selectedIds, adhoc]);

  const [recipientCount, setRecipientCount] = useState<{ withEmail: number; total: number }>({ withEmail: 0, total: 0 });
  useEffect(() => {
    // Guard against stale-response races: if the deps change (mode /
    // filter / adhoc) while the previous resolveRecipients call is still
    // in flight, the stale reply must not overwrite fresh state.
    let cancelled = false;
    (async () => {
      const resolved = await resolveRecipients(filter);
      let total = 0;
      if (mode === "all_active") total = (await listStudents(undefined, true)).length;
      else if (mode === "year") total = students.length;
      else if (mode === "adhoc") total = adhoc.length;
      else total = selectedIds.size;
      if (cancelled) return;
      setRecipientCount({ withEmail: resolved.length, total });
    })();
    return () => { cancelled = true; };
  }, [filter, mode, year, students.length, selectedIds, adhoc]);

  function useTemplate(tId: string) {
    if (!tId) return;
    const t = templates.find((x) => x.id === Number(tId));
    if (!t) return;
    setSubject(t.subject);
    setBody(t.body);
  }

  async function onAddFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    const parts = await Promise.all(files.map(fileToAttachment));
    setAttachments((prev) => [...prev, ...parts]);
    e.target.value = "";
  }

  const previewCtx = useMemo(() => {
    const first = filteredStudents.find((s) => parseRecipients(s.email).length > 0) || filteredStudents[0];
    if (!first) return null;
    return buildMergeContext(
      { student: first, parentName: [first.father_name, first.mother_name].filter(Boolean).join(" & ") || "Parent", emails: parseRecipients(first.email) },
      settings,
    );
  }, [filteredStudents, settings]);

  async function onSend() {
    if (!subject.trim() || !body.trim()) { await showAlert("Enter a subject and body first.", { kind: "warning" }); return; }
    if (recipientCount.withEmail === 0) { await showAlert("No matching students have an email address on file.", { kind: "warning" }); return; }
    const ok = await showConfirm(`Send this email to ${recipientCount.withEmail} recipient${recipientCount.withEmail === 1 ? "" : "s"}?`);
    if (!ok) return;
    setBusy(true);
    setProgress([]);
    try {
      const recipients = await resolveRecipients(filter);
      const s = { ...settings, bcc_self: bccSelf ? "1" : "0" };
      const res = await sendGroupEmail({
        subject, body, recipients, attachments,
        settings: s,
        onProgress: (p) => setProgress((prev) => [...prev, p]),
      });
      if (res.failed === 0) await showAlert(`Sent to ${res.sent} recipient${res.sent === 1 ? "" : "s"}.`);
      else await showAlert(`Sent to ${res.sent}. Failed: ${res.failed}. See Message History for details.`, { kind: "warning" });
    } catch (e: any) {
      await showAlert(`Send failed: ${e?.message || e}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const toggleId = (id: number) => setSelectedIds((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <h1 style={{ marginTop: 0 }}>Compose Group Email</h1>
      <p style={{ color: "var(--muted)", marginTop: -8 }}>
        Personalized email — each parent gets their own copy with merge fields filled in. Only students with a valid email address receive it.
      </p>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ fontWeight: 600 }}>Send to:</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="all_active">All active parents</option>
            <option value="year">Roster year…</option>
            <option value="students">Selected students…</option>
            {adhoc.length > 0 && <option value="adhoc">Ad-hoc recipient(s)</option>}
          </select>
          {mode === "year" && (
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          )}
          <div style={{ marginLeft: "auto", color: "var(--muted)" }}>
            {recipientCount.withEmail} of {recipientCount.total} have email on file
          </div>
        </div>

        {mode === "adhoc" && (
          <div style={{ marginTop: 12, padding: 10, background: "rgba(37,99,235,.08)", borderRadius: 6, border: "1px solid rgba(37,99,235,.25)" }}>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
              Sending to individual recipient{adhoc.length === 1 ? "" : "s"} (not from the student roster). Message will still be logged in Message History.
            </div>
            {adhoc.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
                <b style={{ minWidth: 140 }}>{r.name}</b>
                <span style={{ color: "var(--muted)" }}>{r.email}</span>
                {r.label && <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)" }}>Re: {r.label}</span>}
              </div>
            ))}
          </div>
        )}

        {mode === "students" && (
          <div style={{ marginTop: 12 }}>
            <input
              type="search"
              placeholder="Search students…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: "100%", padding: 8, marginBottom: 8 }}
            />
            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
              {filteredStudents.map((s) => {
                const hasEmail = parseRecipients(s.email).length > 0;
                return (
                  <label key={s.id} style={{ display: "flex", gap: 8, padding: 4, opacity: hasEmail ? 1 : 0.5 }}>
                    <input
                      type="checkbox"
                      disabled={!hasEmail}
                      checked={selectedIds.has(s.id)}
                      onChange={() => toggleId(s.id)}
                    />
                    <span style={{ flex: 1 }}>{s.name}</span>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>
                      {hasEmail ? s.email : "no email"}
                    </span>
                  </label>
                );
              })}
              {filteredStudents.length === 0 && <div style={{ color: "var(--muted)", padding: 8 }}>No students match.</div>}
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
              <button className="btn secondary" onClick={() => setSelectedIds(new Set(filteredStudents.filter((s) => parseRecipients(s.email).length > 0).map((s) => s.id)))}>Select all visible</button>
              <button className="btn secondary" onClick={() => setSelectedIds(new Set())}>Clear</button>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <label style={{ fontWeight: 600 }}>Template:</label>
          <select onChange={(e) => useTemplate(e.target.value)} defaultValue="">
            <option value="">— none —</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.is_builtin ? " (built-in)" : ""}</option>)}
          </select>
          <div style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>
            Tokens: {"{{parent_name}} {{student_name}} {{daycare_name}} {{contact_email}} {{contact_phone}} {{month}} {{year}} {{date}}"}
          </div>
        </div>
        <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 12 }} placeholder="Reminder about pickup — {{student_name}}" />
        <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Body</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} style={{ width: "100%", padding: 8, fontFamily: "inherit" }} placeholder={"Hi {{parent_name}},\n\nA quick note about {{student_name}}...\n\nThank you,\n{{daycare_name}}"} />
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <strong>Attachments</strong>
          <label className="btn secondary" style={{ cursor: "pointer" }}>
            + Add file
            <input type="file" multiple hidden onChange={onAddFile} />
          </label>
        </div>
        {attachments.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>No attachments. Attachments are sent with every recipient's email.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {attachments.map((a, i) => (
              <li key={i} style={{ display: "flex", justifyContent: "space-between", padding: 4 }}>
                <span>{a.filename}</span>
                <button className="btn link danger" onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 24 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={bccSelf} onChange={(e) => setBccSelf(e.target.checked)} />
          BCC myself
        </label>
        <button className="btn secondary" onClick={() => setShowPreview(true)} disabled={!previewCtx || !subject || !body}>Preview</button>
        <button className="btn" onClick={onSend} disabled={busy || recipientCount.withEmail === 0}>
          {busy ? `Sending ${progress.length}/${recipientCount.withEmail}…` : `Send to ${recipientCount.withEmail}`}
        </button>
      </div>

      {progress.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <strong>Send progress</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, maxHeight: 200, overflowY: "auto", fontSize: 13 }}>
            {progress.map((p, i) => (
              <li key={i} style={{ color: p.ok ? "inherit" : "var(--danger)" }}>
                {p.ok ? "✓" : "✗"} {p.student} — {p.recipient}{p.error ? ` (${p.error})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showPreview && previewCtx && (
        <div onClick={() => setShowPreview(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", padding: 24, borderRadius: 8, maxWidth: 640, width: "90%", maxHeight: "80vh", overflow: "auto" }}>
            <h2 style={{ marginTop: 0 }}>Preview (first recipient)</h2>
            <div style={{ marginBottom: 8, color: "var(--muted)", fontSize: 12 }}>Subject:</div>
            <div style={{ marginBottom: 12, fontWeight: 600 }}>{renderCommsTemplate(subject, previewCtx)}</div>
            <div style={{ marginBottom: 8, color: "var(--muted)", fontSize: 12 }}>Body:</div>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", background: "#f8fafc", padding: 12, borderRadius: 6 }}>{renderCommsTemplate(body, previewCtx)}</pre>
            <div style={{ textAlign: "right", marginTop: 12 }}>
              <button className="btn" onClick={() => setShowPreview(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
