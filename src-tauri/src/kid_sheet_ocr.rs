// v3.1.0 — Deterministic monthly-attendance sheet reader (kid variant).
//
// Motivation:
//   The vision-model consensus pipeline (extract_month_attendance in
//   azure_ai.rs) has proven unreliable on the printed Echelon sheet:
//   primary silently under-reads (returned 2/25 rows in July 2026), and
//   the secondary occasionally over-marks (200 marks on a ~65-mark
//   sheet). Root cause: neither model can be trusted to count columns
//   and rows on a 25×31 grid; both drift.
//
//   The sheet is designed to be AI-friendly precisely so we DON'T need
//   a vision model for the mark itself:
//     • QR code encodes month/year and the printed roster (row order).
//     • Four corner fiducials give a stable homography anchor.
//     • Grid lines are 1px black borders — visible even in phone photos.
//     • Cells contain only three states: blank, X (present), - (absent).
//
//   This module implements a pure-CV pipeline:
//     1. Detect the 4 fiducials → homography → canonical 2200×1700 image.
//     2. Detect grid lines to recover exact row/column boundaries.
//     3. Classify each cell by ink density + stroke shape.
//
//   No network calls. Deterministic. ~500ms on a phone photo.
//   The vision-model pipeline is kept as a fallback (opt-in beta toggle
//   in Settings — the caller decides which pipeline to run).

#![allow(clippy::needless_range_loop)]

use image::{DynamicImage, GenericImageView, GrayImage, Luma};
use serde::{Deserialize, Serialize};

// ─── Canonical geometry (11×8.5in landscape @ 200 DPI) ──────────────────
// Same aspect ratio as the print sheet. High enough resolution to keep
// 4mm fiducials at ~32px squares (very detectable).

const CANONICAL_W: u32 = 2200; // 11 in × 200 DPI
const CANONICAL_H: u32 = 1700; // 8.5 in × 200 DPI

// Fiducial CENTER positions in canonical pixels, matching the CSS in
// MonthlyAttendance.tsx (v3.0.5 layout — locked).
//   TL: top: 2mm, left: 15mm → center at (15mm+2mm, 2mm+2mm) = (17mm, 4mm)
//   TR: top: 2mm, right: 15mm → center at (11in − 17mm, 4mm)
//   BL: bottom: 10mm, left: 15mm → center at (17mm, 8.5in − 12mm)
//   BR: bottom: 10mm, right: 15mm → center at (11in − 17mm, 8.5in − 12mm)
// mm → canonical px: mm × (200 / 25.4) ≈ mm × 7.874.
const FID_INSET_X_PX: f64 = 133.86;      // 17 mm
const FID_INSET_Y_TOP_PX: f64 = 31.50;   //  4 mm
const FID_INSET_Y_BOT_PX: f64 = 94.49;   // 12 mm

fn canonical_fiducial_targets() -> [(f64, f64); 4] {
    let w = CANONICAL_W as f64;
    let h = CANONICAL_H as f64;
    [
        (FID_INSET_X_PX,           FID_INSET_Y_TOP_PX),               // TL
        (w - FID_INSET_X_PX,       FID_INSET_Y_TOP_PX),               // TR
        (FID_INSET_X_PX,           h - FID_INSET_Y_BOT_PX),           // BL
        (w - FID_INSET_X_PX,       h - FID_INSET_Y_BOT_PX),           // BR
    ]
}

// ─── Public API ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ExtractLocalArgs {
    pub image_path: String,
    /// The month key used to build the day list, e.g. "2026-07".
    pub target_month: String,
    /// Days in `target_month` that are weekends / STAT / centre-closed,
    /// as 1-based day numbers. These are excluded from classification
    /// (the sheet's non-writing zones).
    pub weekend_days: Vec<u32>,
    pub stat_days: Vec<u32>,
    pub closed_days: Vec<u32>,
    /// Roster in printed row order — one entry per row of the sheet's
    /// body. Used to key the output rows without touching handwriting.
    pub roster: Vec<RosterEntry>,
}

#[derive(Deserialize, Clone)]
pub struct RosterEntry {
    pub student_id: i64,
    pub student_name: String,
}

#[derive(Serialize, Clone)]
pub struct ExtractedRow {
    pub child_name: String,
    /// Day (as string) → "P" or "A". Blank cells are OMITTED.
    pub marks: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize)]
pub struct ExtractLocalResult {
    pub month: String,
    pub rows: Vec<ExtractedRow>,
    /// Diagnostic breadcrumbs — surfaced in raw_text for debugging.
    pub raw_text: String,
    pub uncertain_cells: Vec<UncertainCell>,
    pub providers: Vec<ProviderMeta>,
    /// Always "local_deterministic" from this pipeline.
    pub consensus_action: String,
    pub days_centre_open: Option<u32>,
}

#[derive(Serialize)]
pub struct UncertainCell {
    pub child_name: String,
    pub day: String,
    pub picked: String,
    pub votes: Vec<String>,
    pub confidence: f32,
}

#[derive(Serialize)]
pub struct ProviderMeta {
    pub provider: String,
    pub ok: bool,
    pub latency_ms: u128,
    pub row_count: usize,
    pub mark_count: usize,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn extract_kid_attendance_local(
    args: ExtractLocalArgs,
) -> Result<ExtractLocalResult, String> {
    let start = std::time::Instant::now();
    let path = args.image_path.clone();
    let target_month = args.target_month.clone();
    let roster = args.roster.clone();
    let weekend = args.weekend_days.clone();
    let stat = args.stat_days.clone();
    let closed = args.closed_days.clone();

    let (result, err) = tokio::task::spawn_blocking(move || {
        run_pipeline(&path, &target_month, &roster, &weekend, &stat, &closed)
    })
    .await
    .map_err(|e| format!("local ocr task panicked: {}", e))?
    .map(|r| (Some(r), None))
    .unwrap_or_else(|e| (None, Some(e)));

    let elapsed_ms = start.elapsed().as_millis();
    if let Some(mut r) = result {
        let mark_count: usize = r.rows.iter().map(|row| row.marks.len()).sum();
        let row_count = r.rows.iter().filter(|r| !r.marks.is_empty()).count();
        r.providers = vec![ProviderMeta {
            provider: "local_deterministic_v1".to_string(),
            ok: true,
            latency_ms: elapsed_ms,
            row_count,
            mark_count,
            error: None,
        }];
        eprintln!(
            "[kid-ocr-local] ok in {}ms — {} rows, {} marks",
            elapsed_ms, row_count, mark_count
        );
        Ok(r)
    } else {
        let msg = err.unwrap_or_else(|| "unknown local ocr failure".to_string());
        eprintln!("[kid-ocr-local] failed in {}ms: {}", elapsed_ms, msg);
        Err(msg)
    }
}

// ─── Pipeline ────────────────────────────────────────────────────────────

fn run_pipeline(
    path: &str,
    target_month: &str,
    roster: &[RosterEntry],
    weekend: &[u32],
    stat: &[u32],
    closed: &[u32],
) -> Result<ExtractLocalResult, String> {
    let img = image::open(path).map_err(|e| format!("failed to open image: {}", e))?;
    let (orig_w, orig_h) = img.dimensions();

    // The image may still be in portrait / rotated orientation. Try
    // fiducial detection at 0°, 90°, 180°, 270° and pick the rotation
    // that gives four well-placed fiducials (one per corner).
    // Try per-corner detection at 4 rotations, keeping the BEST partial
    // result (most confident corners) even if the rectangle check fails.
    // Real-world photos frequently crop out 1-2 fiducials; we can still
    // recover using the remaining strong pair + known print aspect ratio.
    // v3.1.2: always keep the current rotation as a candidate (even at zero
    // confident fiducials) so the page-quad fallback can still be tried.
    // Tie-break equal confident counts using a landscape-aspect score:
    // the sheet is designed 245.4×199.9mm (landscape), so we prefer
    // rotations where any confident-fiducial pair's bounding box is wider
    // than tall.
    let mut best_partial: Option<(u32, [Option<FiducialPick>; 4], GrayImage, f64)> = None;
    for deg in [0u32, 90, 180, 270] {
        eprintln!("[kid-ocr-local] trying rotation {}°", deg);
        let rotated = match deg {
            0 => img.clone(),
            90 => image::DynamicImage::ImageRgba8(image::imageops::rotate90(&img.to_rgba8())),
            180 => image::DynamicImage::ImageRgba8(image::imageops::rotate180(&img.to_rgba8())),
            270 => image::DynamicImage::ImageRgba8(image::imageops::rotate270(&img.to_rgba8())),
            _ => unreachable!(),
        };
        let gray = rotated.to_luma8();
        let picks = detect_fiducial_picks(&gray);
        let strong_count = picks.iter().filter(|p| p.as_ref().map_or(false, |q| q.confident)).count();
        eprintln!(
            "[kid-ocr-local] rotation {}° found {} confident fiducials",
            deg, strong_count
        );
        if strong_count == 4 {
            let fids = [
                picks[0].as_ref().unwrap().pos,
                picks[1].as_ref().unwrap().pos,
                picks[2].as_ref().unwrap().pos,
                picks[3].as_ref().unwrap().pos,
            ];
            if fiducials_look_sane(&fids, gray.width(), gray.height()) {
                eprintln!("[kid-ocr-local] rotation {}° all 4 confident and rectangular", deg);
                best_partial = Some((deg, picks, gray, f64::INFINITY));
                break;
            }
        }
        // Landscape-aspect score for tie-break: compute the bounding box
        // of confident picks and reward width > height. Falls back to 0
        // when fewer than 2 confident picks (no meaningful aspect).
        let landscape_score = {
            let cs: Vec<_> = picks.iter().filter_map(|p| p.as_ref().filter(|q| q.confident).map(|q| q.pos)).collect();
            if cs.len() >= 2 {
                let xs: Vec<f64> = cs.iter().map(|p| p.0).collect();
                let ys: Vec<f64> = cs.iter().map(|p| p.1).collect();
                let bw = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
                    - xs.iter().cloned().fold(f64::INFINITY, f64::min);
                let bh = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
                    - ys.iter().cloned().fold(f64::INFINITY, f64::min);
                // Aspect ratio bonus: landscape (bw > bh) is what we want.
                if bh > 0.0 { bw / bh } else { 0.0 }
            } else {
                0.0
            }
        };
        let this_key = (strong_count as f64) * 100.0 + landscape_score;
        let cur_key = best_partial.as_ref().map(|(_, _, _, k)| *k);
        if cur_key.map_or(true, |k| this_key > k) {
            best_partial = Some((deg, picks, gray, this_key));
        }
    }

    let (rotation_applied, picks, gray, _score) = best_partial.ok_or_else(|| {
        format!(
            "no fiducial candidates found in {}×{} image at any rotation",
            orig_w, orig_h
        )
    })?;

    // Two anchoring strategies, in order of preference:
    //   1. Fiducial-based warp: uses the 4 corner squares (or synthesizes
    //      missing ones from partial + known geometry). Highest precision
    //      when fiducials are visible.
    //   2. Page-quad warp (OMRChecker CropPage-style): detects the sheet's
    //      outer paper boundary as the largest bright rectangle and warps
    //      paper corners → canonical page corners. Works even when ALL
    //      fiducials are cropped or unprinted — as long as the paper edges
    //      are visible against a darker background.
    // We commit to fiducials only when at least 3 are confident (strong
    // signal); otherwise we let the page-quad detector try first and only
    // fall through to fiducial synthesis if page detection fails.
    let strong = picks.iter().filter(|p| p.as_ref().map_or(false, |q| q.confident)).count();
    let warped: GrayImage;
    let anchor_desc: String;

    if strong >= 3 {
        let fiducials = synthesize_fiducials(&picks, gray.width(), gray.height()).ok_or_else(|| {
            format!(
                "3+ confident fiducials but synthesis failed in {}×{} image",
                orig_w, orig_h
            )
        })?;
        eprintln!(
            "[kid-ocr-local] fiducial anchor (rot {}°, {} confident): TL=({:.0},{:.0}) TR=({:.0},{:.0}) BL=({:.0},{:.0}) BR=({:.0},{:.0})",
            rotation_applied, strong,
            fiducials[0].0, fiducials[0].1,
            fiducials[1].0, fiducials[1].1,
            fiducials[2].0, fiducials[2].1,
            fiducials[3].0, fiducials[3].1,
        );
        warped = perspective_warp(
            &gray, &fiducials, &canonical_fiducial_targets(),
            CANONICAL_W, CANONICAL_H,
        );
        anchor_desc = format!("fiducials-{}confident", strong);
    } else if let Some(page) = detect_page_quad(&gray) {
        eprintln!(
            "[kid-ocr-local] page-quad anchor (rot {}°, only {} confident fiducials): TL=({:.0},{:.0}) TR=({:.0},{:.0}) BL=({:.0},{:.0}) BR=({:.0},{:.0})",
            rotation_applied, strong,
            page[0].0, page[0].1,
            page[1].0, page[1].1,
            page[2].0, page[2].1,
            page[3].0, page[3].1,
        );
        // Paper corners → canonical page corners (full 2200×1700).
        let page_dst: [(f64, f64); 4] = [
            (0.0, 0.0),
            (CANONICAL_W as f64, 0.0),
            (0.0, CANONICAL_H as f64),
            (CANONICAL_W as f64, CANONICAL_H as f64),
        ];
        warped = perspective_warp(&gray, &page, &page_dst, CANONICAL_W, CANONICAL_H);
        anchor_desc = format!("page-quad-{}fid", strong);
    } else {
        // Last resort: synthesize from whatever fiducials we have.
        let fiducials = synthesize_fiducials(&picks, gray.width(), gray.height()).ok_or_else(|| {
            format!(
                "could not resolve sheet position in {}×{} image — retake the photo showing all 4 paper edges OR all 4 corner black squares",
                orig_w, orig_h
            )
        })?;
        eprintln!(
            "[kid-ocr-local] fiducial-synthesis fallback (rot {}°, {} confident): TL=({:.0},{:.0}) TR=({:.0},{:.0}) BL=({:.0},{:.0}) BR=({:.0},{:.0})",
            rotation_applied, strong,
            fiducials[0].0, fiducials[0].1,
            fiducials[1].0, fiducials[1].1,
            fiducials[2].0, fiducials[2].1,
            fiducials[3].0, fiducials[3].1,
        );
        warped = perspective_warp(
            &gray, &fiducials, &canonical_fiducial_targets(),
            CANONICAL_W, CANONICAL_H,
        );
        anchor_desc = format!("fid-synth-{}confident", strong);
    }

    // Detect the grid.
    let grid = detect_grid(&warped, roster.len(), target_month)?;

    // Classify each cell.
    let (rows, uncertain) = classify_cells(&warped, &grid, roster, weekend, stat, closed);

    let raw_text = format!(
        "[local ocr v1.1] rotation={}° anchor={} ({} rows × {} day cols), roster {}\n\ngrid: rows_y={:?}, cols_x={:?}",
        rotation_applied,
        anchor_desc,
        grid.row_ys.len().saturating_sub(1),
        grid.col_xs.len().saturating_sub(1),
        roster.len(),
        grid.row_ys.iter().take(4).collect::<Vec<_>>(),
        grid.col_xs.iter().take(4).collect::<Vec<_>>(),
    );

    Ok(ExtractLocalResult {
        month: target_month.to_string(),
        rows,
        raw_text,
        uncertain_cells: uncertain,
        providers: vec![], // filled in by caller with timing
        consensus_action: "local_deterministic".to_string(),
        days_centre_open: None,
    })
}

// ─── Fiducial detection ──────────────────────────────────────────────────

// A per-corner detection result, with confidence so downstream code can
// fall back to synthesis when a corner is off-frame or unprinted.
#[derive(Clone, Copy, Debug)]
struct FiducialPick {
    pos: (f64, f64),
    size: f64,   // max(bw, bh) of the picked blob, in pixels
    fill: f64,
    confident: bool,
}

/// Per-corner fiducial search. Splits the image into four 30%×30% corner
/// crops and runs a local Otsu threshold on each independently, so uneven
/// lighting or a shadowed corner doesn't kill detection elsewhere. Returns
/// one Option per corner; confidence flag is set when the pick both is
/// solid-square-shaped AND close to the expected size.
fn detect_fiducial_picks(gray: &GrayImage) -> [Option<FiducialPick>; 4] {
    let (w, h) = gray.dimensions();
    if w < 400 || h < 300 {
        eprintln!("[kid-ocr-local]   image too small: {}×{}", w, h);
        return [None; 4];
    }

    let long_edge = w.max(h) as f64;
    let expected_side = 4.0 / 25.4 * (long_edge / 11.0);
    let min_side = (expected_side * 0.30).max(5.0);
    let max_side = expected_side * 3.5;
    let min_area = (min_side * min_side * 0.4) as u32;
    let max_area = (max_side * max_side * 1.8) as u32;

    let crop_frac = 0.30;
    let cw = (w as f64 * crop_frac) as u32;
    let ch = (h as f64 * crop_frac) as u32;

    let regions = [
        (0u32,   0u32,   "TL", 0.0f64,    0.0f64),
        (w - cw, 0,      "TR", cw as f64, 0.0),
        (0,      h - ch, "BL", 0.0,       ch as f64),
        (w - cw, h - ch, "BR", cw as f64, ch as f64),
    ];

    let mut picked: [Option<FiducialPick>; 4] = [None; 4];
    for (ci, &(x0, y0, label, ox, oy)) in regions.iter().enumerate() {
        let sub = image::imageops::crop_imm(gray, x0, y0, cw, ch).to_image();
        let local_thr = otsu_threshold(&sub).saturating_sub(8);
        let labels = label_dark_components(&sub, local_thr);
        let all = summarize_blobs(&labels, sub.width(), sub.height());

        let candidates: Vec<&Blob> = all.iter().filter(|b| {
            let bw = (b.x1 - b.x0 + 1) as f64;
            let bh = (b.y1 - b.y0 + 1) as f64;
            let aspect = if bw > bh { bw / bh } else { bh / bw };
            b.area >= min_area
                && b.area <= max_area
                && bw >= min_side
                && bh >= min_side
                && bw <= max_side
                && bh <= max_side
                && aspect <= 1.8
                && b.fill_ratio() >= 0.45
        }).collect();

        let diag = (cw as f64).hypot(ch as f64);
        let mut scored: Vec<(&Blob, f64)> = candidates.iter().map(|b| {
            let (bx, by) = b.centroid();
            let bw = (b.x1 - b.x0 + 1) as f64;
            let bh = (b.y1 - b.y0 + 1) as f64;
            let side = bw.max(bh);
            let size_err = (side - expected_side).abs() / expected_side;
            let corner_d = ((bx - ox).powi(2) + (by - oy).powi(2)).sqrt() / diag;
            let score = size_err + 0.15 * corner_d;
            (*b, score)
        }).collect();
        scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

        if let Some(&(b, _)) = scored.first() {
            let (bx, by) = b.centroid();
            let full_x = bx + x0 as f64;
            let full_y = by + y0 as f64;
            let bw = (b.x1 - b.x0 + 1) as f64;
            let bh = (b.y1 - b.y0 + 1) as f64;
            let side = bw.max(bh);
            let fill = b.fill_ratio();
            // Confidence: strong fill AND size close to expected.
            let size_ok = side >= expected_side * 0.70 && side <= expected_side * 1.35;
            let confident = fill >= 0.85 && size_ok;
            eprintln!(
                "[kid-ocr-local]   {}: {} candidates (thr={}, exp {:.0}px), picked {:.0}×{:.0}@({:.0},{:.0}) fill={:.2} confident={}",
                label, candidates.len(), local_thr, expected_side, bw, bh, full_x, full_y, fill, confident
            );
            picked[ci] = Some(FiducialPick {
                pos: (full_x, full_y),
                size: side,
                fill,
                confident,
            });
        } else {
            eprintln!(
                "[kid-ocr-local]   {}: NO candidate (crop {}×{} thr={}, exp {:.0}px, size window [{:.0}..{:.0}]px)",
                label, cw, ch, local_thr, expected_side, min_side, max_side
            );
        }
    }

    picked
}

/// Given per-corner picks (some may be missing or non-confident), return
/// four fiducial positions in image coordinates. Falls back to inferring
/// missing corners from confident ones using the known printed sheet
/// geometry (always landscape 245.4×199.9mm — the CSS produces one design).
///
/// Corner indexing throughout: TL=0, TR=1, BL=2, BR=3.
fn synthesize_fiducials(
    picks: &[Option<FiducialPick>; 4],
    _w: u32,
    _h: u32,
) -> Option<[(f64, f64); 4]> {
    let confident: Vec<usize> = picks.iter().enumerate()
        .filter_map(|(i, p)| p.as_ref().and_then(|q| if q.confident { Some(i) } else { None }))
        .collect();

    // Fast path: all 4 confident.
    if confident.len() == 4 {
        return Some([
            picks[0].as_ref().unwrap().pos,
            picks[1].as_ref().unwrap().pos,
            picks[2].as_ref().unwrap().pos,
            picks[3].as_ref().unwrap().pos,
        ]);
    }

    // 3-anchor path: complete the missing corner via parallelogram — the
    // three known points fully determine an affine (rotation + skew) frame,
    // so the missing corner is exactly determined and we should never
    // discard the third measurement. For missing corner `m`, the diagonal
    // opposite is d = 3 - m (TL↔BR, TR↔BL). The two adjacent corners are
    // a, b (the remaining two indices). Then: p_m = p_a + p_b - p_d.
    if confident.len() == 3 {
        let all = [0usize, 1, 2, 3];
        let missing = *all.iter().find(|i| !confident.contains(*i)).unwrap();
        let diag = 3 - missing;
        let adj: Vec<usize> = all.iter().copied()
            .filter(|i| *i != missing && *i != diag)
            .collect();
        let pm = {
            let pa = picks[adj[0]].as_ref().unwrap().pos;
            let pb = picks[adj[1]].as_ref().unwrap().pos;
            let pd = picks[diag].as_ref().unwrap().pos;
            (pa.0 + pb.0 - pd.0, pa.1 + pb.1 - pd.1)
        };
        eprintln!(
            "[kid-ocr-local] 3-anchor synthesis: missing corner {} (diag={}, adj={:?}) → ({:.0}, {:.0})",
            missing, diag, adj, pm.0, pm.1
        );
        let mut out = [(0.0, 0.0); 4];
        for i in 0..4 {
            out[i] = if i == missing { pm } else { picks[i].as_ref().unwrap().pos };
        }
        return Some(out);
    }

    if confident.len() < 2 {
        eprintln!("[kid-ocr-local] only {} confident fiducial(s) — cannot synthesize", confident.len());
        return None;
    }

    // 2-anchor path. Order: TL=0, TR=1, BL=2, BR=3.
    let diagonals = [(0usize, 3usize), (1, 2)];
    let edges_lr = [(0usize, 2usize), (1, 3)]; // left edge, right edge — same-x pairs
    let edges_tb = [(0usize, 1usize), (2, 3)]; // top edge, bottom edge — same-y pairs

    let has = |i: usize| confident.contains(&i);
    let pick = |i: usize| picks[i].as_ref().unwrap().pos;

    // Case: both diagonal points confident.
    // The sheet is always designed landscape 245.4×199.9mm (long × short).
    // Diagonal length = √(245.4² + 199.9²) = 316.5mm; we axis-align to the
    // image, which is only correct when the sheet is roughly straight.
    for &(a, b) in &diagonals {
        if has(a) && has(b) {
            let pa = pick(a);
            let pb = pick(b);
            // Figure out which pick is TL and which is BR (in image space).
            // For diagonal (0,3): pa is TL by construction, pb is BR.
            // For diagonal (1,2): pa is TR, pb is BL — need to derive TL/BR
            // from image y-coordinates rather than from the (a,b) labels.
            let (tl, tr, bl, br) = if (a, b) == (0, 3) {
                let tl = pa; let br = pb;
                (tl, (br.0, tl.1), (tl.0, br.1), br)
            } else {
                // (1, 2): pa is TR (top-right), pb is BL (bottom-left).
                // Determine which is actually the top vs bottom by y.
                let (top_right, bot_left) = if pa.1 < pb.1 { (pa, pb) } else { (pb, pa) };
                let tl = (bot_left.0, top_right.1);
                let br = (top_right.0, bot_left.1);
                (tl, top_right, bot_left, br)
            };
            eprintln!(
                "[kid-ocr-local] 2-anchor diagonal synthesis {}+{} → TL=({:.0},{:.0}) TR=({:.0},{:.0}) BL=({:.0},{:.0}) BR=({:.0},{:.0})",
                a, b, tl.0, tl.1, tr.0, tr.1, bl.0, bl.1, br.0, br.1
            );
            return Some([tl, tr, bl, br]);
        }
    }

    // Case: adjacent pair on the left or right edge (both share x).
    // On a landscape sheet, this pair spans the SHORT dimension of the
    // printed frame: axis = 199.9mm, perpendicular = 245.4mm.
    for &(a, b) in &edges_lr {
        if has(a) && has(b) {
            let pa = pick(a); let pb = pick(b);
            let (top, bot) = if pa.1 < pb.1 { (pa, pb) } else { (pb, pa) };
            let axis_len = (bot.0 - top.0).hypot(bot.1 - top.1);
            let axis_mm_true = 199.9;
            let perp_mm = 245.4;
            let pxpermm = axis_len / axis_mm_true;
            let perp_len_px = perp_mm * pxpermm;
            // Perpendicular unit vector (rotate axis 90° CW): (dy, -dx)/len.
            let dx = bot.0 - top.0;
            let dy = bot.1 - top.1;
            let perp = (dy / axis_len, -dx / axis_len);
            // Left edge (a in {0,2}): perp points RIGHT into sheet. Right edge: LEFT.
            let sign = if a == 0 || a == 2 { 1.0 } else { -1.0 };
            let (opp_top_x, opp_top_y) = (top.0 + sign * perp.0 * perp_len_px, top.1 + sign * perp.1 * perp_len_px);
            let (opp_bot_x, opp_bot_y) = (bot.0 + sign * perp.0 * perp_len_px, bot.1 + sign * perp.1 * perp_len_px);
            eprintln!(
                "[kid-ocr-local] 2-anchor edge-LR synthesis {}+{} — axis={:.0}mm, perp={:.0}mm, pxperMM={:.2}, axis_len_px={:.0}",
                a, b, axis_mm_true, perp_mm, pxpermm, axis_len
            );
            let (tl, tr, bl, br) = if a == 0 || a == 2 {
                (top, (opp_top_x, opp_top_y), bot, (opp_bot_x, opp_bot_y))
            } else {
                ((opp_top_x, opp_top_y), top, (opp_bot_x, opp_bot_y), bot)
            };
            return Some([tl, tr, bl, br]);
        }
    }

    // Case: adjacent pair on the top or bottom edge (both share y).
    // On a landscape sheet, this pair spans the LONG dimension:
    // axis = 245.4mm, perpendicular = 199.9mm.
    for &(a, b) in &edges_tb {
        if has(a) && has(b) {
            let pa = pick(a); let pb = pick(b);
            let (left, right) = if pa.0 < pb.0 { (pa, pb) } else { (pb, pa) };
            let axis_len = (right.0 - left.0).hypot(right.1 - left.1);
            let axis_mm_true = 245.4;
            let perp_mm = 199.9;
            let pxpermm = axis_len / axis_mm_true;
            let perp_len_px = perp_mm * pxpermm;
            let dx = right.0 - left.0;
            let dy = right.1 - left.1;
            // Perpendicular pointing DOWN into the sheet: (-dy, dx)/len.
            let perp = (-dy / axis_len, dx / axis_len);
            let sign = if a == 0 || a == 1 { 1.0 } else { -1.0 };
            let (opp_l_x, opp_l_y) = (left.0 + sign * perp.0 * perp_len_px, left.1 + sign * perp.1 * perp_len_px);
            let (opp_r_x, opp_r_y) = (right.0 + sign * perp.0 * perp_len_px, right.1 + sign * perp.1 * perp_len_px);
            eprintln!(
                "[kid-ocr-local] 2-anchor edge-TB synthesis {}+{} — axis={:.0}mm, perp={:.0}mm, pxperMM={:.2}, axis_len_px={:.0}",
                a, b, axis_mm_true, perp_mm, pxpermm, axis_len
            );
            let (tl, tr, bl, br) = if a == 0 || a == 1 {
                (left, right, (opp_l_x, opp_l_y), (opp_r_x, opp_r_y))
            } else {
                ((opp_l_x, opp_l_y), (opp_r_x, opp_r_y), left, right)
            };
            return Some([tl, tr, bl, br]);
        }
    }

    eprintln!("[kid-ocr-local] 2+ confident fiducials but no usable pair (need diagonal or same-edge)");
    None
}

// ─── Page-quad detection (OMRChecker-style CropPage) ────────────────────
//
// When fiducials are cropped, off-frame, or unprinted, we can still recover
// the sheet position from the paper itself — the sheet is a nearly-full
// bright rectangle against a darker background (table, hand, phone edge).
//
// Approach: downsample → global Otsu → label bright components → pick the
// largest one → find its four diagonal extremes (min x+y, max x-y,
// min x-y, max x+y). These are the paper's corners even under rotation.
//
// This is a Rust port of the core idea in OMRChecker's CropPage plugin,
// stripped down to what Echelon needs (no OpenCV, no contour approximation,
// just diagonal extremes on the largest bright blob).
fn detect_page_quad(gray: &GrayImage) -> Option<[(f64, f64); 4]> {
    let (w, h) = gray.dimensions();
    if w < 400 || h < 300 {
        return None;
    }

    // Downsample to ~800px max side for speed. Page corners don't need full
    // resolution — we'll scale back at the end.
    let long_side = w.max(h) as f64;
    let scale = (long_side / 800.0).max(1.0);
    let dw = ((w as f64) / scale).round().max(200.0) as u32;
    let dh = ((h as f64) / scale).round().max(150.0) as u32;
    let small = image::imageops::resize(gray, dw, dh, image::imageops::FilterType::Triangle);

    // Heavy Gaussian blur BEFORE threshold: the sheet has dark grid lines
    // and text throughout, which would otherwise fragment the paper into
    // hundreds of small bright polygons between the lines. Blurring with
    // sigma ~= 4% of the long side smears those dark features into the
    // surrounding white so the paper labels as one big bright blob.
    let blur_sigma = (dw.max(dh) as f32) * 0.04;
    let small = image::imageops::blur(&small, blur_sigma);

    // Otsu — but we want to separate paper (bright) from background (dark).
    let thr = otsu_threshold(&small);

    // Label bright components (pixels > thr) using flood fill.
    let n = (dw * dh) as usize;
    let mut labels = vec![0u32; n];
    let mut next_label: u32 = 1;
    let mut stack: Vec<u32> = Vec::with_capacity(4096);
    for y in 0..dh {
        for x in 0..dw {
            let i = (y * dw + x) as usize;
            if labels[i] != 0 { continue; }
            if small.get_pixel(x, y).0[0] <= thr { continue; }
            labels[i] = next_label;
            stack.clear();
            stack.push(i as u32);
            while let Some(idx) = stack.pop() {
                let px = idx % dw;
                let py = idx / dw;
                let neighbors = [
                    (px.wrapping_sub(1), py, px > 0),
                    (px + 1, py, px + 1 < dw),
                    (px, py.wrapping_sub(1), py > 0),
                    (px, py + 1, py + 1 < dh),
                ];
                for &(nx, ny, ok) in &neighbors {
                    if !ok { continue; }
                    let ni = (ny * dw + nx) as usize;
                    if labels[ni] != 0 { continue; }
                    if small.get_pixel(nx, ny).0[0] <= thr { continue; }
                    labels[ni] = next_label;
                    stack.push(ni as u32);
                }
            }
            next_label += 1;
        }
    }

    // Find the largest bright component.
    if next_label < 2 { return None; }
    let mut areas = vec![0u32; next_label as usize];
    for &l in labels.iter() {
        areas[l as usize] += 1;
    }
    let (paper_label, paper_area) = areas.iter().enumerate().skip(1)
        .max_by_key(|(_, &a)| a)
        .map(|(i, &a)| (i as u32, a))?;

    // Reject if paper is too small — probably not the sheet.
    let min_area = (dw * dh) / 4;
    if paper_area < min_area {
        eprintln!(
            "[kid-ocr-local] page-quad: largest bright blob only {} px ({}% of image, need ≥25%)",
            paper_area, paper_area * 100 / (dw * dh)
        );
        return None;
    }

    // Find the four diagonal extremes on that blob.
    // TL minimizes (x+y). TR maximizes (x-y). BL minimizes (x-y). BR maximizes (x+y).
    let mut tl = (0i32, 0i32, i32::MAX);   // (x, y, x+y)
    let mut br = (0i32, 0i32, i32::MIN);   // (x, y, x+y)
    let mut tr = (0i32, 0i32, i32::MIN);   // (x, y, x-y)
    let mut bl = (0i32, 0i32, i32::MAX);   // (x, y, x-y)
    for y in 0..dh {
        for x in 0..dw {
            if labels[(y * dw + x) as usize] != paper_label { continue; }
            let (xi, yi) = (x as i32, y as i32);
            let sum = xi + yi;
            let diff = xi - yi;
            if sum < tl.2 { tl = (xi, yi, sum); }
            if sum > br.2 { br = (xi, yi, sum); }
            if diff > tr.2 { tr = (xi, yi, diff); }
            if diff < bl.2 { bl = (xi, yi, diff); }
        }
    }

    // Scale back to original resolution.
    let sx = w as f64 / dw as f64;
    let sy = h as f64 / dh as f64;
    let quad = [
        ((tl.0 as f64 + 0.5) * sx, (tl.1 as f64 + 0.5) * sy),
        ((tr.0 as f64 + 0.5) * sx, (tr.1 as f64 + 0.5) * sy),
        ((bl.0 as f64 + 0.5) * sx, (bl.1 as f64 + 0.5) * sy),
        ((br.0 as f64 + 0.5) * sx, (br.1 as f64 + 0.5) * sy),
    ];
    eprintln!(
        "[kid-ocr-local] page-quad extremes: TL=({:.0},{:.0}) TR=({:.0},{:.0}) BL=({:.0},{:.0}) BR=({:.0},{:.0}) (paper {}% of {}x{})",
        quad[0].0, quad[0].1, quad[1].0, quad[1].1,
        quad[2].0, quad[2].1, quad[3].0, quad[3].1,
        paper_area * 100 / (dw * dh), w, h
    );

    // Sanity-check the quad: sides should form a rough rectangle. Use
    // looser tolerances than fiducial checks because paper edges are
    // measured to blob-extreme pixels which are noisier.
    if !page_quad_looks_sane(&quad, w, h) {
        eprintln!("[kid-ocr-local] page-quad: extremes don't form a plausible rectangle");
        return None;
    }

    // And the quad should cover most of the image (paper fills the frame).
    let quad_w = ((quad[1].0 - quad[0].0).abs() + (quad[3].0 - quad[2].0).abs()) / 2.0;
    let quad_h = ((quad[2].1 - quad[0].1).abs() + (quad[3].1 - quad[1].1).abs()) / 2.0;
    if quad_w < w as f64 * 0.5 || quad_h < h as f64 * 0.5 {
        eprintln!(
            "[kid-ocr-local] page-quad: paper only {:.0}×{:.0} in {}×{} image (too small)",
            quad_w, quad_h, w, h
        );
        return None;
    }

    // Reject quads that touch the image border — the paper is off-frame,
    // so we can't measure its true corner. Better to fall through to the
    // fiducial-synthesis path than warp using the wrong quad.
    let margin = (w.min(h) as f64) * 0.01;
    let touches_border = quad.iter().any(|(x, y)| {
        *x < margin || *y < margin || *x > w as f64 - margin || *y > h as f64 - margin
    });
    if touches_border {
        eprintln!("[kid-ocr-local] page-quad: at least one corner touches image border — paper is off-frame");
        return None;
    }

    Some(quad)
}

fn fiducials_look_sane(fids: &[(f64, f64); 4], w: u32, h: u32) -> bool {
    let (tl, tr, bl, br) = (fids[0], fids[1], fids[2], fids[3]);
    // Top edge horizontal-ish, bottom edge horizontal-ish, left edge vertical-ish.
    let top_dy = (tl.1 - tr.1).abs();
    let bot_dy = (bl.1 - br.1).abs();
    let left_dx = (tl.0 - bl.0).abs();
    let right_dx = (tr.0 - br.0).abs();
    let tol_y = h as f64 * 0.15;
    let tol_x = w as f64 * 0.15;
    if top_dy > tol_y || bot_dy > tol_y || left_dx > tol_x || right_dx > tol_x {
        return false;
    }
    // TR must be right of TL, BR right of BL, BL below TL, BR below TR.
    tr.0 > tl.0 + w as f64 * 0.3
        && br.0 > bl.0 + w as f64 * 0.3
        && bl.1 > tl.1 + h as f64 * 0.3
        && br.1 > tr.1 + h as f64 * 0.3
}

/// Looser rectangle check for page-quad extremes, which sit on real paper
/// edges (skewed, cropped, noisy) rather than fixed fiducial squares.
/// Requires: TR is to the right of TL, BL is below TL, BR is right-of-BL
/// and below-of-TR, and no side is degenerate.
fn page_quad_looks_sane(fids: &[(f64, f64); 4], w: u32, h: u32) -> bool {
    let (tl, tr, bl, br) = (fids[0], fids[1], fids[2], fids[3]);
    let wf = w as f64;
    let hf = h as f64;
    // Order sanity — each corner in its correct half.
    if !(tr.0 > tl.0 + wf * 0.3
        && br.0 > bl.0 + wf * 0.3
        && bl.1 > tl.1 + hf * 0.3
        && br.1 > tr.1 + hf * 0.3)
    {
        return false;
    }
    // Reject wildly non-parallel sides (>25% mismatch). Real paper photos
    // can be perspective-skewed but sides should still be roughly parallel.
    let top_len = ((tr.0 - tl.0).powi(2) + (tr.1 - tl.1).powi(2)).sqrt();
    let bot_len = ((br.0 - bl.0).powi(2) + (br.1 - bl.1).powi(2)).sqrt();
    let left_len = ((bl.0 - tl.0).powi(2) + (bl.1 - tl.1).powi(2)).sqrt();
    let right_len = ((br.0 - tr.0).powi(2) + (br.1 - tr.1).powi(2)).sqrt();
    let horiz_ratio = top_len.max(bot_len) / top_len.min(bot_len).max(1.0);
    let vert_ratio = left_len.max(right_len) / left_len.min(right_len).max(1.0);
    horiz_ratio < 1.4 && vert_ratio < 1.4
}

// ─── Otsu + connected components ─────────────────────────────────────────

fn otsu_threshold(gray: &GrayImage) -> u8 {
    let mut hist = [0u32; 256];
    for p in gray.pixels() {
        hist[p.0[0] as usize] += 1;
    }
    let total: u32 = gray.pixels().len() as u32;
    let sum_all: f64 = (0..256).map(|i| i as f64 * hist[i] as f64).sum();
    let mut sum_b = 0.0;
    let mut w_b = 0.0;
    let mut max_between = 0.0;
    let mut best = 128u8;
    for i in 0..256 {
        w_b += hist[i] as f64;
        if w_b == 0.0 { continue; }
        let w_f = total as f64 - w_b;
        if w_f == 0.0 { break; }
        sum_b += i as f64 * hist[i] as f64;
        let m_b = sum_b / w_b;
        let m_f = (sum_all - sum_b) / w_f;
        let between = w_b * w_f * (m_b - m_f).powi(2);
        if between > max_between {
            max_between = between;
            best = i as u8;
        }
    }
    best
}

/// Flood-fill labeling of black-pixel components (px <= thr).
/// Returns a same-size buffer of label ids (0 = background, ≥1 = component).
fn label_dark_components(gray: &GrayImage, thr: u8) -> Vec<u32> {
    let (w, h) = gray.dimensions();
    let n = (w * h) as usize;
    let mut labels = vec![0u32; n];
    let mut next_label: u32 = 1;
    let mut stack: Vec<u32> = Vec::with_capacity(1024);
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if labels[i] != 0 { continue; }
            if gray.get_pixel(x, y).0[0] > thr { continue; }
            // BFS
            labels[i] = next_label;
            stack.clear();
            stack.push(i as u32);
            while let Some(idx) = stack.pop() {
                let px = idx % w;
                let py = idx / w;
                // 4-connectivity is sufficient for solid fiducial squares
                // and much faster than 8-connectivity.
                let neighbors = [
                    (px.wrapping_sub(1), py, px > 0),
                    (px + 1, py, px + 1 < w),
                    (px, py.wrapping_sub(1), py > 0),
                    (px, py + 1, py + 1 < h),
                ];
                for &(nx, ny, ok) in &neighbors {
                    if !ok { continue; }
                    let ni = (ny * w + nx) as usize;
                    if labels[ni] != 0 { continue; }
                    if gray.get_pixel(nx, ny).0[0] > thr { continue; }
                    labels[ni] = next_label;
                    stack.push(ni as u32);
                }
            }
            next_label += 1;
        }
    }
    labels
}

struct Blob {
    area: u32,
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    sum_x: u64,
    sum_y: u64,
}

impl Blob {
    fn centroid(&self) -> (f64, f64) {
        (
            self.sum_x as f64 / self.area as f64,
            self.sum_y as f64 / self.area as f64,
        )
    }
    fn fill_ratio(&self) -> f64 {
        let bw = (self.x1 - self.x0 + 1) as f64;
        let bh = (self.y1 - self.y0 + 1) as f64;
        self.area as f64 / (bw * bh)
    }
}

fn summarize_blobs(labels: &[u32], w: u32, h: u32) -> Vec<Blob> {
    let max_label = *labels.iter().max().unwrap_or(&0);
    if max_label == 0 { return Vec::new(); }
    let mut blobs: Vec<Blob> = (0..=max_label as usize)
        .map(|_| Blob { area: 0, x0: u32::MAX, y0: u32::MAX, x1: 0, y1: 0, sum_x: 0, sum_y: 0 })
        .collect();
    for y in 0..h {
        for x in 0..w {
            let l = labels[(y * w + x) as usize] as usize;
            if l == 0 { continue; }
            let b = &mut blobs[l];
            b.area += 1;
            if x < b.x0 { b.x0 = x; }
            if y < b.y0 { b.y0 = y; }
            if x > b.x1 { b.x1 = x; }
            if y > b.y1 { b.y1 = y; }
            b.sum_x += x as u64;
            b.sum_y += y as u64;
        }
    }
    blobs.into_iter().skip(1).filter(|b| b.area > 0).collect()
}

// ─── Perspective warp ────────────────────────────────────────────────────

/// Compute a 3×3 homography that maps `src` quad to `dst` quad, then
/// bilinear-interpolate each canonical pixel from the source.
fn perspective_warp(
    src: &GrayImage,
    src_quad: &[(f64, f64); 4],
    dst_quad: &[(f64, f64); 4],
    out_w: u32,
    out_h: u32,
) -> GrayImage {
    // We compute the INVERSE homography (dst → src) directly, so for each
    // canonical output pixel we look up its source coordinate.
    let h_inv = homography_from_quads(dst_quad, src_quad).expect("degenerate quad");
    let mut out = GrayImage::new(out_w, out_h);
    let (sw, sh) = (src.width() as f64, src.height() as f64);
    for y in 0..out_h {
        for x in 0..out_w {
            let (sx, sy) = apply_homography(&h_inv, x as f64 + 0.5, y as f64 + 0.5);
            if sx < 0.0 || sy < 0.0 || sx >= sw - 1.0 || sy >= sh - 1.0 {
                // Off-source — paint white (paper). Keeps grid detection happy.
                out.put_pixel(x, y, Luma([255]));
                continue;
            }
            let v = bilinear(src, sx, sy);
            out.put_pixel(x, y, Luma([v]));
        }
    }
    out
}

fn bilinear(img: &GrayImage, x: f64, y: f64) -> u8 {
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let dx = x - x0 as f64;
    let dy = y - y0 as f64;
    let v00 = img.get_pixel(x0, y0).0[0] as f64;
    let v10 = img.get_pixel(x0 + 1, y0).0[0] as f64;
    let v01 = img.get_pixel(x0, y0 + 1).0[0] as f64;
    let v11 = img.get_pixel(x0 + 1, y0 + 1).0[0] as f64;
    let v = v00 * (1.0 - dx) * (1.0 - dy)
        + v10 * dx * (1.0 - dy)
        + v01 * (1.0 - dx) * dy
        + v11 * dx * dy;
    v.clamp(0.0, 255.0) as u8
}

fn apply_homography(h: &[f64; 9], x: f64, y: f64) -> (f64, f64) {
    let w = h[6] * x + h[7] * y + h[8];
    if w.abs() < 1e-9 { return (f64::NAN, f64::NAN); }
    let sx = (h[0] * x + h[1] * y + h[2]) / w;
    let sy = (h[3] * x + h[4] * y + h[5]) / w;
    (sx, sy)
}

/// Direct linear transform (DLT) to find homography that maps
/// src[i] → dst[i] for 4 point pairs. Returns the 3x3 as a row-major [9].
fn homography_from_quads(src: &[(f64, f64); 4], dst: &[(f64, f64); 4]) -> Option<[f64; 9]> {
    // 8 equations, 8 unknowns (h33 fixed to 1). Solve Ax = b.
    let mut a = [[0.0f64; 8]; 8];
    let mut b = [0.0f64; 8];
    for i in 0..4 {
        let (x, y) = src[i];
        let (xp, yp) = dst[i];
        let r = 2 * i;
        a[r] =     [ x,  y,  1.0, 0.0, 0.0, 0.0, -x * xp, -y * xp ];
        a[r + 1] = [0.0, 0.0, 0.0,  x,   y,  1.0, -x * yp, -y * yp ];
        b[r] = xp;
        b[r + 1] = yp;
    }
    let x = solve_8x8(&mut a, &mut b)?;
    Some([x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], 1.0])
}

fn solve_8x8(a: &mut [[f64; 8]; 8], b: &mut [f64; 8]) -> Option<[f64; 8]> {
    // Gaussian elimination with partial pivoting.
    for i in 0..8 {
        let mut pivot = i;
        for k in (i + 1)..8 {
            if a[k][i].abs() > a[pivot][i].abs() { pivot = k; }
        }
        if a[pivot][i].abs() < 1e-12 { return None; }
        a.swap(i, pivot);
        b.swap(i, pivot);
        for k in (i + 1)..8 {
            let f = a[k][i] / a[i][i];
            for j in i..8 { a[k][j] -= f * a[i][j]; }
            b[k] -= f * b[i];
        }
    }
    let mut x = [0.0f64; 8];
    for i in (0..8).rev() {
        let mut s = b[i];
        for j in (i + 1)..8 { s -= a[i][j] * x[j]; }
        x[i] = s / a[i][i];
    }
    Some(x)
}

// ─── Grid detection ──────────────────────────────────────────────────────
//
// After warping to canonical, the table sits at roughly:
//   Left edge:  ~134px (14.4% inset — matches CSS `margin: auto` with
//               width: calc(100% - 129px)).
//   Right edge: ~2066px.
//   Top edge:   varies with h1/meta/legend height — detected by looking
//               for the first strong horizontal ink line below y = 200px.
//   Bottom edge: last strong horizontal ink line above y = CANONICAL_H − 200.
//
// Approach: sum ink pixels along each row (horizontal projection) and
// each column (vertical projection) within a generous search band. Peaks
// = grid lines. Non-max-suppress to reduce each thick line to one
// coordinate. Return sorted arrays of row-Y and column-X positions.

struct GridSpec {
    /// Sorted Y coordinates of horizontal grid lines. len = rows + 1
    /// (header + N body rows). row i's body: (row_ys[i], row_ys[i+1]).
    row_ys: Vec<u32>,
    /// Sorted X coordinates of vertical grid lines. len = cols + 1
    /// (name col + D day cols). col i's body: (col_xs[i], col_xs[i+1]).
    col_xs: Vec<u32>,
}

fn detect_grid(warped: &GrayImage, roster_size: usize, target_month: &str) -> Result<GridSpec, String> {
    let (w, h) = warped.dimensions();
    // Threshold — Otsu on the warped image (which is mostly white paper).
    let thr = otsu_threshold(warped);
    let thr = thr.saturating_sub(15);

    // Table search window (canonical coords, matches CSS geometry).
    let x_search_lo = 100u32; // give ~30px slack around 134
    let x_search_hi = w - 100;
    let y_search_lo = 180u32; // below h1+meta+legend (~130-180px)
    let y_search_hi = h - 60;

    // Horizontal projection: for each y in the search band, count how
    // many pixels along the horizontal (in the x_search range) are ink.
    // A grid line lights up ~1500-1700 pixels; text lights up <200.
    let x_len = x_search_hi - x_search_lo;
    let mut h_proj = vec![0u32; h as usize];
    for y in y_search_lo..y_search_hi {
        let mut c = 0u32;
        for x in x_search_lo..x_search_hi {
            if warped.get_pixel(x, y).0[0] <= thr { c += 1; }
        }
        h_proj[y as usize] = c;
    }
    // A horizontal grid line has ink density > 60% of the search width.
    let h_thr = (x_len as f64 * 0.55) as u32;
    let row_ys = non_max_suppress_peaks(&h_proj, h_thr, 8);

    // Vertical projection: same idea, in the column direction, using the
    // band between the first and last detected horizontal rules.
    if row_ys.len() < 3 {
        return Err(format!(
            "grid: found only {} horizontal lines (need ≥ {}). Retake photo with all 4 fiducials clearly visible.",
            row_ys.len(),
            roster_size + 2,
        ));
    }
    let y_top = *row_ys.first().unwrap();
    let y_bot = *row_ys.last().unwrap();

    let mut v_proj = vec![0u32; w as usize];
    for x in x_search_lo..x_search_hi {
        let mut c = 0u32;
        for y in y_top..y_bot {
            if warped.get_pixel(x, y).0[0] <= thr { c += 1; }
        }
        v_proj[x as usize] = c;
    }
    let v_thr = ((y_bot - y_top) as f64 * 0.6) as u32;
    let col_xs = non_max_suppress_peaks(&v_proj, v_thr, 6);

    let expected_days = expected_days_in_month(target_month) as usize;
    let expected_cols = expected_days + 1; // + name column
    let expected_rows = roster_size + 1;   // + header

    // Tolerance: printed grid should give EXACTLY expected_cols vertical
    // lines and expected_rows horizontal lines. Accept ±2 to survive
    // occasional line dropouts on faint scans; the caller can retry.
    if (col_xs.len() as i32 - (expected_cols + 1) as i32).abs() > 2 {
        return Err(format!(
            "grid: found {} vertical lines, expected {} ± 2 for {} days + name col. Photo may be blurry or fiducials misplaced.",
            col_xs.len(),
            expected_cols + 1,
            expected_days,
        ));
    }
    if (row_ys.len() as i32 - (expected_rows + 1) as i32).abs() > 2 {
        return Err(format!(
            "grid: found {} horizontal lines, expected {} ± 2 for roster of {}. Roster may be out of date with the printed sheet.",
            row_ys.len(),
            expected_rows + 1,
            roster_size,
        ));
    }

    Ok(GridSpec { row_ys, col_xs })
}

/// Non-maximum suppression over a 1D projection: collect indices where
/// the value crosses `thr` and no larger value exists within `radius`.
fn non_max_suppress_peaks(proj: &[u32], thr: u32, radius: usize) -> Vec<u32> {
    let mut peaks = Vec::new();
    let n = proj.len();
    let mut i = 0;
    while i < n {
        if proj[i] < thr { i += 1; continue; }
        // Find the local max within a contiguous run of over-threshold values.
        let mut j = i;
        while j + 1 < n && proj[j + 1] >= thr { j += 1; }
        let mut best = i;
        for k in i..=j {
            if proj[k] > proj[best] { best = k; }
        }
        // Enforce spacing.
        if peaks.last().map(|&p: &u32| best as u32 - p >= radius as u32).unwrap_or(true) {
            peaks.push(best as u32);
        }
        i = j + 1;
    }
    peaks
}

// ─── Cell classification ─────────────────────────────────────────────────

/// For each body row × day column, look at the cell contents and decide
/// blank / P / A. Also emits an "uncertain" list for cells near the
/// borderline so the UI can surface them for review.
fn classify_cells(
    warped: &GrayImage,
    grid: &GridSpec,
    roster: &[RosterEntry],
    weekend: &[u32],
    stat: &[u32],
    closed: &[u32],
) -> (Vec<ExtractedRow>, Vec<UncertainCell>) {
    let thr = otsu_threshold(warped).saturating_sub(20);
    let non_writing: std::collections::HashSet<u32> = weekend
        .iter()
        .chain(stat.iter())
        .chain(closed.iter())
        .copied()
        .collect();

    // Body rows start after the header (grid row 0 = header→body_top).
    // roster[i] is at body row i, between row_ys[i+1] and row_ys[i+2].
    // Day columns start after the name column: day d (1-based) is
    // between col_xs[d] and col_xs[d+1].
    let n_rows = roster.len().min(grid.row_ys.len().saturating_sub(2));
    let n_cols = grid.col_xs.len().saturating_sub(2); // subtract name col + last-line

    let mut rows: Vec<ExtractedRow> = Vec::with_capacity(n_rows);
    let mut uncertain: Vec<UncertainCell> = Vec::new();

    for ri in 0..n_rows {
        let y0 = grid.row_ys[ri + 1] + 2;
        let y1 = grid.row_ys[ri + 2].saturating_sub(2);
        if y1 <= y0 + 4 { continue; }
        let mut marks: std::collections::BTreeMap<String, String> = Default::default();
        for ci in 0..n_cols {
            let day = (ci + 1) as u32;
            if non_writing.contains(&day) { continue; }
            let x0 = grid.col_xs[ci + 1] + 2;
            let x1 = grid.col_xs[ci + 2].saturating_sub(2);
            if x1 <= x0 + 4 { continue; }
            let (kind, confidence) = classify_one_cell(warped, x0, y0, x1, y1, thr);
            match kind {
                CellKind::Blank => {}
                CellKind::P => {
                    marks.insert(day.to_string(), "P".to_string());
                    if confidence < 0.65 {
                        uncertain.push(UncertainCell {
                            child_name: roster[ri].student_name.clone(),
                            day: day.to_string(),
                            picked: "P".to_string(),
                            votes: vec!["P".to_string(), "?".to_string()],
                            confidence,
                        });
                    }
                }
                CellKind::A => {
                    marks.insert(day.to_string(), "A".to_string());
                    if confidence < 0.65 {
                        uncertain.push(UncertainCell {
                            child_name: roster[ri].student_name.clone(),
                            day: day.to_string(),
                            picked: "A".to_string(),
                            votes: vec!["A".to_string(), "?".to_string()],
                            confidence,
                        });
                    }
                }
            }
        }
        rows.push(ExtractedRow {
            child_name: roster[ri].student_name.clone(),
            marks,
        });
    }
    (rows, uncertain)
}

enum CellKind { Blank, P, A }

/// Classify a single cell based on ink density + stroke shape.
///
/// Heuristic:
///   • ink_density (fraction of pixels below threshold in the interior)
///     < 3%   → BLANK
///     ≥ 3%:
///       Compute vertical extent of ink (rows with ≥ 1 ink pixel in the
///       interior 60% of the cell width) and horizontal extent.
///       An X spans BOTH axes ≥ 45% of the cell.
///       A dash spans horizontal ≥ 30% but vertical < 30%.
///       Anything else that has ink but doesn't fit → treat as X (safer:
///       an under-drawn X still counts a child as present) but flag low
///       confidence.
fn classify_one_cell(img: &GrayImage, x0: u32, y0: u32, x1: u32, y1: u32, thr: u8) -> (CellKind, f32) {
    let w = (x1 - x0) as usize;
    let h = (y1 - y0) as usize;
    if w < 3 || h < 3 { return (CellKind::Blank, 1.0); }
    // Sample the inner 90% to avoid grazing the grid line.
    let inset_x = ((w as f64) * 0.05).max(1.0) as u32;
    let inset_y = ((h as f64) * 0.05).max(1.0) as u32;
    let ix0 = x0 + inset_x;
    let iy0 = y0 + inset_y;
    let ix1 = x1 - inset_x;
    let iy1 = y1 - inset_y;
    let iw = (ix1 - ix0) as usize;
    let ih = (iy1 - iy0) as usize;

    let mut ink_count = 0u32;
    let mut row_ink = vec![0u32; ih];
    let mut col_ink = vec![0u32; iw];
    for y in iy0..iy1 {
        for x in ix0..ix1 {
            if img.get_pixel(x, y).0[0] <= thr {
                ink_count += 1;
                row_ink[(y - iy0) as usize] += 1;
                col_ink[(x - ix0) as usize] += 1;
            }
        }
    }
    let total = (iw * ih) as f32;
    let density = ink_count as f32 / total;
    if density < 0.03 { return (CellKind::Blank, 1.0 - density * 10.0); }

    // Vertical extent = fraction of rows that have any meaningful ink.
    // "Meaningful" = at least 2 pixels across, to ignore JPEG noise dots.
    let v_ink_rows = row_ink.iter().filter(|&&c| c >= 2).count();
    let h_ink_cols = col_ink.iter().filter(|&&c| c >= 2).count();
    let v_ext = v_ink_rows as f32 / ih as f32;
    let h_ext = h_ink_cols as f32 / iw as f32;

    // Confidence: how strong is the winning classification.
    if v_ext >= 0.45 && h_ext >= 0.45 {
        // Crossing strokes — X.
        let conf = ((v_ext + h_ext) * 0.5).min(1.0);
        (CellKind::P, conf)
    } else if v_ext < 0.35 && h_ext >= 0.30 {
        // Long horizontal stroke — dash.
        let conf = h_ext.min(1.0) * (1.0 - v_ext);
        (CellKind::A, conf.clamp(0.0, 1.0))
    } else if density > 0.10 {
        // Non-trivial ink but ambiguous shape — call it P (safer default:
        // present > absent; the reviewer can flip if wrong) but mark it
        // low-confidence so the UI flags it.
        (CellKind::P, 0.40)
    } else {
        // Ambiguous low-ink — could be smudge or a tentative dash.
        (CellKind::A, 0.40)
    }
}

// ─── Utilities ───────────────────────────────────────────────────────────

fn expected_days_in_month(target_month: &str) -> u32 {
    // Parse "YYYY-MM" → days in that month. Fallback 31.
    let parts: Vec<&str> = target_month.split('-').collect();
    if parts.len() != 2 { return 31; }
    let y: i32 = parts[0].parse().unwrap_or(2026);
    let m: u32 = parts[1].parse().unwrap_or(1);
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 },
        _ => 31,
    }
}

// Suppress an unused-import warning when the module is compiled with all
// features off; DynamicImage is used implicitly via image::open.
#[allow(dead_code)]
fn _unused_dyn() -> Option<DynamicImage> { None }

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn otsu_bimodal_input() {
        // Half dark, half bright pixels — Otsu should split at or just above
        // the darker peak (any threshold in [30, 219] correctly separates
        // the two modes into background vs foreground).
        let mut img = GrayImage::new(20, 20);
        for y in 0..20 {
            for x in 0..20 {
                img.put_pixel(x, y, Luma([if x < 10 { 30 } else { 220 }]));
            }
        }
        let t = otsu_threshold(&img);
        assert!(t >= 30 && t < 220, "otsu threshold out of range: {}", t);
    }

    #[test]
    fn nms_peaks_basic() {
        // Two runs of over-threshold values with a valley between.
        let proj = vec![0, 0, 5, 6, 7, 8, 5, 0, 0, 0, 9, 10, 8, 0, 0];
        let peaks = non_max_suppress_peaks(&proj, 5, 3);
        assert_eq!(peaks, vec![5, 11], "expected peaks at 5 and 11, got {:?}", peaks);
    }

    #[test]
    fn expected_days_matches_calendar() {
        assert_eq!(expected_days_in_month("2026-07"), 31);
        assert_eq!(expected_days_in_month("2026-02"), 28);
        assert_eq!(expected_days_in_month("2024-02"), 29);
        assert_eq!(expected_days_in_month("2026-04"), 30);
    }

    #[test]
    fn homography_identity() {
        // Map a unit quad to itself → identity.
        let q = [(0.0, 0.0), (100.0, 0.0), (0.0, 100.0), (100.0, 100.0)];
        let h = homography_from_quads(&q, &q).unwrap();
        let (x, y) = apply_homography(&h, 42.0, 17.0);
        assert!((x - 42.0).abs() < 1e-6);
        assert!((y - 17.0).abs() < 1e-6);
    }

    #[test]
    fn cell_classify_blank_dash_x() {
        let mut img = GrayImage::new(60, 60);
        for p in img.pixels_mut() { p.0[0] = 255; }
        // Blank cell (10,10)-(30,30)
        let (k, _) = classify_one_cell(&img, 10, 10, 30, 30, 200);
        assert!(matches!(k, CellKind::Blank));
        // Dash in cell (30,30)-(50,50): horizontal line at mid y.
        for x in 33..47 {
            img.put_pixel(x, 40, Luma([20]));
            img.put_pixel(x, 41, Luma([20]));
        }
        let (k, _) = classify_one_cell(&img, 30, 30, 50, 50, 200);
        assert!(matches!(k, CellKind::A), "expected A, got other");
        // Big X in cell (10,30)-(30,50): two crossing diagonals.
        for i in 0..15 {
            img.put_pixel(12 + i, 32 + i, Luma([20]));
            img.put_pixel(12 + i, 32 + i + 1, Luma([20]));
            img.put_pixel(28 - i, 32 + i, Luma([20]));
            img.put_pixel(28 - i, 32 + i + 1, Luma([20]));
        }
        let (k, _) = classify_one_cell(&img, 10, 30, 30, 50, 200);
        assert!(matches!(k, CellKind::P), "expected P for X strokes");
    }

    /// Manual probe (run with `cargo test -- --ignored`) that inspects
    /// per-rotation fiducial + page-quad detection on a real KidsJuly.jpeg
    /// fixture on the developer machine. NOT a coverage test — the fixture
    /// is developer-local and it prints diagnostics rather than asserting
    /// end-to-end correctness. If the fixture is present, the test asserts
    /// at least ONE rotation yields ≥2 confident fiducials so we don't
    /// silently regress the detector.
    #[test]
    #[ignore]
    fn probe_kidsjuly_detection() {
        let path = r"C:\Users\alosing\rs_scanner\sectoral\KidsJuly.jpeg";
        if !std::path::Path::new(path).exists() {
            eprintln!("[probe] skipped — {} not present", path);
            return;
        }
        let img = image::open(path).expect("open KidsJuly.jpeg");
        let mut best_conf = 0usize;
        for deg in [0u32, 90, 180, 270] {
            let rotated = match deg {
                0 => img.clone(),
                90 => image::DynamicImage::ImageRgba8(image::imageops::rotate90(&img.to_rgba8())),
                180 => image::DynamicImage::ImageRgba8(image::imageops::rotate180(&img.to_rgba8())),
                270 => image::DynamicImage::ImageRgba8(image::imageops::rotate270(&img.to_rgba8())),
                _ => unreachable!(),
            };
            let gray = rotated.to_luma8();
            eprintln!("=== rot {}° ({}x{}) ===", deg, gray.width(), gray.height());
            match detect_page_quad(&gray) {
                Some(q) => eprintln!(
                    "  page-quad: TL=({:.0},{:.0}) TR=({:.0},{:.0}) BL=({:.0},{:.0}) BR=({:.0},{:.0})",
                    q[0].0, q[0].1, q[1].0, q[1].1, q[2].0, q[2].1, q[3].0, q[3].1
                ),
                None => eprintln!("  page-quad: none"),
            }
            let picks = detect_fiducial_picks(&gray);
            let n_conf = picks.iter().filter(|p| p.as_ref().map_or(false, |q| q.confident)).count();
            eprintln!("  fiducials: {} confident", n_conf);
            best_conf = best_conf.max(n_conf);
        }
        assert!(
            best_conf >= 2,
            "regression: fiducial detector found 0 or 1 confident fiducials at every rotation on KidsJuly.jpeg (was 2 in v3.1.1)"
        );
    }

    /// Manual probe (run with `cargo test -- --ignored`) that runs the
    /// full pipeline against KidsJuly.jpeg and prints the outcome. Does
    /// NOT assert success — KidsJuly is a known-hard case where the
    /// paper's right edge is off-frame — but it does assert the pipeline
    /// runs to completion without panicking.
    #[test]
    #[ignore]
    fn probe_kidsjuly_full_pipeline() {
        let path = r"C:\Users\alosing\rs_scanner\sectoral\KidsJuly.jpeg";
        if !std::path::Path::new(path).exists() {
            eprintln!("[probe] skipped — {} not present", path);
            return;
        }
        let roster: Vec<RosterEntry> = (0..25)
            .map(|i| RosterEntry {
                student_id: i as i64,
                student_name: format!("Kid {}", i + 1),
            })
            .collect();
        let outcome = std::panic::catch_unwind(|| {
            run_pipeline(path, "2026-07", &roster, &[4, 5, 11, 12, 18, 19, 25, 26], &[1], &[])
        });
        assert!(outcome.is_ok(), "pipeline panicked — should Err, not panic");
        match outcome.unwrap() {
            Ok(r) => {
                let marks: usize = r.rows.iter().map(|row| row.marks.len()).sum();
                let rows_with_marks = r.rows.iter().filter(|row| !row.marks.is_empty()).count();
                eprintln!(
                    "[probe] pipeline succeeded — {} rows total, {} rows w/ marks, {} marks",
                    r.rows.len(), rows_with_marks, marks
                );
            }
            Err(e) => eprintln!("[probe] pipeline returned Err (expected for KidsJuly): {}", e),
        }
    }
}
