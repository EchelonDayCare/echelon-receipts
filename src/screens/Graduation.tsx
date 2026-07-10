import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  getSettings,
  setSetting,
  listStudents,
  upsertStudent,
} from "../lib/db";
import type { Student } from "../types";

// Payloads mirrored from src-tauri/src/graduation/commands.rs
type ProgressTick = {
  frame?: number;
  fps?: number;
  total_size?: number;
  out_time_us?: number;
  out_time_ms?: number;
  done: boolean;
};
type ProgressPayload = { job_id: string; stage: string; tick: ProgressTick };
type LogPayload = { job_id: string; level: string; message: string };
type PreflightReport = {
  checks: [string, { ok: boolean; message: string }][];
  all_ok: boolean;
};

type ChildFolder = { student_id: number; display_name: string; folder: string };
type Layout = {
  root: string;
  reel_photos: string;
  kids_photos: string;
  music: string;
  template: string;
  output: string;
  readme: string;
  child_folders: ChildFolder[];
};

// Reel + per-child render defaults. Kept in sync with engine.rs.
const REEL_DURATION_SEC = 15 * 60;
const REEL_AVG_PHOTO_SEC = 3.0;
const KID_DURATION_SEC = 2 * 60;
const KID_AVG_PHOTO_SEC = 3.0;

export default function Graduation() {
  const [year, setYear] = useState<string>(String(new Date().getFullYear()));
  const [baseFolder, setBaseFolder] = useState<string>("");
  const [layout, setLayout] = useState<Layout | null>(null);
  const [showScaffoldModal, setShowScaffoldModal] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [busy, setBusy] = useState<null | "scaffold" | "preflight" | "reel" | "child" | "slides" | "all">(null);
  const [currentStage, setCurrentStage] = useState<string>("");
  const [progress, setProgress] = useState<ProgressTick | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [savedOk, setSavedOk] = useState(false);
  // Tracks a user-initiated cancel so a batch loop bails between
  // renders instead of continuing after killing the current FFmpeg.
  const cancelledRef = useRef(false);

  useEffect(() => {
    (async () => {
      const s = await getSettings();
      if (s.grad_year) setYear(s.grad_year);
      if (s.grad_base_folder) setBaseFolder(s.grad_base_folder);
      setStudents(await listStudents(undefined, false));
    })().catch((e) => appendLog(`error: ${e}`));
  }, []);

  useEffect(() => {
    let un1: UnlistenFn | null = null;
    let un2: UnlistenFn | null = null;
    (async () => {
      un1 = await listen<ProgressPayload>("graduation://progress", (evt) => {
        setCurrentStage(evt.payload.stage);
        setProgress(evt.payload.tick);
        if (evt.payload.tick.done) {
          appendLog(`✓ ${evt.payload.stage} finished`);
        }
      });
      un2 = await listen<LogPayload>("graduation://log", (evt) => {
        appendLog(evt.payload.message);
      });
    })().catch(() => {});
    return () => {
      un1?.();
      un2?.();
    };
  }, []);

  const graduating = useMemo(
    () => students.filter((s) => String(s.graduation_year || "") === year),
    [students, year],
  );

  function appendLog(line: string) {
    setLog((prev) => (prev.length > 400 ? [...prev.slice(-400), line] : [...prev, line]));
  }

  async function pickBaseFolder() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) {
      setBaseFolder(picked);
      await setSetting("grad_base_folder", picked);
      await setSetting("grad_year", year);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 1600);
      setLayout(null); // force re-scaffold when base changes
    }
  }

  async function scaffold() {
    if (!baseFolder) {
      appendLog("Pick a base folder first");
      return;
    }
    if (graduating.length === 0) {
      appendLog("Mark at least one student as graduating this year");
      return;
    }
    setBusy("scaffold");
    try {
      const lay = await invoke<Layout>("graduation_scaffold", {
        req: {
          base_folder: baseFolder,
          year: Number(year),
          students: graduating.map((s) => ({ id: s.id, name: s.name })),
        },
      });
      setLayout(lay);
      await setSetting("grad_year", year);
      setShowScaffoldModal(true);
      appendLog(`✓ Folders ready at ${lay.root}`);
    } catch (e) {
      appendLog(`scaffold error: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function reveal(path: string) {
    try {
      // Tauri's opener scope doesn't recognise the Windows extended-length
      // prefix (\\?\C:\...). Strip it before invoking; the underlying
      // Win32 API accepts the plain form for well-known paths.
      const cleaned = path.replace(/^\\\\\?\\/, "");
      await openPath(cleaned);
    } catch (e) {
      appendLog(`open folder error: ${e}`);
    }
  }

  async function renderReel(nested = false) {
    if (!layout) return;
    if (!nested) setBusy("reel");
    setProgress(null);
    const job = `reel-${Date.now()}`;
    try {
      const out = await invoke<{ output_path: string; frames_encoded: number; duration_ms: number }>(
        "graduation_render_reel",
        {
          req: {
            source_folder: layout.reel_photos,
            output_folder: layout.output,
            music_track: null,
            music_folder: layout.music,
            year: Number(year),
            duration_sec: REEL_DURATION_SEC,
            avg_photo_sec: REEL_AVG_PHOTO_SEC,
            job_id: job,
          },
        },
      );
      appendLog(`✓ Reel done in ${(out.duration_ms / 1000).toFixed(1)}s → ${out.output_path}`);
    } catch (e) {
      appendLog(`reel error: ${e}`);
      throw e;
    } finally {
      if (!nested) setBusy(null);
    }
  }

  async function renderPerChild(nested = false) {
    if (!layout) return;
    if (graduating.length === 0) {
      appendLog("No graduating students for " + year);
      return;
    }
    if (!nested) setBusy("child");
    for (const c of layout.child_folders) {
      if (cancelledRef.current) {
        appendLog("↳ Cancelled — skipping remaining students");
        break;
      }
      const student = graduating.find((s) => s.id === c.student_id);
      if (!student) continue;
      const job = `child-${c.student_id}-${Date.now()}`;
      setProgress(null);
      appendLog(`→ Rendering ${c.display_name}...`);
      try {
        const out = await invoke<{ output_path: string; frames_encoded: number; duration_ms: number }>(
          "graduation_render_child",
          {
            req: {
              source_folder: c.folder,
              output_folder: layout.output,
              student_id: c.student_id,
              display_name: c.display_name,
              year: Number(year),
              music_track: null,
              music_folder: layout.music,
              duration_sec: KID_DURATION_SEC,
              avg_photo_sec: KID_AVG_PHOTO_SEC,
              job_id: job,
            },
          },
        );
        appendLog(`  ✓ ${c.display_name} in ${(out.duration_ms / 1000).toFixed(1)}s → ${out.output_path}`);
      } catch (e) {
        appendLog(`  ✗ ${c.display_name}: ${e}`);
        // Distinguish user cancel from per-child failure. On cancel,
        // stop the batch immediately; on plain failure, continue with
        // the next child (a single missing folder shouldn't tank the
        // whole class's slideshows).
        if (cancelledRef.current) break;
      }
    }
    if (!nested) setBusy(null);
  }

  async function renderSlides(nested = false) {
    if (!layout) return;
    if (graduating.length === 0) {
      appendLog("No graduating students for " + year);
      return;
    }
    if (!nested) setBusy("slides");
    try {
      const out = await invoke<{ output_path: string; slides_written: number; template_used: string }>(
        "graduation_render_slides",
        {
          req: {
            template_path: null,
            template_folder: layout.template,
            output_folder: layout.output,
            year: Number(year),
            students: graduating.map((s) => {
              const childFolder = layout.child_folders.find((c) => c.student_id === s.id);
              return {
                name: s.name,
                note: s.graduation_note || "",
                photo_folder: childFolder?.folder ?? null,
              };
            }),
          },
        },
      );
      appendLog(`✓ Slides done: ${out.slides_written} kids → ${out.output_path}`);
      appendLog(`  (template: ${out.template_used})`);
    } catch (e) {
      appendLog(`slides error: ${e}`);
      throw e;
    } finally {
      if (!nested) setBusy(null);
    }
  }

  async function renderAll() {
    // Clear any prior cancel flag on both sides before starting a new
    // batch so a stale cancel doesn't abort us instantly.
    cancelledRef.current = false;
    try { await invoke("graduation_reset_cancel"); } catch { /* ok */ }
    setBusy("all");
    try {
      await renderReel(true);
      if (cancelledRef.current) { appendLog("↳ Cancelled after reel"); return; }
      await renderPerChild(true);
      if (cancelledRef.current) { appendLog("↳ Cancelled before slides"); return; }
      await renderSlides(true);
    } catch (e) {
      // Individual renders already logged; renderAll bails on the
      // first hard error so the user isn't waiting for downstream
      // stages that likely depend on the same disk / cache.
      appendLog(`batch stopped: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function runPreflight() {
    if (!layout) return;
    setBusy("preflight");
    try {
      const rep = await invoke<PreflightReport>("graduation_preflight", {
        req: {
          reel_folder: layout.reel_photos,
          kids_folder: layout.kids_photos,
          slides_folder: layout.template,
          // Free-space + writability actually matter on the OUTPUT
          // folder, not the input folders. Send it so preflight can
          // gate the render on real disk conditions.
          output_folder: layout.output,
          check_heic: true,
        },
      });
      setPreflight(rep);
      appendLog(rep.all_ok ? "✓ Preflight passed" : "✗ Preflight failed — see checks below");
    } catch (e) {
      appendLog(`preflight error: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    cancelledRef.current = true;
    try {
      await invoke("graduation_cancel");
      appendLog("Cancelled");
    } catch (e) {
      appendLog(`cancel error: ${e}`);
    }
  }

  async function saveStudentNote(s: Student, note: string) {
    await upsertStudent({ ...s, graduation_note: note });
    setStudents((prev) => prev.map((x) => (x.id === s.id ? { ...x, graduation_note: note } : x)));
  }

  async function toggleGraduating(s: Student, on: boolean) {
    const updated: Student = { ...s, graduation_year: on ? Number(year) : null };
    await upsertStudent(updated);
    setStudents((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
    // Marking someone new means the scaffold is stale.
    if (layout) setLayout(null);
  }

  const isBusy = busy !== null;
  // Progress % depends on the current stage: reel = 15 min, per-child
  // = 2 min. The old code always divided by REEL_DURATION_SEC, capping
  // per-child renders at ~13% of the bar.
  const progressUs = progress?.out_time_us ?? progress?.out_time_ms;
  const stageDurationSec =
    currentStage === "per-child" ? KID_DURATION_SEC : REEL_DURATION_SEC;
  const timePct = progressUs
    ? Math.min(100, (progressUs / 1_000_000 / stageDurationSec) * 100)
    : 0;

  // Modal dismisses on Escape as well as click-outside for keyboard
  // accessibility. Bound only while the modal is open.
  useEffect(() => {
    if (!showScaffoldModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowScaffoldModal(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showScaffoldModal]);

  return (
    <main className="content">
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Graduation Day</h1>
        <p style={{ color: "#475569", marginTop: 6, maxWidth: 720 }}>
          Renders a 15-minute year-in-review reel, a 2-minute video for each
          graduating child, and a PowerPoint deck. Pick one folder — the app
          creates everything else it needs inside it.
        </p>
      </header>

      {/* Step 1: base folder + year */}
      <section className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
          <span style={stepBadge}>1</span>
          <h2 style={{ margin: 0 }}>Pick your Graduation Day folder</h2>
        </div>
        <p style={{ color: "#64748b", margin: "0 0 12px 40px" }}>
          Choose any folder on your computer. The app will create a{" "}
          <code>Graduation-{year}</code> subfolder inside it with all the sub-folders you need.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: 40 }}>
          <input
            type="text"
            readOnly
            value={baseFolder}
            placeholder="No folder chosen"
            style={{ flex: 1, padding: "8px 12px", background: "#f8fafc" }}
          />
          <button className="btn primary" onClick={pickBaseFolder} disabled={isBusy}>
            {baseFolder ? "Change folder" : "Choose folder"}
          </button>
          {baseFolder && (
            <button className="btn" onClick={() => reveal(baseFolder)}>Open</button>
          )}
          {savedOk && <span style={{ color: "#059669" }}>✓ Saved</span>}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16, marginLeft: 40 }}>
          <label style={{ fontWeight: 600 }}>Graduation year</label>
          <input
            type="number"
            min="2000"
            max="2099"
            value={year}
            onChange={(e) => {
              setYear(e.target.value);
              setLayout(null);
            }}
            onBlur={() => setSetting("grad_year", year)}
            style={{ width: 100, padding: "6px 10px" }}
          />
        </div>
      </section>

      {/* Step 2: mark graduating students */}
      <section className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
          <span style={stepBadge}>2</span>
          <h2 style={{ margin: 0 }}>Mark this year's graduating students ({graduating.length})</h2>
        </div>
        <p style={{ color: "#64748b", margin: "0 0 12px 40px" }}>
          Check every child graduating in {year}. The teacher's note appears on that
          child's slide in the PowerPoint deck.
        </p>
        <div style={{ marginLeft: 40 }}>
          {students.length === 0 ? (
            <div style={{ color: "#64748b" }}>No students in the roster yet. Add them on the Students page.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}></th>
                  <th>Name</th>
                  <th>Teacher note (goes on slide + credits card)</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => {
                  const on = String(s.graduation_year || "") === year;
                  return (
                    <tr key={s.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => toggleGraduating(s, e.target.checked)}
                        />
                      </td>
                      <td>{s.name}</td>
                      <td>
                        <textarea
                          rows={2}
                          style={{ width: "100%", padding: 6 }}
                          placeholder='e.g. "Ann has grown from a shy first-day kid to..."'
                          defaultValue={s.graduation_note || ""}
                          onBlur={(e) => saveStudentNote(s, e.target.value)}
                          disabled={!on}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Step 3: scaffold */}
      <section className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
          <span style={stepBadge}>3</span>
          <h2 style={{ margin: 0 }}>Set up folders for {year}</h2>
        </div>
        <p style={{ color: "#64748b", margin: "0 0 12px 40px" }}>
          The app will create sub-folders for the year reel, per-child photos, music,
          and output. Existing folders are kept — safe to re-run.
        </p>
        <div style={{ marginLeft: 40 }}>
          <button
            className="btn primary"
            onClick={scaffold}
            disabled={isBusy || !baseFolder || graduating.length === 0}
          >
            {busy === "scaffold" ? "Setting up..." : layout ? "Re-check / update folders" : "Set up folders"}
          </button>
          {layout && (
            <button className="btn" onClick={() => reveal(layout.root)} style={{ marginLeft: 8 }}>
              Open {year} folder
            </button>
          )}
        </div>
      </section>

      {/* Step 4: render — only shown after scaffold */}
      {layout && (
        <section className="card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
            <span style={stepBadge}>4</span>
            <h2 style={{ margin: 0 }}>Render videos + slides</h2>
          </div>
          <p style={{ color: "#64748b", margin: "0 0 12px 40px" }}>
            Once you've dropped photos into <code>1-Year-Reel-Photos</code> and each
            child's folder, click below. Music and template are auto-detected from
            their folders; if empty the bundled defaults are used.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginLeft: 40 }}>
            <button className="btn primary" onClick={renderAll} disabled={isBusy || graduating.length === 0}>
              {busy === "all" ? "Rendering everything..." : "Render everything"}
            </button>
            <button className="btn" onClick={runPreflight} disabled={isBusy}>
              {busy === "preflight" ? "Checking..." : "Run preflight"}
            </button>
            <button className="btn" onClick={() => renderReel()} disabled={isBusy}>
              {busy === "reel" ? "Rendering reel..." : "Reel only"}
            </button>
            <button className="btn" onClick={() => renderPerChild()} disabled={isBusy || graduating.length === 0}>
              {busy === "child" ? "Rendering..." : `Per-child only (${graduating.length})`}
            </button>
            <button className="btn" onClick={() => renderSlides()} disabled={isBusy || graduating.length === 0}>
              {busy === "slides" ? "Building deck..." : "Slides only"}
            </button>
            {isBusy && (
              <button className="btn danger" onClick={cancel}>
                Cancel
              </button>
            )}
          </div>
        </section>
      )}

      {/* Progress + log */}
      {(progress || log.length > 0 || preflight) && (
        <section className="card" style={{ padding: 20 }}>
          <h2 style={{ marginTop: 0 }}>Progress</h2>
          {progress && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontWeight: 600 }}>{currentStage}</span>
                <span style={{ color: "#475569" }}>
                  {progress.frame ? `frame ${progress.frame}` : ""}
                  {progress.fps ? ` @ ${progress.fps.toFixed(1)} fps` : ""}
                </span>
              </div>
              <div style={{ height: 8, background: "#e2e8f0", borderRadius: 4, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${timePct}%`,
                    background: "#2563eb",
                    transition: "width 200ms ease-out",
                  }}
                />
              </div>
            </div>
          )}

          {preflight && (
            <div style={{ marginBottom: 12 }}>
              <h3 style={{ marginTop: 0 }}>Preflight checks</h3>
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {preflight.checks.map(([name, r]) => (
                  <li key={name} style={{ color: r.ok ? "#059669" : "#dc2626" }}>
                    <strong>{r.ok ? "✓" : "✗"} {name}:</strong> {r.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {log.length > 0 && (
            <>
              <h3 style={{ marginTop: 0 }}>Render log</h3>
              <pre
                style={{
                  maxHeight: 320,
                  overflowY: "auto",
                  background: "#0f172a",
                  color: "#e2e8f0",
                  padding: 12,
                  fontSize: 12,
                  lineHeight: 1.5,
                  borderRadius: 6,
                  margin: 0,
                }}
              >
                {log.join("\n")}
              </pre>
            </>
          )}
        </section>
      )}

      {/* Scaffold-done modal */}
      {showScaffoldModal && layout && (
        <div
          onClick={() => setShowScaffoldModal(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.55)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white", borderRadius: 12, maxWidth: 640, width: "92%",
              padding: 28, boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: 8 }}>✓ Folders are ready</h2>
            <p style={{ marginTop: 0, color: "#475569" }}>
              Please put the photos (and optionally music / a custom template) into the folders
              below. When you're done, come back and click <strong>"Render everything"</strong>.
            </p>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 14, fontSize: 13, marginBottom: 16 }}>
              <div><strong>📸 Year reel photos →</strong> <code>1-Year-Reel-Photos/</code></div>
              <div style={{ marginTop: 6 }}>
                <strong>👶 Per-child photos →</strong> <code>2-Per-Child-Photos/</code>
                <ul style={{ margin: "4px 0 0 20px", padding: 0 }}>
                  {layout.child_folders.slice(0, 6).map((c) => (
                    <li key={c.student_id}><code>{c.folder.split(/[\\/]/).pop()}</code></li>
                  ))}
                  {layout.child_folders.length > 6 && (
                    <li>… and {layout.child_folders.length - 6} more</li>
                  )}
                </ul>
                <div style={{ marginTop: 4, color: "#64748b", fontSize: 12 }}>
                  Include one photo named after the child (first name, last name, or full name — e.g. <code>Beau.jpg</code>, <code>Seymour.jpg</code>, or <code>Beau Seymour.jpg</code>) to show them on their graduation slide.
                </div>
              </div>
              <div style={{ marginTop: 6 }}><strong>🎵 Custom music (optional) →</strong> <code>3-Music-Optional/</code> <span style={{ color: "#64748b", fontSize: 12 }}>(drop multiple tracks — one is picked at random per render)</span></div>
              <div style={{ marginTop: 4 }}><strong>🖼️ Custom template (optional) →</strong> <code>4-Slide-Template-Optional/</code></div>
              <div style={{ marginTop: 4, color: "#64748b" }}>Rendered files land in <code>5-Output/</code>.</div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => reveal(layout.root)}>
                Open {year} folder
              </button>
              <button className="btn primary" onClick={() => setShowScaffoldModal(false)}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

const stepBadge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: "50%",
  background: "#2563eb",
  color: "white",
  fontWeight: 700,
  fontSize: 14,
};
