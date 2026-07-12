# Echelon Receipts v2.6.3

Big release focused on the Schedule tab: absence tracking, closed-day
safety, and an AI text panel that understands "Judy is on vacation this
week" and "Judy was sick yesterday, Aldex covered."

## New

### Waitlist
- **Birth-month range filter.** Filter the waitlist by a birth-month
  window (e.g. "Sep 2024 → Feb 2025") to plan cohort intakes.

### Graduation
- **PPTX photo fix.** Photos now respect their original orientation and
  aspect ratio in the generated deck.
- **Cover slide fallback.** If the template has no cover, the deck now
  opens on a title slide instead of the first child.

### Schedule tab
- **Month view.** Toggle between Week and Month at the top of the tab.
  Month view shows every day in the calendar month with the same
  closed-day and absence indicators as the week grid.
- **Month total column.** The weekly grid now shows a "Month" column
  beside the weekly total so you can see each person's month-to-date
  hours at a glance.
- **Break-parity totals.** Schedule totals now use the exact same rule
  as the Hours tab: an unpaid 30-minute lunch is auto-deducted when a
  shift is 5 hours or longer with no explicit break. The number on the
  Schedule matches what payroll sees.
- **Closed-day gate.** You can no longer accidentally schedule a shift
  on a weekend, stat holiday, or day the centre is marked closed. The
  drawer, the + Add cell, the AI panel, and the AI parser all block it
  with a plain-English reason.
- **Existing-shift-on-closed-day warning.** If a shift was scheduled
  before a day was marked closed, the cell now shows an amber warning
  so you can act on it explicitly.
- **Past-date safety.** Creating a shift in the past for a *working*
  status is blocked with a specific error. Absences (vacation / sick /
  day off) can still be recorded in the past — that's how you catch up
  after the fact.

### Schedule — Absence tracking
- **Vacation / Sick / Day-off statuses.** The shift drawer now has a
  Kind selector. Pick "Vacation", "Sick", or "Day off" and the row
  renders as a colored marker instead of a time block. Absences count
  as 0 hours and never publish times to WhatsApp.
- **AI absence recognition.** The AI text panel understands sentences
  like:
  - "Judy is on vacation this week"
  - "Mark Aldex sick tomorrow"
  - "Sara has a day off Friday"
  - "Judy was sick yesterday and Aldex covered"
  The last pattern will mark Judy's shift as Sick and assign a new
  planned shift to Aldex on the same day.
- **Atomic replacement rollback.** If the AI is asked to replace an
  existing shift and the new shift fails to save, the original shift is
  restored to its exact previous status (not silently downgraded to
  "planned"). If the restore itself fails, you get a ⚠ warning
  directing you to the Recently cancelled panel.

### Closure impact
- **Closure-impact modal.** When you close a day that has live shifts —
  from the Centre Calendar, from the master Holidays toggle, or from a
  per-holiday save — you now get a modal listing the affected shifts
  with three choices:
  - **Cancel** (leave the day open)
  - **Close and cancel the shifts** (default)
  - **Close and keep the shifts** (they'll show with an amber warning)
- **Failure surface.** If any cancel fails during "Close and cancel
  shifts", the exact rows that failed are shown after the operation
  instead of silently swallowed.
- **Holidays master toggle guarded.** Turning stat holidays back ON now
  runs the same impact check for the next 26 weeks — no more silent
  loss of a shift scheduled on Canada Day.

### Recently cancelled panel
- **Undoable cancellations.** A collapsed "Recently cancelled" panel at
  the bottom of the Schedule tab shows every shift cancelled in the
  last 7 days with a Restore button. Restore brings the shift back with
  its original status (planned / confirmed / vacation / sick / etc.).
  This is the safety net for the closure-impact "cancel the shifts"
  path.

## Fixed

- **WhatsApp Publish.** Absence rows are now sent as "Fri Jul 18:
  Vacation" instead of the placeholder 09:00–17:00 time block. The
  weekly total already excluded them; the printed lines now match.
- **Month view stranded shifts.** In month view, a closed-day cell with
  a live shift on it is now a clickable amber button that opens the
  drawer instead of an inert red cell you can't act on.
- **Absence tooltips.** Absence markers in the week grid now show the
  staff member's name in the tooltip, not the raw staff ID.

## Under the hood

- New `restoreShift(id, expectedVersion)` that recovers a shift's
  original status from the audit trail. Falls back to "planned" only
  for legacy pre-v2.6.3 rows that don't carry the prev-status payload.
- `cancelShift` now writes the shift's previous status into the audit
  payload so the restore path is deterministic.
- Shared `runClosureImpact` helper so the Centre Calendar, the
  Holidays master toggle, and per-holiday saves can't drift out of
  sync.

## Notes

- The 30-minute auto-lunch deduction on shifts ≥5h with no explicit
  break has always been the Hours-tab rule. As of v2.6.3 the Schedule
  tab uses the same rule; totals on the Schedule may read 0.5h lower
  than they did in v2.6.2 for long unbroken shifts. This matches
  payroll, not a regression.
