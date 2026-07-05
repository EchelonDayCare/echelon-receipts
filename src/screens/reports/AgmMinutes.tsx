// AGM Minutes editor — form on the left, live preview on the right.
// Preview mirrors the .docx output so what you see is what you get in Word.

import { useEffect, useMemo, useState } from "react";
import { writeFile } from "@tauri-apps/plugin-fs";
import { showAlert, showConfirm } from "../../lib/dialogs";
import {
  AgmMinutes, ChairmanBlock, buildInitialDraft, saveDraft,
  generateDocxBlob, listDraftYears, shortYearLabel,
} from "../../lib/agmMinutes";
import { currentFiscalYear } from "../../lib/fiscalYear";
import { resolveReportPath, NoReportsFolderError } from "../../lib/reportsFolder";

const RECENT_FY_SPAN = 6;   // show current FY + 5 back in the year picker

export default function AgmMinutesEditor() {
  const [fyStart, setFyStart] = useState<number>(currentFiscalYear());
  const [minutes, setMinutes] = useState<AgmMinutes | null>(null);
  const [savedYears, setSavedYears] = useState<Array<{ year_label: string; updated_at: string; finalized_at: string | null }>>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refreshList() {
    try { setSavedYears(await listDraftYears()); } catch { /* ignore */ }
  }

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    (async () => {
      const m = await buildInitialDraft(fyStart);
      if (!cancelled) { setMinutes(m); setDirty(false); }
    })().finally(() => { if (!cancelled) setBusy(false); });
    refreshList();
    return () => { cancelled = true; };
  }, [fyStart]);

  function patch(partial: Partial<AgmMinutes>) {
    if (!minutes) return;
    setMinutes({ ...minutes, ...partial });
    setDirty(true);
  }

  async function onSave() {
    if (!minutes) return;
    setBusy(true);
    try {
      await saveDraft(minutes);
      setDirty(false);
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
      setMinutes(m); setDirty(false);
    } finally { setBusy(false); }
  }

  async function onGenerate() {
    if (!minutes) return;
    const filename = `AGM-${minutes.yearLabel}.docx`;
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

    setBusy(true);
    try {
      await saveDraft(minutes, /* finalized */ true);
      setDirty(false);
      await refreshList();
      const blob = await generateDocxBlob(minutes);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await writeFile(dest, bytes);
      await showAlert(`✅ Document generated at:\n${dest}`);
    } catch (e: any) {
      await showAlert("Generate failed: " + (e?.message || e), { kind: "error" });
    } finally { setBusy(false); }
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
            <select value={fyStart} onChange={(e) => setFyStart(parseInt(e.target.value, 10))} disabled={busy}>
              {yearOptions.map((y) => {
                const yl = shortYearLabel(y);
                const saved = savedYears.find((s) => s.year_label === yl);
                const suffix = saved ? (saved.finalized_at ? " ✓ exported" : " · draft") : "";
                return <option key={y} value={y}>AGM {yl}{suffix}</option>;
              })}
            </select>
          </label>
          <button className="btn secondary" onClick={onReset} disabled={busy}>Reset from prior year</button>
          <button className="btn secondary" onClick={onSave} disabled={busy || !dirty}>
            {dirty ? "Save Draft" : "Saved"}
          </button>
          <button className="btn" onClick={onGenerate} disabled={busy || !minutes}>
            📄 Generate
          </button>
        </div>
      </div>

      {!minutes ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Loading…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 20 }}>
          <FormPane minutes={minutes} patch={patch} />
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
}

function FormPane({ minutes, patch }: FormProps) {
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
      <Panel title="3. Chairman's Report">
        <p style={{ margin: "-4px 0 8px 0", color: "var(--muted)", fontSize: 12 }}>
          Empty sub-sections are skipped in the exported document. Enter one bullet per line for list blocks.
        </p>
        {minutes.chairmanReport.map((b, idx) => (
          <ChairmanEditor key={idx} block={b}
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
      <Panel title="4. Financial Report">
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
        </Field>
        <Field label="Facilities Maintenance">
          <textarea rows={3} value={minutes.facilitiesMaintenance}
                    onChange={(e) => patch({ facilitiesMaintenance: e.target.value })} />
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

function ChairmanEditor({ block, onChange, onRemove }: {
  block: ChairmanBlock;
  onChange: (next: ChairmanBlock) => void;
  onRemove: () => void;
}) {
  const isList = Array.isArray(block.body);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 10, background: "var(--surface, #fafafa)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <input type="text" value={block.heading}
               onChange={(e) => onChange({ ...block, heading: e.target.value })}
               style={{ flex: 1, fontWeight: 600 }} />
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, background: "var(--card, #fff)" }}>
      <h3 style={{ marginTop: 0, marginBottom: 10, fontSize: 15 }}>{title}</h3>
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
