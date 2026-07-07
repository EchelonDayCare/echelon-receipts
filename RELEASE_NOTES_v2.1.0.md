# Echelon Receipts v2.1.0 — Release Notes

**Released:** 2026-07-07
**Platforms:** macOS (Apple Silicon), Windows (NSIS installer)

## What's new

### 📅 Monthly Attendance grid
Attendance now matches the paper sign-in sheet Luxmi actually uses.
- **Name × day-of-month grid** — click a cell to cycle **P** (present) →
  **A** (absent) → **H** (half-day) → **S** (sick) → **V** (vacation) → blank.
- **Centre Calendar** — mark days when the centre is closed (stat holidays,
  PD days, closures). Weekends are seeded automatically. The
  *Days Centre open* counter updates live.
- **OCR upload** — snap or scan a completed monthly sheet; Azure AI reads
  each child's row of marks, matches to your roster, and you review before
  importing.
- **Printable blank template** — landscape, matches the paper layout with
  weekends and closed days pre-shaded.

The old Daily Log (per-visit in/out timestamps) has been removed. Centres
that need per-visit sign-in should stay on v2.0.0 for now.

### 📊 Attendance Analytics (Reports)
Brand-new report replacing the single-month "Attendance Summary".
- **Centre-wide** view: attendance rate, days open, active children,
  P/H/A/S/V totals. Monthly trend bar chart. Per-month and per-child
  breakdown tables.
- **Child-wise** view: pick any child; see their attendance rate, centre
  rank, monthly trend, and a day-by-day colour-coded calendar.
- Filter by any date range (defaults to last 3 months) with quick presets
  (This month / Last 3 mo / YTD / per-year).
- CSV export + Print.

### 🐛 Bug fixes
- **Ask Echelon** was broken on every v2.0.0 install (`prep-master: file is
  not a database`). Fixed by routing through the app's SQLCipher-aware DB
  connection.
- **Deposit slip preview** no longer errors with "This content is blocked"
  — the CSP now allows blob:/data: iframes.
- **Credit-card statement OCR** (Expenses → Import) now works for PDFs.
  The Mistral API needs `document_url` for PDFs, not `image_url`.
- **Print pop-up blocked** — every print action now uses a hidden iframe
  attached to the main window, since Tauri's WebView blocks
  `window.open()`.
- **Staff module flashing open and closing** on click — race between
  `staffEnabled` async load and the catch-all route. Staff routes are now
  mounted unconditionally; the feature flag remains at the entry point.

## Upgrade notes

- **Safe upgrade from v2.0.0.** The only schema change is a new
  `centre_calendar` table, added idempotently on first launch.
- **Data preserved.** All existing attendance records are readable by
  the new Monthly grid and Analytics report — the underlying
  `child_attendance` rows are unchanged.
- **Half-day marks** ("H") are stored as `status='present', hours_decimal=0`
  for backward compatibility.

## Known limitations

- No half-day distinction in the analytics rank if you ever re-enable the
  Daily Log via a downgrade — H marks would show as "present".
- OCR of the monthly grid depends on handwriting legibility; the review
  screen lets you fix mistakes before importing.
