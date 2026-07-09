import { useEffect, useState } from "react";

// Shared long-wait progress banner for AI/OCR flows (monthly attendance,
// staff credentials, etc). We don't have Tauri events wired for per-stage
// progress from the Rust side yet, so the stages here are time-based
// approximations calibrated to what the models actually take on typical
// input sizes. That's still dramatically better than a static toast —
// the user sees the elapsed clock, an active phase, and rough ETA.
//
// stages: ordered list of { label, expectedMs }. The banner walks through
// them as wall time passes; the last stage lingers indefinitely once
// reached (until the parent unmounts the banner). Set `active` to false
// (or unmount the banner) as soon as the underlying op resolves.

export interface OcrProgressStage {
  label: string;
  expectedMs: number;
}

export interface OcrProgressBannerProps {
  /** When false the banner is hidden entirely. */
  active: boolean;
  /** Ordered stages; when total elapsed passes a stage's cumulative expected time, we advance. */
  stages: OcrProgressStage[];
  /** Optional trailing hint (small grey text under the bar). */
  hint?: string;
}

export function OcrProgressBanner({ active, stages, hint }: OcrProgressBannerProps) {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!active) { setElapsedMs(0); return; }
    const started = Date.now();
    const id = window.setInterval(() => setElapsedMs(Date.now() - started), 250);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active) return null;

  // Walk stages by cumulative expected time. Last stage stays active
  // even if we overshoot its estimate.
  let cumulative = 0;
  let currentIdx = stages.length - 1;
  for (let i = 0; i < stages.length; i++) {
    cumulative += stages[i].expectedMs;
    if (elapsedMs < cumulative) { currentIdx = i; break; }
  }
  const totalExpected = stages.reduce((n, s) => n + s.expectedMs, 0);
  const pct = Math.min(100, Math.round((elapsedMs / totalExpected) * 100));
  const secs = Math.round(elapsedMs / 1000);

  return (
    <div style={{
      padding: 14, marginBottom: 12, background: "#eff6ff",
      border: "1px solid #bfdbfe", borderRadius: 8, color: "#1e3a8a",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <span style={{ fontSize: 20 }}>⏳</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{stages[currentIdx].label}</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Step {currentIdx + 1} of {stages.length} · {secs}s elapsed
          </div>
        </div>
      </div>
      <div style={{
        height: 6, background: "#dbeafe", borderRadius: 3, overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`, height: "100%", background: "#3b82f6",
          transition: "width 400ms ease-out",
        }} />
      </div>
      {hint && <div style={{ marginTop: 6, fontSize: 11, opacity: 0.7 }}>{hint}</div>}
    </div>
  );
}

// Preset stage list for the monthly attendance dual-model OCR run.
// Calibrated to typical wall clock ~50-120s (post-downscale, medium reasoning).
export const MONTH_OCR_STAGES: OcrProgressStage[] = [
  { label: "Reading file & downscaling for AI…", expectedMs: 3_000 },
  { label: "Sending to both vision models in parallel…", expectedMs: 2_000 },
  { label: "Primary (gpt-5.4) analysing the grid…", expectedMs: 75_000 },
  { label: "Reconciling results between models…", expectedMs: 5_000 },
];

// Preset for staff credential AI reads (single model, faster).
export const CREDENTIAL_OCR_STAGES: OcrProgressStage[] = [
  { label: "Reading credential document…", expectedMs: 3_000 },
  { label: "Extracting fields with AI…", expectedMs: 20_000 },
];
