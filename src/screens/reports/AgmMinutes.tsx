// AGM Minutes editor — form on the left, live preview on the right.
// Preview mirrors the .docx output so what you see is what you get in Word.

import { useEffect, useMemo, useRef, useState } from "react";
import { writeFile, exists } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { showAlert, showConfirm } from "../../lib/dialogs";
import { getSettings } from "../../lib/db";
import { logError } from "../../lib/errorLog";
import {
  AgmMinutes, ChairmanBlock, buildInitialDraft, saveDraft,
  generateDocxBlob, listDraftYears, shortYearLabel,
} from "../../lib/agmMinutes";
import { currentFiscalYear } from "../../lib/fiscalYear";
import { resolveReportPath, NoReportsFolderError } from "../../lib/reportsFolder";
import {
  gatherYearContext, draftEntireMinutes,
  draftFinancialReport, draftStaffingChallenges, draftFacilitiesMaintenance,
  draftChairmanBlock, isChairmanHeadingGrounded,
} from "../../lib/aiDraft";

const RECENT_FY_SPAN = 6;   // show current FY + 5 back in the year picker

export default function AgmMinutesEditor({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const [fyStart, setFyStart] = useState<number>(currentFiscalYear());
  const [minutes, setMinutes] = useState<AgmMinutes | null>(null);
  const [savedYears, setSavedYears] = useState<Array<{ year_label: string; updated_at: string; finalized_at: string | null }>>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);   // section id being drafted, or "all"
  // Bounded stack of pre-AI snapshots so Undo unwinds each AI action.
  const [aiHistory, setAiHistory] = useState<AgmMinutes[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiRedact, setAiRedact] = useState(true);

  // Refs used to make in-flight AI work safe against year switches, unmounts and cancellations.
  const initialRef = useRef<AgmMinutes | null>(null);   // snapshot from buildInitialDraft — used to detect user edits
  const fyStartRef = useRef<number>(fyStart);
  const aiEpochRef = useRef<number>(0);
  const aiAbortRef = useRef<AbortController | null>(null);
  const dirtyRef = useRef(dirty);
  useEffect(() => { fyStartRef.current = fyStart; }, [fyStart]);
  useEffect(() => { dirtyRef.current = dirty; onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // Unsaved-work guard — Tauri v2 uses onCloseRequested (beforeunload does not
  // fire reliably in the webview). Prompts the user before losing edits.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
          if (!dirtyRef.current) return;
          const ok = await showConfirm(
            "You have unsaved AGM Minutes edits. Close anyway and discard them?"
          );
          if (!ok) event.preventDefault();
        });
      } catch (e: any) {
        void logError("WARN", `[AgmMinutes onCloseRequested] ${e?.message || e}`);
      }
    })();
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, []);

  // Load AI opt-in setting.
  useEffect(() => {
    (async () => {
      try {
        const s = await getSettings();
        setAiEnabled(s.agm_ai_enabled === "1" && s.azure_ai_key_set === "1");
        setAiRedact(s.agm_ai_redact !== "0");   // default ON
      } catch (e: any) {
        void logError("WARN", `[AgmMinutes getSettings] ${e?.message || e}`);
      }
    })();
  }, []);

  async function refreshList() {
    try { setSavedYears(await listDraftYears()); }
    catch (e: any) { void logError("WARN", `[AgmMinutes.refreshList] ${e?.message || e}`); }
  }

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    // Abort any in-flight AI request from the previous year so its response
    // cannot land in the newly-selected year's state.
    if (aiAbortRef.current) { aiAbortRef.current.abort(); aiAbortRef.current = null; }
    aiEpochRef.current++;
    setAiBusy(null);
    setAiHistory([]);
    (async () => {
      const m = await buildInitialDraft(fyStart);
      if (!cancelled) {
        setMinutes(m);
        initialRef.current = m;
        setDirty(false);
      }
    })().finally(() => { if (!cancelled) setBusy(false); });
    refreshList();
    return () => {
      cancelled = true;
      // On unmount / year change: cancel outstanding fetches.
      if (aiAbortRef.current) { aiAbortRef.current.abort(); aiAbortRef.current = null; }
      aiEpochRef.current++;
    };
  }, [fyStart]);

  function patch(partial: Partial<AgmMinutes>) {
    // Functional setState avoids stale-closure bugs when AI callbacks resolve
    // interleaved with rapid user typing.
    setMinutes((prev) => (prev ? { ...prev, ...partial } : prev));
    setDirty(true);
  }

  async function onSave() {
    if (!minutes) return;
    setBusy(true);
    try {
      await saveDraft(minutes);
      setDirty(false);
      setAiHistory([]);
      await refreshList();
      await showAlert("Draft saved.");
    } catch (e: any) {
      await showAlert("Save failed: " + (e?.message || e), { kind: "error" });
    } finally { setBusy(false); }
  }

  async function onReset() {
    if (dirty && !(await showConfirm("Discard unsaved edits and reload from prior year?"))) return;
    setBusy(true);
    try {
      const m = await buildInitialDraft(fyStart, { forceFresh: true });
      setMinutes(m); setDirty(false); setAiHistory([]);
    } finally { setBusy(false); }
  }

  async function onGenerate() {
    if (!minutes) return;
    // Derive filename from the trusted `fyStart` selector, not the JSON
    // payload — defends against a tampered restore whose yearLabel string
    // contains path characters.
    const filename = `AGM-${shortYearLabel(fyStart)}.docx`;
    let dest: string;
    try {
      dest = await resolveReportPath("agmMinutes", filename);
    } catch (e: any) {
      if (e instanceof NoReportsFolderError) {
        await showAlert("Pick a Reports folder in Settings first, then try again.", { kind: "warning" });
      } else {
        await showAlert("Could not resolve report path: " + (e?.message || e), { kind: "error" });
      }
      return;
    }

    // Soft-confirm before overwriting an existing docx.
    try {
      if (await exists(dest)) {
        const ok = await showConfirm(
          `A file already exists at:\n${dest}\n\nOverwrite it with the current draft?`
        );
        if (!ok) return;
      }
    } catch (e: any) {
      void logError("WARN", `[AgmMinutes exists check] ${e?.message || e}`);
    }

    setBusy(true);
    let wroteOk = false;
    try {
      // Generate + write BEFORE marking finalized in the DB, so a failed
      // write doesn't leave the draft flagged as exported.
      const blob = await generateDocxBlob(minutes);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await writeFile(dest, bytes);
      wroteOk = true;
      await saveDraft(minutes, /* finalized */ true);
      setDirty(false);
      setAiHistory([]);
      await refreshList();
      await showAlert(`✅ Document generated at:\n${dest}`);
    } catch (e: any) {
      if (!wroteOk) {
        // Still persist the current edits as an in-progress draft so nothing is lost.
        try { await saveDraft(minutes, /* finalized */ false); setDirty(false); await refreshList(); }
        catch (e2: any) { void logError("WARN", `[AgmMinutes onGenerate fallback save] ${e2?.message || e2}`); }
      }
      void logError("ERROR", `[AgmMinutes onGenerate] ${e?.message || e}`);
      await showAlert("Generate failed: " + (e?.message || e), { kind: "error" });
    } finally { setBusy(false); }
  }

  // ---------- AI drafting ----------
  /** Prepare epoch/abort for a new AI operation. Returns the captured epoch + fyStart + signal. */
  function beginAi(): { epoch: number; fy: number; signal: AbortSignal } {
    if (aiAbortRef.current) aiAbortRef.current.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    aiEpochRef.current++;
    return { epoch: aiEpochRef.current, fy: fyStartRef.current, signal: controller.signal };
  }
  /** Guard: only apply an AI result if we're still on the same year and the same op. */
  function aiStillValid(epoch: number, fy: number): boolean {
    return aiEpochRef.current === epoch && fyStartRef.current === fy;
  }
  function onCancelAi() {
    if (aiAbortRef.current) aiAbortRef.current.abort();
  }

  // Bounded stack of pre-AI snapshots. Every AI action pushes the current
  // draft onto the stack (up to `UNDO_LIMIT` entries), Undo pops the top.
  const UNDO_LIMIT = 10;
  function pushHistory(snap: AgmMinutes) {
    setAiHistory((prev) => {
      const next = [...prev, snap];
      return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next;
    });
  }

  async function onDraftAll() {
    if (!minutes) return;
    const ok = await showConfirm(
      "Draft the whole document with AI?\n\n" +
      "Only sections you have not already filled in (Financial Report, Staffing " +
      "Challenges, Facilities Maintenance, and empty Chairman's Report sub-sections) " +
      "will be replaced with AI-drafted prose based on this year's data. " +
      "Anything you have typed manually is preserved. Sections without on-device " +
      "data (e.g. SCD Funding, Snack and Meal, Licensing) are skipped — the AI " +
      "will not invent content for them."
    );
    if (!ok) return;
    const { epoch, fy, signal } = beginAi();
    setAiBusy("all");
    pushHistory(minutes);
    try {
      const ctx = await gatherYearContext(fy, { redact: aiRedact });
      const next = await draftEntireMinutes(minutes, ctx, { signal, initial: initialRef.current ?? undefined });
      if (!aiStillValid(epoch, fy)) return;
      setMinutes(next);
      setDirty(true);
    } catch (e: any) {
      if ((e?.name === "AbortError") || signal.aborted) return;   // user cancelled or year switched
      await showAlert("AI draft failed: " + (e?.message || e), { kind: "error" });
    } finally {
      if (aiStillValid(epoch, fy)) setAiBusy(null);
    }
  }

  function onUndoAi() {
    setAiHistory((prev) => {
      if (prev.length === 0) return prev;
      const restored = prev[prev.length - 1];
      setMinutes(restored);
      setDirty(true);
      return prev.slice(0, -1);
    });
  }

  async function draftField(
    id: string,
    fetcher: (signal: AbortSignal) => Promise<string>,
    assign: (text: string) => void,
  ) {
    if (!minutes) return;
    const { epoch, fy, signal } = beginAi();
    setAiBusy(id);
    pushHistory(minutes);
    try {
      const text = await fetcher(signal);
      if (!aiStillValid(epoch, fy)) return;
      assign(text);
      setDirty(true);
    } catch (e: any) {
      if ((e?.name === "AbortError") || signal.aborted) return;
      // Ungrounded sections and insufficient-data errors show a friendly
      // message rather than a generic "AI draft failed" — they are expected
      // outcomes, not bugs.
      const isFriendly = e?.name === "UngroundedSectionError" || e?.name === "InsufficientDataError";
      await showAlert(e?.message || String(e), { kind: isFriendly ? "warning" : "error" });
    } finally {
      if (aiStillValid(epoch, fy)) setAiBusy(null);
    }
  }

  // ---------- Year picker options ----------
  const yearOptions = useMemo(() => {
    const now = currentFiscalYear();
    const set = new Set<number>();
    for (let y = now; y >= now - RECENT_FY_SPAN; y--) set.add(y);
    savedYears.forEach((s) => {
      const parsed = parseInt(s.year_label.slice(0, 4), 10);
      if (!isNaN(parsed)) set.add(parsed);
    });
    return Array.from(set).sort((a, b) => b - a);
  }, [savedYears]);

  return (
    <div style={{ padding: 24, maxWidth: 1400 }}>
      {/* ---------- Toolbar ---------- */}
      <div className="no-print" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ marginTop: 0, marginBottom: 4 }}>AGM Minutes</h1>
          <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>
            Draft this year's Annual General Meeting minutes and export a Word document that matches the Society's format.
            Starts from last year's draft — edit only what's changed.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            Year:
            <select value={fyStart} onChange={(e) => setFyStart(parseInt(e.target.value, 10))} disabled={busy || !!aiBusy}>
              {yearOptions.map((y) => {
                const yl = shortYearLabel(y);
                const saved = savedYears.find((s) => s.year_label === yl);
                const suffix = saved ? (saved.finalized_at ? " ✓ exported" : " · draft") : "";
                return <option key={y} value={y}>AGM {yl}{suffix}</option>;
              })}
            </select>
          </label>
          <button className="btn secondary" onClick={onReset} disabled={busy || !!aiBusy}>Reset from prior year</button>
          <button className="btn secondary" onClick={onSave} disabled={busy || !!aiBusy || !dirty}>
            {dirty ? "Save Draft" : "Saved"}
          </button>
          {aiEnabled && (
            <button className="btn secondary" onClick={onDraftAll} disabled={busy || !!aiBusy || !minutes}
                    title="Draft empty sections and free-text bodies with AI using this year's data.">
              {aiBusy === "all" ? "✨ Drafting…" : "✨ Draft with AI"}
            </button>
          )}
          {aiBusy && (
            <button className="btn ghost" onClick={onCancelAi} title="Cancel the in-progress AI draft.">
              ✕ Cancel AI
            </button>
          )}
          {aiHistory.length > 0 && !aiBusy && (
            <button className="btn ghost" onClick={onUndoAi} title="Restore the text before the last AI draft.">
              ↶ Undo AI ({aiHistory.length})
            </button>
          )}
          <button className="btn" onClick={onGenerate} disabled={busy || !!aiBusy || !minutes}>
            📄 Generate
          </button>
        </div>
      </div>

      {!minutes ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Loading…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 20 }}>
          <FormPane minutes={minutes} patch={patch}
                    fyStart={fyStart}
                    aiBusy={aiBusy}
                    aiEnabled={aiEnabled}
                    aiRedact={aiRedact}
                    draftField={draftField} />
          <PreviewPane minutes={minutes} />
        </div>
      )}
    </div>
  );
}

// ============================================================================
//                                   FORM
// ============================================================================

interface FormProps {
  minutes: AgmMinutes;
  patch: (p: Partial<AgmMinutes>) => void;
  fyStart: number;
  aiBusy: string | null;
  aiEnabled: boolean;
  aiRedact: boolean;
  draftField: (id: string, fetcher: (signal: AbortSignal) => Promise<string>, assign: (text: string) => void) => Promise<void>;
}

function FormPane({ minutes, patch, fyStart, aiBusy, aiEnabled, aiRedact, draftField }: FormProps) {
  async function aiFin() {
    await draftField("fin",
      async (signal) => draftFinancialReport(await gatherYearContext(fyStart, { redact: aiRedact }), signal),
      (text) => patch({ financialReportBody: text }));
  }
  async function aiStaffing() {
    await draftField("staffing",
      async (signal) => draftStaffingChallenges(await gatherYearContext(fyStart, { redact: aiRedact }), signal),
      (text) => patch({ staffingChallenges: text }));
  }
  async function aiFacilities() {
    await draftField("facilities",
      async (signal) => draftFacilitiesMaintenance(await gatherYearContext(fyStart, { redact: aiRedact }), signal),
      (text) => patch({ facilitiesMaintenance: text }));
  }
  async function aiChairman() {
    await draftField("chairman", async (signal) => {
      const ctx = await gatherYearContext(fyStart, { redact: aiRedact });
      const filled: ChairmanBlock[] = [];
      for (const b of minutes.chairmanReport) {
        const isList = Array.isArray(b.body);
        const isEmpty = isList ? (b.body as string[]).length === 0 : ((b.body as string).trim() === "");
        if (!isEmpty) { filled.push(b); continue; }
        try {
          const body = await draftChairmanBlock(b.heading, ctx, isList, signal);
          filled.push({ heading: b.heading, body });
        } catch (e) {
          if ((e as any)?.name === "AbortError" || signal.aborted) throw e;
          // Ungrounded chairman blocks are silently skipped — the user sees the
          // block still empty and can type their own content.
          filled.push(b);
        }
      }
      patch({ chairmanReport: filled });
      return "";
    }, () => { /* patch already applied inside fetcher */ });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ---- Header block ---- */}
      <Panel title="Meeting details">
        <Field label="Association name">
          <input type="text" value={minutes.associationName}
                 onChange={(e) => patch({ associationName: e.target.value })} />
        </Field>
        <Grid3>
          <Field label="Date">
            <input type="text" value={minutes.meetingDate}
                   onChange={(e) => patch({ meetingDate: e.target.value })}
                   placeholder="October 20, 2025" />
          </Field>
          <Field label="Time">
            <input type="text" value={minutes.meetingTime}
                   onChange={(e) => patch({ meetingTime: e.target.value })}
                   placeholder="5:00 PM" />
          </Field>
          <Field label="Location">
            <input type="text" value={minutes.meetingLocation}
                   onChange={(e) => patch({ meetingLocation: e.target.value })} />
          </Field>
        </Grid3>
      </Panel>

      {/* ---- 1. Attendance ---- */}
      <Panel title="1. Attendance">
        <Field label="Present (one name per line)">
          <textarea rows={5} value={minutes.present.join("\n")}
                    onChange={(e) => patch({ present: linesFrom(e.target.value) })} />
        </Field>
        <Field label="Absent (one name per line; leave empty for None)">
          <textarea rows={3} value={minutes.absent.join("\n")}
                    onChange={(e) => patch({ absent: linesFrom(e.target.value) })} />
        </Field>
      </Panel>

      {/* ---- 2. Previous minutes ---- */}
      <Panel title="2. Adoption of Previous Minutes">
        <Grid2>
          <Field label="Read by">
            <input type="text" value={minutes.previousMinutesReadBy}
                   onChange={(e) => patch({ previousMinutesReadBy: e.target.value })} />
          </Field>
          <Field label="Approved by">
            <input type="text" value={minutes.previousMinutesApprovedBy}
                   onChange={(e) => patch({ previousMinutesApprovedBy: e.target.value })} />
          </Field>
        </Grid2>
      </Panel>

      {/* ---- 3. Chairman's Report ---- */}
      <Panel title="3. Chairman's Report"
        action={aiEnabled ? (
          <button className="btn ghost" style={{ fontSize: 12 }}
                  disabled={!!aiBusy} onClick={aiChairman}
                  title="Only sections grounded in on-device data will be drafted: Staffing Updates and Maintenance Completed. Others are left blank for you to write.">
            {aiBusy === "chairman" ? "✨ Drafting…" : "✨ AI fill grounded"}
          </button>
        ) : undefined}>
        <p style={{ margin: "-4px 0 8px 0", color: "var(--muted)", fontSize: 12 }}>
          Empty sub-sections are skipped in the exported document. Enter one bullet per line for list blocks.
          {aiEnabled && (
            <> AI drafts <strong>Staffing Updates</strong> and <strong>Maintenance Completed</strong> from on-device data;
            other headings must be written by hand.</>
          )}
        </p>
        {minutes.chairmanReport.map((b, idx) => (
          <ChairmanEditor key={idx} block={b}
            aiEnabled={aiEnabled}
            grounded={isChairmanHeadingGrounded(b.heading)}
            onChange={(next) => {
              const copy = [...minutes.chairmanReport];
              copy[idx] = next; patch({ chairmanReport: copy });
            }}
            onRemove={() => {
              const copy = minutes.chairmanReport.filter((_, i) => i !== idx);
              patch({ chairmanReport: copy });
            }}
          />
        ))}
        <button className="btn secondary" style={{ marginTop: 4 }} onClick={() => {
          patch({ chairmanReport: [...minutes.chairmanReport, { heading: "New sub-heading:", body: "" }] });
        }}>+ Add sub-heading</button>
      </Panel>

      {/* ---- 4. Financial Report ---- */}
      <Panel title="4. Financial Report"
        action={aiEnabled ? (
          <button className="btn ghost" style={{ fontSize: 12 }} disabled={!!aiBusy} onClick={aiFin}
                  title="Draft the financial narrative from this year's revenue, subsidies and expenses.">
            {aiBusy === "fin" ? "✨ Drafting…" : "✨ AI draft"}
          </button>
        ) : undefined}>
        <Field label="Presented by">
          <input type="text" value={minutes.financialReportPresenter}
                 onChange={(e) => patch({ financialReportPresenter: e.target.value })} />
        </Field>
        <Field label="Body">
          <textarea rows={4} value={minutes.financialReportBody}
                    onChange={(e) => patch({ financialReportBody: e.target.value })} />
        </Field>
      </Panel>

      {/* ---- 5. General Discussion ---- */}
      <Panel title="5. General Discussion">
        <Field label="Staffing Challenges">
          <textarea rows={3} value={minutes.staffingChallenges}
                    onChange={(e) => patch({ staffingChallenges: e.target.value })} />
          {aiEnabled && (
            <button className="btn ghost" style={{ fontSize: 12, alignSelf: "flex-start", marginTop: 4 }}
                    disabled={!!aiBusy} onClick={aiStaffing}>
              {aiBusy === "staffing" ? "✨ Drafting…" : "✨ AI draft"}
            </button>
          )}
        </Field>
        <Field label="Facilities Maintenance">
          <textarea rows={3} value={minutes.facilitiesMaintenance}
                    onChange={(e) => patch({ facilitiesMaintenance: e.target.value })} />
          {aiEnabled && (
            <button className="btn ghost" style={{ fontSize: 12, alignSelf: "flex-start", marginTop: 4 }}
                    disabled={!!aiBusy} onClick={aiFacilities}>
              {aiBusy === "facilities" ? "✨ Drafting…" : "✨ AI draft"}
            </button>
          )}
        </Field>
      </Panel>

      {/* ---- 6. Board Elections ---- */}
      <Panel title="6. Board Elections">
        <Field label="Description">
          <textarea rows={3} value={minutes.boardElections}
                    onChange={(e) => patch({ boardElections: e.target.value })} />
        </Field>
      </Panel>

      {/* ---- 7. Future Agenda Items ---- */}
      <Panel title="7. Future Agenda Items">
        <Field label="One item per line">
          <textarea rows={5} value={minutes.futureAgenda.join("\n")}
                    onChange={(e) => patch({ futureAgenda: linesFrom(e.target.value) })} />
        </Field>
      </Panel>

      {/* ---- 8. Adjournment ---- */}
      <Panel title="8. Adjournment">
        <Field label="Adjourned at">
          <input type="text" value={minutes.adjournmentTime}
                 onChange={(e) => patch({ adjournmentTime: e.target.value })} placeholder="7:00 PM" />
        </Field>
      </Panel>
    </div>
  );
}

function ChairmanEditor({ block, onChange, onRemove, aiEnabled, grounded }: {
  block: ChairmanBlock;
  onChange: (next: ChairmanBlock) => void;
  onRemove: () => void;
  aiEnabled?: boolean;
  grounded?: boolean;
}) {
  const isList = Array.isArray(block.body);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 10, background: "var(--surface, #fafafa)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <input type="text" value={block.heading}
               onChange={(e) => onChange({ ...block, heading: e.target.value })}
               style={{ flex: 1, fontWeight: 600 }} />
        {aiEnabled && grounded && (
          <span title="AI can draft this section from on-device data"
                style={{
                  fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
                  padding: "2px 6px", borderRadius: 4,
                  background: "var(--accent-bg, #eef6ff)",
                  color: "var(--accent, #1a5fb4)",
                  border: "1px solid var(--accent, #1a5fb4)",
                }}>✨ AI-GROUNDED</span>
        )}
        <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={isList}
                 onChange={(e) => onChange({
                   ...block,
                   body: e.target.checked
                     ? (typeof block.body === "string" ? linesFrom(block.body) : block.body)
                     : (Array.isArray(block.body) ? block.body.join("\n") : block.body),
                 })} />
          bullets
        </label>
        <button className="btn link danger" onClick={onRemove} style={{ fontSize: 12 }}>remove</button>
      </div>
      <textarea rows={isList ? 4 : 3}
                style={{ width: "100%", boxSizing: "border-box" }}
                value={Array.isArray(block.body) ? block.body.join("\n") : block.body}
                onChange={(e) => onChange({
                  ...block,
                  body: isList ? linesFrom(e.target.value) : e.target.value,
                })}
                placeholder={isList ? "One bullet per line" : "Paragraph text"} />
    </div>
  );
}

// ============================================================================
//                                 PREVIEW
// ============================================================================

function PreviewPane({ minutes }: { minutes: AgmMinutes }) {
  return (
    <div style={{ position: "sticky", top: 12, alignSelf: "start" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>
        Preview — matches the exported Word document
      </div>
      <div style={{
        background: "#fff",
        color: "#111",
        padding: "48px 56px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontFamily: "'Times New Roman', Times, serif",
        fontSize: 15,
        lineHeight: 1.5,
        maxHeight: "calc(100vh - 120px)",
        overflowY: "auto",
        boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
      }}>
        <div style={{ textAlign: "center", fontWeight: 700, fontSize: 18 }}>
          Minutes of the Annual General Meeting {minutes.yearLabel}
        </div>
        <div style={{ textAlign: "center", fontWeight: 700, marginBottom: 12 }}>
          {minutes.associationName}
        </div>
        <div><strong>Date:</strong> {minutes.meetingDate}</div>
        <div><strong>Time:</strong> {minutes.meetingTime}</div>
        <div><strong>Location:</strong> {minutes.meetingLocation}</div>

        <PreviewH n={1} t="Attendance" />
        <div><strong>Present:</strong></div>
        <PreviewBullets items={minutes.present.length ? minutes.present : ["—"]} />
        <div><strong>Absent:</strong></div>
        <PreviewBullets items={minutes.absent.length ? minutes.absent : ["None"]} />

        <PreviewH n={2} t="Adoption of Previous Minutes" />
        <p style={pStyle}>
          The minutes of the previous AGM were read by {minutes.previousMinutesReadBy.trim() || "____"} and approved by {minutes.previousMinutesApprovedBy.trim() || "____"}.
        </p>

        <PreviewH n={3} t="Chairman’s Report" />
        {minutes.chairmanReport.map((b, i) => {
          const heading = b.heading.trim();
          if (!heading) return null;
          if (Array.isArray(b.body)) {
            const items = b.body.map((x) => x.trim()).filter(Boolean);
            if (items.length === 0) return null;
            return (
              <div key={i}>
                <div style={{ fontWeight: 700, marginTop: 8 }}>{heading}</div>
                <PreviewBullets items={items} />
              </div>
            );
          }
          const text = (b.body || "").trim();
          if (!text) return null;
          return (
            <div key={i}>
              <div style={{ fontWeight: 700, marginTop: 8 }}>{heading}</div>
              {text.split(/\n+/).map((l, j) => l.trim() ? <p key={j} style={pStyle}>{l.trim()}</p> : null)}
            </div>
          );
        })}

        <PreviewH n={4} t="Financial Report" />
        <p style={pStyle}>
          {(minutes.financialReportPresenter.trim()
              ? `The financial report was presented by ${minutes.financialReportPresenter.trim()}. `
              : "The financial report was presented. ")}
          {(minutes.financialReportBody.split(/\n+/)[0] || "").trim()}
        </p>
        {minutes.financialReportBody.split(/\n+/).slice(1).map((l, i) => l.trim() ? <p key={i} style={pStyle}>{l.trim()}</p> : null)}

        <PreviewH n={5} t="General Discussion" />
        {minutes.staffingChallenges.trim() && <>
          <div style={{ fontWeight: 700 }}>Staffing Challenges:</div>
          {minutes.staffingChallenges.split(/\n+/).map((l, i) => l.trim() ? <p key={i} style={pStyle}>{l.trim()}</p> : null)}
        </>}
        {minutes.facilitiesMaintenance.trim() && <>
          <div style={{ fontWeight: 700, marginTop: 8 }}>Facilities Maintenance:</div>
          {minutes.facilitiesMaintenance.split(/\n+/).map((l, i) => l.trim() ? <p key={i} style={pStyle}>{l.trim()}</p> : null)}
        </>}

        <PreviewH n={6} t="Board Elections" />
        {minutes.boardElections.trim().split(/\n+/).map((l, i) => l.trim() ? <p key={i} style={pStyle}>{l.trim()}</p> : null)}

        <PreviewH n={7} t="Future Agenda Items" />
        <PreviewBullets items={minutes.futureAgenda.map((x) => x.trim()).filter(Boolean).length
          ? minutes.futureAgenda.map((x) => x.trim()).filter(Boolean)
          : ["—"]} />

        <PreviewH n={8} t="Adjournment" />
        <p style={pStyle}>The meeting was adjourned at {minutes.adjournmentTime || "____"}.</p>
      </div>
    </div>
  );
}

const pStyle: React.CSSProperties = { margin: "6px 0" };

function PreviewH({ n, t }: { n: number; t: string }) {
  return <div style={{ fontWeight: 700, fontSize: 15, marginTop: 16, marginBottom: 4 }}>{n}. {t}</div>;
}
function PreviewBullets({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: "4px 0 4px 22px", padding: 0 }}>
      {items.map((it, i) => <li key={i} style={{ margin: "2px 0" }}>{it}</li>)}
    </ul>
  );
}

// ============================================================================
//                                 SHARED
// ============================================================================

function Panel({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, background: "var(--card, #fff)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
        {action}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--muted)" }}>
      <span>{label}</span>
      <div style={{ color: "var(--fg)", display: "flex", flexDirection: "column" }}>{children}</div>
    </label>
  );
}
function Grid2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{children}</div>;
}
function Grid3({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1.2fr", gap: 10 }}>{children}</div>;
}
function linesFrom(text: string): string[] {
  return text.split(/\r?\n/).map((s) => s.replace(/\s+$/g, "")).filter((s) => s.length > 0);
}
