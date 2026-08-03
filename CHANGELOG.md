# Changelog

All notable changes shipped as a DMG. Only entries the owner has approved
for release are listed here — "code-complete, awaiting ship approval" work
lives in the session plan.md until it ships.

## v3.14.0 — Bundled template layout refinements

Follow-up to v3.13.0. The bundled certificate template is now positioned
to match a professional certificate reference (photo + name row on the
same axis, no overlap with the underlying certificate art).

### Changed
- **Slide size switched to 4:3** — matches the certificate PNG's native
  aspect. Full-bleed background no longer stretches horizontally.
- **Photo tile: rounded rectangle**, positioned left of the recipient
  block, sized ~21%×30% of the slide (matches the reference design).
- **`{{Year}}` mask** — solid cream fill behind the token so the
  hardcoded "2025" in the certificate art doesn't bleed through.
- **`{{Name}}`** — moved onto the natural recipient blank line, right
  of the photo.
- **`{{Note}}`** — small italic under the recognition paragraph.
- **Intro slide simplified** — single "Class of {year}" overlay in the
  recipient blank instead of the earlier 3-line stack (which collided
  with the baked-in certificate paragraph). Year mask matches the
  marker slide.

## v3.13.0 — Bundled certificate-style default template

The old bundled default (`graduation-template.pptx`) was a bare marker
slide that triggered the v3.12.0 auto-cover. Replaced with a proper
2-slide branded template so out-of-the-box decks look like a graduation
ceremony, not a form.

### Changed
- **Default template is now 2 slides**:
  * **Slide 1 (intro)** — full-bleed watercolor "Certificate of
    Graduation" background with owls, bunting, mortarboard, diploma,
    and daycare seal. Overlays: "Class of 2026", "Echelon Daycare",
    "Graduation Ceremony".
  * **Slide 2 (per-student marker)** — same certificate background
    with `{{Name}}`, `{{Year}}`, `{{Note}}` text tokens and a small
    `{{Photo}}`-tagged picture placeholder in the lower-left area.
- **Photo placeholder is a distinct image file** (not the certificate
  background) so per-child photo swap replaces only the small tile,
  never the beautiful certificate background.
- Because the default now has 2 slides, the v3.12.0 auto-cover code
  path no longer triggers for the bundled default — the hand-crafted
  intro is used as-is.

### Notes
- Custom user templates continue to work unchanged. A 1-slide user
  template still gets the v3.12.0 auto-generated branded cover.
- The intro slide's "Class of 2026" text is authored directly in the
  pptx — daycare admins can edit it in PowerPoint / Keynote each
  year, or replace the whole template with their own.

## v3.12.0 — Clean auto-generated cover slide (daycare branding)

The auto-generated cover slide for grad decks previously cloned the
per-student marker slide, which unfortunately dragged the marker's
**photo placeholder silhouette** onto the cover (a big beige person
icon next to "Class of 2026"). Fixed.

### Changed
- **Custom cover slide.** When the template has no explicit title
  slide, we now build a clean centred cover from scratch instead of
  cloning the marker. Layout:
  * daycare logo at the top (when configured in Settings)
  * daycare name below the logo (when configured)
  * "Class of {year}" as the display heading
  * "Graduation Ceremony" subtitle
- **No photo placeholder on the cover.** The `<p:pic>` element is no
  longer present on the auto-generated cover — no more beige
  silhouette.
- Cover inherits the template's `slideLayout` reference so theme
  colours and master styles carry through the entire deck.
- Logo is embedded as `ppt/media/cover_logo.{png|jpg}` inside the
  pptx zip with a proper `Content-Types` override.

### Preserved
- Templates that already ship an explicit title/cover slide are still
  left untouched — we only fill in the missing cover.
- Non-png/jpg logos, missing settings, or malformed data URLs all
  degrade cleanly to a text-only cover — the render never fails
  because branding is unavailable.

## v3.11.0 — Photo curation score cache

Small change with a big effect on **re-run** speed for grad-reel work.

### Changed
- **Sharpness scores are now cached to disk.** Every grad-reel run
  previously re-decoded and re-scored every photo (JPEG decode →
  resize to 500px → 3x3 Laplacian variance). For a 100-photo class,
  that's ~5-20s of CPU each run. HEIC decode was already cached; now
  the sharpness score is too, keyed by content fingerprint
  (`sha256(path|mtime|size)[..16]`). Re-runs against the same folder
  skip scoring entirely — typical repeat run drops by ~4-15s
  wall-clock on class-of-100 sets.
- Storage: tiny 8-byte sidecar files under `{graduation-cache}/scores/`,
  written atomically per-photo so concurrent rayon threads never
  contend on a shared map or lock.

### Behaviour preserved
- Cache misses on any edit (mtime bump or size change), so replacing
  a photo with a same-named one always rescores. Corrupt or
  non-finite sidecar values fall back to a fresh score. Failed writes
  are logged and swallowed — a broken cache never fails a render.

## v3.10.0 — Backend performance: SMTP pool reuse + faster PPTX writes

Two surgical backend improvements that don't touch a single UI pixel or
change any user-facing behaviour, but noticeably speed up two hot paths.

### Changed
- **SMTP transport is now cached across sends.** Lettre's `SmtpTransport`
  wraps an `Arc<Pool>` internally; each `.send()` call reuses an idle
  TLS+SASL session from that pool. We were building a fresh transport
  per `send_email` invocation, discarding the pool between calls. A
  session-scoped cache keyed by `(host, port, user, password_fingerprint)`
  now holds up to 16 transports. First send fully connects and
  authenticates; subsequent sends against the same server reuse the
  pooled connection. On the v3.8.0 grad-email flow this collapses N
  full handshakes into 1 — a 20-kid class goes from ~40 s to ~5 s of
  network wait. Also benefits monthly receipts and tax receipts.
  Password fingerprint is a SHA-256 hash, so rotating the password
  transparently invalidates the cache entry.
- **PPTX zip writes skip Deflate for already-compressed media.** JPEG,
  PNG, MP4, WebP, HEIC, HEIF, and GIF entries now use `Stored`
  compression instead of `Deflated`. These formats are already
  compressed at the pixel level, so running them through Deflate burns
  CPU for a bit-for-bit copy (typically slightly *larger* than input).
  Faster deck generation on photo-heavy graduation slideshows, and a
  smaller `.pptx` on disk. XML/rels parts still use Deflate.

### Notes
- Zero API change. All existing callers of `send_email` transparently
  benefit; PPTX consumers (PowerPoint, Keynote, LibreOffice) all handle
  `Stored` entries per the zip spec.
- `SmtpTransport` cache tested empirically — its Clone impl shares the
  underlying `Arc<Pool>`, so multiple cache-hit callers share pooled
  sockets rather than each opening a new one.

## v3.9.0 — Hero photo plays first in the reel

If a photo in a kid's folder is named after them (e.g. `Aarav Sharma.jpg`,
matching the same rule the PPTX slide uses), it now plays as the first
picture in that kid's reel — right after the name card. This gives the
slide and the reel a consistent "opening shot" and lets you pick the
photo that best represents the child without renaming or renumbering.

### Added
- `curate::hero_first` — reorders the photo list so any name-matched
  files (via `paths::child_photos`, same matcher as the graduation
  slides) are emitted first, in tier priority order (full name → first
  + last → first only). Applies to both the per-child reel and each
  segment of the class reel.
- Hero photos are forced in even if `curate` had dropped them for low
  sharpness — the whole point of a hero is that the operator picked it,
  so the sharpness heuristic yields.
- Per-child render logs `Hero photo detected for <name> — playing first.`
  when a hero is matched, so operators can confirm the wiring.

### Behaviour
- Zero regression when no hero is named: reels play in natural filename
  order exactly as before.
- HEIC heroes work correctly — the returned path points at the decoded
  JPEG in the HEIC cache, not the raw `.heic`, so FFmpeg is happy on
  every platform.

## v3.8.0 — Email graduation reels to parents (3-click flow)

After per-child reels are rendered, the operator can email each kid's MP4
directly to their parents in a single guided modal. Templates are seeded
with a warm default ("A little graduation memory from Echelon"), fully
editable, and remembered across sessions.

### Added
- **📧 Email reels to parents** button on Grad Step 4. Opens a modal
  listing each rendered per-child MP4 next to that student's parent
  email(s), reel file size, and a per-row send checkbox. Kids without
  an email on file are shown grayed with a "no email on file" note.
- Subject / body templates persisted in settings, editable inline,
  saved on Send **and** on Close (so drafts survive a mid-flow
  navigation).
- Two-parent-family greetings ("Hi Mike & Sarah,") when both parents
  are named on the student record.
- Pre-flight 25 MB SMTP attachment size guard so oversized reels fail
  fast with a clear "share via cloud link instead" message rather than
  a raw SMTP 552.
- Cancel-during-send button in the modal so the operator can stop the
  batch if SMTP hangs, without losing already-sent progress.

### Changed
- `send_email` audit log now records `grad_reel` sends alongside
  receipts and annual receipts — both success and failure paths are
  written to the communications history.

## v3.7.0 — Concurrent per-child renders on macOS (grad perf pass, Round 2)

The per-child render batch used to encode students strictly one at a
time. On macOS, VideoToolbox has multiple hardware encoder engines and
can comfortably run two 720p reels in parallel. This release runs
2 concurrent renders on Mac (1 on Windows, where the `h264_mf` MFT is
single-instance and serialises at the driver level anyway). A class of
20 kids finishes ~1.7-1.9× faster on Mac Silicon.

### Changed
- **Per-child render batch now runs 2 concurrent renders on macOS**
  (1 on Windows). Uses a shared queue + N worker promises, so a slow
  student never blocks fast ones from finishing.
- Backend `RenderState` refactored from a single `current_child` slot
  to a `HashMap<job_id, CommandChild>`. `graduation_cancel` drains and
  kills every in-flight FFmpeg — so pressing Cancel mid-batch stops
  both workers cleanly.
- Frontend `renderPerChild` batch entrypoint now resets the backend
  cancel flag once at the top, instead of every per-kid render
  self-resetting. (Self-reset by render N would clobber a user's cancel
  signal already flipped for render N-1.)

### Notes
- Windows behaviour unchanged (still serial). No visual change to any
  output; only wall-clock time on Mac batches.

## v3.6.0 — Parallel photo curation + parallel slide encoding (grad perf pass)

Every render mode starts with a photo scan + sharpness rank + HEIC
decode pass. That pass was single-threaded and often slower than the
FFmpeg encode itself. Similarly, slide-deck generation encoded each
student's photo serially. On a modern 8-core Mac both phases now run
4-8× faster.

### Changed
- **Round 1: Photo curation runs in parallel across all CPU cores**
  using `rayon`. HEIC decode, EXIF orientation correction, and
  sharpness scoring all parallelise per-file. Applies to every render
  mode (per-child, class reel, main reel, slides).
- **Round 3: PowerPoint slide photo encoding parallelised.** Per-kid
  JPEG decode → flatten → crop → downscale → JPEG re-encode is now a
  parallel pre-pass; the serial slide-writing loop consumes
  pre-encoded bytes via `Option::take()` (no double buffering). Slide
  order and warning behaviour identical to before.
- Sharpness tie-break is now deterministic (source path ASC) so
  equal-score photos have a stable playback order regardless of which
  worker finishes first.
- Added dep: `rayon = "1.10"`.

### Reviewed by
- Codex (gpt-5.3-codex): Round 1 clean. Round 3 flagged clone-based
  memory doubling → fixed via `.take()`.
- Sonnet 4.6 rubber-duck: Round 1 clean (1 nit fixed, 1 pre-existing
  bug filed). Round 3 flagged same memory concern → fixed. Cancellation
  concern verified not-a-regression (return Err before serial loop).

### Deferred to v3.7.0
- Round 2 (parallel per-kid renders) — needs batched backend command
  + tokio semaphore + coordinated cancel; too much refactor surface
  for one release.
- Round 4b (skip aliasing on Mac) — savings too small to justify
  the callsite churn.

## v3.5.1 — Per-child name cards + button reorder

### Added
- **Per-child reels now open with a name card** (same PNG renderer as
  Class reel — Inter font, slate-blue card, drop shadow). Rendered at
  1280×720, xfaded into the first photo. Falls back gracefully to
  no-card if the PNG renderer fails.

### Changed
- **Step 4 button order** reflows to workflow order: Run preflight →
  Slides only → Per-child only → Class reel → Reel only → Render
  everything (primary, right-most).

## v3.5.0 — Name cards rendered in Rust

Fixes the macOS "No such filter: 'drawtext'" crash and makes name-card
visuals identical across every OS.

### Changed
- **Name cards are now pre-rendered as PNGs in Rust** using `ab_glyph`
  and a bundled Inter Variable font (SIL Open Font License v1.1).
  - Eliminates the runtime dependency on the FFmpeg sidecar being built
    with `libfreetype` (drawtext filter). macOS DMGs shipped without
    libfreetype no longer crash mid-render.
  - Deterministic visuals across macOS, Windows, and Linux — the same
    Inter Bold-ish glyphs render on every OS.
  - No more system-font resolution dance
    (`resolve_system_font()` → removed).
  - No more drawtext availability probe
    (`preflight::ffmpeg_has_filter` → removed).
- Long names auto-shrink to fit the card (≤85% of card width) before
  running off-frame.
- Bundled font file: `src-tauri/resources/fonts/Inter-Variable.ttf`
  (embedded at compile time via `include_bytes!`, ~880 KB into binary).
- Attribution added to `resources/NOTICE.txt`; OFL license copy at
  `resources/fonts/Inter-OFL.txt`.

### Removed
- `preflight::required_filters()` no longer lists `drawtext`.

## v3.4.0 — Static frames + user-selectable reel length

Two owner-requested changes to the Graduation reel pipeline.

### Changed
- **Ken Burns pan/zoom removed** on every reel (main reel, per-kid,
  class reel). Photos are now shown static in-frame, letting each
  still read clearly without motion drift. Xfade transitions between
  photos are preserved. Backend: `zoompan` filter dropped from both
  `engine.rs::build_filter_script` and `class_reel.rs::build_segment_filter`.

### Added
- **Reel length settings** (Graduation → Render section):
  - "Main reel length (seconds)" — controls "Reel only" / "Render everything"
    output. Default 900s (15 min), range 10s–1800s (30 min).
  - "Per-child reel length (seconds)" — controls "Per-child only" output.
    Default 120s (2 min), same range.
  - Both persisted globally via settings (`grad_main_reel_sec`,
    `grad_per_kid_reel_sec`).
  - Progress bar denominator now uses the selected length so the bar
    scales with actual render duration.

### Notes
- Class reel already had its own per-kid seconds knob (Class reel
  settings → Seconds per kid) — unchanged.

## v3.3.0 — Class Reel (code-complete, awaiting ship approval)

One-tap "class reel" from the Graduation module: combines every
graduating kid's photos into a single 10–12 minute MP4 where each
kid gets a name card + ~30 seconds of their photos, xfade-chained
together with music underneath. Perfect for graduation ceremonies
where you want a single hit-play video instead of clicking through
each per-kid reel.

### Added
- **🎬 Class reel button** in the Graduation module. Renders a
  `Class-Reel-<year>.mp4` alongside the per-kid reels.
- **Two-pass render**: silent per-kid segment (name card + Ken Burns
  photos) → concat with xfades + music, loudnorm-normalized and
  faded out over the last 3 s.
- **Inline settings panel**: seconds per kid (default 30), photos per
  kid (default 6), name-card duration (default 1.5 s), resolution
  (1080p / 720p).
- **Custom playback order** via HTML5 native drag-and-drop with ↑↓
  fallback buttons. Per-kid checkboxes to exclude any kid from the
  reel. "Reset to A–Z" resets both. Order + exclusions persist per
  graduating year.
- **Progress bar** reports `class-reel-seg-N-of-M` and
  `class-reel-concat` stages so the user sees which kid is currently
  encoding.
- **Skipped-kids list** in the result summary: any kid whose folder
  is missing or empty is silently skipped and reported by name.
- **System font auto-detection** for name cards: Arial Bold on
  Windows, Helvetica on macOS, DejaVu Sans on Linux. Falls back to a
  text-less colored breather with a warning if none is found.

### Notes
- FFmpeg 7.x sidecar required (uses `-/filter_complex` script syntax).
- Class-reel FPS + xfade duration are locked at 30 fps / 0.6 s via
  `class_reel::CLASS_REEL_FPS` + `CLASS_REEL_XFADE_SEC` — both passes
  read from the same constants so they can't drift.

## v1.8.0 — Organizer Voice Capture (code-complete, awaiting ship approval)

**Also in this batch (unreleased, awaiting same ship):**
- **Deposit slip preview now in-app on macOS.** `depositSlip.ts` switched
  from `iframe.contentWindow.print()` (which on WKWebView deferred to
  Preview.app) to the shared `pdfPreview.ts` helper: `html2pdf` → Blob URL
  → in-app `<iframe>` modal with Print / Save-as-PDF / Close buttons.
  Same UX on Windows WebView2 and macOS WKWebView. Added
  `src/lib/pdfPreview.ts` — reusable for any future in-app PDF preview.

One-tap dictation for the Organizer. Instead of clicking through "New
meeting → Kind → Date → Time → Attendees…", say _"Meeting with Daisy
tomorrow at 11 for 30 minutes"_ and Whisper + GPT-4.1 turn it into a
pre-filled draft you confirm and save.

### Added
- **🎤 Voice add button** in the Organizer header (next to _Print PDF_).
  Modal state machine: idle → recording → transcribing → understanding →
  review → save. Cancel at any stage. Pulsing red mic while recording;
  live timer.
- **Whisper transcription** via the user's Azure Whisper deployment.
  Endpoint URL stored in `settings.azure_whisper_endpoint` (not secret);
  API key stored in the OS keychain under `azure_whisper_key`.
- **GPT-4.1 event extraction** with a strict JSON schema:
  `{ kind: meeting|followup|action_item, title, date, time,
  duration_min, participants, notes, priority, confidence }`. Reuses the
  existing `azure_ai_key` — one key, one Settings tab.
- **Editable draft card** — every field pre-filled, all editable. Low
  confidence (<70%) surfaces a warning banner. Meeting kind is guessed
  from title/attendees keywords (board / parent / staff / vendor /
  inspection / other).
- **Voice section** in _Settings → AI_ — endpoint URL, keychain-stored
  key, per-user enable toggle, transcript-retention toggle.

### Security
- New **`azure_url_guard`** module — every endpoint URL passed over IPC
  is validated: https-only, no userinfo, host must end in
  `.cognitiveservices.azure.com` / `.openai.azure.com` /
  `.services.ai.azure.com`, path must start with `/openai/deployments/`.
  13 Rust unit tests cover the allowlist edge cases.
- **Audio limits** enforced server-side: 25 MiB decoded cap (Whisper's
  own per-request limit); MIME allowlist
  (`audio/webm | audio/wav | audio/mp4 | audio/mpeg | audio/ogg`).
- API keys never leave the keychain — the frontend passes only the
  endpoint URL over IPC (Phase-4b H-7 pattern).

### Data
- Migration 025 (`db.ts::ensureSchema`, not the Rust list) adds
  `organizer_ai_events(id, created_at, kind, prompt_hash, prompt_text,
  response_text, latency_ms, error)` with a 180-day rolling purge —
  mirrors the `agm_ai_events` retention.
- Transcripts are **hashed by default** (sha256); raw text only kept
  when `organizer_ai_store_transcripts=1`. Auto-purged after 180 days
  either way.
- New settings: `azure_whisper_endpoint`, `azure_whisper_key_set`,
  `voice_organizer_enabled` (default on), `organizer_ai_store_transcripts`.

### Tests
- Vitest `src/lib/voice.test.ts` — `toLocalIso` shape/zero-padding,
  `isVoiceConfigured` truth table.
- Rust `#[cfg(test)]` in `azure_url_guard.rs` — 13 allowlist cases
  including homoglyph attack (`openai.azure.com.evil.com`) and
  wrong-path rejection.

## v1.5.0 — Notification Bell (code-complete, awaiting ship approval)

Single header bell that surfaces every actionable item across the app.
Replaces the ad-hoc "check every screen" workflow with one always-visible
badge and a grouped dropdown, so nothing important gets missed.

### Added
- **Header bell** on every non-Home screen with unread badge (1–9, then "10+").
  Red badge when any critical item is unread, blue otherwise.
- **Dropdown panel** with per-row Open / Snooze (1h, 4h, tomorrow, next week) /
  Dismiss, Undo-dismiss footer, and "Mark all as read". ESC or outside-click
  closes; batches 3+ same-category unread items within an hour into a single
  collapsed row.
- **Full-page history** at `#/notifications` (accessible from the bell footer
  only — not the sidebar). Filters by category, severity, read/unread, date
  window; bulk mark-read and dismiss; CSV export.
- **Notifications tab** in Configuration with per-category enable + minimum
  severity, quiet hours, and MM-DD date pickers for AGM date, T-slip deadline
  (default Feb 28), and CCFRI monthly claim day. All reminders repeat yearly
  automatically — no year in the picker. Test-notification button.
- **17 scanners** covering staff credential expiry (60/30/14/7/3/0d/overdue),
  emergency drill cadence, vault document expiry, receipt aging (30/60/90d),
  schedule not yet published for next Monday, staff schedule confirmations
  missing (4/24/48h after publish), meeting action items due, follow-ups,
  waitlist offers pending 5/7/10d, new waitlist applications (last 7d), AGM
  and T-slip reminders, CCFRI monthly claim, cloud backup stale (35/45/60d)
  and failed. System-update scanner stubbed until the updater is wired.

### Changed
- Cloud backup now surfaces failures via the bell (writes `last_backup_error`
  setting on catch, clears it on success).

### Data
- Migration 023 adds `notifications`, `notification_settings`,
  `notification_events` tables. UUID PKs, soft delete, optimistic concurrency,
  per-entity event log — same Data Contract as Vault / Schedule / Organizer.
- Dedup key format `{category}:{source_kind}:{source_id}:{tier}` — same item
  advancing to a stricter tier (e.g. 30d → 7d) produces a new row so the
  escalation is visible; resolved items are soft-deleted on the next scan.

### Scheduler
- First scan 100ms after mount, then every 10 minutes; also on window focus
  and on bell open (30s debounce). Scanners run in isolation — one failure
  doesn't take down the others.

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
