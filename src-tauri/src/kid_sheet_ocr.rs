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
    let mut best: Option<(u32, [(f64, f64); 4], GrayImage)> = None;
    for deg in [0u32, 90, 180, 270] {
        let rotated = match deg {
            0 => img.clone(),
            90 => image::DynamicImage::ImageRgba8(image::imageops::rotate90(&img.to_rgba8())),
            180 => image::DynamicImage::ImageRgba8(image::imageops::rotate180(&img.to_rgba8())),
            270 => image::DynamicImage::ImageRgba8(image::imageops::rotate270(&img.to_rgba8())),
            _ => unreachable!(),
        };
        let gray = rotated.to_luma8();
        if let Some(fids) = detect_fiducials(&gray) {
            // Sanity: the 4 must roughly form a rectangle. Reject skew > 30%.
            if fiducials_look_sane(&fids, gray.width(), gray.height()) {
                best = Some((deg, fids, gray));
                break;
            }
        }
    }
    let (rotation_applied, fiducials, gray) = best.ok_or_else(|| {
        format!(
            "could not find 4 corner fiducials in {}×{} image at any rotation — retake the photo with all 4 black corner squares visible",
            orig_w, orig_h
        )
    })?;

    // Warp to canonical.
    let warped = perspective_warp(&gray, &fiducials, CANONICAL_W, CANONICAL_H);

    // Detect the grid.
    let grid = detect_grid(&warped, roster.len(), target_month)?;

    // Classify each cell.
    let (rows, uncertain) = classify_cells(&warped, &grid, roster, weekend, stat, closed);

    let raw_text = format!(
        "[local ocr v1] rotation={}° fiducials=OK ({} rows × {} day cols), roster {}\n\ngrid: rows_y={:?}, cols_x={:?}",
        rotation_applied,
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

/// Otsu-threshold the image, find connected black components, filter to
/// roughly-square blobs of the expected fiducial size, then pick the one
/// closest to each corner.
fn detect_fiducials(gray: &GrayImage) -> Option<[(f64, f64); 4]> {
    let (w, h) = gray.dimensions();
    if w < 400 || h < 300 {
        return None;
    }
    let thr = otsu_threshold(gray);
    // Slightly permissive threshold — ink can be lighter than the paper's
    // brightest patches after JPEG compression.
    let thr = thr.saturating_sub(10);

    // 4mm fiducial at 200 DPI = ~32px. Photos are smaller than canonical
    // typically (phone photos ~1600-3000px long edge). At 1600px long edge
    // over 11in paper = 145 DPI, so 4mm ≈ 23px, area ≈ 530px². Give a wide
    // tolerance because we may see anywhere from 800×600 to 4000×3000.
    let long_edge = w.max(h) as f64;
    let expected_side = 4.0 / 25.4 * (long_edge / 11.0); // mm → px on long axis
    let min_side = (expected_side * 0.4).max(6.0);
    let max_side = expected_side * 2.5;
    let min_area = (min_side * min_side * 0.5) as u32;
    let max_area = (max_side * max_side * 1.5) as u32;

    let labels = label_dark_components(gray, thr);
    let mut blobs: Vec<Blob> = summarize_blobs(&labels, gray.width(), gray.height());
    blobs.retain(|b| {
        let bw = (b.x1 - b.x0 + 1) as f64;
        let bh = (b.y1 - b.y0 + 1) as f64;
        let aspect = if bw > bh { bw / bh } else { bh / bw };
        b.area >= min_area
            && b.area <= max_area
            && bw >= min_side
            && bh >= min_side
            && bw <= max_side
            && bh <= max_side
            && aspect <= 1.6
            && b.fill_ratio() >= 0.55 // fiducials are SOLID squares
    });

    if blobs.len() < 4 {
        return None;
    }

    // Assign each blob a "corner affinity" score for TL / TR / BL / BR
    // (lower = better). Consider only blobs in the outer 20% of the frame.
    let margin_x = w as f64 * 0.20;
    let margin_y = h as f64 * 0.20;
    let corners = [
        (0.0, 0.0),
        (w as f64, 0.0),
        (0.0, h as f64),
        (w as f64, h as f64),
    ];
    let mut picked: [Option<(f64, f64)>; 4] = [None; 4];
    let mut used = std::collections::HashSet::new();
    for (ci, &(cx, cy)) in corners.iter().enumerate() {
        let mut best_idx = None;
        let mut best_d = f64::MAX;
        for (bi, b) in blobs.iter().enumerate() {
            if used.contains(&bi) {
                continue;
            }
            let (bx, by) = b.centroid();
            // Require the blob is on the correct side of the frame.
            let ok_x = if cx < 1.0 { bx < w as f64 - margin_x } else { bx > margin_x };
            let ok_y = if cy < 1.0 { by < h as f64 - margin_y } else { by > margin_y };
            if !ok_x || !ok_y {
                continue;
            }
            let d = (bx - cx).powi(2) + (by - cy).powi(2);
            if d < best_d {
                best_d = d;
                best_idx = Some(bi);
            }
        }
        if let Some(bi) = best_idx {
            picked[ci] = Some(blobs[bi].centroid());
            used.insert(bi);
        } else {
            return None;
        }
    }
    Some([
        picked[0].unwrap(),
        picked[1].unwrap(),
        picked[2].unwrap(),
        picked[3].unwrap(),
    ])
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
    out_w: u32,
    out_h: u32,
) -> GrayImage {
    let dst = canonical_fiducial_targets();
    // We compute the INVERSE homography (dst → src) directly, so for each
    // canonical output pixel we look up its source coordinate.
    let h_inv = homography_from_quads(&dst, src_quad).expect("degenerate fiducial quad");
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
}
