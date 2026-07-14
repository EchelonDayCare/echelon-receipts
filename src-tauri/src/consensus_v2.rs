// Staff timesheet OCR pipeline — v2 redesign.
//
// See files/OCR_REDESIGN_PLAN_FINAL.md for the full rationale. Short version:
//
//   The prior pipeline (consensus.rs) keyed consensus on `staff_id | work_date`
//   after each engine had already fuzzy-matched its own guessed staff-name
//   string to the roster. A column whose header no engine could resolve was
//   silently dropped (Kiran, July 2026). A column with a strong-looking
//   header could steal data from a neighbour (Sager, July 2026 — 4 of 5 rows
//   were actually Kiran's or Chloe's cell contents).
//
// v2's primitive is the (column_index, day) cell, not a named row. Each
// engine emits `CellRead { col, day, tokens_in, tokens_out, ... }`. Staff
// identity is resolved ONCE per column, GLOBALLY (one-to-one over roster ∪
// {empty, unknown, new_staff}). Individual cells then vote on times using
// JOINT (IN, OUT) candidate resolution (11:00 → 7:40 becomes 11:00 → 19:40
// because that is the only pair for which out > in and duration is sane).
//
// The pipeline output has three buckets:
//   • confident    — ready to import as-is
//   • please_check — needs a human decision (ambiguous column, soft warning)
//   • couldnt_read — surfaced with reason; user can "keep anyway"
//
// Nothing is silently dropped. Nothing writes to `staff_hours` until
// `commit_ocr_import` is called by the UI.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{Duration, Instant};

use crate::consensus::{
    v2_days_in as days_in,
    v2_detect_month_from_di as detect_month_from_di,
    v2_is_weekend_marker as is_weekend_marker,
    v2_normalize_image as normalize_image,
    v2_normalize_time as normalize_time,
    v2_parse_leading_day as parse_leading_day,
    v2_redact as redact,
    v2_scan_times as scan_times_pure,
    v2_sniff_month_year as sniff_month_year,
    v2_truncate as truncate,
    PROVIDER_MAX_ATTEMPTS_PUB as PROVIDER_MAX_ATTEMPTS,
    PROVIDER_RETRY_BACKOFF_MS_PUB as PROVIDER_RETRY_BACKOFF_MS,
    PROVIDER_TIMEOUT_SECS_PUB as PROVIDER_TIMEOUT_SECS,
};

// ────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DayType {
    Worked,
    Stat,
    Sick,
    Vacation,
    Off,
}

impl DayType {
    fn as_db_str(&self) -> &'static str {
        match self {
            DayType::Worked => "worked",
            DayType::Stat => "stat",
            DayType::Sick => "sick",
            DayType::Vacation => "vacation",
            DayType::Off => "off",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Bbox {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

/// A single cell read from a single engine. `col` is the physical column
/// index on the sheet (0-based, left-to-right). Never contains a staff name.
#[derive(Debug, Clone, Serialize)]
pub struct CellRead {
    pub engine: String,
    pub col: u8,
    pub day: u8,
    /// Raw digit tokens the engine saw in the IN slot, in document order.
    /// Not yet PM-inferred. Empty if the engine saw nothing.
    pub tokens_in: Vec<String>,
    pub tokens_out: Vec<String>,
    pub checkbox_selected: Option<bool>,
    pub is_stat_marker: bool,
    pub confidence: f32,
    pub bbox: Option<Bbox>,
}

/// One engine's read of a column header cell.
#[derive(Debug, Clone, Serialize)]
pub struct HeaderRead {
    pub engine: String,
    pub col: u8,
    pub text: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum ColumnDecision {
    Confident { staff_id: i64, staff_name: String },
    Ambiguous { candidates: Vec<ColumnCandidate> },
    Empty,
    Unknown { header_read: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnCandidate {
    pub staff_id: i64,
    pub staff_name: String,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedColumn {
    pub col: u8,
    pub decision: ColumnDecision,
    pub confidence: f32,
    pub header_reads: Vec<HeaderRead>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "verdict")]
pub enum RowVerdict {
    Confident,
    PleaseCheck { reasons: Vec<String> },
    CouldntRead { reasons: Vec<String> },
}

#[derive(Debug, Clone, Serialize)]
pub struct ProposedRow {
    pub staff_id: Option<i64>,
    pub staff_name: Option<String>,
    pub column_index: u8,
    pub work_date: String,
    pub in_time: Option<String>,
    pub out_time: Option<String>,
    pub no_lunch: bool,
    pub day_type: DayType,
    pub verdict: RowVerdict,
    pub confidence: f32,
    /// Populated only when column decision is Ambiguous; the UI shows the
    /// picker at the column banner and then propagates the choice to every
    /// row in this column.
    pub column_candidates: Vec<ColumnCandidate>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GridConsensusResult {
    pub confident: Vec<ProposedRow>,
    pub please_check: Vec<ProposedRow>,
    pub couldnt_read: Vec<ProposedRow>,
    pub columns: Vec<ResolvedColumn>,
    pub stat_days: Vec<u8>,
    pub detected_month_year: Option<String>,
    pub engines_ok: Vec<String>,
    pub engines_failed: Vec<(String, String)>,
    pub month_key: String,
    /// Debug/telemetry payload: one entry per engine with raw response body
    /// (redacted). Frontend can show this in a collapsible panel.
    pub raw_by_engine: Vec<(String, String)>,
    /// Per-engine cell counts (post-parse, pre-consensus). Frontend uses
    /// this for the "Engine X · N rows" badges above the review table.
    #[serde(default)]
    pub cells_by_engine: Vec<(String, usize)>,
}

// ────────────────────────────────────────────────────────────────────────
// Settings
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CentreHours {
    pub open_min: u32,
    pub close_min: u32,
    pub slack_min: u32,
}

impl CentreHours {
    fn default() -> Self {
        Self { open_min: 7 * 60, close_min: 18 * 60 + 30, slack_min: 60 }
    }
    fn from_strings(open: &str, close: &str, slack: &str) -> Self {
        let parse_hm = |s: &str, fallback: u32| -> u32 {
            if let Some((h, m)) = s.split_once(':') {
                if let (Ok(hh), Ok(mm)) = (h.parse::<u32>(), m.parse::<u32>()) {
                    if hh < 24 && mm < 60 {
                        return hh * 60 + mm;
                    }
                }
            }
            fallback
        };
        Self {
            open_min: parse_hm(open, 7 * 60),
            close_min: parse_hm(close, 18 * 60 + 30),
            slack_min: slack.parse::<u32>().unwrap_or(60),
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// Public Tauri command args
// ────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GridArgs {
    pub image_b64: String,
    pub mime_type: String,
    pub month_year: String,
    /// [{id, name}] passed from the frontend. Order does not matter.
    pub roster: Vec<RosterEntry>,
    /// Optional print-manifest hint from a v2 QR: pre-known column→staff map.
    #[serde(default)]
    pub manifest: Option<Vec<ManifestEntry>>,
    pub centre_open_time: String,
    pub centre_close_time: String,
    pub centre_hours_slack_min: String,
    #[serde(default)]
    pub enable_mistral_ocr: Option<bool>,
    #[serde(default)]
    pub enable_azure_di: Option<bool>,
    /// ISO YYYY-MM-DD dates that are statutory holidays for the month
    /// being scanned. Sourced from Settings → Stat Holidays on the
    /// frontend (respects opt-outs). When populated, the backend emits
    /// a STAT row per non-empty column for each date and discards any
    /// AI-reported time value that falls on these days. Weekends are
    /// handled deterministically from the date itself; do not include
    /// them here.
    #[serde(default)]
    pub stat_dates: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RosterEntry {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ManifestEntry {
    pub col: u8,
    pub staff_id: i64,
    pub staff_name: String,
}

// ────────────────────────────────────────────────────────────────────────
// Name similarity (Levenshtein-based, tolerant of common OCR errors)
// ────────────────────────────────────────────────────────────────────────

fn norm_name(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Returns a similarity in [0.0, 1.0]. 1.0 means "same normalised string".
/// Uses first-name affinity: matches on the first word count double.
pub fn name_similarity(a: &str, b: &str) -> f32 {
    let na = norm_name(a);
    let nb = norm_name(b);
    if na.is_empty() || nb.is_empty() {
        return 0.0;
    }
    if na == nb {
        return 1.0;
    }
    let base = levenshtein_ratio(&na, &nb);
    let first_a = na.split_whitespace().next().unwrap_or("");
    let first_b = nb.split_whitespace().next().unwrap_or("");
    let first_sim = if !first_a.is_empty() && !first_b.is_empty() {
        // Prefix-match boost: "Kiranpreet" starts with "Kiran" → treat as 1.0.
        if first_a.starts_with(first_b) || first_b.starts_with(first_a) {
            1.0
        } else {
            levenshtein_ratio(first_a, first_b)
        }
    } else {
        0.0
    };
    // First-name affinity: give it 40% weight so "Kiranpreet" ≈ "Kiran" scores
    // higher than "Kiranpreet" vs "Chloe".
    (base * 0.6 + first_sim * 0.4).clamp(0.0, 1.0)
}

fn levenshtein_ratio(a: &str, b: &str) -> f32 {
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let (m, n) = (ac.len(), bc.len());
    if m == 0 && n == 0 {
        return 1.0;
    }
    let max_len = m.max(n) as f32;
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut cur = vec![0usize; n + 1];
    for i in 1..=m {
        cur[0] = i;
        for j in 1..=n {
            let cost = if ac[i - 1] == bc[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    1.0 - (prev[n] as f32 / max_len)
}

// ────────────────────────────────────────────────────────────────────────
// Global column resolver
//
// Score each (col, candidate) pair, then solve as a max-weight assignment
// over `columns × (roster ∪ {empty, unknown, new_staff})`. Roster entries
// have exclusive assignment; the meta candidates {empty, unknown} can be
// assigned to multiple columns.
//
// Brute force over permutations up to N=8 (sheet has 5). Falls back to
// greedy if N > 8. Assertion catches surprises.
// ────────────────────────────────────────────────────────────────────────

pub fn resolve_columns(
    header_reads: &[HeaderRead],
    cell_reads: &[CellRead],
    roster: &[RosterEntry],
    manifest: Option<&[ManifestEntry]>,
    n_columns: u8,
) -> Vec<ResolvedColumn> {
    let mut per_col_headers: Vec<Vec<HeaderRead>> = (0..n_columns).map(|_| Vec::new()).collect();
    for h in header_reads {
        if (h.col as usize) < per_col_headers.len() {
            per_col_headers[h.col as usize].push(h.clone());
        }
    }
    // Per-column digit presence: was any engine reading substantive digits
    // in this column? Empty columns should score high for "empty" candidate.
    let mut per_col_has_digits: Vec<bool> = vec![false; n_columns as usize];
    for c in cell_reads {
        if (c.col as usize) < per_col_has_digits.len()
            && (!c.tokens_in.is_empty() || !c.tokens_out.is_empty() || c.is_stat_marker)
        {
            per_col_has_digits[c.col as usize] = true;
        }
    }

    // Manifest override map (if present).
    let manifest_map: std::collections::HashMap<u8, ManifestEntry> = manifest
        .map(|m| m.iter().map(|e| (e.col, e.clone())).collect())
        .unwrap_or_default();

    // Score matrix: rows = columns (0..N), cols = candidate index.
    // Candidate 0..R = roster entry index.
    // Candidate R   = special "empty".
    // Candidate R+1 = special "unknown" (header read but no roster match).
    let r = roster.len();
    let empty_idx = r;
    let unknown_idx = r + 1;
    let n_cand = r + 2;
    let mut score = vec![vec![0.0f32; n_cand]; n_columns as usize];
    // Track OCR-only (non-manifest) header-similarity contribution separately.
    // Confident verdict requires OCR evidence >= 0.35, so a manifest bonus
    // can never single-handedly promote a column past the confident gate.
    let mut ocr_evidence = vec![vec![0.0f32; n_cand]; n_columns as usize];
    let mut top_reads: Vec<String> = vec![String::new(); n_columns as usize];

    for col in 0..(n_columns as usize) {
        let reads = &per_col_headers[col];
        let has_digits = per_col_has_digits[col];
        // Aggregate score per roster candidate.
        for (ri, entry) in roster.iter().enumerate() {
            let mut s = 0.0f32;
            for hr in reads {
                let sim = name_similarity(&hr.text, &entry.name);
                s += hr.confidence * sim;
            }
            ocr_evidence[col][ri] = s;
            // Digit presence prior: staff columns almost always have some cells.
            if has_digits {
                s += 0.05;
            }
            score[col][ri] = s;
        }
        // Manifest prior — steer disambiguation. Not counted toward OCR
        // evidence; a manifest-only candidate stays Ambiguous.
        if let Some(m) = manifest_map.get(&(col as u8)) {
            if let Some(ri) = roster.iter().position(|e| e.id == m.staff_id) {
                score[col][ri] += 0.6;
            }
        }
        // Empty candidate: if no header reads AND no digits → very high.
        // If header reads exist but no digits → moderate.
        // If header reads AND digits → very low.
        score[col][empty_idx] = match (reads.is_empty(), has_digits) {
            (true, false) => 0.9,
            (false, false) => 0.5,
            (_, true) => 0.05,
        };
        // Unknown candidate: header read exists, digits exist, but no
        // roster candidate scores well. Give it a small baseline so that
        // if no roster candidate crosses threshold, unknown wins.
        score[col][unknown_idx] = if has_digits && !reads.is_empty() { 0.35 } else { 0.15 };
        // Capture the best header read text for Unknown fallback rendering.
        top_reads[col] = reads
            .iter()
            .max_by(|a, b| a.confidence.partial_cmp(&b.confidence).unwrap_or(std::cmp::Ordering::Equal))
            .map(|h| h.text.clone())
            .unwrap_or_default();
    }

    // Solve assignment.
    let assignment = solve_assignment(&score, r, empty_idx, unknown_idx, n_columns as usize);

    // Build ResolvedColumn per physical col.
    let mut out = Vec::with_capacity(n_columns as usize);
    for col in 0..(n_columns as usize) {
        let cand = assignment[col];
        let s = score[col][cand];
        let (decision, confidence) = if cand < r {
            // Determine confident vs ambiguous by margin.
            let mut ranked: Vec<(usize, f32)> = (0..r).map(|i| (i, score[col][i])).collect();
            ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let winner_score = s;
            let runner_up = ranked
                .iter()
                .find(|(i, _)| *i != cand)
                .map(|(_, v)| *v)
                .unwrap_or(0.0);
            let margin = winner_score - runner_up;
            // Confident REQUIRES real OCR header evidence (>= 0.35), not just
            // digit-presence + manifest. This closes the "stale manifest with
            // no readable header" hole.
            let ocr_backing = ocr_evidence[col][cand];
            let confident_ok = ocr_backing >= 0.35
                && winner_score >= 0.55
                && (margin >= 0.15 || winner_score >= 0.85);
            if confident_ok {
                (
                    ColumnDecision::Confident {
                        staff_id: roster[cand].id,
                        staff_name: roster[cand].name.clone(),
                    },
                    winner_score.min(1.0),
                )
            } else {
                let candidates: Vec<ColumnCandidate> = ranked
                    .into_iter()
                    .take(3)
                    .filter(|(_, s)| *s > 0.05)
                    .map(|(i, s)| ColumnCandidate {
                        staff_id: roster[i].id,
                        staff_name: roster[i].name.clone(),
                        score: s,
                    })
                    .collect();
                if candidates.is_empty() {
                    (ColumnDecision::Unknown { header_read: top_reads[col].clone() }, s)
                } else {
                    (ColumnDecision::Ambiguous { candidates }, s)
                }
            }
        } else if cand == empty_idx {
            (ColumnDecision::Empty, s)
        } else {
            (ColumnDecision::Unknown { header_read: top_reads[col].clone() }, s)
        };
        out.push(ResolvedColumn {
            col: col as u8,
            decision,
            confidence,
            header_reads: per_col_headers[col].clone(),
        });
    }
    out
}

/// Max-weight assignment on a small `n × n_cand` score matrix.
/// Roster candidates (index < roster_len) are exclusive (each may be assigned
/// to at most one column). Empty and Unknown may be reused. `n_cols <= 8`
/// (brute force). Falls back to greedy above 8.
fn solve_assignment(
    score: &[Vec<f32>],
    roster_len: usize,
    empty_idx: usize,
    unknown_idx: usize,
    n_cols: usize,
) -> Vec<usize> {
    if n_cols > 8 || roster_len > 12 {
        return greedy_assignment(score, roster_len, empty_idx, unknown_idx, n_cols);
    }
    let n_cand = roster_len + 2;
    let mut best_score = f32::NEG_INFINITY;
    let mut best_assign = vec![empty_idx; n_cols];
    // Recursive search: for each column, pick a candidate not yet used
    // among roster (empty/unknown always allowed).
    let mut used = vec![false; roster_len];
    let mut current = vec![0usize; n_cols];
    fn recurse(
        col: usize,
        n_cols: usize,
        n_cand: usize,
        roster_len: usize,
        empty_idx: usize,
        unknown_idx: usize,
        score: &[Vec<f32>],
        used: &mut Vec<bool>,
        current: &mut Vec<usize>,
        running: f32,
        best: &mut f32,
        best_assign: &mut Vec<usize>,
    ) {
        if col == n_cols {
            if running > *best {
                *best = running;
                *best_assign = current.clone();
            }
            return;
        }
        for c in 0..n_cand {
            if c < roster_len && used[c] {
                continue;
            }
            let mark = c < roster_len;
            if mark {
                used[c] = true;
            }
            current[col] = c;
            recurse(
                col + 1, n_cols, n_cand, roster_len, empty_idx, unknown_idx,
                score, used, current, running + score[col][c], best, best_assign,
            );
            if mark {
                used[c] = false;
            }
        }
        // Silence unused-warnings when trivially exhausted.
        let _ = empty_idx; let _ = unknown_idx;
    }
    recurse(
        0, n_cols, n_cand, roster_len, empty_idx, unknown_idx,
        score, &mut used, &mut current, 0.0, &mut best_score, &mut best_assign,
    );
    best_assign
}

fn greedy_assignment(
    score: &[Vec<f32>],
    roster_len: usize,
    empty_idx: usize,
    _unknown_idx: usize,
    n_cols: usize,
) -> Vec<usize> {
    // Greedy: pick the (col, cand) with highest score iteratively.
    let mut result = vec![empty_idx; n_cols];
    let mut col_taken = vec![false; n_cols];
    let mut cand_taken = vec![false; roster_len];
    let n_cand = roster_len + 2;
    let mut pairs: Vec<(usize, usize, f32)> = Vec::new();
    for c in 0..n_cols {
        for k in 0..n_cand {
            pairs.push((c, k, score[c][k]));
        }
    }
    pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    for (c, k, _s) in pairs {
        if col_taken[c] {
            continue;
        }
        if k < roster_len && cand_taken[k] {
            continue;
        }
        result[c] = k;
        col_taken[c] = true;
        if k < roster_len {
            cand_taken[k] = true;
        }
        if col_taken.iter().all(|x| *x) {
            break;
        }
    }
    result
}

// ────────────────────────────────────────────────────────────────────────
// Joint IN/OUT candidate resolution
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct TimeCandidate {
    literal_h: u32,
    literal_m: u32,
}

impl TimeCandidate {
    fn expand(&self) -> Vec<u32> {
        // Return possible minutes-since-midnight interpretations.
        let base = self.literal_h * 60 + self.literal_m;
        if self.literal_h == 0 || self.literal_h > 12 {
            // Already unambiguous (either 24h form or noon/midnight edge).
            vec![base]
        } else {
            let pm = (self.literal_h % 12 + 12) * 60 + self.literal_m;
            let am = self.literal_h * 60 + self.literal_m;
            if am == pm { vec![am] } else { vec![am, pm] }
        }
    }
}

/// Parse a HH:MM-shaped token into a TimeCandidate. Returns None for junk.
fn parse_time_token(s: &str) -> Option<TimeCandidate> {
    // Reuse existing normalizer to handle "8 30", "8:30", "830", etc.
    let n = normalize_time(s)?;
    let (hh, mm) = n.split_once(':')?;
    let h: u32 = hh.parse().ok()?;
    let m: u32 = mm.parse().ok()?;
    if h > 23 || m > 59 { return None; }
    // Undo any AM/PM the legacy normalizer applied by keeping the literal.
    // Since normalize_time may have already added 12 (e.g. for "3pm"), we
    // just accept whatever came out — it's already been disambiguated.
    Some(TimeCandidate { literal_h: h, literal_m: m })
}

fn fmt_hhmm(minutes: u32) -> String {
    format!("{:02}:{:02}", (minutes / 60) % 24, minutes % 60)
}

/// Joint (IN, OUT) selection over candidate pairs.
///
/// Returns (in_hhmm, out_hhmm, score, reasons). Score is a heuristic:
/// higher is better. Reasons is a list of soft/warning messages the row
/// should carry into the UI.
fn resolve_pair(
    in_tokens: &[String],
    out_tokens: &[String],
    hours: &CentreHours,
) -> (Option<String>, Option<String>, f32, Vec<String>) {
    let in_cands: Vec<TimeCandidate> = in_tokens.iter().filter_map(|s| parse_time_token(s)).collect();
    let out_cands: Vec<TimeCandidate> = out_tokens.iter().filter_map(|s| parse_time_token(s)).collect();

    if in_cands.is_empty() && out_cands.is_empty() {
        return (None, None, 0.0, Vec::new());
    }

    // Expand to all minute-value pairs.
    let in_exp: Vec<u32> = if in_cands.is_empty() {
        vec![]
    } else {
        in_cands.iter().flat_map(|c| c.expand()).collect()
    };
    let out_exp: Vec<u32> = if out_cands.is_empty() {
        vec![]
    } else {
        out_cands.iter().flat_map(|c| c.expand()).collect()
    };

    // Single-sided cases: pick the interpretation that lies within the
    // operating window most snugly.
    if out_exp.is_empty() {
        let (best, warn) = pick_single(&in_exp, hours, /*is_in=*/ true);
        return (Some(fmt_hhmm(best)), None, 0.4, warn);
    }
    if in_exp.is_empty() {
        let (best, warn) = pick_single(&out_exp, hours, /*is_in=*/ false);
        return (None, Some(fmt_hhmm(best)), 0.4, warn);
    }

    let mut best: Option<(u32, u32, f32, Vec<String>)> = None;
    for &i in &in_exp {
        for &o in &out_exp {
            let (s, r) = score_pair(i, o, hours);
            if s <= 0.0 { continue; }
            if best.as_ref().map(|b| s > b.2).unwrap_or(true) {
                best = Some((i, o, s, r));
            }
        }
    }
    match best {
        Some((i, o, s, r)) => (Some(fmt_hhmm(i)), Some(fmt_hhmm(o)), s, r),
        None => {
            // Every pair failed validity. Fall back to raw literals with a
            // hard warning so the row lands in couldnt_read.
            let i0 = *in_exp.first().unwrap();
            let o0 = *out_exp.first().unwrap();
            (
                Some(fmt_hhmm(i0)),
                Some(fmt_hhmm(o0)),
                0.0,
                vec!["no valid (IN, OUT) pair — needs review".to_string()],
            )
        }
    }
}

fn pick_single(cands: &[u32], hours: &CentreHours, is_in: bool) -> (u32, Vec<String>) {
    let mut best = cands[0];
    let mut best_s = f32::NEG_INFINITY;
    for &v in cands {
        let s = single_score(v, hours, is_in);
        if s > best_s {
            best_s = s;
            best = v;
        }
    }
    let mut warn = Vec::new();
    if best_s < 0.0 {
        warn.push(if is_in { "IN outside centre hours".into() } else { "OUT outside centre hours".into() });
    }
    (best, warn)
}

fn single_score(v: u32, hours: &CentreHours, is_in: bool) -> f32 {
    let lo = hours.open_min.saturating_sub(hours.slack_min);
    let hi = hours.close_min + hours.slack_min;
    let in_window = v >= lo && v <= hi;
    let mut s = if in_window { 1.0 } else { -0.5 };
    // Small nudge for the expected end of the interval.
    if is_in && v < hours.close_min {
        s += 0.05;
    }
    if !is_in && v > hours.open_min {
        s += 0.05;
    }
    s
}

fn score_pair(in_min: u32, out_min: u32, hours: &CentreHours) -> (f32, Vec<String>) {
    let mut reasons = Vec::new();
    if out_min <= in_min {
        return (0.0, reasons); // invalid
    }
    let dur = out_min - in_min;
    if dur > 16 * 60 || dur < 5 {
        return (0.0, reasons);
    }
    let lo = hours.open_min.saturating_sub(hours.slack_min);
    let hi = hours.close_min + hours.slack_min;
    let mut s = 1.0f32;
    if in_min < lo {
        s -= 0.4;
        reasons.push(format!("IN {} is before centre opens", fmt_hhmm(in_min)));
    }
    if out_min > hi {
        s -= 0.4;
        reasons.push(format!("OUT {} is after centre closes", fmt_hhmm(out_min)));
    }
    if dur > 12 * 60 {
        s -= 0.3;
        reasons.push(format!("shift is {:.1} hours (over 12)", dur as f32 / 60.0));
    } else if dur < 15 {
        s -= 0.4;
        reasons.push(format!("shift is only {} minutes", dur));
    }
    (s.max(0.01), reasons)
}

// ────────────────────────────────────────────────────────────────────────
// Temporal validator (two-tier)
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub enum ValidationVerdict {
    Ok,
    Soft { reasons: Vec<String> },
    Hard { reasons: Vec<String> },
}

pub fn validate_row(
    in_time: Option<&str>,
    out_time: Option<&str>,
    day_type: &DayType,
    hours: &CentreHours,
) -> ValidationVerdict {
    if matches!(day_type, DayType::Stat | DayType::Sick | DayType::Vacation | DayType::Off) {
        return ValidationVerdict::Ok;
    }
    let (i, o) = match (in_time, out_time) {
        (Some(a), Some(b)) => (a, b),
        _ => {
            return ValidationVerdict::Hard {
                reasons: vec!["missing IN or OUT time".into()],
            };
        }
    };
    let parse = |s: &str| -> Option<u32> {
        let (h, m) = s.split_once(':')?;
        let hh: u32 = h.parse().ok()?;
        let mm: u32 = m.parse().ok()?;
        if hh > 23 || mm > 59 { return None; }
        Some(hh * 60 + mm)
    };
    let in_min = match parse(i) {
        Some(v) => v,
        None => return ValidationVerdict::Hard { reasons: vec![format!("malformed IN {i}")] },
    };
    let out_min = match parse(o) {
        Some(v) => v,
        None => return ValidationVerdict::Hard { reasons: vec![format!("malformed OUT {o}")] },
    };
    if out_min <= in_min {
        return ValidationVerdict::Hard {
            reasons: vec![format!("OUT {o} not after IN {i}")],
        };
    }
    let dur = out_min - in_min;
    if dur > 16 * 60 {
        return ValidationVerdict::Hard {
            reasons: vec![format!("shift {:.1}h exceeds 16h", dur as f32 / 60.0)],
        };
    }
    if dur < 5 {
        return ValidationVerdict::Hard {
            reasons: vec![format!("shift only {} min", dur)],
        };
    }
    let mut soft = Vec::new();
    if dur > 12 * 60 {
        soft.push(format!("shift {:.1}h is over 12h", dur as f32 / 60.0));
    }
    if dur < 15 {
        soft.push(format!("shift only {} min", dur));
    }
    let lo = hours.open_min.saturating_sub(hours.slack_min);
    let hi = hours.close_min + hours.slack_min;
    if in_min < lo {
        soft.push(format!("IN {i} is before centre opens {}", fmt_hhmm(hours.open_min)));
    }
    if out_min > hi {
        soft.push(format!("OUT {o} is after centre closes {}", fmt_hhmm(hours.close_min)));
    }
    if soft.is_empty() { ValidationVerdict::Ok } else { ValidationVerdict::Soft { reasons: soft } }
}

// ────────────────────────────────────────────────────────────────────────
// Engine parsers (grid primitive)
// ────────────────────────────────────────────────────────────────────────

/// Parse Azure DI's `analyzeResult` into a set of grid cell reads and header reads.
pub fn parse_di_grid(result: &serde_json::Value, month_year_hint: &str) -> (Vec<CellRead>, Vec<HeaderRead>, Vec<u8>, u8) {
    let tables = match result["analyzeResult"]["tables"].as_array() {
        Some(t) if !t.is_empty() => t,
        _ => return (vec![], vec![], vec![], 0),
    };
    let table = &tables[0];
    let cells = match table["cells"].as_array() { Some(c) => c, None => return (vec![], vec![], vec![], 0) };

    let (yy, mm): (i32, u32) = {
        let parts: Vec<&str> = month_year_hint.split('-').collect();
        if parts.len() != 2 { return (vec![], vec![], vec![], 0); }
        match (parts[0].parse(), parts[1].parse()) {
            (Ok(y), Ok(m)) if (1..=12).contains(&m) => (y, m),
            _ => return (vec![], vec![], vec![], 0),
        }
    };

    // Row 0: header slot allocation via columnSpan (same idea as legacy).
    let mut slots: Vec<(u64, u64)> = Vec::new(); // (col_start, col_end_exclusive)
    let mut header_texts_per_slot: Vec<String> = Vec::new();
    for c in cells {
        if c["rowIndex"].as_u64() != Some(0) { continue; }
        let col = match c["columnIndex"].as_u64() { Some(x) => x, None => continue };
        let span = c["columnSpan"].as_u64().unwrap_or(1);
        let content = c["content"].as_str().unwrap_or("").trim().to_string();
        if span < 2 { continue; }
        let low = content.to_lowercase();
        if low.contains("day") || low == "(name)" || content.is_empty() { continue; }
        slots.push((col, col + span));
        header_texts_per_slot.push(content);
    }
    // Fallback: if no span≥2 header slots were found, infer slots from
    // the overall table column count. Sheet layout is `[Day] [S1 IN][S1 OUT] [S2 IN][S2 OUT] ...`
    // so every 2 columns after column 0 forms one staff slot.
    if slots.is_empty() {
        let col_count = table["columnCount"].as_u64()
            .or_else(|| cells.iter().filter_map(|c| c["columnIndex"].as_u64()).max().map(|m| m + 1))
            .unwrap_or(0);
        if col_count >= 3 {
            let mut c = 1u64;
            while c + 1 < col_count {
                slots.push((c, c + 2));
                header_texts_per_slot.push(String::new());
                c += 2;
            }
        }
    }
    let n_cols = slots.len() as u8;
    if n_cols == 0 { return (vec![], vec![], vec![], 0); }

    // Header reads: one per slot, engine confidence ~0.7 (Azure DI is
    // reasonable at printed headers but weak at handwriting; the actual
    // handwritten header row is *below* this and we'll pick it up via
    // per-column cell content sniffing in the "name row" pass below).
    let mut header_reads: Vec<HeaderRead> = header_texts_per_slot
        .iter()
        .enumerate()
        .filter(|(_, t)| !t.is_empty())
        .map(|(i, t)| HeaderRead { engine: "azure_di".into(), col: i as u8, text: t.clone(), confidence: 0.6 })
        .collect();

    // Also collect row-1 content (usually the handwritten staff name row).
    for c in cells {
        if c["rowIndex"].as_u64() != Some(1) { continue; }
        let col = match c["columnIndex"].as_u64() { Some(x) => x, None => continue };
        let content = c["content"].as_str().unwrap_or("").trim().to_string();
        if content.is_empty() { continue; }
        // Which slot does this column fall into?
        if let Some((idx, _)) = slots.iter().enumerate().find(|(_, (a, b))| col >= *a && col < *b) {
            header_reads.push(HeaderRead { engine: "azure_di".into(), col: idx as u8, text: content, confidence: 0.7 });
        }
    }

    // Group cells by rowIndex for data rows (rowIndex >= 2).
    let mut by_row: std::collections::BTreeMap<u64, Vec<&serde_json::Value>> = Default::default();
    for c in cells {
        let r = match c["rowIndex"].as_u64() { Some(x) => x, None => continue };
        if r < 2 { continue; }
        by_row.entry(r).or_default().push(c);
    }

    let mut cell_reads = Vec::new();
    let mut stat_days: Vec<u8> = Vec::new();

    for (_r, row_cells) in by_row {
        // Day column.
        let day_content = row_cells.iter()
            .find(|c| c["columnIndex"].as_u64() == Some(0))
            .and_then(|c| c["content"].as_str())
            .unwrap_or("").trim().to_string();
        let day_num: Option<u32> = parse_leading_day(&day_content);
        let day = match day_num { Some(d) => d, None => continue };
        if day > days_in(yy, mm) { continue; }

        // Full-row markers.
        let row_text: String = row_cells.iter()
            .map(|c| c["content"].as_str().unwrap_or("").to_lowercase())
            .collect::<Vec<_>>().join(" ");
        let row_is_weekend = row_text.contains(" sat") || row_text.contains("sat ")
            || row_text.contains(" sun") || row_text.contains("sun ")
            || row_text.trim() == "sat" || row_text.trim() == "sun";
        if row_is_weekend { continue; }
        let row_is_stat = row_text.contains(" stat") || row_text.starts_with("stat")
            || row_text.contains("statutory") || row_text.contains("holiday");
        if row_is_stat {
            stat_days.push(day as u8);
            // Emit a stat marker cell per slot so the driver knows every
            // column had a stat entry on this day.
            for col in 0..n_cols {
                cell_reads.push(CellRead {
                    engine: "azure_di".into(),
                    col,
                    day: day as u8,
                    tokens_in: vec![],
                    tokens_out: vec![],
                    checkbox_selected: None,
                    is_stat_marker: true,
                    confidence: 0.9,
                    bbox: None,
                });
            }
            continue;
        }

        for (idx, (col_start, col_end)) in slots.iter().enumerate() {
            let slot_cells: Vec<&&serde_json::Value> = row_cells.iter()
                .filter(|c| {
                    let ci = c["columnIndex"].as_u64().unwrap_or(u64::MAX);
                    ci >= *col_start && ci < *col_end
                })
                .collect();
            let combined: String = slot_cells.iter()
                .map(|c| c["content"].as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>().join(" ");
            let low = combined.to_lowercase();
            if low.contains("sat") || low.contains("sun") || low.contains("off")
                || low.contains("sick") || low.contains("pto") || low.contains("vac") {
                continue;
            }
            let is_stat = low.contains("stat") || low.contains("holiday");
            if is_stat {
                cell_reads.push(CellRead {
                    engine: "azure_di".into(),
                    col: idx as u8,
                    day: day as u8,
                    tokens_in: vec![],
                    tokens_out: vec![],
                    checkbox_selected: None,
                    is_stat_marker: true,
                    confidence: 0.85,
                    bbox: None,
                });
                continue;
            }
            let has_selected = combined.split(':').any(|tok| tok.trim().eq_ignore_ascii_case("selected"));
            // Extract time tokens in doc order.
            let mut times: Vec<String> = Vec::new();
            for c in &slot_cells {
                let txt = c["content"].as_str().unwrap_or("");
                for t in scan_times_pure(txt) {
                    times.push(t);
                    if times.len() >= 2 { break; }
                }
                if times.len() >= 2 { break; }
            }
            let checkbox = if has_selected { Some(true) } else { None };
            // scan_times_pure returned strings like "07:40" (with its 1..6→PM rule
            // already applied). We store as tokens_in / tokens_out based on
            // simple ordering: first = IN, second = OUT. If only one, use
            // literal_h ≥ 12 as the OUT heuristic (matches DI's own behaviour).
            let (tin, tout) = if times.len() >= 2 {
                (vec![times[0].clone()], vec![times[1].clone()])
            } else if times.len() == 1 {
                let h = times[0].split(':').next().unwrap_or("0").parse::<u32>().unwrap_or(0);
                if h >= 12 { (vec![], vec![times[0].clone()]) } else { (vec![times[0].clone()], vec![]) }
            } else {
                (vec![], vec![])
            };
            if tin.is_empty() && tout.is_empty() && checkbox.is_none() {
                continue;
            }
            cell_reads.push(CellRead {
                engine: "azure_di".into(),
                col: idx as u8,
                day: day as u8,
                tokens_in: tin,
                tokens_out: tout,
                checkbox_selected: checkbox,
                is_stat_marker: false,
                confidence: 0.75,
                bbox: None,
            });
        }
    }

    (cell_reads, header_reads, stat_days, n_cols)
}

/// Parse a Mistral OCR markdown blob into per-column digit witnesses.
///
/// Mistral cannot reliably read handwritten headers, so we emit no
/// HeaderRead entries here; but the per-column digit reads are strong.
pub fn parse_mistral_grid(md: &str, month_year_hint: &str) -> (Vec<CellRead>, Option<String>) {
    let detected = sniff_month_year(md);
    let month_key = detected.clone().unwrap_or_else(|| month_year_hint.to_string());
    let mut cell_reads: Vec<CellRead> = Vec::new();

    // Split into blocks of consecutive table lines.
    let mut cur_block: Vec<Vec<String>> = Vec::new();
    let flush = |block: &mut Vec<Vec<String>>, reads: &mut Vec<CellRead>, month: &str| {
        if block.len() >= 3 {
            extract_mistral_grid_block(block, reads, month);
        }
        block.clear();
    };
    for line in md.lines() {
        let l = line.trim();
        if l.starts_with('|') && l.ends_with('|') {
            let cells: Vec<String> = l.trim_matches('|').split('|').map(|s| s.trim().to_string()).collect();
            cur_block.push(cells);
        } else if !cur_block.is_empty() {
            flush(&mut cur_block, &mut cell_reads, &month_key);
        }
    }
    if !cur_block.is_empty() {
        flush(&mut cur_block, &mut cell_reads, &month_key);
    }
    (cell_reads, detected)
}

fn extract_mistral_grid_block(block: &[Vec<String>], out: &mut Vec<CellRead>, month_key: &str) {
    if block.is_empty() { return; }
    let ncols = block[0].len();
    if ncols < 4 { return; }

    // Data rows: any row whose first cell parses as a day 1..31.
    let data_rows: Vec<&Vec<String>> = block.iter()
        .filter(|r| r.first().and_then(|s| parse_leading_day(s)).is_some())
        .collect();
    if data_rows.is_empty() { return; }

    // Column layout (Jul 2026+): col 0 = day label, then (IN, OUT) pairs
    // per staff. The old sheet had a third "No.Ln" checkbox per staff
    // which was dropped — paid_hours auto-deducts a 30-min lunch on shifts
    // ≥5h per BC ESA. The grid is now 1 + 2*N cells wide.
    //
    // We try BOTH stride=2 and stride=3 and pick the layout whose parse
    // yields more complete IN+OUT time pairs. On a legacy stride=3 grid
    // parsed as stride=2, adjacent pairs become (IN,OUT), (NoLn,IN),
    // (OUT,NoLn) … so only 1/3 of pairs contain both times. The scoring
    // catches that and picks stride=3.
    let try_stride = |stride: usize, out: &mut Vec<CellRead>| -> (usize, usize) {
        let staff_col_count = (ncols.saturating_sub(1) / stride).min(12);
        let mut emitted = 0usize;
        let mut full_pairs = 0usize;
        for row in &data_rows {
            let day = match parse_leading_day(&row[0]) { Some(d) => d, None => continue };
            for i in 0..staff_col_count {
                let base = 1 + i * stride;
                let in_val = row.get(base).cloned().unwrap_or_default();
                let out_val = row.get(base + 1).cloned().unwrap_or_default();
                if in_val.is_empty() && out_val.is_empty() { continue; }
                if is_weekend_marker(&in_val) || is_weekend_marker(&out_val) { continue; }
                let tin: Vec<String> = normalize_time(&in_val).into_iter().collect();
                let tout: Vec<String> = normalize_time(&out_val).into_iter().collect();
                if tin.is_empty() && tout.is_empty() { continue; }
                let nl_val = if stride >= 3 { row.get(base + 2).cloned().unwrap_or_default() } else { String::new() };
                let checkbox = if stride >= 3 && !nl_val.is_empty() {
                    let s = nl_val.trim();
                    // ☑, ✓, ✔, X = ticked; ☐, empty box = not ticked.
                    if s.contains('☑') || s.contains('✓') || s.contains('✔') || s.eq_ignore_ascii_case("x") {
                        Some(true)
                    } else if s.contains('☐') || s.contains('□') {
                        Some(false)
                    } else { None }
                } else { None };
                if !tin.is_empty() && !tout.is_empty() { full_pairs += 1; }
                out.push(CellRead {
                    engine: "mistral_ocr".into(),
                    col: i as u8,
                    day: day as u8,
                    tokens_in: tin,
                    tokens_out: tout,
                    checkbox_selected: checkbox,
                    is_stat_marker: false,
                    confidence: 0.6,
                    bbox: None,
                });
                emitted += 1;
            }
        }
        (emitted, full_pairs)
    };

    // Score both stride=2 and stride=3; keep the one with more IN+OUT
    // complete pairs. On a tie or both zero, prefer stride=2.
    let mut trial2: Vec<CellRead> = Vec::new();
    let (_e2, f2) = try_stride(2, &mut trial2);
    let mut trial3: Vec<CellRead> = Vec::new();
    let (_e3, f3) = try_stride(3, &mut trial3);
    if f3 > f2 {
        out.extend(trial3);
    } else {
        out.extend(trial2);
    }

    let _ = month_key; // month is applied by the driver
}

// doc_ai (mistral-document-ai-2512) call site + schema removed 2026-07-14.
// Rationale: benchmarked at 1.1% precision on the July timesheet (89 of 90
// emitted cells were hallucinations). The schema-forced JSON extractor
// confabulates times to fill blanks. See consensus_v2::tests for the new
// Mistral-primary / DI-secondary consensus rules.


/// Call Azure DI (raw HTTP submit + poll).
async fn call_di_raw(
    api_key: &str,
    image_b64: &str,
) -> Result<(serde_json::Value, String), String> {
    const DI_ENDPOINT: &str = "https://ai-nse.cognitiveservices.azure.com";
    const DI_API_VERSION: &str = "2024-11-30";
    let submit_url = format!(
        "{DI_ENDPOINT}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version={DI_API_VERSION}"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(PROVIDER_TIMEOUT_SECS))
        .build().map_err(|e| format!("http client: {e}"))?;
    let submit_resp = client.post(&submit_url)
        .header("Ocp-Apim-Subscription-Key", api_key)
        .header("Content-Type", "application/json")
        .json(&json!({ "base64Source": image_b64 }))
        .send().await.map_err(|e| format!("request: {e}"))?;
    let sub_status = submit_resp.status();
    let op_loc = submit_resp.headers().get("operation-location")
        .and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    if !sub_status.is_success() {
        let t = submit_resp.text().await.unwrap_or_default();
        return Err(format!("http {sub_status} @ di submit :: {}", truncate(&t, 400)));
    }
    let op_loc = op_loc.ok_or_else(|| "azure-di: no Operation-Location header".to_string())?;
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let poll_resp = client.get(&op_loc)
            .header("Ocp-Apim-Subscription-Key", api_key)
            .send().await.map_err(|e| format!("poll: {e}"))?;
        if !poll_resp.status().is_success() {
            let t = poll_resp.text().await.unwrap_or_default();
            return Err(format!("di poll failed: {}", truncate(&t, 300)));
        }
        let v: serde_json::Value = poll_resp.json().await.map_err(|e| format!("poll json: {e}"))?;
        let status = v["status"].as_str().unwrap_or("");
        if status == "succeeded" {
            let raw = truncate(&v.to_string(), 8000);
            return Ok((v, raw));
        }
        if status == "failed" {
            return Err(format!("di analyze failed: {}", truncate(&v.to_string(), 400)));
        }
    }
    Err("azure-di: polling timed out".to_string())
}

async fn call_mistral_ocr_raw(
    api_key: &str,
    image_b64: &str,
    mime_type: &str,
) -> Result<String, String> {
    let data_url = format!("data:{mime_type};base64,{image_b64}");
    let body = json!({
        "model": "mistral-ocr-4-0",
        "document": { "type": "image_url", "image_url": data_url },
        "include_image_base64": false
    });
    let url = "https://ai-nse.services.ai.azure.com/providers/mistral/azure/ocr";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(PROVIDER_TIMEOUT_SECS))
        .build().map_err(|e| format!("http client: {e}"))?;
    let resp = client.post(url)
        .header("api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body).send().await.map_err(|e| format!("request: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("read: {e}"))?;
    if !status.is_success() {
        return Err(format!("http {status} @ mistral-ocr :: {}", truncate(&text, 800)));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("json: {e}"))?;
    let markdown = v["pages"].as_array()
        .map(|arr| arr.iter().filter_map(|p| p["markdown"].as_str())
            .collect::<Vec<_>>().join("\n\n"))
        .unwrap_or_default();
    if markdown.is_empty() {
        return Err(format!("no markdown in response: {}", truncate(&text, 300)));
    }
    Ok(markdown)
}

// ────────────────────────────────────────────────────────────────────────
// Driver: extract_timesheet_grid
// ────────────────────────────────────────────────────────────────────────

pub async fn extract_grid_impl(args: GridArgs) -> Result<GridConsensusResult, String> {
    // Validate base64 early.
    base64::engine::general_purpose::STANDARD.decode(args.image_b64.as_bytes())
        .map_err(|e| format!("image base64: {e}"))?;

    let azure_ai_key: Option<String> = crate::secrets::get_secret_opt("azure_ai_key");
    let secrets_owned: Vec<String> = [azure_ai_key.clone().unwrap_or_default()]
        .into_iter().filter(|s| !s.is_empty()).collect();
    let redact_now = |s: String| {
        let refs: Vec<&str> = secrets_owned.iter().map(|s| s.as_str()).collect();
        redact(s, &refs)
    };

    let hours = CentreHours::from_strings(
        &args.centre_open_time, &args.centre_close_time, &args.centre_hours_slack_min,
    );

    let (img, mime) = normalize_image(&args.image_b64, &args.mime_type);
    let month_hint = args.month_year.clone();
    let mistral_enabled = args.enable_mistral_ocr.unwrap_or(true);
    let di_enabled = args.enable_azure_di.unwrap_or(true);

    #[cfg(debug_assertions)]
    eprintln!(
        "\n════════ [OCR-V2] extract_timesheet_grid ════════\n\
         image: mime={} b64_len={} month_hint={} roster={} manifest={} \
         hours={{open={}, close={}, slack={}}}",
        mime, img.len(), month_hint,
        args.roster.len(),
        args.manifest.as_ref().map(|m| m.len()).unwrap_or(0),
        hours.open_min, hours.close_min, hours.slack_min,
    );

    // ── Retry helper ────────────────────────────────────────────────
    let is_retriable = |err: &str| -> bool {
        let e = err.to_ascii_lowercase();
        e.contains("timeout") || e.contains("sending request") || e.starts_with("request:")
            || e.contains("connection") || e.contains("connect") || e.contains("reset")
            || e.contains("eof") || e.contains("dns") || e.contains("stream")
            || e.contains("http/2") || e.contains("502") || e.contains("503")
            || e.contains("504") || e.contains("429")
    };

    macro_rules! with_retries {
        ($name:literal, $body:expr) => {{
            let started = Instant::now();
            let mut last: Result<_, String> = Err("no attempt".into());
            for attempt in 1..=PROVIDER_MAX_ATTEMPTS {
                let r = tokio::time::timeout(
                    Duration::from_secs(PROVIDER_TIMEOUT_SECS + 5),
                    $body,
                ).await.unwrap_or_else(|_| Err("provider timeout".to_string()));
                match r {
                    Ok(v) => { last = Ok(v); break; }
                    Err(e) => {
                        #[cfg(debug_assertions)]
                        eprintln!("── [OCR-V2:{}] attempt {}/{} failed: {}", $name, attempt, PROVIDER_MAX_ATTEMPTS, e);
                        last = Err(e.clone());
                        if attempt < PROVIDER_MAX_ATTEMPTS && is_retriable(&e) {
                            tokio::time::sleep(Duration::from_millis(PROVIDER_RETRY_BACKOFF_MS * attempt as u64)).await;
                            continue;
                        }
                        break;
                    }
                }
            }
            (started.elapsed().as_millis() as u64, last)
        }};
    }

    // Fire the three providers in parallel.
    let key_di = azure_ai_key.clone();
    let key_mistral = azure_ai_key.clone();
    let key_docai = azure_ai_key.clone();
    let img_di = img.clone();
    let img_mistral = img.clone();
    let img_docai = img.clone();
    let mime_di = mime.clone();
    let mime_mistral = mime.clone();
    let mime_docai = mime.clone();
    let month_docai = month_hint.clone();

    let di_fut = async move {
        if !di_enabled { return (0u64, Err("azure_di disabled by user".into())); }
        let key = match key_di { Some(k) if !k.is_empty() => k, _ => return (0u64, Err("no Azure AI key".into())) };
        let _ = mime_di;
        with_retries!("azure_di", call_di_raw(&key, &img_di))
    };

    let mistral_fut = async move {
        if !mistral_enabled { return (0u64, Err("mistral_ocr disabled by user".into())); }
        let key = match key_mistral { Some(k) if !k.is_empty() => k, _ => return (0u64, Err("no Azure AI key".into())) };
        with_retries!("mistral_ocr", call_mistral_ocr_raw(&key, &img_mistral, &mime_mistral))
    };

    let docai_fut = async move {
        // doc_ai (mistral-document-ai-2512) was retired 2026-07-14 after
        // benchmarking against ground truth showed 1.1% precision on the
        // July timesheet (89 hallucinated cells out of 90). The
        // schema-forced JSON extractor confabulates times to fill blanks.
        // Left as a fast Ok(empty) so the tokio::join! call site stays put
        // and downstream code sees a well-formed empty contribution.
        let _ = (key_docai, img_docai, mime_docai, month_docai);
        (0u64, Ok::<(Vec<CellRead>, Vec<HeaderRead>, Vec<u8>, Option<String>, u8, String), String>(
            (Vec::new(), Vec::new(), Vec::new(), None, 0u8, String::new())
        ))
    };

    let ((di_ms, di_res), (mist_ms, mist_res), (docai_ms, docai_res)) =
        tokio::join!(di_fut, mistral_fut, docai_fut);

    let mut engines_ok = Vec::new();
    let mut engines_failed = Vec::new();
    let mut raw_by_engine: Vec<(String, String)> = Vec::new();
    let (mut di_cell_count, mut mist_cell_count, mut docai_cell_count) = (0usize, 0usize, 0usize);

    // DI → grid
    let (mut di_cells, mut di_headers, mut di_stat, mut di_n_cols) = (Vec::new(), Vec::new(), Vec::new(), 0u8);
    let mut di_detected_month: Option<String> = None;
    match di_res {
        Ok((v, raw)) => {
            engines_ok.push("azure_di".to_string());
            di_detected_month = detect_month_from_di(&v);
            let month_for_parse = di_detected_month.clone().unwrap_or_else(|| month_hint.clone());
            let (c, h, s, n) = parse_di_grid(&v, &month_for_parse);
            di_cells = c; di_headers = h; di_stat = s; di_n_cols = n;
            di_cell_count = di_cells.len();
            #[cfg(debug_assertions)]
            eprintln!("── [OCR-V2:azure_di] latency={}ms cells={} headers={} n_cols={} stat_days={:?}", di_ms, di_cells.len(), di_headers.len(), di_n_cols, di_stat);
            raw_by_engine.push(("azure_di".into(), redact_now(raw)));
        }
        Err(e) => {
            engines_failed.push(("azure_di".to_string(), redact_now(e.clone())));
            #[cfg(debug_assertions)]
            eprintln!("── [OCR-V2:azure_di] FAILED latency={}ms {}", di_ms, redact_now(e));
        }
    }

    let (mut mist_cells, mut mist_detected_month): (Vec<CellRead>, Option<String>) = (Vec::new(), None);
    match mist_res {
        Ok(md) => {
            engines_ok.push("mistral_ocr".to_string());
            let (c, d) = parse_mistral_grid(&md, &month_hint);
            mist_cells = c; mist_detected_month = d;
            mist_cell_count = mist_cells.len();
            #[cfg(debug_assertions)]
            eprintln!("── [OCR-V2:mistral_ocr] latency={}ms cells={}", mist_ms, mist_cells.len());
            raw_by_engine.push(("mistral_ocr".into(), redact_now(truncate(&md, 4000))));
        }
        Err(e) => {
            engines_failed.push(("mistral_ocr".to_string(), redact_now(e.clone())));
            #[cfg(debug_assertions)]
            eprintln!("── [OCR-V2:mistral_ocr] FAILED latency={}ms {}", mist_ms, redact_now(e));
        }
    }

    let (mut docai_cells, mut docai_headers, mut docai_stat, mut docai_detected, mut docai_n_cols) =
        (Vec::new(), Vec::new(), Vec::new(), None, 0u8);
    match docai_res {
        Ok((c, h, s, d, n, raw)) => {
            engines_ok.push("doc_ai".to_string());
            docai_cells = c; docai_headers = h; docai_stat = s; docai_detected = d; docai_n_cols = n;
            docai_cell_count = docai_cells.len();
            #[cfg(debug_assertions)]
            eprintln!("── [OCR-V2:doc_ai] latency={}ms cells={} headers={} n_cols={} stat_days={:?}", docai_ms, docai_cells.len(), docai_headers.len(), docai_n_cols, docai_stat);
            raw_by_engine.push(("doc_ai".into(), redact_now(truncate(&raw, 4000))));
        }
        Err(e) => {
            engines_failed.push(("doc_ai".to_string(), redact_now(e.clone())));
            #[cfg(debug_assertions)]
            eprintln!("── [OCR-V2:doc_ai] FAILED latency={}ms {}", docai_ms, redact_now(e));
        }
    }

    if engines_ok.is_empty() {
        return Err(format!(
            "all OCR engines failed: {}",
            engines_failed.iter().map(|(n, e)| format!("{n}={e}")).collect::<Vec<_>>().join("; ")
        ));
    }

    // ── Month resolution (validated, deterministic tie-break) ───────
    let is_valid_month = |s: &str| -> bool {
        let mut parts = s.split('-');
        let y = parts.next().and_then(|x| x.parse::<i32>().ok());
        let m = parts.next().and_then(|x| x.parse::<u32>().ok());
        matches!((y, m), (Some(y), Some(m)) if (1900..=2999).contains(&y) && (1..=12).contains(&m))
            && parts.next().is_none()
    };
    let month_votes: Vec<String> = [di_detected_month.clone(), mist_detected_month.clone(), docai_detected.clone()]
        .into_iter().flatten().filter(|s| is_valid_month(s)).collect();
    let mut month_counts: std::collections::BTreeMap<String, u32> = Default::default();
    for m in &month_votes { *month_counts.entry(m.clone()).or_insert(0u32) += 1; }
    // Prefer month_hint on ties. Also require >=2 matching votes to override
    // a valid hint — a single engine can misread a header.
    let hint_is_valid = is_valid_month(&month_hint);
    let detected_month: Option<String> = {
        let top = month_counts.iter().max_by_key(|(_, c)| **c).map(|(m, c)| (m.clone(), *c));
        match (top, hint_is_valid) {
            (Some((m, _)), true) if m == month_hint => Some(m),
            (Some((_, c)), true) if c < 2 => Some(month_hint.clone()),
            (Some((m, _)), _) => Some(m),
            (None, true) => Some(month_hint.clone()),
            (None, false) => None,
        }
    };
    let month_key = match detected_month.clone() {
        Some(m) if is_valid_month(&m) => m,
        _ if hint_is_valid => month_hint.clone(),
        _ => return Err(format!("no valid month detected (hint={month_hint:?})")),
    };

    // ── Column count (max across all engines, including Mistral) ─────
    let mist_max_col: u8 = mist_cells.iter().map(|c| c.col).max().map(|m| m + 1).unwrap_or(0);
    let n_columns = di_n_cols.max(docai_n_cols).max(mist_max_col);
    let n_columns = if n_columns == 0 { 5 } else { n_columns };

    // ── Parse month_key once for calendar validation ────────────────
    let (year_i, month_i): (i32, u32) = {
        let mut parts = month_key.split('-');
        let y = parts.next().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
        let m = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        (y, m)
    };
    let month_days: u8 = if (1..=12).contains(&month_i) && year_i > 0 {
        days_in(year_i, month_i) as u8
    } else {
        31
    };

    // ── Aggregate cells and headers across engines ───────────────────
    let mut all_cells: Vec<CellRead> = Vec::new();
    all_cells.extend(di_cells.iter().cloned());
    all_cells.extend(mist_cells.iter().cloned());
    all_cells.extend(docai_cells.iter().cloned());

    let mut all_headers: Vec<HeaderRead> = Vec::new();
    all_headers.extend(di_headers.iter().cloned());
    all_headers.extend(docai_headers.iter().cloned());

    // ── Weekend detection (SAT/SUN can never be STAT) ────────────────
    // GPT (doc_ai) has been observed to lump every blank weekday and every
    // weekend into `stat_days` when the sheet has empty rows. Weekends are
    // structurally never statutory holidays (they're just closed), so we
    // filter them out unconditionally.
    let is_weekend_day = |d: u8| -> bool {
        if (1..=12).contains(&month_i) && year_i > 0 && d >= 1 && d <= month_days {
            if let Some(date) = chrono::NaiveDate::from_ymd_opt(year_i, month_i, d as u32) {
                use chrono::Datelike;
                let wd = date.weekday();
                return wd == chrono::Weekday::Sat || wd == chrono::Weekday::Sun;
            }
        }
        false
    };

    // Strip is_stat_marker from weekend cells (doc_ai false positive).
    let all_cells: Vec<CellRead> = all_cells.into_iter()
        // is_stat_marker is deprecated. STAT is now sourced solely from
        // args.stat_dates (Settings → Stat Holidays). We ignore any
        // engine-emitted STAT markers to eliminate hallucination surface.
        .map(|mut c| { c.is_stat_marker = false; c })
        .filter(|c| c.day >= 1 && c.day <= month_days && (c.col as u16) < n_columns as u16)
        // Weekends are ALWAYS closed. Silently drop any AI cell that
        // lands on Sat/Sun — the user can't work when the centre is
        // closed, so these are noise.
        .filter(|c| !is_weekend_day(c.day))
        .collect();

    // ── Stat days (from Settings, not from OCR) ──────────────────────
    // The frontend passes args.stat_dates as ISO YYYY-MM-DD strings
    // sourced from bcStatHolidays() minus opt-outs. This is deterministic
    // and does not depend on any AI reading. Weekends can never be STAT
    // (the centre is already closed) so we filter them out.
    let mut stat_days: Vec<u8> = args.stat_dates.iter()
        .filter_map(|s| {
            let mut parts = s.split('-');
            let y: i32 = parts.next()?.parse().ok()?;
            let m: u32 = parts.next()?.parse().ok()?;
            let d: u32 = parts.next()?.parse().ok()?;
            if y == year_i && m == month_i && d >= 1 && d <= month_days as u32 {
                let du = d as u8;
                if is_weekend_day(du) { None } else { Some(du) }
            } else {
                None
            }
        })
        .collect();
    stat_days.sort();
    stat_days.dedup();

    // Drop cells that fall on STAT days — the STAT emission loop below
    // will surface them as day_type=Stat regardless of AI-reported time.
    let all_cells: Vec<CellRead> = {
        let stat_set: std::collections::HashSet<u8> = stat_days.iter().copied().collect();
        all_cells.into_iter().filter(|c| !stat_set.contains(&c.day)).collect()
    };

    // ── Column resolution ────────────────────────────────────────────
    let resolved_columns = resolve_columns(
        &all_headers, &all_cells, &args.roster, args.manifest.as_deref(), n_columns,
    );

    // ── Per (col, day) cell consensus ────────────────────────────────
    use std::collections::HashMap;
    let mut by_cell: HashMap<(u8, u8), Vec<&CellRead>> = HashMap::new();
    for c in &all_cells {
        by_cell.entry((c.col, c.day)).or_default().push(c);
    }

    let mut confident: Vec<ProposedRow> = Vec::new();
    let mut please_check: Vec<ProposedRow> = Vec::new();
    let mut couldnt_read: Vec<ProposedRow> = Vec::new();

    // STAT days emit one row per non-empty column with day_type=Stat.
    for day in &stat_days {
        for col_res in &resolved_columns {
            if matches!(col_res.decision, ColumnDecision::Empty) { continue; }
            let (staff_id, staff_name, col_cands) = column_decision_to_row_fields(&col_res.decision);
            let work_date = date_from(&month_key, *day);
            let row = ProposedRow {
                staff_id, staff_name,
                column_index: col_res.col,
                work_date,
                in_time: None, out_time: None, no_lunch: false,
                day_type: DayType::Stat,
                verdict: if staff_id.is_some() { RowVerdict::Confident } else {
                    RowVerdict::PleaseCheck { reasons: vec!["ambiguous column".into()] }
                },
                confidence: col_res.confidence,
                column_candidates: col_cands,
            };
            match &row.verdict {
                RowVerdict::Confident => confident.push(row),
                RowVerdict::PleaseCheck { .. } => please_check.push(row),
                RowVerdict::CouldntRead { .. } => couldnt_read.push(row),
            }
        }
    }

    // Cell rows.
    let stat_set: std::collections::HashSet<u8> = stat_days.iter().copied().collect();
    let mut keys: Vec<(u8, u8)> = by_cell.keys().copied().collect();
    keys.sort();
    for (col, day) in keys {
        if stat_set.contains(&day) {
            continue; // STAT already emitted above from args.stat_dates
        }
        let reads = &by_cell[&(col, day)];

        // ── Per-engine token collection ──────────────────────────────
        // Mistral OCR is the primary source of truth (95.8% precision
        // benchmarked 2026-07-14). Azure DI is retained only to (a) flag
        // conflicts against Mistral and (b) rescue cells Mistral missed.
        // Any DI-only cell surfaces as PleaseCheck; DI is never allowed
        // to override Mistral silently.
        let mut mist_in: Vec<String> = Vec::new();
        let mut mist_out: Vec<String> = Vec::new();
        let mut di_in: Vec<String> = Vec::new();
        let mut di_out: Vec<String> = Vec::new();
        let mut checkbox_votes = 0i32;
        let mut checkbox_seen = 0i32;
        for r in reads {
            let (buf_in, buf_out): (&mut Vec<String>, &mut Vec<String>) = match r.engine.as_str() {
                "mistral_ocr" => (&mut mist_in, &mut mist_out),
                "azure_di"    => (&mut di_in,   &mut di_out),
                _             => continue, // doc_ai retired; ignore its cells
            };
            for t in &r.tokens_in {
                if !buf_in.iter().any(|x| x == t) { buf_in.push(t.clone()); }
            }
            for t in &r.tokens_out {
                if !buf_out.iter().any(|x| x == t) { buf_out.push(t.clone()); }
            }
            if let Some(cb) = r.checkbox_selected {
                checkbox_seen += 1;
                if cb { checkbox_votes += 1; }
            }
        }
        let no_lunch = checkbox_seen > 0 && checkbox_votes * 2 > checkbox_seen;

        let mist_has_tokens = !mist_in.is_empty() || !mist_out.is_empty();
        let di_has_tokens   = !di_in.is_empty()   || !di_out.is_empty();

        // Skip cells with no evidence at all — no time tokens and no
        // checkbox reading. Cells with a checkbox-only read (staff
        // ticked "no lunch" but didn't fill in times) are surfaced for
        // review; the human decides whether to keep or drop.
        if !mist_has_tokens && !di_has_tokens && checkbox_seen == 0 {
            continue;
        }

        // Defensive bounds check — pre-filter should have prevented this,
        // but guard against panic if an engine emits a col past n_columns.
        let col_res = match resolved_columns.get(col as usize) {
            Some(r) => r,
            None => continue,
        };
        // Ignore cells in an Empty column (probably noise).
        if matches!(col_res.decision, ColumnDecision::Empty) {
            continue;
        }
        let (staff_id, staff_name, col_cands) = column_decision_to_row_fields(&col_res.decision);
        let work_date = date_from(&month_key, day);

        // ── Mistral-primary resolution ──────────────────────────────
        // Try Mistral's tokens alone first. If Mistral saw the cell,
        // its answer is the answer. If Mistral was silent, fall back to
        // DI but flag the row for review.
        let (in_time, out_time, pair_score, mut soft_reasons, primary_engine);
        let mut extra_reasons: Vec<String> = Vec::new();
        if mist_has_tokens {
            let (i, o, s, r) = resolve_pair(&mist_in, &mist_out, &hours);
            in_time = i; out_time = o; pair_score = s; soft_reasons = r;
            primary_engine = "mistral_ocr";
        } else {
            let (i, o, s, r) = resolve_pair(&di_in, &di_out, &hours);
            in_time = i; out_time = o; pair_score = s; soft_reasons = r;
            primary_engine = "azure_di";
            extra_reasons.push("only Azure DI saw this cell — no Mistral witness".into());
        }

        // ── DI cross-check (only when Mistral was primary) ──────────
        // If DI also has tokens for this cell, resolve them the same way
        // and compare against Mistral's answer. Any divergence (>5 min
        // on either boundary, or a slot Mistral saw as blank that DI
        // filled) becomes a PleaseCheck reason so the reviewer can pick.
        if primary_engine == "mistral_ocr" && di_has_tokens {
            let (di_in_t, di_out_t, _di_score, _) = resolve_pair(&di_in, &di_out, &hours);
            fn diff_min(a: &Option<String>, b: &Option<String>) -> Option<u32> {
                let (a, b) = (a.as_deref()?, b.as_deref()?);
                let parse = |s: &str| -> Option<u32> {
                    let mut p = s.split(':');
                    let h: u32 = p.next()?.parse().ok()?;
                    let m: u32 = p.next()?.parse().ok()?;
                    Some(h * 60 + m)
                };
                let (ma, mb) = (parse(a)?, parse(b)?);
                Some(ma.abs_diff(mb))
            }
            match (in_time.as_ref(), di_in_t.as_ref()) {
                (Some(_), Some(_)) => {
                    if let Some(d) = diff_min(&in_time, &di_in_t) {
                        if d > 5 {
                            extra_reasons.push(format!(
                                "Azure DI reads IN as {}, Mistral {} (differ by {}m)",
                                di_in_t.as_deref().unwrap_or("?"),
                                in_time.as_deref().unwrap_or("?"),
                                d,
                            ));
                        }
                    }
                }
                (None, Some(v)) => extra_reasons.push(format!("Azure DI adds IN {v}, Mistral saw none")),
                _ => {}
            }
            match (out_time.as_ref(), di_out_t.as_ref()) {
                (Some(_), Some(_)) => {
                    if let Some(d) = diff_min(&out_time, &di_out_t) {
                        if d > 5 {
                            extra_reasons.push(format!(
                                "Azure DI reads OUT as {}, Mistral {} (differ by {}m)",
                                di_out_t.as_deref().unwrap_or("?"),
                                out_time.as_deref().unwrap_or("?"),
                                d,
                            ));
                        }
                    }
                }
                (None, Some(v)) => extra_reasons.push(format!("Azure DI adds OUT {v}, Mistral saw none")),
                _ => {}
            }
        }

        let validation = validate_row(in_time.as_deref(), out_time.as_deref(), &DayType::Worked, &hours);
        let mut verdict = match validation {
            ValidationVerdict::Ok => RowVerdict::Confident,
            ValidationVerdict::Soft { reasons } => {
                let mut r = soft_reasons.clone();
                r.extend(reasons);
                RowVerdict::PleaseCheck { reasons: r }
            }
            ValidationVerdict::Hard { reasons } => {
                let mut r = soft_reasons.clone();
                r.extend(reasons);
                RowVerdict::CouldntRead { reasons: r }
            }
        };
        // If pair_score is 0.0 (no valid pair found), demote to couldnt_read.
        if pair_score <= 0.01 && (in_time.is_some() || out_time.is_some()) {
            if let RowVerdict::Confident = verdict {
                verdict = RowVerdict::PleaseCheck { reasons: vec!["low-confidence time reading".into()] };
            }
        }
        // ── Merge Mistral-vs-DI cross-check reasons ──────────────────
        // Any divergence between Mistral (primary) and DI (secondary)
        // was collected in `extra_reasons` above. A row with extras
        // must go through review — the human picks which engine to
        // trust. This replaces the old ≥2-engine corroboration gate
        // (which relied on doc_ai as a third voter and produced 60+
        // spurious please_check rows per scan; benchmarked 2026-07-14).
        if !extra_reasons.is_empty() {
            match &mut verdict {
                RowVerdict::Confident => {
                    verdict = RowVerdict::PleaseCheck { reasons: extra_reasons.clone() };
                }
                RowVerdict::PleaseCheck { reasons } => {
                    for r in &extra_reasons { reasons.push(r.clone()); }
                }
                RowVerdict::CouldntRead { .. } => {}
            }
        }
        let _ = primary_engine; // retained for future logging/telemetry
        // Column ambiguity dominates: a row cannot be Confident if its column
        // is not resolved.
        if staff_id.is_none() {
            let mut r = match &verdict { RowVerdict::Confident => Vec::new(), RowVerdict::PleaseCheck { reasons } | RowVerdict::CouldntRead { reasons } => reasons.clone() };
            r.insert(0, "column staff not resolved".into());
            verdict = if matches!(verdict, RowVerdict::CouldntRead { .. }) {
                RowVerdict::CouldntRead { reasons: r }
            } else {
                RowVerdict::PleaseCheck { reasons: r }
            };
        }
        // Merge soft_reasons that were dropped (for OK case).
        if let RowVerdict::Confident = verdict {
            soft_reasons.clear();
        }

        let confidence = (col_res.confidence * 0.5 + pair_score * 0.5).clamp(0.0, 1.0);

        let row = ProposedRow {
            staff_id, staff_name,
            column_index: col,
            work_date,
            in_time, out_time, no_lunch,
            day_type: DayType::Worked,
            verdict: verdict.clone(),
            confidence,
            column_candidates: col_cands,
        };
        match &row.verdict {
            RowVerdict::Confident => confident.push(row),
            RowVerdict::PleaseCheck { .. } => please_check.push(row),
            RowVerdict::CouldntRead { .. } => couldnt_read.push(row),
        }
    }

    #[cfg(debug_assertions)]
    eprintln!("════════ [OCR-V2] done: confident={} please_check={} couldnt_read={} ════════",
        confident.len(), please_check.len(), couldnt_read.len());

    // Per-engine cell counts (post-parse; before consensus). Used by the
    // UI to render honest "Engine · N rows" badges.
    let cells_by_engine: Vec<(String, usize)> = vec![
        ("azure_di".into(), di_cell_count),
        ("mistral_ocr".into(), mist_cell_count),
        ("doc_ai".into(), docai_cell_count),
    ];

    // ── Debug dump ─────────────────────────────────────────────────────
    // Writes the full per-engine per-cell data + consensus outcome to a
    // JSON file in the system temp dir so we can benchmark engines
    // against ground truth without eyeballing screenshots. Runs on every
    // v2 scan in DEBUG builds only; each run overwrites the previous file.
    #[cfg(debug_assertions)]
    {
        let dump = serde_json::json!({
            "timestamp_utc": chrono::Utc::now().to_rfc3339(),
            "month_hint": month_hint,
            "detected_month": detected_month,
            "n_columns_final": n_columns,
            "engines_ok": engines_ok,
            "engines_failed": engines_failed.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
            "azure_di": {
                "cell_count": di_cell_count,
                "n_cols": di_n_cols,
                "stat_days": di_stat.clone(),
                "headers": di_headers.clone(),
                "cells": di_cells.clone(),
            },
            "mistral_ocr": {
                "cell_count": mist_cell_count,
                "cells": mist_cells.clone(),
            },
            "doc_ai": {
                "cell_count": docai_cell_count,
                "n_cols": docai_n_cols,
                "stat_days": docai_stat.clone(),
                "headers": docai_headers.clone(),
                "cells": docai_cells.clone(),
            },
            "resolved_columns": resolved_columns,
            "stat_days_final": stat_days,
            "consensus": {
                "confident": confident.iter().map(|r| serde_json::json!({
                    "col": r.column_index, "staff": r.staff_name,
                    "day": r.work_date, "in": r.in_time, "out": r.out_time,
                    "day_type": r.day_type.as_db_str(),
                })).collect::<Vec<_>>(),
                "please_check": please_check.iter().map(|r| serde_json::json!({
                    "col": r.column_index, "staff": r.staff_name,
                    "day": r.work_date, "in": r.in_time, "out": r.out_time,
                    "day_type": r.day_type.as_db_str(),
                    "reasons": match &r.verdict { RowVerdict::PleaseCheck { reasons } => reasons.clone(), _ => vec![] },
                })).collect::<Vec<_>>(),
                "couldnt_read": couldnt_read.iter().map(|r| serde_json::json!({
                    "col": r.column_index, "staff": r.staff_name,
                    "day": r.work_date,
                    "reasons": match &r.verdict { RowVerdict::CouldntRead { reasons } => reasons.clone(), _ => vec![] },
                })).collect::<Vec<_>>(),
            },
        });
        let path = std::env::temp_dir().join("echelon-ocr-dump.json");
        if let Ok(txt) = serde_json::to_string_pretty(&dump) {
            let _ = std::fs::write(&path, txt);
            eprintln!("── [OCR-V2] debug dump → {}", path.display());
        }
    }

    Ok(GridConsensusResult {
        confident, please_check, couldnt_read,
        columns: resolved_columns,
        stat_days,
        detected_month_year: detected_month,
        engines_ok, engines_failed,
        month_key,
        raw_by_engine,
        cells_by_engine,
    })
}

fn column_decision_to_row_fields(dec: &ColumnDecision) -> (Option<i64>, Option<String>, Vec<ColumnCandidate>) {
    match dec {
        ColumnDecision::Confident { staff_id, staff_name } => (Some(*staff_id), Some(staff_name.clone()), Vec::new()),
        ColumnDecision::Ambiguous { candidates } => (None, None, candidates.clone()),
        ColumnDecision::Empty => (None, None, Vec::new()),
        ColumnDecision::Unknown { .. } => (None, None, Vec::new()),
    }
}

fn date_from(month_key: &str, day: u8) -> String {
    // month_key is "YYYY-MM"; day is 1..31.
    format!("{}-{:02}", month_key, day)
}

// ────────────────────────────────────────────────────────────────────────
// Tauri commands
// ────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn extract_timesheet_grid(args: GridArgs) -> Result<GridConsensusResult, String> {
    extract_grid_impl(args).await
}

#[derive(Deserialize)]
pub struct RevalidateArgs {
    pub in_time: Option<String>,
    pub out_time: Option<String>,
    pub day_type: String, // "worked" | "stat" | ...
    pub centre_open_time: String,
    pub centre_close_time: String,
    pub centre_hours_slack_min: String,
}

#[derive(Serialize)]
pub struct RevalidateResult {
    pub verdict: String, // "ok" | "soft" | "hard"
    pub reasons: Vec<String>,
}

#[tauri::command]
pub async fn revalidate_row(args: RevalidateArgs) -> Result<RevalidateResult, String> {
    let hours = CentreHours::from_strings(
        &args.centre_open_time, &args.centre_close_time, &args.centre_hours_slack_min,
    );
    let day_type = match args.day_type.trim().to_ascii_lowercase().as_str() {
        "worked" => DayType::Worked,
        "stat" => DayType::Stat,
        "sick" => DayType::Sick,
        "vacation" => DayType::Vacation,
        "off" => DayType::Off,
        other => return Err(format!("unknown day_type: {other}")),
    };
    let v = validate_row(args.in_time.as_deref(), args.out_time.as_deref(), &day_type, &hours);
    Ok(match v {
        ValidationVerdict::Ok => RevalidateResult { verdict: "ok".into(), reasons: Vec::new() },
        ValidationVerdict::Soft { reasons } => RevalidateResult { verdict: "soft".into(), reasons },
        ValidationVerdict::Hard { reasons } => RevalidateResult { verdict: "hard".into(), reasons },
    })
}

// ────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────
// Unit tests
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn hours_default() -> CentreHours {
        CentreHours { open_min: 7 * 60, close_min: 18 * 60 + 30, slack_min: 60 }
    }

    #[test]
    fn resolve_pair_pm_inference_for_out_only() {
        let h = hours_default();
        let (i, o, s, _) = resolve_pair(&["11:00".into()], &["7:40".into()], &h);
        assert_eq!(i.as_deref(), Some("11:00"));
        assert_eq!(o.as_deref(), Some("19:40"));
        assert!(s > 0.0);
    }

    #[test]
    fn resolve_pair_prefers_pm_out_when_am_would_be_before_in() {
        let h = hours_default();
        let (_i, o, _s, _) = resolve_pair(&["8:30".into()], &["5:00".into()], &h);
        assert_eq!(o.as_deref(), Some("17:00"));
    }

    #[test]
    fn resolve_pair_leaves_valid_am_alone() {
        let h = hours_default();
        let (i, o, _s, _) = resolve_pair(&["9:00".into()], &["13:00".into()], &h);
        assert_eq!(i.as_deref(), Some("09:00"));
        assert_eq!(o.as_deref(), Some("13:00"));
    }

    #[test]
    fn validate_row_rejects_midnight_cross() {
        let h = hours_default();
        let v = validate_row(Some("22:00"), Some("06:00"), &DayType::Worked, &h);
        assert!(matches!(v, ValidationVerdict::Hard { .. }));
    }

    #[test]
    fn validate_row_soft_outside_hours() {
        let h = hours_default();
        // Both times within window (lo=06:00, hi=19:30), duration=9h → Ok.
        let v = validate_row(Some("08:15"), Some("17:15"), &DayType::Worked, &h);
        assert!(matches!(v, ValidationVerdict::Ok));
    }

    #[test]
    fn validate_row_soft_over_12h() {
        let h = hours_default();
        let v = validate_row(Some("07:00"), Some("20:00"), &DayType::Worked, &h);
        // 13h shift → soft warning (open=07:00 lo=06:00, close=18:30 hi=19:30
        // → OUT 20:00 is over hi → still soft, not hard).
        match v {
            ValidationVerdict::Soft { reasons } => {
                assert!(reasons.iter().any(|r| r.contains("over 12")));
            }
            other => panic!("expected Soft, got {other:?}"),
        }
    }

    #[test]
    fn validate_row_stat_bypasses_time_checks() {
        let h = hours_default();
        let v = validate_row(None, None, &DayType::Stat, &h);
        assert!(matches!(v, ValidationVerdict::Ok));
    }

    #[test]
    fn name_similarity_first_name_affinity() {
        let s1 = name_similarity("Kiranpreet", "Kiran");
        let s2 = name_similarity("Kiranpreet", "Chloe");
        assert!(s1 > s2, "expected Kiranpreet~Kiran ({s1}) > Kiranpreet~Chloe ({s2})");
        assert!(s1 > 0.6);
    }

    #[test]
    fn column_resolver_prevents_double_assignment() {
        // Two columns both header-read as "Chloe"; resolver must map to different rosters.
        let roster = vec![
            RosterEntry { id: 1, name: "Chloe".into() },
            RosterEntry { id: 2, name: "Judy".into() },
        ];
        let headers = vec![
            HeaderRead { engine: "doc_ai".into(), col: 0, text: "Chloe".into(), confidence: 0.9 },
            HeaderRead { engine: "doc_ai".into(), col: 1, text: "Chloe".into(), confidence: 0.6 },
        ];
        let cells = vec![
            CellRead { engine: "doc_ai".into(), col: 0, day: 1, tokens_in: vec!["9:00".into()], tokens_out: vec![], checkbox_selected: None, is_stat_marker: false, confidence: 0.8, bbox: None },
            CellRead { engine: "doc_ai".into(), col: 1, day: 1, tokens_in: vec!["9:00".into()], tokens_out: vec![], checkbox_selected: None, is_stat_marker: false, confidence: 0.8, bbox: None },
        ];
        let res = resolve_columns(&headers, &cells, &roster, None, 2);
        // Exactly one column resolves to Chloe (id=1). The other must not.
        let chloe_cols: Vec<u8> = res.iter().filter_map(|r| match &r.decision {
            ColumnDecision::Confident { staff_id: 1, .. } => Some(r.col),
            _ => None,
        }).collect();
        assert_eq!(chloe_cols.len(), 1, "resolver double-assigned Chloe: {:?}", res);
    }

    #[test]
    fn column_resolver_flags_new_staff_as_unknown() {
        let roster = vec![RosterEntry { id: 1, name: "Chloe".into() }];
        let headers = vec![
            HeaderRead { engine: "doc_ai".into(), col: 0, text: "Chloe".into(), confidence: 0.9 },
            HeaderRead { engine: "doc_ai".into(), col: 1, text: "Kiranpreet".into(), confidence: 0.9 },
        ];
        let cells = vec![
            CellRead { engine: "doc_ai".into(), col: 1, day: 1, tokens_in: vec!["9:00".into()], tokens_out: vec![], checkbox_selected: None, is_stat_marker: false, confidence: 0.8, bbox: None },
        ];
        let res = resolve_columns(&headers, &cells, &roster, None, 2);
        assert!(matches!(res[0].decision, ColumnDecision::Confident { staff_id: 1, .. }));
        // Col 1 must NOT be Confident-Chloe, and must NOT be silently Empty.
        match &res[1].decision {
            ColumnDecision::Unknown { header_read } => {
                assert!(header_read.to_lowercase().contains("kiran"), "wrong header: {header_read}");
            }
            other => panic!("expected Unknown for new staff, got {other:?}"),
        }
    }

    #[test]
    fn column_resolver_manifest_prior_boosts_but_needs_corroboration() {
        let roster = vec![
            RosterEntry { id: 1, name: "Chloe".into() },
            RosterEntry { id: 2, name: "Kiran".into() },
        ];
        // Header reads that themselves are ambiguous, but Mistral OCR sees
        // "Kiran" in col 1's header. Manifest agrees.
        let headers = vec![
            HeaderRead { engine: "doc_ai".into(), col: 0, text: "Chloe".into(), confidence: 0.9 },
            HeaderRead { engine: "doc_ai".into(), col: 1, text: "Kiran".into(), confidence: 0.6 },
        ];
        let cells = vec![
            CellRead { engine: "doc_ai".into(), col: 1, day: 1, tokens_in: vec!["9:00".into()], tokens_out: vec![], checkbox_selected: None, is_stat_marker: false, confidence: 0.8, bbox: None },
        ];
        let manifest = vec![ManifestEntry { col: 1, staff_id: 2, staff_name: "Kiran".into() }];
        let res = resolve_columns(&headers, &cells, &roster, Some(&manifest), 2);
        assert!(matches!(res[1].decision, ColumnDecision::Confident { staff_id: 2, .. }),
                "manifest + corroborating OCR should confirm col 1 -> Kiran; got {:?}", res[1].decision);
    }

    #[test]
    fn column_resolver_manifest_without_readable_header_stays_ambiguous() {
        // Stale manifest on a column that has digits but NO readable header
        // for that roster candidate. Prior code would clear the Confident
        // gate at score 0.65 (0.05 digits + 0.6 manifest); v2 requires OCR
        // evidence >= 0.35 for Confident.
        let roster = vec![
            RosterEntry { id: 1, name: "Chloe".into() },
            RosterEntry { id: 2, name: "Kiran".into() },
        ];
        let headers: Vec<HeaderRead> = vec![]; // no header readable
        let cells = vec![
            CellRead { engine: "doc_ai".into(), col: 0, day: 1, tokens_in: vec!["9:00".into()], tokens_out: vec![], checkbox_selected: None, is_stat_marker: false, confidence: 0.8, bbox: None },
        ];
        let manifest = vec![ManifestEntry { col: 0, staff_id: 2, staff_name: "Kiran".into() }];
        let res = resolve_columns(&headers, &cells, &roster, Some(&manifest), 1);
        // Must NOT be Confident. Ambiguous or Unknown are both acceptable.
        assert!(!matches!(res[0].decision, ColumnDecision::Confident { .. }),
                "manifest alone without any header evidence must not force Confident; got {:?}", res[0].decision);
    }

    #[test]
    fn column_resolver_stale_manifest_loses_to_strong_ocr() {
        // Stale manifest says Kiran but the OCR clearly reads Sager.
        let roster = vec![
            RosterEntry { id: 1, name: "Sager".into() },
            RosterEntry { id: 2, name: "Kiran".into() },
        ];
        let headers = vec![
            HeaderRead { engine: "doc_ai".into(), col: 0, text: "Sager".into(), confidence: 0.95 },
        ];
        let cells = vec![
            CellRead { engine: "doc_ai".into(), col: 0, day: 1, tokens_in: vec!["9:00".into()], tokens_out: vec![], checkbox_selected: None, is_stat_marker: false, confidence: 0.8, bbox: None },
        ];
        let manifest = vec![ManifestEntry { col: 0, staff_id: 2, staff_name: "Kiran".into() }];
        let res = resolve_columns(&headers, &cells, &roster, Some(&manifest), 1);
        // Strong OCR evidence for Sager should still win over stale manifest.
        assert!(matches!(res[0].decision, ColumnDecision::Confident { staff_id: 1, .. }),
                "strong OCR evidence should override stale manifest; got {:?}", res[0].decision);
    }
}
