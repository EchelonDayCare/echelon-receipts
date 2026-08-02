import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { readDir, exists, stat } from "@tauri-apps/plugin-fs";
import {
  getSettings,
  setSetting,
  listStudents,
  upsertStudent,
} from "../lib/db";
import { sendGradReelEmail } from "../lib/gradEmail";
import { parseRecipients } from "../lib/email";
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
// v3.8.0: one row in the "Email reels to parents" modal. Each row maps
// a discovered MP4 in the output folder to the matching student in the
// current grad year. Rows with `include=false` are skipped on send;
// rows where `emails` is empty are automatically excluded and shown
// grayed with a "no email on file" note.
type EmailRow = {
  student_id: number;
  student_name: string;
  parent_name: string;
  emails: string[];       // parsed from students.email
  email_field_raw: string;
  video_path: string;
  video_filename: string;
  video_size_bytes: number;
  include: boolean;
};
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
// User-overridable via UI (persisted per year via settings).
const REEL_DURATION_SEC_DEFAULT = 15 * 60; // main reel: 15 min
const REEL_AVG_PHOTO_SEC = 3.0;
const KID_DURATION_SEC_DEFAULT = 2 * 60;   // per-kid reel: 2 min
const KID_AVG_PHOTO_SEC = 3.0;
// Bounds — see PHOTO_SEC clamp in commands.rs (0.8–6.0). Reel length
// must be long enough to hold at least a couple photos at min pace.
const REEL_LEN_MIN_SEC = 10;
const REEL_LEN_MAX_SEC = 30 * 60; // 30 min cap

function clampReelSec(v: number): number {
  if (!Number.isFinite(v)) return KID_DURATION_SEC_DEFAULT;
  return Math.min(REEL_LEN_MAX_SEC, Math.max(REEL_LEN_MIN_SEC, Math.round(v)));
}

// Format seconds → "M:SS" for the reel-length label preview.
function fmtMSS(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
// Class-reel defaults — overridable in Settings.
const CLASS_REEL_DEFAULTS = {
  seconds_per_kid: 30,
  photos_per_kid: 6,
  name_card_sec: 1.5,
  width: 1920,
  height: 1080,
};

export default function Graduation() {
  const [year, setYear] = useState<string>(String(new Date().getFullYear()));
  const [baseFolder, setBaseFolder] = useState<string>("");
  const [layout, setLayout] = useState<Layout | null>(null);
  const [showScaffoldModal, setShowScaffoldModal] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [busy, setBusy] = useState<null | "scaffold" | "preflight" | "reel" | "child" | "slides" | "class" | "all">(null);
  const [currentStage, setCurrentStage] = useState<string>("");
  const [progress, setProgress] = useState<ProgressTick | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [savedOk, setSavedOk] = useState(false);
  // Class-reel settings (persisted via getSettings/setSetting).
  const [classSecondsPerKid, setClassSecondsPerKid] = useState<number>(CLASS_REEL_DEFAULTS.seconds_per_kid);
  const [classPhotosPerKid, setClassPhotosPerKid] = useState<number>(CLASS_REEL_DEFAULTS.photos_per_kid);
  const [classNameCardSec, setClassNameCardSec] = useState<number>(CLASS_REEL_DEFAULTS.name_card_sec);
  const [classResolution, setClassResolution] = useState<"1080p" | "720p">("1080p");
  // v3.4.0: user-selectable reel lengths (seconds). Persisted per year.
  const [mainReelSec, setMainReelSec] = useState<number>(REEL_DURATION_SEC_DEFAULT);
  const [perKidReelSec, setPerKidReelSec] = useState<number>(KID_DURATION_SEC_DEFAULT);
  // Per-kid ordering + inclusion for the class reel.
  //
  // classReelOrder holds student IDs in playback order. It's seeded
  // from `layout.child_folders` (alphabetical) on first render and
  // persisted via `grad_class_order_<year>` so custom drag-drop order
  // survives an app restart. When new graduating kids are added, they
  // are appended to the end automatically.
  //
  // classReelExcluded is the set of student IDs the user has unchecked;
  // excluded kids are skipped in the render. Persisted via
  // `grad_class_excluded_<year>`.
  const [classReelOrder, setClassReelOrder] = useState<number[]>([]);
  const [classReelExcluded, setClassReelExcluded] = useState<number[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // Guards the class-reel persistence useEffects against a year-switch
  // race: when `year` changes, the persistence effects fire immediately
  // with the previous year's order/excluded still in state, which would
  // clobber the incoming year's saved data before the reconcile effect
  // gets a chance to hydrate. We only allow writes once reconcile has
  // finished loading the current year — signalled by the ref matching
  // the current `year`.
  const hydratedYearRef = useRef<string | null>(null);
  // Terminal batch summary — set when a render function fully completes
  // (not cancelled, no error). Rendered as a big green banner so the
  // user gets an unmissable "done" signal after long Windows encodes.
  const [runSummary, setRunSummary] = useState<{ title: string; detail: string } | null>(null);
  const runStartRef = useRef<number>(0);
  // Tracks a user-initiated cancel so a batch loop bails between
  // renders instead of continuing after killing the current FFmpeg.
  const cancelledRef = useRef(false);
  // v3.7.0: with concurrent per-child renders on macOS, the progress
  // listener can otherwise receive events from a job that already
  // completed (in-flight event delivered after the awaited invoke
  // resolved) and flicker the bar. We only accept progress events
  // whose job_id is in `activeJobsRef`.
  const activeJobsRef = useRef<Set<string>>(new Set());
  // v3.8.0: Email-reels-to-parents flow. `emailModal` is null when the
  // modal is closed. When open, it holds the enumerated per-child reels
  // discovered on disk in the output folder (only kids whose MP4 has
  // been rendered actually appear — no "email a non-existent file").
  const [emailModal, setEmailModal] = useState<null | {
    rows: EmailRow[];
    subject: string;
    body: string;
    sending: boolean;
    log: string[];
    // v3.8.0 review-fix: track whether templates have been edited so
    // we can persist them on Close (not only on Send). This preserves
    // draft template changes across modal open/close cycles.
    templateDirty: boolean;
  }>(null);
  // v3.8.0 review-fix (Sonnet finding #3): allow the operator to
  // interrupt a batch send that's stuck on a slow SMTP handshake. This
  // ref is watched between iterations of the send loop — it can't
  // abort an in-flight lettre call, but it stops queueing new work.
  const emailCancelRef = useRef(false);

  useEffect(() => {
    (async () => {
      const s = await getSettings();
      if (s.grad_year) setYear(s.grad_year);
      if (s.grad_base_folder) setBaseFolder(s.grad_base_folder);
      if (s.grad_class_seconds_per_kid) setClassSecondsPerKid(Number(s.grad_class_seconds_per_kid));
      if (s.grad_class_photos_per_kid) setClassPhotosPerKid(Number(s.grad_class_photos_per_kid));
      if (s.grad_class_name_card_sec !== undefined && s.grad_class_name_card_sec !== null && s.grad_class_name_card_sec !== "")
        setClassNameCardSec(Number(s.grad_class_name_card_sec));
      if (s.grad_class_resolution === "720p" || s.grad_class_resolution === "1080p")
        setClassResolution(s.grad_class_resolution);
      if (s.grad_main_reel_sec) setMainReelSec(clampReelSec(Number(s.grad_main_reel_sec)));
      if (s.grad_per_kid_reel_sec) setPerKidReelSec(clampReelSec(Number(s.grad_per_kid_reel_sec)));
      setStudents(await listStudents(undefined, false));
    })().catch((e) => appendLog(`error: ${e}`));
  }, []);

  // Reconcile persisted class-reel order + excluded set whenever the
  // layout or year changes: drop kids no longer in the class, append
  // new kids to the tail, preserve the user's manual order otherwise.
  useEffect(() => {
    if (!layout) return;
    (async () => {
      const s = await getSettings();
      const orderKey = `grad_class_order_${year}`;
      const excludedKey = `grad_class_excluded_${year}`;
      const savedOrderRaw = (s as Record<string, string | undefined>)[orderKey];
      const savedExcludedRaw = (s as Record<string, string | undefined>)[excludedKey];
      let savedOrder: number[] = [];
      let savedExcluded: number[] = [];
      try { if (savedOrderRaw) savedOrder = JSON.parse(savedOrderRaw); } catch { /* ignore corrupt */ }
      try { if (savedExcludedRaw) savedExcluded = JSON.parse(savedExcludedRaw); } catch { /* ignore corrupt */ }
      const currentIds = new Set(layout.child_folders.map((c) => c.student_id));
      // Preserve saved order for kids still present, drop the rest.
      const preserved = savedOrder.filter((id) => currentIds.has(id));
      // Append newly-added kids to the tail, alphabetical within the
      // new-kids group so they land in a predictable spot.
      const newKids = layout.child_folders
        .filter((c) => !preserved.includes(c.student_id))
        .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }))
        .map((c) => c.student_id);
      const merged = preserved.length > 0 ? [...preserved, ...newKids] : newKids;
      setClassReelOrder(merged);
      // Drop excluded IDs no longer in class.
      setClassReelExcluded(savedExcluded.filter((id) => currentIds.has(id)));
      // Mark this year as hydrated — persistence effects below now
      // trust that state reflects this year's data.
      hydratedYearRef.current = year;
    })().catch(() => { /* non-fatal */ });
  }, [layout, year]);

  // Persist class-reel order + excluded set whenever the user changes them.
  // Gated on hydratedYearRef so a stale (previous-year) order can't be
  // written into the newly-selected year's settings key during a year
  // switch. Reconcile updates the ref only after loading this year.
  useEffect(() => {
    if (!layout || hydratedYearRef.current !== year) return;
    if (classReelOrder.length === 0) return;
    setSetting(`grad_class_order_${year}`, JSON.stringify(classReelOrder)).catch(() => {});
  }, [classReelOrder, layout, year]);
  useEffect(() => {
    if (!layout || hydratedYearRef.current !== year) return;
    setSetting(`grad_class_excluded_${year}`, JSON.stringify(classReelExcluded)).catch(() => {});
  }, [classReelExcluded, layout, year]);

  // Persist user-selected reel lengths (global, not per-year — same
  // pacing preference travels across graduations).
  useEffect(() => {
    setSetting("grad_main_reel_sec", String(mainReelSec)).catch(() => {});
  }, [mainReelSec]);
  useEffect(() => {
    setSetting("grad_per_kid_reel_sec", String(perKidReelSec)).catch(() => {});
  }, [perKidReelSec]);

  useEffect(() => {
    let un1: UnlistenFn | null = null;
    let un2: UnlistenFn | null = null;
    (async () => {
      un1 = await listen<ProgressPayload>("graduation://progress", (evt) => {
        // v3.7.0: with 2 concurrent per-child jobs on macOS, only
        // reflect progress from a job still in the active set. Stale
        // events from a completed sibling would otherwise reset the
        // bar mid-render.
        if (activeJobsRef.current.size > 0 && !activeJobsRef.current.has(evt.payload.job_id)) {
          return;
        }
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

  function fmtElapsed(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return `${m}m ${rs}s`;
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
    if (!nested) { setBusy("reel"); setRunSummary(null); runStartRef.current = Date.now(); }
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
            duration_sec: mainReelSec,
            avg_photo_sec: REEL_AVG_PHOTO_SEC,
            job_id: job,
          },
        },
      );
      appendLog(`✓ Reel done in ${(out.duration_ms / 1000).toFixed(1)}s → ${out.output_path}`);
      if (!nested) setRunSummary({
        title: "✓ Reel complete",
        detail: `1 video in ${fmtElapsed(Date.now() - runStartRef.current)} → ${out.output_path}`,
      });
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
    if (!nested) { setBusy("child"); setRunSummary(null); runStartRef.current = Date.now(); }
    // Local non-null capture for closures inside workers.
    const layoutRef = layout;
    // v3.7.0: batch entrypoint must reset the backend cancel flag once,
    // BEFORE spawning any concurrent renders. Individual render commands
    // no longer self-reset (a self-reset by render N+1 would clobber
    // render N's cancel signal in a parallel batch).
    if (!nested) {
      cancelledRef.current = false;
      try { await invoke("graduation_reset_cancel"); } catch { /* ok */ }
    }
    let successCount = 0;
    let failCount = 0;
    // v3.7.0: bounded concurrency. macOS VideoToolbox has multiple HW
    // encoder engines and comfortably runs 2 concurrent 720p encodes;
    // Windows h264_mf is a single-instance MFT so parallel encodes
    // serialise at the driver level (no gain, occasional flakes).
    const isMac = typeof navigator !== "undefined"
      && /Macintosh|Mac OS X/i.test(navigator.userAgent);
    const concurrency = isMac ? 2 : 1;
    // Copy the list so we can shift() safely. Kids are already in
    // alphabetical order from layout.child_folders.
    const queue = [...layoutRef.child_folders];
    async function worker() {
      while (true) {
        if (cancelledRef.current) return;
        const c = queue.shift();
        if (!c) return;
        // v3.7.0: recheck cancel after shift — otherwise a cancel
        // that fires between the guard and the invoke lands us in
        // spawn_and_stream's cancel branch and prints a misleading
        // "✗ name: cancelled" as if it were a per-kid failure.
        if (cancelledRef.current) return;
        const student = graduating.find((s) => s.id === c.student_id);
        if (!student) continue;
        const job = `child-${c.student_id}-${Date.now()}`;
        activeJobsRef.current.add(job);
        appendLog(`→ Rendering ${c.display_name}...`);
        try {
          const out = await invoke<{ output_path: string; frames_encoded: number; duration_ms: number }>(
            "graduation_render_child",
            {
              req: {
                  source_folder: c.folder,
                  output_folder: layoutRef.output,
                  student_id: c.student_id,
                  display_name: c.display_name,
                  year: Number(year),
                  music_track: null,
                  music_folder: layoutRef.music,
                  duration_sec: perKidReelSec,
                  avg_photo_sec: KID_AVG_PHOTO_SEC,
                  job_id: job,
              },
            },
          );
          successCount++;
          appendLog(`  ✓ ${c.display_name} in ${(out.duration_ms / 1000).toFixed(1)}s → ${out.output_path}`);
        } catch (e) {
          failCount++;
          appendLog(`  ✗ ${c.display_name}: ${e}`);
          if (cancelledRef.current) { activeJobsRef.current.delete(job); return; }
        }
        activeJobsRef.current.delete(job);
      }
    }
    // Fire N workers in parallel; each pulls from the shared queue
    // until empty or cancelled.
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (!nested) {
      setBusy(null);
      if (!cancelledRef.current) {
        const failNote = failCount > 0 ? ` · ${failCount} failed` : "";
        setRunSummary({
          title: `✓ Per-child renders complete`,
          detail: `${successCount} of ${graduating.length} videos in ${fmtElapsed(Date.now() - runStartRef.current)}${failNote} → ${layout.output}`,
        });
      }
    }
  }

  // Reorder kids in the class-reel play order by moving `fromIdx` to
  // `toIdx`. Called from the drag-drop UI in the settings panel.
  function moveClassReelKid(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    setClassReelOrder((prev) => {
      if (fromIdx >= prev.length || toIdx >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }

  function toggleClassReelKid(studentId: number, included: boolean) {
    setClassReelExcluded((prev) => {
      const has = prev.includes(studentId);
      if (included && has) return prev.filter((id) => id !== studentId);
      if (!included && !has) return [...prev, studentId];
      return prev;
    });
  }

  function resetClassReelOrder() {
    if (!layout) return;
    const alpha = [...layout.child_folders]
      .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }))
      .map((c) => c.student_id);
    setClassReelOrder(alpha);
    setClassReelExcluded([]);
  }

  async function renderClassReel() {
    if (!layout) return;
    if (graduating.length === 0) {
      appendLog("No graduating students for " + year);
      return;
    }
    // Persist current settings first so future runs pick up whatever
    // the user tweaked in the inline controls.
    await setSetting("grad_class_seconds_per_kid", String(classSecondsPerKid));
    await setSetting("grad_class_photos_per_kid", String(classPhotosPerKid));
    await setSetting("grad_class_name_card_sec", String(classNameCardSec));
    await setSetting("grad_class_resolution", classResolution);

    cancelledRef.current = false;
    try { await invoke("graduation_reset_cancel"); } catch { /* ok */ }
    setBusy("class");
    setRunSummary(null);
    runStartRef.current = Date.now();

    // Segment order: user's custom drag-drop order (persisted per year).
    // Falls back to alphabetical if the order state hasn't hydrated yet
    // (e.g. classReelOrder is empty because the layout just changed).
    // Excluded kids are filtered out.
    const excluded = new Set(classReelExcluded);
    const byId = new Map(layout.child_folders.map((c) => [c.student_id, c]));
    const orderedIds = classReelOrder.length > 0
      ? classReelOrder
      : [...layout.child_folders]
          .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }))
          .map((c) => c.student_id);
    const orderedSegments = orderedIds
      .filter((id) => !excluded.has(id))
      .map((id) => byId.get(id))
      .filter((c): c is ChildFolder => c !== undefined)
      .map((c) => ({
        student_id: c.student_id,
        display_name: c.display_name,
        source_folder: c.folder,
      }));

    if (orderedSegments.length === 0) {
      appendLog("All kids are excluded — nothing to render. Check at least one kid.");
      setBusy(null);
      return;
    }

    const { width, height } = classResolution === "720p"
      ? { width: 1280, height: 720 }
      : { width: 1920, height: 1080 };

    const job = `classreel-${Date.now()}`;
    try {
      const out = await invoke<{
        output_path: string;
        frames_encoded: number;
        duration_ms: number;
        segments_rendered: number;
        skipped: string[];
        music_used: string | null;
      }>("graduation_render_class_reel", {
        req: {
          segments: orderedSegments,
          output_folder: layout.output,
          music_track: null,
          music_folder: layout.music,
          year: Number(year),
          seconds_per_kid: classSecondsPerKid,
          photos_per_kid: classPhotosPerKid,
          name_card_sec: classNameCardSec,
          width,
          height,
          job_id: job,
        },
      });
      appendLog(`✓ Class reel done in ${(out.duration_ms / 1000).toFixed(1)}s → ${out.output_path}`);
      if (out.skipped.length > 0) {
        appendLog(`  skipped ${out.skipped.length} kid(s): ${out.skipped.join(", ")}`);
      }
      const skipNote = out.skipped.length > 0 ? ` · ${out.skipped.length} skipped` : "";
      setRunSummary({
        title: "✓ Class reel complete",
        detail: `${out.segments_rendered} kids in ${fmtElapsed(Date.now() - runStartRef.current)}${skipNote} → ${out.output_path}`,
      });
    } catch (e) {
      appendLog(`class reel error: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function renderSlides(nested = false) {
    if (!layout) return;
    if (graduating.length === 0) {
      appendLog("No graduating students for " + year);
      return;
    }
    if (!nested) { setBusy("slides"); setRunSummary(null); runStartRef.current = Date.now(); }
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
      if (!nested) setRunSummary({
        title: "✓ Slides deck complete",
        detail: `${out.slides_written} slides in ${fmtElapsed(Date.now() - runStartRef.current)} → ${out.output_path}`,
      });
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
    setRunSummary(null);
    runStartRef.current = Date.now();
    try {
      await renderReel(true);
      if (cancelledRef.current) { appendLog("↳ Cancelled after reel"); return; }
      await renderPerChild(true);
      if (cancelledRef.current) { appendLog("↳ Cancelled before slides"); return; }
      await renderSlides(true);
      setRunSummary({
        title: "✓ Graduation batch complete",
        detail: `Reel + ${graduating.length} kid videos + slides deck in ${fmtElapsed(Date.now() - runStartRef.current)} → ${layout?.output ?? ""}`,
      });
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

  // v3.8.0: enumerate rendered per-child MP4s in the output folder and
  // build a per-student send list. The filename convention is
  // `{padded_student_id}-{sanitized_name}.mp4` (see
  // student_folder_name in graduation/paths.rs). We match by the
  // leading numeric id — stripping leading zeros so 5+ digit ids still
  // work (student_folder_name uses `{:04}` which is MINIMUM 4 digits,
  // not a fixed width). Kids present in the `graduating` list but
  // with no MP4 on disk are silently skipped (they haven't been
  // rendered yet). Kids present on disk but not currently in
  // `graduating` are also skipped.
  async function openEmailModal() {
    if (!layout) return;
    // v3.8.0 review-fix (Sonnet #2): normalise the output folder path
    // to strip any trailing separator so we don't produce
    // `C:\...\output\\1234-alice.mp4` when the picker returned a path
    // ending in `\`. Rust plugin-fs canonicalisation isn't reliable
    // enough to lean on here.
    const outDir = layout.output.replace(/[\\/]+$/, "");
    const sep = outDir.includes("\\") ? "\\" : "/";
    let entries: { name: string }[];
    try {
      const raw = await readDir(outDir);
      entries = raw
        .filter((e) => !e.isDirectory && /\.mp4$/i.test(e.name))
        .map((e) => ({ name: e.name }));
    } catch (e) {
      appendLog(`Could not read output folder: ${e}`);
      return;
    }
    // v3.8.0 review-fix (Sonnet #10): tighten the filename regex to
    // match the FULL per-child pattern `NNNN-<sanitized>.mp4`. A
    // manually placed file like `1234-vacation-clip.mp4` still passes
    // this shape but the risk is intrinsic to filename matching; at
    // minimum we exclude class reel and year reel outputs (which
    // don't begin with digits).
    const perChildRe = /^(\d+)-.+\.mp4$/i;
    const byId: Map<string, string> = new Map();
    for (const e of entries) {
      const m = perChildRe.exec(e.name);
      if (!m) continue;
      // Strip leading zeros so `0007-Ann.mp4` maps to id "7".
      const id = m[1].replace(/^0+/, "") || "0";
      byId.set(id, e.name);
    }
    const rows: EmailRow[] = [];
    for (const s of graduating) {
      const filename = byId.get(String(s.id));
      if (!filename) continue;
      const emails = parseRecipients(s.email);
      // v3.8.0 review-fix (Sonnet #7): if both parents have names on
      // file, greet both ("Mike & Sarah"). This is a per-family
      // salutation, not per-address — one email still goes to both
      // addresses on the To: line.
      const firstNames = [s.father_name, s.mother_name]
        .filter((n): n is string => !!n && typeof n === "string" && n.trim().length > 0)
        .map((n) => n.trim().split(/\s+/)[0]);
      const parentName = firstNames.join(" & ");
      rows.push({
        student_id: s.id,
        student_name: s.name,
        parent_name: parentName,
        emails,
        email_field_raw: s.email || "",
        video_path: `${outDir}${sep}${filename}`,
        video_filename: filename,
        video_size_bytes: 0,
        include: emails.length > 0,
      });
    }
    // Populate video sizes so the UI can show them and we can pre-flag
    // any file over the ~25 MB SMTP ceiling. `stat` is best-effort —
    // any row we can't stat is left at size 0 and treated as unknown
    // (still allowed to send; SMTP will surface the real error).
    await Promise.all(
      rows.map(async (r) => {
        try {
          const info = await stat(r.video_path);
          r.video_size_bytes = Number(info.size ?? 0);
          if (r.video_size_bytes === 0) {
            // Empty or vanished file — exclude by default.
            r.include = false;
          }
        } catch {
          try {
            const ok = await exists(r.video_path);
            if (!ok) r.include = false;
          } catch {}
        }
      }),
    );
    // Load templates from settings. If no rows survived, still open
    // the modal with an empty-state message rather than silently
    // returning — the user needs feedback that the click did something.
    const settings = await getSettings();
    const subjectTpl =
      settings.grad_reel_email_subject ||
      "A little graduation memory from Echelon — {{student}} ({{year}})";
    const bodyTpl =
      settings.grad_reel_email_body ||
      "Hi {{parent_name}},\n\nCongratulations to {{student}} on graduating!\n\nWarmly,\nEchelon Daycare";
    const initialLog: string[] =
      rows.length === 0
        ? [
            "No per-child MP4s found for graduating students yet.",
            "Render each child's reel first, then come back here.",
          ]
        : [];
    emailCancelRef.current = false;
    setEmailModal({
      rows,
      subject: subjectTpl,
      body: bodyTpl,
      sending: false,
      log: initialLog,
      templateDirty: false,
    });
  }

  async function persistEmailTemplates(subject: string, body: string) {
    try {
      await setSetting("grad_reel_email_subject", subject);
      await setSetting("grad_reel_email_body", body);
    } catch {
      // Non-critical — user can re-edit next time.
    }
  }

  async function closeEmailModal() {
    if (!emailModal || emailModal.sending) return;
    // v3.8.0 review-fix (Sonnet #6): persist template edits on Close
    // too, not only on Send. Otherwise the operator loses a hand-typed
    // note if they close the modal to fix something else.
    if (emailModal.templateDirty) {
      await persistEmailTemplates(emailModal.subject, emailModal.body);
    }
    setEmailModal(null);
  }

  function cancelEmailBatch() {
    emailCancelRef.current = true;
    setEmailModal((prev) => prev && ({
      ...prev,
      log: [...prev.log, "↳ Cancelling after current send..."],
    }));
  }

  async function sendReelEmails() {
    if (!emailModal || !layout) return;
    if (emailModal.sending) return;
    emailCancelRef.current = false;
    setEmailModal({ ...emailModal, sending: true, log: ["→ Preparing..."] });
    const settings = await getSettings();
    const toSend = emailModal.rows.filter((r) => r.include && r.emails.length > 0);
    if (toSend.length === 0) {
      setEmailModal((prev) => prev && ({
        ...prev,
        sending: false,
        log: [...prev.log, "Nothing selected to send."],
      }));
      return;
    }
    setEmailModal((prev) => prev && ({
      ...prev,
      sending: true,
      log: [`→ Sending ${toSend.length} emails...`],
    }));
    let ok = 0, fail = 0, skipped = 0;
    const startedAt = Date.now();
    // Serial send: SMTP servers rate-limit hard, and each attachment
    // opens a fresh TLS connection through lettre. A batch of 20 kids
    // completes in ~30 s serially and stays well below Hotmail/Gmail
    // per-minute thresholds. Parallel sends here would trip the rate
    // limiter and get half the batch bounced.
    for (let i = 0; i < toSend.length; i++) {
      const r = toSend[i];
      if (emailCancelRef.current) {
        skipped = toSend.length - i;
        setEmailModal((prev) => prev && ({
          ...prev,
          log: [...prev.log, `↳ Cancelled — ${skipped} not sent`],
        }));
        break;
      }
      try {
        const recipients = await sendGradReelEmail({
          recipient: {
            student_id: r.student_id,
            student_name: r.student_name,
            parent_name: r.parent_name,
            email_field: r.email_field_raw,
            video_path: r.video_path,
            video_filename: r.video_filename,
          },
          year,
          subjectTpl: emailModal.subject,
          bodyTpl: emailModal.body,
          settings,
        });
        ok++;
        setEmailModal((prev) => prev && ({
          ...prev,
          log: [...prev.log, `  ✓ [${i + 1}/${toSend.length}] ${r.student_name} → ${recipients.join(", ")}`],
        }));
      } catch (e: any) {
        fail++;
        setEmailModal((prev) => prev && ({
          ...prev,
          log: [...prev.log, `  ✗ [${i + 1}/${toSend.length}] ${r.student_name}: ${e?.message || e}`],
        }));
      }
    }
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    const summary = skipped > 0
      ? `Done — ${ok} sent, ${fail} failed, ${skipped} skipped, ${took}s`
      : `Done — ${ok} sent, ${fail} failed, ${took}s`;
    setEmailModal((prev) => prev && ({
      ...prev,
      sending: false,
      log: [...prev.log, summary],
    }));
    // Persist any template edits so next time they open the modal,
    // their tweaked wording is remembered.
    await persistEmailTemplates(emailModal.subject, emailModal.body);
    setEmailModal((prev) => prev && ({ ...prev, templateDirty: false }));
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
  // Progress % depends on the current stage. Uses the user-selected
  // reel lengths (perKidReelSec, mainReelSec) so the bar scales with
  // the actual render duration, not the old hardcoded 15-min ceiling.
  const progressUs = progress?.out_time_us ?? progress?.out_time_ms;
  const totalClassDurationSec = graduating.length * classSecondsPerKid;
  const stageDurationSec =
    currentStage === "per-child" ? perKidReelSec
    : currentStage.startsWith("class-reel-seg-") ? classSecondsPerKid
    : currentStage === "class-reel-concat" ? totalClassDurationSec
    : mainReelSec;
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
            <button className="btn" onClick={runPreflight} disabled={isBusy}>
              {busy === "preflight" ? "Checking..." : "Run preflight"}
            </button>
            <button className="btn" onClick={() => renderSlides()} disabled={isBusy || graduating.length === 0}>
              {busy === "slides" ? "Building deck..." : "Slides only"}
            </button>
            <button className="btn" onClick={() => renderPerChild()} disabled={isBusy || graduating.length === 0}>
              {busy === "child" ? "Rendering..." : `Per-child only (${graduating.length})`}
            </button>
            <button
              className="btn"
              onClick={renderClassReel}
              disabled={isBusy || graduating.length === 0}
              title={`Combine every kid into one long video`}
            >
              {busy === "class"
                ? "Rendering class reel..."
                : (() => {
                    const excludedSet = new Set(classReelExcluded);
                    const included = classReelOrder.length > 0
                      ? classReelOrder.filter((id) => !excludedSet.has(id)).length
                      : graduating.length;
                    const mins = Math.round(included * classSecondsPerKid / 60);
                    return `Class reel (${included} kids × ${classSecondsPerKid}s ≈ ${mins} min)`;
                  })()}
            </button>
            <button className="btn" onClick={() => renderReel()} disabled={isBusy}>
              {busy === "reel" ? "Rendering reel..." : "Reel only"}
            </button>
            <button className="btn primary" onClick={renderAll} disabled={isBusy || graduating.length === 0}>
              {busy === "all" ? "Rendering everything..." : "Render everything"}
            </button>
            {/* v3.8.0: send each rendered per-child MP4 to that child's
                parents in a single flow. Only enabled once a scaffold
                exists and the user isn't mid-render. */}
            <button
              className="btn"
              onClick={openEmailModal}
              disabled={isBusy || graduating.length === 0}
              title="Email each child's reel to their parents"
            >
              📧 Email reels to parents
            </button>
            {isBusy && (
              <button className="btn danger" onClick={cancel}>
                Cancel
              </button>
            )}
          </div>

          {/* v3.4.0: reel length settings (main + per-kid). Persisted globally. */}
          <details style={{ marginLeft: 40, marginTop: 16, color: "#475569" }}>
            <summary style={{ cursor: "pointer", userSelect: "none", fontWeight: 600 }}>
              Reel length settings
            </summary>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, marginTop: 12, maxWidth: 640 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>Main reel length (seconds)</span>
                <input
                  type="number"
                  min={REEL_LEN_MIN_SEC}
                  max={REEL_LEN_MAX_SEC}
                  step={30}
                  value={mainReelSec}
                  onChange={(e) => setMainReelSec(clampReelSec(Number(e.target.value)))}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
                <span style={{ fontSize: 12, color: "#94a3b8" }}>
                  ≈ {fmtMSS(mainReelSec)} (used by "Reel only" &amp; "Render everything")
                </span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>Per-child reel length (seconds)</span>
                <input
                  type="number"
                  min={REEL_LEN_MIN_SEC}
                  max={REEL_LEN_MAX_SEC}
                  step={15}
                  value={perKidReelSec}
                  onChange={(e) => setPerKidReelSec(clampReelSec(Number(e.target.value)))}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
                <span style={{ fontSize: 12, color: "#94a3b8" }}>
                  ≈ {fmtMSS(perKidReelSec)} per kid (used by "Per-child only")
                </span>
              </label>
            </div>
          </details>

          {/* Class reel settings (inline, collapsible feel via details/summary). */}
          <details style={{ marginLeft: 40, marginTop: 16, color: "#475569" }}>
            <summary style={{ cursor: "pointer", userSelect: "none", fontWeight: 600 }}>
              Class reel settings
            </summary>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
                marginTop: 12,
                padding: 12,
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
              }}
            >
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>Seconds per kid</span>
                <input
                  type="number"
                  min={10}
                  max={120}
                  step={1}
                  value={classSecondsPerKid}
                  onChange={(e) => setClassSecondsPerKid(Math.max(10, Math.min(120, Number(e.target.value) || 30)))}
                  disabled={isBusy}
                  style={{ padding: "6px 8px", borderRadius: 4, border: "1px solid #cbd5e1" }}
                />
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  {graduating.length} kids → ≈ {Math.round(graduating.length * classSecondsPerKid / 60)} min video
                </span>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>Photos per kid</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  value={classPhotosPerKid}
                  onChange={(e) => setClassPhotosPerKid(Math.max(1, Math.min(30, Number(e.target.value) || 6)))}
                  disabled={isBusy}
                  style={{ padding: "6px 8px", borderRadius: 4, border: "1px solid #cbd5e1" }}
                />
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  ≈ {((classSecondsPerKid - classNameCardSec) / Math.max(1, classPhotosPerKid)).toFixed(1)}s per photo
                </span>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>Name card (seconds)</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  step={0.1}
                  value={classNameCardSec}
                  onChange={(e) => setClassNameCardSec(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
                  disabled={isBusy}
                  style={{ padding: "6px 8px", borderRadius: 4, border: "1px solid #cbd5e1" }}
                />
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  {classNameCardSec === 0 ? "Disabled" : "Shown before each kid's photos"}
                </span>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>Resolution</span>
                <select
                  value={classResolution}
                  onChange={(e) => setClassResolution((e.target.value === "720p" ? "720p" : "1080p"))}
                  disabled={isBusy}
                  style={{ padding: "6px 8px", borderRadius: 4, border: "1px solid #cbd5e1" }}
                >
                  <option value="1080p">1080p (1920×1080)</option>
                  <option value="720p">720p (1280×720) — faster</option>
                </select>
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  Drag kids below to reorder
                </span>
              </label>
            </div>

            {/* Per-kid order + inclusion. Drag rows to reorder,
                uncheck to exclude from the render. */}
            {layout.child_folders.length > 0 && (() => {
              const byId = new Map(layout.child_folders.map((c) => [c.student_id, c]));
              const displayed = classReelOrder
                .map((id) => byId.get(id))
                .filter((c): c is ChildFolder => c !== undefined);
              const excludedSet = new Set(classReelExcluded);
              const includedCount = displayed.filter((c) => !excludedSet.has(c.student_id)).length;
              return (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#334155" }}>
                      Play order ({includedCount} of {displayed.length} kids · ≈ {Math.round(includedCount * classSecondsPerKid / 60)} min)
                    </div>
                    <button
                      type="button"
                      className="btn"
                      onClick={resetClassReelOrder}
                      disabled={isBusy}
                      style={{ fontSize: 12, padding: "4px 10px" }}
                    >
                      Reset to A-Z
                    </button>
                  </div>
                  <ol
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      maxHeight: 320,
                      overflowY: "auto",
                      border: "1px solid #e2e8f0",
                      borderRadius: 6,
                      background: "white",
                    }}
                  >
                    {displayed.map((c, idx) => {
                      const isDragging = dragIndex === idx;
                      const isTarget = dragOverIndex === idx && dragIndex !== null && dragIndex !== idx;
                      const included = !excludedSet.has(c.student_id);
                      return (
                        <li
                          key={c.student_id}
                          draggable={!isBusy}
                          onDragStart={(e) => {
                            if (isBusy) return;
                            setDragIndex(idx);
                            // Firefox needs a non-empty dataTransfer to start the drag.
                            e.dataTransfer.effectAllowed = "move";
                            try { e.dataTransfer.setData("text/plain", String(idx)); } catch { /* ignore */ }
                          }}
                          onDragOver={(e) => {
                            if (dragIndex === null) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            if (dragOverIndex !== idx) setDragOverIndex(idx);
                          }}
                          onDragLeave={() => {
                            if (dragOverIndex === idx) setDragOverIndex(null);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragIndex !== null) moveClassReelKid(dragIndex, idx);
                            setDragIndex(null);
                            setDragOverIndex(null);
                          }}
                          onDragEnd={() => {
                            setDragIndex(null);
                            setDragOverIndex(null);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "8px 12px",
                            borderBottom: idx < displayed.length - 1 ? "1px solid #f1f5f9" : "none",
                            background: isTarget
                              ? "#dbeafe"
                              : isDragging
                                ? "#f1f5f9"
                                : included ? "white" : "#f8fafc",
                            opacity: included ? 1 : 0.55,
                            cursor: isBusy ? "not-allowed" : "grab",
                            transition: "background 100ms ease-out",
                          }}
                          title="Drag to reorder"
                        >
                          <span
                            aria-hidden="true"
                            style={{ color: "#94a3b8", fontSize: 16, lineHeight: 1, userSelect: "none" }}
                          >
                            ⋮⋮
                          </span>
                          <span style={{
                            fontSize: 12,
                            color: "#64748b",
                            width: 28,
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                          }}>
                            {idx + 1}.
                          </span>
                          <input
                            type="checkbox"
                            checked={included}
                            onChange={(e) => toggleClassReelKid(c.student_id, e.target.checked)}
                            disabled={isBusy}
                            aria-label={`Include ${c.display_name} in class reel`}
                            style={{ cursor: isBusy ? "not-allowed" : "pointer" }}
                          />
                          <span style={{
                            flex: 1,
                            fontSize: 14,
                            color: included ? "#0f172a" : "#94a3b8",
                            textDecoration: included ? "none" : "line-through",
                          }}>
                            {c.display_name}
                          </span>
                          {/* Small nudge arrows for keyboard / non-drag users. */}
                          <button
                            type="button"
                            className="btn"
                            onClick={() => moveClassReelKid(idx, idx - 1)}
                            disabled={isBusy || idx === 0}
                            aria-label={`Move ${c.display_name} up`}
                            style={{ padding: "2px 8px", fontSize: 12 }}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => moveClassReelKid(idx, idx + 1)}
                            disabled={isBusy || idx === displayed.length - 1}
                            aria-label={`Move ${c.display_name} down`}
                            style={{ padding: "2px 8px", fontSize: 12 }}
                          >
                            ↓
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              );
            })()}
          </details>
        </section>
      )}

      {/* Progress + log */}
      {(progress || log.length > 0 || preflight || runSummary) && (
        <section className="card" style={{ padding: 20 }}>
          <h2 style={{ marginTop: 0 }}>Progress</h2>
          {runSummary && !isBusy && (
            <div
              role="status"
              aria-live="polite"
              style={{
                marginBottom: 16,
                padding: "14px 16px",
                background: "#ecfdf5",
                border: "1px solid #6ee7b7",
                borderRadius: 8,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: "#065f46", fontSize: 15, marginBottom: 4 }}>
                  {runSummary.title}
                </div>
                <div style={{ color: "#047857", fontSize: 13, wordBreak: "break-all" }}>
                  {runSummary.detail}
                </div>
              </div>
              <button
                className="btn"
                style={{ flexShrink: 0 }}
                onClick={() => setRunSummary(null)}
                aria-label="Dismiss completion banner"
              >
                Dismiss
              </button>
            </div>
          )}
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
                  Photos are matched by filename. Any of these work (with or without spaces, extension optional): <code>Beau.jpg</code>, <code>Beau Seymour.jpg</code>, <code>BeauSeymour.jpg</code>, <code>Beau Andrew Seymour.jpg</code>, <code>BeauAndrewSeymour.jpg</code>. If multiple photos match, up to 4 will be placed on the slide.
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
      {/* v3.8.0: Email-reels-to-parents modal */}
      {emailModal && layout && (
        <div
          onClick={() => { void closeEmailModal(); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.55)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white", borderRadius: 12, maxWidth: 820, width: "94%",
              maxHeight: "90vh", overflowY: "auto",
              padding: 28, boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: 4 }}>📧 Email reels to parents</h2>
            <p style={{ marginTop: 0, color: "#64748b", fontSize: 13 }}>
              Each selected child's reel is attached to a separate email and sent to
              the email address(es) on file. Templates use{" "}
              <code>{"{{student}}"}</code>, <code>{"{{year}}"}</code>,{" "}
              <code>{"{{parent_name}}"}</code>, <code>{"{{contact_email}}"}</code>,
              <code>{"{{contact_phone}}"}</code>.
            </p>

            <label style={{ display: "block", marginTop: 12, fontSize: 13, fontWeight: 500 }}>
              Subject
            </label>
            <input
              type="text"
              value={emailModal.subject}
              disabled={emailModal.sending}
              onChange={(e) => setEmailModal({ ...emailModal, subject: e.target.value, templateDirty: true })}
              style={{
                width: "100%", padding: "8px 10px", borderRadius: 6,
                border: "1px solid #cbd5e1", fontSize: 14, marginTop: 4,
              }}
            />

            <label style={{ display: "block", marginTop: 12, fontSize: 13, fontWeight: 500 }}>
              Body
            </label>
            <textarea
              value={emailModal.body}
              disabled={emailModal.sending}
              onChange={(e) => setEmailModal({ ...emailModal, body: e.target.value, templateDirty: true })}
              rows={8}
              style={{
                width: "100%", padding: "8px 10px", borderRadius: 6,
                border: "1px solid #cbd5e1", fontSize: 13, marginTop: 4,
                fontFamily: "inherit", resize: "vertical",
              }}
            />

            {emailModal.rows.length === 0 ? (
              <div style={{ marginTop: 16, padding: 20, background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, color: "#92400e", fontSize: 13 }}>
                <strong>No per-child MP4s found in the output folder yet.</strong>
                <div style={{ marginTop: 6 }}>
                  Render each child's reel first (Step 4 → <em>Per-child only</em>{" "}
                  or <em>Render everything</em>), then reopen this dialog.
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 16, border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead style={{ background: "#f8fafc" }}>
                    <tr>
                      <th style={{ padding: "8px 10px", textAlign: "left", width: 40 }}>Send</th>
                      <th style={{ padding: "8px 10px", textAlign: "left" }}>Child</th>
                      <th style={{ padding: "8px 10px", textAlign: "left" }}>Parent email(s)</th>
                      <th style={{ padding: "8px 10px", textAlign: "left" }}>Reel file</th>
                      <th style={{ padding: "8px 10px", textAlign: "right", width: 80 }}>Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {emailModal.rows.map((r, i) => {
                      const noEmail = r.emails.length === 0;
                      const sizeMb = r.video_size_bytes > 0 ? r.video_size_bytes / (1024 * 1024) : 0;
                      const oversize = sizeMb > 24;
                      return (
                        <tr key={r.student_id} style={{ borderTop: "1px solid #e2e8f0", opacity: noEmail ? 0.55 : 1 }}>
                          <td style={{ padding: "6px 10px" }}>
                            <input
                              type="checkbox"
                              checked={r.include && !noEmail}
                              disabled={noEmail || emailModal.sending}
                              onChange={(e) => {
                                const rows = [...emailModal.rows];
                                rows[i] = { ...rows[i], include: e.target.checked };
                                setEmailModal({ ...emailModal, rows });
                              }}
                            />
                          </td>
                          <td style={{ padding: "6px 10px" }}>{r.student_name}</td>
                          <td style={{ padding: "6px 10px", color: noEmail ? "#dc2626" : "#0f172a" }}>
                            {noEmail ? "no email on file" : r.emails.join(", ")}
                          </td>
                          <td style={{ padding: "6px 10px", color: "#64748b", fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}>
                            {r.video_filename}
                          </td>
                          <td style={{ padding: "6px 10px", textAlign: "right", color: oversize ? "#dc2626" : "#64748b", fontVariantNumeric: "tabular-nums" }}>
                            {sizeMb > 0
                              ? `${sizeMb.toFixed(1)} MB${oversize ? " ⚠" : ""}`
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {emailModal.rows.some((r) => r.video_size_bytes / (1024 * 1024) > 24) && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#dc2626" }}>
                ⚠ Files over 24 MB may be rejected by SMTP. Consider uncheck­ing
                them or sharing via a cloud link instead.
              </div>
            )}

            {emailModal.log.length > 0 && (
              <pre
                style={{
                  marginTop: 12, background: "#0f172a", color: "#e2e8f0",
                  padding: 12, borderRadius: 8, maxHeight: 180, overflowY: "auto",
                  fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, monospace",
                }}
              >
                {emailModal.log.join("\n")}
              </pre>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              {emailModal.sending && (
                <button className="btn danger" onClick={cancelEmailBatch}>
                  Cancel send
                </button>
              )}
              <button
                className="btn"
                onClick={() => { void closeEmailModal(); }}
                disabled={emailModal.sending}
              >
                Close
              </button>
              <button
                className="btn primary"
                onClick={sendReelEmails}
                disabled={
                  emailModal.sending ||
                  emailModal.rows.filter((r) => r.include && r.emails.length > 0).length === 0
                }
              >
                {emailModal.sending
                  ? "Sending..."
                  : `Send ${emailModal.rows.filter((r) => r.include && r.emails.length > 0).length} emails`}
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
