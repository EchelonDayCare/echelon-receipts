# Changelog

All notable changes shipped as a DMG. Only entries the owner has approved
for release are listed here — "code-complete, awaiting ship approval" work
lives in the session plan.md until it ships.

## v1.4.0 — Waitlist Prioritization (code-complete, awaiting ship approval)

Turn a raw sync'd waitlist into a ranked, defensible queue. Owner still makes
the call, but the list surfaces the strongest candidates first with a
transparent breakdown.

### Added
- **Weighted priority score** on every waitlist entry. Signals:
  retention runway (months until BC kindergarten, capped 24),
  toilet-trained, in-building family, sibling of current/alumni student,
  wait time (capped 365d), enrollment intensity (days/wk or full-time).
- **Score column** on `Waitlist → All` with hover tooltip showing each
  signal's contribution ("+30 sibling of current student", "+15 toilet
  trained"…). Sort defaults to score descending.
- **Prioritization card** in the waitlist detail drawer with editors for
  days/week, full-time, sibling-of, and private priority notes. Live
  score preview updates as you edit.
- **Priority weights panel** in `Waitlist → Settings`. Every weight is
  tunable, defaults are restorable, and setting a weight to 0 disables
  that signal entirely.

### Data
- Migration 022: additive columns on `waitlist_entries`
  (`full_time`, `days_per_week`, `sibling_student_id`, `priority_notes`)
  and 7 new `waitlist_weight_*` settings rows.
- Fully backward compatible with v1.3.x DBs — all new columns nullable,
  new settings idempotent.

## v1.3.0 — Organizer / Ops Dashboard (code-complete, awaiting ship approval)

Third module in the Phase-2 wave. A single "what needs my attention?" page
that pulls from every other module.

### Added
- **Organizer** sidebar module + Home tile — three panels on one page.
- **Upcoming** panel — time-window filter (Today / 7 / 30 / 60 / 90 days)
  with source chips to toggle: staff credentials, drill cadence, vault
  document expiries, aging A/R, AGM statutory deadline (fiscal-year-end +
  6 mo), T-slips (Feb 28), CCFRI monthly, open meeting action items, and
  open follow-ups.
- **Meetings** log — kind chips (board, parent, staff, vendor, inspection,
  other), markdown notes with live preview, per-meeting action items with
  owner + due date + done toggle.
- **Follow-ups** panel — quick-add with due date + priority (low/normal/
  high), inline done toggle, soft delete.
- Home alerts: "N items due today" (danger) or "N due within 7 days" (info).
- Print-to-PDF for a portable morning briefing.
- Migration 021 adds `meetings`, `meeting_actions`, `meeting_events`,
  `followups`, plus drill-cadence day settings.

## v1.2.0 — Staff Schedule (code-complete, awaiting ship approval)

Second module in the Phase-2 wave. Sunday-night weekly grid + one-click
WhatsApp publish so the owner never leaves the desk.

### Added
- **Staff → Schedule** weekly grid — rows = active staff, columns = Mon–Sun.
  Click a cell to add a shift, click an existing shift to edit / cancel /
  reassign. Cancelled shifts render with a strikethrough.
- Per-staff weekly hour totals with an amber "⚠ OT" warning past 40h.
- **Copy → next week** and **Copy → next 4 weeks** — skips destination
  days that already have shifts so a partial re-run never duplicates.
- **Publish week** modal — pick who to send to, pre-filled WhatsApp
  messages (per-staff schedule with dates + times + rooms + total hours)
  open sequentially via `wa.me` deep-links so the owner just hits Send.
- New settings: `shift_msg_weekly`, `shift_msg_change`, `shift_msg_cancel`
  templates with `{{staff_first_name}}`, `{{week_range}}`, `{{shift_lines}}`,
  `{{total_hours}}`, `{{old_shift}}`, `{{new_shift}}`, `{{reason_or_none}}`,
  `{{owner_first_name}}` tokens.
- **Staff → Schedule Audit** — chronological event log for a week.
- **Staff → Confirmations** — per-staff-per-week publish tracker with
  manual "mark acknowledged" once the reply lands.
- Home alert: "N staff have unpublished shifts this week."
- `whatsapp_phone_e164` column added to `staff` (E.164 format).
- Migration 020 adds `staff_shifts`, `staff_shift_events`,
  `staff_weekly_publish` (unique per staff × week).

### Notes
- **Zero automation of WhatsApp itself.** The app opens the OS handler
  with a pre-filled message; the owner still presses Send. This keeps us
  well clear of WhatsApp ToS territory that would risk a phone-number ban.

## v1.1.0 — Document Vault (code-complete, awaiting ship approval)

**First module built on the Phase-2 Data Contract** (UUID PKs, UTC ISO
timestamps, soft delete, optimistic concurrency, per-entity event log,
content-addressable blob storage).

### Added
- **Document Vault** sidebar module — upload, tag, and centrally track
  licences, insurance policies, internal policies, staff & child records,
  vendor contracts, financial docs, incident reports, board minutes, and more.
- Content-addressable blob store (SHA-256): re-uploading the same PDF is
  detected automatically and offers a "just update the metadata" path.
- Version history per document: uploading a new version preserves the old
  copy and marks the new one as current — old versions remain accessible.
- Bulk **Export ZIP** for licensing inspections. Human-readable filenames
  (`category/title__v1.pdf`) organised by category.
- Inline preview for PDFs and images; download for everything else.
- Home dashboard alert: "N documents expire within 60 days" (danger for
  already-expired, warn for upcoming).
- Full audit log per document (created / updated / deleted / new_version /
  downloaded / exported / restored).
- Soft-delete with a "Show deleted (restore within 30 days)" filter chip
  in the Library sidebar.

### Technical
- Migration 019 in `src/lib/db.ts`: new tables `documents`,
  `document_events`, `blobs`; new column `staff_credentials.document_id`.
- New `src/repo/documentsRepo.ts` — typed repository, no raw SQL leaks
  to UI code.
- New Rust command `documents_export_zip` (uses the `zip` crate).
- Optimistic concurrency: two simultaneous metadata edits — second save
  errors "Document was changed by another writer. Please reload."

### Deferred (documented debts, not yet built)
- Blob garbage collection when `ref_count = 0` — Phase 1 cleanup train.
- Full-text search inside PDF content — Phase 2.
- Staff → Credentials "attach source PDF" button — coming in v1.1.1
  once the Vault UX has real-world use behind it.
- Large-file (>25 MB) support — Phase 2 with Azure Blob.
