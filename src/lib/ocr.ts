// Consensus OCR wrapper — calls extract_timesheet_consensus (3 providers
// in parallel) and computes per-cell agreement across their outputs.
import { invoke } from "@tauri-apps/api/core";
import { matchStaffByName } from "./staff";
import type { Staff } from "../types";
import type { ExtractedRow } from "./gemini";

export type ProviderName = "gemini_pro" | "gpt5" | "mistral_ocr";
export const PROVIDER_LABELS: Record<ProviderName, string> = {
  gemini_pro: "Gemini Flash",
  gpt5: "Mistral Document AI",
  mistral_ocr: "Mistral OCR (digits)",
};

// Mistral OCR contributes only raw per-day digit reads (no staff name, no
// AM/PM). Its rows come back tagged with this sentinel staff_name; the
// consensus computer routes them to a numeric-witness map keyed by work_date.
export const MISTRAL_DIGITS_SENTINEL = "__mistral_digits__";

export interface ProviderOutput {
  provider: ProviderName;
  ok: boolean;
  rows: ExtractedRow[];
  detected_month_year: string | null;
  raw_text: string;
  error: string | null;
  latency_ms: number;
}
export interface ConsensusResult {
  providers: ProviderOutput[];
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

export async function extractTimesheetConsensus(opts: {
  geminiKey: string | null;
  azureKey: string | null;
  imageBytes: Uint8Array;
  mimeType: string;
  monthYear: string;
  knownStaffNames: string[];
}): Promise<ConsensusResult> {
  const image_b64 = bytesToB64(opts.imageBytes);
  return await invoke<ConsensusResult>("extract_timesheet_consensus", {
    args: {
      image_b64,
      mime_type: opts.mimeType,
      month_year: opts.monthYear,
      known_staff_names: opts.knownStaffNames,
      gemini_api_key: opts.geminiKey,
      azure_ai_key: opts.azureKey,
    },
  });
}

// ─── Per-cell voting ──────────────────────────────────────────────────
// Each provider's rows are aligned by (matched_staff_id, work_date).
// For each key, we build a ConsensusRow with per-field vote arrays.
export type Confidence = "green" | "yellow" | "red";

export interface CellVote {
  provider: ProviderName;
  value: string | null;   // null = provider missed the row OR said null
  sawRow: boolean;        // did this provider produce a row for this key at all?
}

export interface ConsensusCell {
  value: string | null;         // majority or user-edited
  votes: CellVote[];
  confidence: Confidence;
  edited: boolean;              // user overrode
}

export interface ConsensusRow {
  key: string;                  // staff_id + "|" + work_date
  staff_id: number;
  staff_name_canonical: string; // staff.name from DB
  staff_names_seen: string[];   // what each provider actually wrote (for tooltip)
  work_date: string;
  in_time: ConsensusCell;
  out_time: ConsensusCell;
  no_lunch: ConsensusCell;      // value is "true"/"false" string
  phantom: boolean;             // only 1 provider saw this row
  row_confidence: Confidence;
  warnings: string[];           // domain-rule flags (weekend, out-of-hours)
}

export interface ConsensusAlignment {
  rows: ConsensusRow[];
  unmatchedNames: string[];     // OCR-said names that we couldn't map to a staff row
  detectedMonthYear: string | null;  // majority-voted month across providers
  succeededProviders: ProviderName[];
  failedProviders: Array<{ provider: ProviderName; error: string }>;
}

function cellConfidence(
  votes: CellVote[],
  effectiveCount: number,
): { value: string | null; confidence: Confidence } {
  const seen = votes.filter((v) => v.sawRow);
  if (seen.length === 0) return { value: null, confidence: "red" };
  if (seen.length === 1) {
    // Only 1 effective provider overall → single-source, yellow (not red)
    // so user can still review + import. If other providers were effective
    // and this one wasn't seen there, it's a phantom → red.
    const conf: Confidence = effectiveCount <= 1 ? "yellow" : "red";
    return { value: seen[0].value, confidence: conf };
  }

  const values = seen.map((v) => v.value);
  const nonNullValues = values.filter((v): v is string => v !== null);
  const distinct = new Set(values);
  const distinctNonNull = new Set(nonNullValues);

  // Every provider that saw the row agrees on the same value (incl. null).
  if (distinct.size === 1) return { value: values[0], confidence: "green" };

  // 3-provider case: proper majority (>=2 of 3 agree on a non-null value).
  if (seen.length >= 3) {
    const counts = new Map<string | null, number>();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    for (const [v, c] of counts) {
      if (c >= 2 && v !== null) return { value: v, confidence: "yellow" };
    }
    return { value: null, confidence: "red" };
  }

  // 2-provider disagreement fallbacks (Mistral offline etc):
  // one said X, the other said null → prefer X, yellow (soft agreement).
  if (distinctNonNull.size === 1 && nonNullValues.length === 1) {
    return { value: nonNullValues[0], confidence: "yellow" };
  }
  // both said different non-null values → red, no majority.
  return { value: null, confidence: "red" };
}

function normalizeTime(t: string | null | undefined): string | null {
  if (!t) return null;
  const m = t.trim().match(/^(\d{1,2}):?(\d{2})?$/);
  if (!m) return t.trim();
  const h = Number(m[1]);
  const mm = Number(m[2] ?? "0");
  if (Number.isNaN(h) || Number.isNaN(mm) || h > 23 || mm > 59) return t.trim();
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function computeConsensus(
  result: ConsensusResult,
  staff: Staff[],
  sheetMonthOverride: string | null,   // e.g. from QR — re-stamps every row's YYYY-MM
): ConsensusAlignment {
  const succeeded: ProviderOutput[] = result.providers.filter((p) => p.ok);
  const failed = result.providers.filter((p) => !p.ok)
    .map((p) => ({ provider: p.provider, error: p.error || "unknown" }));

  // Separate Mistral (numeric witness) from the semantic voters (Gemini + GPT).
  // Mistral rows all carry the sentinel staff_name; the numericGrid maps
  // work_date → literal digit reads, used only to corroborate/tiebreak the
  // semantic providers' times. Mistral does NOT vote on staff name or no_lunch.
  const mistralProvider = succeeded.find((p) => p.provider === "mistral_ocr");
  const numericGrid = new Map<string, { in: string | null; out: string | null }>();
  if (mistralProvider) {
    for (const r of mistralProvider.rows) {
      if (r.staff_name !== MISTRAL_DIGITS_SENTINEL) continue;
      numericGrid.set(r.work_date, { in: r.in_time ?? null, out: r.out_time ?? null });
    }
  }
  const mistralOk = mistralProvider?.ok ?? false;
  const mistralHasDigits = numericGrid.size > 0;

  // Semantic voters = Gemini + GPT (whoever succeeded AND returned rows).
  const semantic = succeeded.filter((p) =>
    p.provider !== "mistral_ocr" && p.rows.length > 0
  );
  const effectiveCount = semantic.length;

  // Majority-vote detected month across effective providers (including Mistral).
  const monthVotes = succeeded.map((p) => p.detected_month_year).filter((x): x is string => !!x);
  const monthCounts = new Map<string, number>();
  for (const m of monthVotes) monthCounts.set(m, (monthCounts.get(m) || 0) + 1);
  let detectedMonthYear: string | null = null;
  let best = 0;
  for (const [m, c] of monthCounts) if (c > best) { detectedMonthYear = m; best = c; }
  const monthKey = sheetMonthOverride || detectedMonthYear;

  // Re-stamp helper for Mistral's numeric grid too (if we resolved the month).
  if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) {
    const restamped = new Map<string, { in: string | null; out: string | null }>();
    for (const [wd, v] of numericGrid) {
      const nd = wd.length >= 10 ? `${monthKey}-${wd.slice(8, 10)}` : wd;
      restamped.set(nd, v);
    }
    numericGrid.clear();
    for (const [k, v] of restamped) numericGrid.set(k, v);
  }

  // Bucket each semantic provider's rows by (staff_id, work_date).
  type Bucket = { staff_id: number; staff_name_canonical: string; work_date: string;
                  per: Partial<Record<ProviderName, ExtractedRow & { rawName: string }>>;
                  names_seen: Set<string> };
  const buckets = new Map<string, Bucket>();
  const unmatchedNames = new Set<string>();

  for (const p of semantic) {
    for (const r of p.rows) {
      const match = matchStaffByName(r.staff_name, staff);
      if (!match) { unmatchedNames.add(r.staff_name); continue; }
      let workDate = r.work_date;
      if (monthKey && /^\d{4}-\d{2}$/.test(monthKey) && workDate.length >= 10) {
        workDate = `${monthKey}-${workDate.slice(8, 10)}`;
      }
      const key = `${match.id}|${workDate}`;
      let b = buckets.get(key);
      if (!b) {
        b = { staff_id: match.id, staff_name_canonical: match.name, work_date: workDate,
              per: {}, names_seen: new Set() };
        buckets.set(key, b);
      }
      b.per[p.provider] = { ...r, rawName: r.staff_name };
      b.names_seen.add(r.staff_name);
    }
  }

  const semanticOrder: ProviderName[] = ["gemini_pro", "gpt5"];

  const rows: ConsensusRow[] = [];
  for (const [key, b] of buckets) {
    // Build vote array from semantic providers only.
    const mkVotes = (field: "in_time" | "out_time" | "no_lunch"): CellVote[] => {
      return semanticOrder.map((prov) => {
        const isEffective = semantic.some((s) => s.provider === prov);
        if (!isEffective) {
          return { provider: prov, value: null, sawRow: false };
        }
        const row = b.per[prov];
        if (!row) return { provider: prov, value: null, sawRow: false };
        let val: string | null;
        if (field === "no_lunch") val = row.no_lunch ? "true" : "false";
        else val = normalizeTime((row as any)[field]);
        return { provider: prov, value: val, sawRow: true };
      });
    };

    const inVotes = mkVotes("in_time");
    const outVotes = mkVotes("out_time");
    const nlVotes = mkVotes("no_lunch");

    // Base semantic consensus.
    let inCell: ConsensusCell = { ...cellConfidence(inVotes, effectiveCount), votes: inVotes, edited: false };
    let outCell: ConsensusCell = { ...cellConfidence(outVotes, effectiveCount), votes: outVotes, edited: false };
    const nlCell: ConsensusCell = { ...cellConfidence(nlVotes, effectiveCount), votes: nlVotes, edited: false };

    // Apply Mistral numeric-witness corroboration to in/out times.
    // Mistral appears as an extra vote entry (for tooltip visibility) and can
    // (a) upgrade a yellow to green when it matches, or
    // (b) tiebreak two disagreeing semantic providers by picking the one whose
    //     digits match Mistral's read (mod 12 for OUT, since Mistral reads
    //     literal digits without AM/PM inference).
    const witness = numericGrid.get(b.work_date);
    inCell = applyMistralWitness(inCell, witness?.in ?? null, "in", mistralOk, mistralHasDigits);
    outCell = applyMistralWitness(outCell, witness?.out ?? null, "out", mistralOk, mistralHasDigits);

    // Also add a Mistral placeholder vote to nlCell for tooltip consistency
    // (Mistral doesn't vote on no_lunch — sawRow=false).
    nlCell.votes = [...nlCell.votes, { provider: "mistral_ocr", value: null, sawRow: false }];

    // sawCount = number of semantic providers that produced this row.
    const sawCount = semanticOrder.filter((p) => b.per[p]).length;
    // Phantom = one semantic provider invented this row when the other should have seen it.
    const phantom = sawCount === 1 && effectiveCount >= 2;
    const worst: Confidence = [inCell.confidence, outCell.confidence, nlCell.confidence]
      .reduce<Confidence>((w, c) => (rank(c) > rank(w) ? c : w), "green");
    const rowConf: Confidence = phantom ? "red" : worst;

    rows.push({
      key,
      staff_id: b.staff_id,
      staff_name_canonical: b.staff_name_canonical,
      staff_names_seen: Array.from(b.names_seen),
      work_date: b.work_date,
      in_time: inCell,
      out_time: outCell,
      no_lunch: nlCell,
      phantom,
      row_confidence: rowConf,
      warnings: [],
    });
  }

  // ─── Domain rules ───────────────────────────────────────────────────
  // Applied after consensus voting. These flag business-logic anomalies
  // (weekends, out-of-hours) and downgrade confidence so Mom reviews them.
  for (const r of rows) {
    const w: string[] = [];
    // Weekend flag — daycare operates Mon–Fri only.
    // work_date is YYYY-MM-DD in local calendar terms; use UTC parse to avoid TZ drift.
    const d = new Date(`${r.work_date}T12:00:00Z`);
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) {
      w.push(`Weekend (${dow === 0 ? "Sunday" : "Saturday"}) — center closed`);
    }
    // Time-window flags.
    const inHM = parseHM(r.in_time.value ?? "");
    const outHM = parseHM(r.out_time.value ?? "");
    if (inHM && (inHM.h * 60 + inHM.m) < (7 * 60 + 30)) {
      w.push(`IN ${r.in_time.value} is before 07:30`);
    }
    if (outHM && (outHM.h * 60 + outHM.m) > (17 * 60 + 30)) {
      w.push(`OUT ${r.out_time.value} is after 17:30`);
    }
    if (w.length > 0) {
      r.warnings = w;
      // A warning always downgrades confidence to at least yellow so the row
      // shows amber. Weekend rows go straight to red (should never import).
      if (dow === 0 || dow === 6) r.row_confidence = "red";
      else if (r.row_confidence === "green") r.row_confidence = "yellow";
    }
  }

  rows.sort((a, b) => a.staff_name_canonical.localeCompare(b.staff_name_canonical) || a.work_date.localeCompare(b.work_date));

  // Report succeededProviders including Mistral even in witness mode so the
  // provider health strip shows it. mistralProvider.rows.length reflects
  // digit-witness rows, not consensus rows.
  const succeededProviders: ProviderName[] = succeeded
    .filter((s) => s.rows.length > 0)
    .map((s) => s.provider as ProviderName);

  return {
    rows,
    unmatchedNames: Array.from(unmatchedNames).sort(),
    detectedMonthYear,
    succeededProviders,
    failedProviders: failed as any,
  };
}

// Compare a semantic majority time (HH:MM) against Mistral's literal digit
// read. For OUT times, Mistral reads no AM/PM (e.g. "03:45" vs semantic
// majority "15:45") — so we accept a match mod 12.
function timeMatchesWitness(semantic: string | null, witness: string | null, kind: "in" | "out"): boolean {
  if (!semantic || !witness) return false;
  const s = parseHM(semantic);
  const w = parseHM(witness);
  if (!s || !w) return false;
  if (s.m !== w.m) return false;
  if (s.h === w.h) return true;
  if (kind === "out" && Math.abs(s.h - w.h) === 12) return true;
  return false;
}
function parseHM(t: string): { h: number; m: number } | null {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

// Fold Mistral's per-day digit reading into a cell already scored by the
// semantic voters. Always appends a Mistral vote entry (for the tooltip).
// Rules (per user requirements):
//  - If Mistral matches the semantic value → confirm (green).
//  - If Mistral disagrees with the semantic value → consult Gemini specifically:
//      * Gemini agrees with Mistral → adopt Gemini's value (2-1 majority), yellow.
//      * Gemini agrees with semantic (Doc AI) → keep semantic value, yellow.
//      * Gemini absent → adopt Mistral's digit reading (with AM/PM inference), yellow.
//      * Gemini disagrees with both → keep semantic, yellow (needs human review).
//  - If semantic voters disagreed (red) → tiebreak with whichever matches Mistral.
function applyMistralWitness(
  cell: ConsensusCell,
  witnessValue: string | null,
  kind: "in" | "out",
  mistralOk: boolean,
  mistralHasDigits: boolean,
): ConsensusCell {
  const witnessVote: CellVote = {
    provider: "mistral_ocr",
    value: witnessValue,
    sawRow: mistralOk && witnessValue !== null,
  };
  const nextVotes = [...cell.votes, witnessVote];

  if (!mistralHasDigits || witnessValue === null) {
    return { ...cell, votes: nextVotes };
  }

  const geminiVote = cell.votes.find((v) => v.provider === "gemini_pro");
  const docaiVote = cell.votes.find((v) => v.provider === "gpt5");

  // Case A: semantic voters agreed on a non-null value.
  if (cell.value !== null && cell.confidence !== "red") {
    if (timeMatchesWitness(cell.value, witnessValue, kind)) {
      return { ...cell, votes: nextVotes, confidence: "green" };
    }
    // Semantic vs Mistral mismatch — consult Gemini specifically.
    const gemSaw = !!(geminiVote && geminiVote.sawRow && geminiVote.value);
    const docSaw = !!(docaiVote && docaiVote.sawRow && docaiVote.value);
    if (gemSaw && timeMatchesWitness(geminiVote!.value, witnessValue, kind)) {
      // Gemini + Mistral majority → adopt Gemini's value.
      return { ...cell, votes: nextVotes, value: geminiVote!.value, confidence: "yellow" };
    }
    if (gemSaw && docSaw && geminiVote!.value === cell.value) {
      // Gemini + Doc AI already agree, Mistral is odd one out → keep semantic, yellow.
      return { ...cell, votes: nextVotes, confidence: "yellow" };
    }
    if (!gemSaw) {
      // Only Doc AI voted, no Gemini → prefer Mistral digits per user rule.
      const inferred = inferAmPm(witnessValue, kind);
      return { ...cell, votes: nextVotes, value: inferred, confidence: "yellow" };
    }
    // Gemini disagrees with both semantic and Mistral — leave semantic value, yellow.
    return { ...cell, votes: nextVotes, confidence: "yellow" };
  }

  // Case B: semantic voters disagreed (red) — Mistral tiebreaks.
  const semanticValues = cell.votes.filter((v) => v.sawRow && v.value !== null);
  const matchingVote = semanticValues.find((v) => timeMatchesWitness(v.value, witnessValue, kind));
  if (matchingVote && matchingVote.value !== null) {
    return { ...cell, votes: nextVotes, value: matchingVote.value, confidence: "yellow" };
  }
  // No semantic vote matches — fall back to Mistral itself (best-effort AM/PM).
  const inferred = inferAmPm(witnessValue, kind);
  return { ...cell, votes: nextVotes, value: inferred, confidence: "yellow" };
}

// Mistral writes literal digits (no AM/PM). For OUT times a small hour is
// almost certainly PM at a daycare (e.g. "3 20" → 15:20). IN times are read
// as-is (morning).
function inferAmPm(witness: string, kind: "in" | "out"): string {
  const hm = parseHM(witness);
  if (!hm) return witness;
  if (kind === "out" && hm.h >= 1 && hm.h <= 11) {
    return `${String(hm.h + 12).padStart(2, "0")}:${String(hm.m).padStart(2, "0")}`;
  }
  return `${String(hm.h).padStart(2, "0")}:${String(hm.m).padStart(2, "0")}`;
}

function rank(c: Confidence): number {
  return c === "red" ? 2 : c === "yellow" ? 1 : 0;
}

export function editCell(cell: ConsensusCell, newValue: string | null): ConsensusCell {
  return { ...cell, value: newValue, confidence: "green", edited: true };
}
