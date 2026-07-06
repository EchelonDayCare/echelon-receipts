// Consensus OCR wrapper — calls extract_timesheet_consensus (3 providers
// in parallel) and computes per-cell agreement across their outputs.
import { invoke } from "@tauri-apps/api/core";
import { matchStaffByName } from "./staff";
import type { Staff } from "../types";
import type { ExtractedRow } from "./ai";

export type ProviderName = "gpt5" | "mistral_ocr" | "azure_di";
export const PROVIDER_LABELS: Record<ProviderName, string> = {
  gpt5: "Mistral Document AI",
  mistral_ocr: "Mistral OCR (digits)",
  azure_di: "Azure Document Intelligence",
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
  imageBytes: Uint8Array;
  mimeType: string;
  monthYear: string;
  knownStaffNames: string[];
  enableMistralOcr?: boolean;
  enableAzureDi?: boolean;
}): Promise<ConsensusResult> {
  const image_b64 = bytesToB64(opts.imageBytes);
  return await invoke<ConsensusResult>("extract_timesheet_consensus", {
    args: {
      image_b64,
      mime_type: opts.mimeType,
      month_year: opts.monthYear,
      known_staff_names: opts.knownStaffNames,
      enable_mistral_ocr: opts.enableMistralOcr ?? true,
      enable_azure_di: opts.enableAzureDi ?? true,
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
  synthetic?: boolean;          // true = calendar-filler row (Doc AI didn't emit it)
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

  // Separate Mistral OCR (numeric witness) from the semantic voters
  // (Mistral Document AI + GPT vision). Mistral OCR rows all carry the
  // sentinel staff_name; the numericGrid maps work_date → literal digit
  // reads, used only to corroborate/tiebreak the semantic providers' times.
  // Mistral OCR does NOT vote on staff name or no_lunch.
  const mistralProvider = succeeded.find((p) => p.provider === "mistral_ocr");
  // Mistral emits one row per staff column per date (up to 4 for this sheet)
  // but they all share the sentinel staff_name — so we can't attribute them
  // to a specific staff. Keep the full list per date and pick the best match
  // per bucket by digit-similarity to the semantic IN vote.
  const numericGrid = new Map<string, Array<{ in: string | null; out: string | null }>>();
  if (mistralProvider) {
    for (const r of mistralProvider.rows) {
      if (r.staff_name !== MISTRAL_DIGITS_SENTINEL) continue;
      const list = numericGrid.get(r.work_date) ?? [];
      list.push({ in: r.in_time ?? null, out: r.out_time ?? null });
      numericGrid.set(r.work_date, list);
    }
  }
  const mistralOk = mistralProvider?.ok ?? false;
  const mistralHasDigits = numericGrid.size > 0;

  // Semantic voters = Mistral Document AI + GPT (whoever succeeded AND returned rows).
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
    const restamped = new Map<string, Array<{ in: string | null; out: string | null }>>();
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
      // Reject rows for calendar days that don't exist in this month
      // (e.g. Doc AI hallucinates day 31 in June, or day 30 in February).
      const dm = workDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dm) {
        const yy = Number(dm[1]), mm = Number(dm[2]), dd = Number(dm[3]);
        const daysIn = new Date(yy, mm, 0).getDate();
        if (dd < 1 || dd > daysIn) continue;
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

  const semanticOrder: ProviderName[] = ["gpt5", "azure_di"];

  // ─── Deterministic bucket iteration ─────────────────────────────────
  // Process buckets in (date, priority, staff_id) order so witness-row
  // consumption is stable across runs. Priority: buckets whose semantic
  // voters AGREE on IN are processed first (their witness matches are
  // unambiguous), then single-source, then disagreements. This makes the
  // ambiguous cases pick from what's LEFT after the obvious matches have
  // been claimed — exactly what solves Sage 06-17 in the Jun-2026 sheet.
  const bucketPriority = (b: Bucket): number => {
    const ins = semanticOrder.map((p) => {
      const row = b.per[p];
      return row ? normalizeTime(row.in_time) : null;
    });
    const nonNull = ins.filter((v): v is string => v !== null);
    if (nonNull.length === 0) return 3;
    if (nonNull.length === 1) return 1;
    return nonNull.every((v) => v === nonNull[0]) ? 0 : 2;
  };
  const bucketKeys = Array.from(buckets.keys()).sort((a, b) => {
    const ba = buckets.get(a)!;
    const bb = buckets.get(b)!;
    if (ba.work_date !== bb.work_date) return ba.work_date.localeCompare(bb.work_date);
    const pa = bucketPriority(ba);
    const pb = bucketPriority(bb);
    if (pa !== pb) return pa - pb;
    return ba.staff_id - bb.staff_id;
  });

  // Witness rows are numbered per-date; once a bucket claims an index the
  // same index cannot be reused by another bucket on the same date.
  const consumedWitness = new Map<string, Set<number>>();
  // Track (staff_id → normalized column positions) of every witness match
  // so we can later estimate each staff's column identity for the recovery
  // pass. Normalized = matched_index / (rows_for_that_date - 1), 0..1.
  const witnessPositions = new Map<number, number[]>();

  const rows: ConsensusRow[] = [];
  const phantomKeys: string[] = [];  // buckets to drop AFTER loop so
                                     // calendar synthesis re-emits them as
                                     // empty placeholders rather than
                                     // showing hallucinated values.
  for (const key of bucketKeys) {
    const b = buckets.get(key)!;
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
    // Mistral rows aren't attributed to a specific staff column, so we
    // pick the Mistral row for this date whose IN best matches this
    // bucket's semantic IN (mod 12). When semantic voters disagree
    // (inCell.value is null/red), try to match against ANY individual
    // semantic IN vote so we can still tiebreak.
    const semanticIns = inCell.votes
      .filter((v) => v.sawRow && v.value !== null && v.provider !== "mistral_ocr")
      .map((v) => v.value as string);
    const inCandidates = inCell.value ? [inCell.value, ...semanticIns] : semanticIns;
    const witnessArr = numericGrid.get(b.work_date) ?? [];
    const consumed = consumedWitness.get(b.work_date) ?? new Set<number>();
    const picked = pickMistralWitnessWithIndex(witnessArr, inCandidates, consumed);
    const witness = picked?.data ?? null;
    if (picked) {
      if (!consumedWitness.has(b.work_date)) consumedWitness.set(b.work_date, new Set());
      consumedWitness.get(b.work_date)!.add(picked.index);
      // Record normalized column position for this staff.
      const W = witnessArr.length;
      const norm = W > 1 ? picked.index / (W - 1) : 0.5;
      const list = witnessPositions.get(b.staff_id) ?? [];
      list.push(norm);
      witnessPositions.set(b.staff_id, list);
    }
    inCell = applyMistralWitness(inCell, witness?.in ?? null, "in", mistralOk, mistralHasDigits && witness !== null);
    outCell = applyMistralWitness(outCell, witness?.out ?? null, "out", mistralOk, mistralHasDigits && witness !== null);

    // Also add a Mistral placeholder vote to nlCell for tooltip consistency
    // (Mistral doesn't vote on no_lunch — sawRow=false).
    nlCell.votes = [...nlCell.votes, { provider: "mistral_ocr", value: null, sawRow: false }];

    // sawCount = number of semantic providers that produced this row.
    const sawCount = semanticOrder.filter((p) => b.per[p]).length;
    // Phantom = one semantic provider invented this row when the other should
    // have seen it — BUT if Mistral OCR digits corroborate, it's a genuine
    // row that the other semantic voter simply misread (e.g. read "SICK"
    // over faint handwriting). In that case, Mistral is the 2nd witness and
    // we should not flag it phantom.
    const mistralCorroborates = witness !== null && (
      (inCell.confidence !== "red" && witness.in !== null) ||
      (outCell.confidence !== "red" && witness.out !== null)
    );
    const phantom = sawCount === 1 && effectiveCount >= 2 && !mistralCorroborates;

    // Drop phantom rows: a single semantic voter said staff X worked on
    // date Y but neither the other voter nor the digit witness sees it.
    // Almost certainly a column-drift hallucination (e.g. Doc AI Kiran
    // 06-18 = 10:35→12:45 when the sheet actually said OFF/OFF). We
    // remove the bucket too so calendar synth re-emits an empty placeholder
    // for consistent UX with truly-blank days.
    if (phantom) {
      phantomKeys.push(key);
      continue;
    }

    const worst: Confidence = [inCell.confidence, outCell.confidence, nlCell.confidence]
      .reduce<Confidence>((w, c) => (rank(c) > rank(w) ? c : w), "green");
    const rowConf: Confidence = worst;

    rows.push({
      key,
      staff_id: b.staff_id,
      staff_name_canonical: b.staff_name_canonical,
      staff_names_seen: Array.from(b.names_seen),
      work_date: b.work_date,
      in_time: inCell,
      out_time: outCell,
      no_lunch: nlCell,
      phantom: false,
      row_confidence: rowConf,
      warnings: [],
    });
  }
  for (const k of phantomKeys) buckets.delete(k);

  // ─── Witness-only recovery ──────────────────────────────────────────
  // For each date where the digit witness has more rows than the semantic
  // voters accounted for, try to attribute the leftover(s) to active staff
  // whose column position (learned globally from other days) is closest to
  // the leftover row's position in the witness list. Yellow confidence —
  // single-source, needs human review.
  const columnRank = new Map<number, number>();
  for (const [sid, positions] of witnessPositions) {
    if (positions.length === 0) continue;
    const sorted = [...positions].sort((a, b) => a - b);
    columnRank.set(sid, sorted[Math.floor(sorted.length / 2)]);
  }
  const COLUMN_DIST_THRESHOLD = 0.34;  // tolerate ~1 column of drift
  for (const [wDate, witnessArr] of numericGrid) {
    const consumed = consumedWitness.get(wDate) ?? new Set<number>();
    const unclaimed: Array<{ index: number; norm: number }> = [];
    for (let i = 0; i < witnessArr.length; i++) {
      if (consumed.has(i)) continue;
      if (witnessArr[i].in === null && witnessArr[i].out === null) continue;
      const norm = witnessArr.length > 1 ? i / (witnessArr.length - 1) : 0.5;
      unclaimed.push({ index: i, norm });
    }
    if (unclaimed.length === 0) continue;
    const missing = staff.filter((s) =>
      s.active === 1 && !buckets.has(`${s.id}|${wDate}`)
    );
    if (missing.length === 0) continue;
    const assignedStaff = new Set<number>();
    for (const u of unclaimed) {
      let bestStaff: typeof missing[number] | null = null;
      let bestDist = Infinity;
      for (const s of missing) {
        if (assignedStaff.has(s.id)) continue;
        const rank = columnRank.get(s.id);
        if (rank === undefined) continue;  // no signal → don't guess
        const dist = Math.abs(rank - u.norm);
        if (dist < bestDist) { bestDist = dist; bestStaff = s; }
      }
      if (!bestStaff || bestDist > COLUMN_DIST_THRESHOLD) continue;
      assignedStaff.add(bestStaff.id);
      const w = witnessArr[u.index];
      const key = `${bestStaff.id}|${wDate}`;
      // Build a synthetic ConsensusRow: no semantic votes, mistral_ocr is
      // the sole source. applyMistralWitness will fill in the value with
      // yellow confidence and PM inference.
      const emptyInVotes: CellVote[] = semanticOrder.map((prov) => ({ provider: prov, value: null, sawRow: false }));
      const emptyOutVotes: CellVote[] = semanticOrder.map((prov) => ({ provider: prov, value: null, sawRow: false }));
      const emptyNlVotes: CellVote[] = semanticOrder.map((prov) => ({ provider: prov, value: null, sawRow: false }));
      let inC: ConsensusCell = { ...cellConfidence(emptyInVotes, effectiveCount), votes: emptyInVotes, edited: false };
      let outC: ConsensusCell = { ...cellConfidence(emptyOutVotes, effectiveCount), votes: emptyOutVotes, edited: false };
      const nlC: ConsensusCell = { ...cellConfidence(emptyNlVotes, effectiveCount), votes: [...emptyNlVotes, { provider: "mistral_ocr", value: null, sawRow: false }], edited: false };
      inC = applyMistralWitness(inC, w.in, "in", mistralOk, w.in !== null);
      outC = applyMistralWitness(outC, w.out, "out", mistralOk, w.out !== null);
      // Register in buckets so calendar synth skips this date.
      buckets.set(key, {
        staff_id: bestStaff.id,
        staff_name_canonical: bestStaff.name,
        work_date: wDate,
        per: {},
        names_seen: new Set(),
      });
      rows.push({
        key,
        staff_id: bestStaff.id,
        staff_name_canonical: bestStaff.name,
        staff_names_seen: ["(recovered from digit witness)"],
        work_date: wDate,
        in_time: inC,
        out_time: outC,
        no_lunch: nlC,
        phantom: false,
        row_confidence: "yellow",
        warnings: [`Recovered from Mistral OCR digit witness — no semantic voter saw this row. Please verify against the sheet.`],
      });
    }
  }

  // ─── Calendar synthesis ─────────────────────────────────────────────
  // Doc AI is non-deterministic about emitting placeholder rows for empty
  // days (esp. weekends). Fill in every day of the detected month for each
  // staff we already saw at least one row for, so mom sees a full calendar
  // and can spot capture gaps. Synthesized rows have null times and will
  // be flagged by the domain-rules loop below.
  if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) {
    const [yStr, mStr] = monthKey.split("-");
    const year = Number(yStr);
    const month = Number(mStr);
    const daysInMonth = new Date(year, month, 0).getDate();
    const staffSeen = new Map<number, string>();
    for (const b of buckets.values()) staffSeen.set(b.staff_id, b.staff_name_canonical);
    for (const [sid, sname] of staffSeen) {
      for (let day = 1; day <= daysInMonth; day++) {
        const workDate = `${monthKey}-${String(day).padStart(2, "0")}`;
        const key = `${sid}|${workDate}`;
        if (buckets.has(key)) continue;
        const emptyVotes: CellVote[] = semanticOrder.map((prov) => ({ provider: prov, value: null, sawRow: false }));
        const nlEmpty: CellVote[] = [...emptyVotes, { provider: "mistral_ocr", value: null, sawRow: false }];
        const emptyCell = (votes: CellVote[]): ConsensusCell =>
          ({ ...cellConfidence(votes, effectiveCount), votes, edited: false });
        rows.push({
          key,
          staff_id: sid,
          staff_name_canonical: sname,
          staff_names_seen: [],
          work_date: workDate,
          in_time: emptyCell(emptyVotes),
          out_time: emptyCell(emptyVotes),
          no_lunch: emptyCell(nlEmpty),
          phantom: false,
          row_confidence: "green",
          warnings: [],
          synthetic: true,
        });
      }
    }
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
    const isWeekend = dow === 0 || dow === 6;
    if (isWeekend) {
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
    // Empty-day flag — weekday with no times captured.
    if (!isWeekend && !r.in_time.value && !r.out_time.value) {
      w.push(`No times captured for this day — check the sheet`);
    }
    if (w.length > 0) {
      r.warnings = w;
      // A warning always downgrades confidence to at least yellow so the row
      // shows amber. Weekend rows go straight to red (should never import).
      if (isWeekend) r.row_confidence = "red";
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

// Same as pickMistralWitness but accepts multiple candidate IN values (e.g.
// individual disagreeing semantic votes) and a set of already-consumed
// witness row indices. Returns the winning witness row + its index so
// callers can mark it consumed. Iteration is TARGET-FIRST so the highest
// priority semantic vote gets its match preferentially, and CONSUMED rows
// are skipped so one witness row can't be claimed by two staff buckets.
function pickMistralWitnessWithIndex(
  candidates: Array<{ in: string | null; out: string | null }>,
  semanticIns: string[],
  consumed: Set<number>,
): { data: { in: string | null; out: string | null }; index: number } | null {
  if (candidates.length === 0) return null;
  const targets = semanticIns
    .map((s) => parseHM(s))
    .filter((x): x is { h: number; m: number } => x !== null);

  if (targets.length === 0) {
    // No semantic anchor — accept the unique unclaimed candidate if there is
    // exactly one. This is what enables the witness-only recovery pass to
    // fall back through this function safely.
    const available: number[] = [];
    for (let i = 0; i < candidates.length; i++) if (!consumed.has(i)) available.push(i);
    if (available.length === 1) return { data: candidates[available[0]], index: available[0] };
    return null;
  }

  // Targets are ordered by caller priority (semantic-majority value first,
  // then individual voters in semanticOrder). Try each target against every
  // unclaimed candidate before moving to the next target.
  for (const s of targets) {
    for (let i = 0; i < candidates.length; i++) {
      if (consumed.has(i)) continue;
      const c = candidates[i];
      if (!c.in) continue;
      const w = parseHM(c.in);
      if (!w) continue;
      if (w.m === s.m && (w.h === s.h || Math.abs(w.h - s.h) === 12)) {
        return { data: c, index: i };
      }
    }
  }
  return null;
}

// Fold Mistral's per-day digit reading into a cell already scored by
// semantic voters (Doc AI + gpt-5.4). v0.2.5 — true 2-of-3 majority:
//   • Semantic majority (both semantics agree, cell.confidence === "green"):
//       - keep green regardless of digits (2/2 semantic majority already best)
//   • Semantic disagreement (both saw, differ):
//       - if digits match one of the semantic votes → 2/3 majority → green
//         with the winning value
//       - if digits match neither → 3-way split → red (all shown in tooltip)
//       - if digits absent → red
//   • Semantic single-source (one saw, one null, cell.confidence === "yellow"):
//       - digits match the present value → 2 sources agree → green
//       - digits disagree → prefer digits, yellow
//   • Semantic empty (nobody saw the row, cell.value === null):
//       - digits present → adopt digits, yellow with AM/PM inference
//       - digits absent → pass through
function applyMistralWitness(
  cell: ConsensusCell,
  witnessValue: string | null,
  kind: "in" | "out",
  mistralOk: boolean,
  mistralHasDigits: boolean,
): ConsensusCell {
  // Mistral reads literal digits (no AM/PM). For OUT times a small hour is
  // almost certainly PM at a daycare — infer here so the tooltip vote matches
  // the semantic majority (e.g. "02:30" out → "14:30").
  const displayWitness = witnessValue !== null ? inferAmPm(witnessValue, kind) : null;
  const witnessVote: CellVote = {
    provider: "mistral_ocr",
    value: displayWitness,
    sawRow: mistralOk && witnessValue !== null,
  };
  const nextVotes = [...cell.votes, witnessVote];

  // No witness signal at all → pass through untouched.
  if (!mistralHasDigits || witnessValue === null) {
    return { ...cell, votes: nextVotes };
  }

  // Semantic majority already achieved → keep green, ignore digits.
  if (cell.confidence === "green") {
    return { ...cell, votes: nextVotes };
  }

  // Semantic disagreement (both saw, they differ → cellConfidence returned
  // red + null). Reach into individual semantic votes to check which one
  // (if any) matches the digit witness → recover a 2/3 majority.
  if (cell.value === null && cell.confidence === "red") {
    const semanticSeen = cell.votes.filter((v) => v.sawRow && v.value !== null);
    for (const sv of semanticSeen) {
      if (timeMatchesWitness(sv.value, witnessValue, kind)) {
        // 2 of 3 agree → strong majority. Yellow (not green) because one
        // model dissented — user should glance at it.
        return { ...cell, votes: nextVotes, value: sv.value, confidence: "yellow" };
      }
    }
    // Digits agree with neither semantic voter → 3-way split → adopt digits
    // as the least-bad guess but leave red-null? No — adopt digits, yellow.
    // (The alternative red means the row is blocked from import; adopting
    // digits at least gives mom something to review.)
    const inferred = inferAmPm(witnessValue, kind);
    return { ...cell, votes: nextVotes, value: inferred, confidence: "yellow" };
  }

  // Nobody saw the row semantically → adopt digit reading.
  if (cell.value === null) {
    const inferred = inferAmPm(witnessValue, kind);
    return { ...cell, votes: nextVotes, value: inferred, confidence: "yellow" };
  }

  // Semantic single-source (yellow): digits either confirm (→ green) or
  // disagree (→ prefer digits, yellow).
  if (timeMatchesWitness(cell.value, witnessValue, kind)) {
    return { ...cell, votes: nextVotes, confidence: "green" };
  }
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
