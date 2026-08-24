# Changelog

All notable changes shipped as a DMG. Only entries the owner has approved
for release are listed here — "code-complete, awaiting ship approval" work
lives in the session plan.md until it ships.

## v3.24.0 — Website module perf + UX pass

Follow-up to v3.23.4's deep-review hardening. Fixes the highest-signal
performance and UX items from the same review that were deferred out of
that release.

### Performance

- **`list_media` no longer does N+1 variant queries.** The Gallery tab
  called one `SELECT … FROM site_media_variants WHERE media_id = ?` per
  photo; on centres with 300+ uploads that meant 300+ round-trips through
  the async DB gate on every refresh. Now runs one `IN (…)` batch per
  chunk of 500 ids, grouped in a `HashMap` and attached in-memory.
- **`spawn_blocking` / `block_in_place` around long-running native work.**
  `run_pipeline` (git fetch/commit/push, render step) and
  `website_tour_add_videos` (ffmpeg transcode + poster extraction) no
  longer starve Tokio's async runtime; other Tauri commands stay
  responsive during a publish or a long transcode.
- **Gallery grid images lazy-load.** Every thumbnail got
  `loading="lazy" decoding="async" width height`, cutting decode CPU on
  Gallery open by an order of magnitude on centres with 100+ photos.

### UX

- **AI proposal review queue.** Prompt-driven page edits used to
  auto-save as a draft revision the moment the AI came back — visitors
  had to open Revisions and roll back if the copy landed wrong. Now the
  proposal renders inline with **Accept & save draft** / **Reject**
  buttons; nothing is written until Accept.
- **Unsaved-edits guard covers react-router navigation.** The existing
  `beforeunload` handler only caught window close and refresh — sidebar
  clicks (e.g. jumping from Contact editor to Careers) silently dropped
  in-progress edits. Added `useBlocker` with a confirm prompt.
- **Preview "Home" opens the site root (`/`)** instead of the redundant
  `/pages/home.html`, matching how visitors actually land on the site.
- **Native OS drag-drop wiring extracted into a reusable
  `useTauriDragDrop` hook.** Same StrictMode-safe behavior as before,
  now shareable across future upload targets.
- **Bulk delete goes to the backend in one command.** Selecting 50
  photos and hitting *Delete selected* used to fire 50 sequential
  `website_delete_media` invocations (each rewriting `gallery.json`).
  New `website_bulk_delete_media` command wraps every soft-delete in a
  single transaction and does one gallery.json rewrite.

### Notes

- Deferred to a follow-up: cross-machine draft reconcile, incremental
  render skip for unchanged pages, and zero-copy preview from the
  working copy. Each needs a schema addition and larger refactor;
  packaging them here would have delayed this bundle.

## v3.23.4 — Website module deep-review hardening

Consolidated fixes from a 4-agent parallel review (code review, functionality
review, security review, Mac/perf review) of the Website CMS module.

### macOS + robustness

- **Preview server now supports HTTP Range requests.** WKWebView refused
  to play locally-hosted video without `Accept-Ranges`. Added single-range
  parsing (`bytes=X-Y`, `bytes=X-`, `bytes=-N`) with 206 Partial Content
  responses; `Accept-Ranges: bytes` emitted on every response.
- **`minimumSystemVersion` raised to 11.0** so Apple Silicon Big Sur+
  users can install without the wrong-arch warning.
- **All working-copy paths now use forward slashes.** Prevented broken
  thumbnails and dead links on macOS when reading DB rows populated on
  Windows.

### Data safety

- **Fresh clones no longer lose gallery entries.** SQLite was treated
  as the source of truth; on a fresh Mac install, `gallery.json` was
  present but the DB was empty, so the Gallery tab appeared blank.
  Publish now stages every `content/**` JSON, and a new
  `hydrate_gallery_from_json` runs idempotently on init to seed
  SQLite from the JSON on any machine.
- **Migration 016** adds `UNIQUE(base_hash, kind)` + `sort_order`
  column, so identical images can coexist as photo + hero + og and
  gallery drag-order persists across restarts.
- **Gallery mutations are now serialised.** A process-wide mutex
  around every `gallery.json` read-modify-write closes a race that
  could truncate the file when two uploads finished within a few
  hundred ms of each other.
- **Corrupt `gallery.json` is now a hard error.** Previously silently
  coerced to `{}`, wiping content on the next save.
- **Fetch refuses to fast-forward if the working tree is dirty**, so
  publishing from one Mac can't discard uncommitted local edits from
  another.
- **Delete flows are locked to the repo directory** via a new
  `safe_delete_under_repo` guard that canonicalizes the parent and
  rejects absolute paths, `..` components, or paths outside
  `assets/{video,image}/…`.

### UX polish

- **Publish "no changes" now returns a clean success**, not a
  simultaneous success+error banner.
- **Preview shows an empty state** when zero pages have rendered.
- **PageEditor guards against accidental window close/refresh** when
  edits are unsaved.
- **Tile links disabled until the working copy is cloned** with a
  first-run info banner, so users can't click Gallery/Preview before
  the repo exists.
- **Drag-drop upload rewired to Tauri v2's webview drag events** —
  DOM `onDrop` never fired under Tauri v2, so drag-drop was silently
  broken. Gallery now uses `getCurrentWebview().onDragDropEvent`.
- **Broken "Ask AI to update this page" link fixed** — added the
  missing `/website/edit/:file` route.
- **Emergency-remove wording matches reality** — no longer promises
  an automatic history rewrite the code doesn't perform.

### Backend correctness

- **Template parse errors no longer swallowed.** A single broken
  template used to make the whole render succeed silently with a
  page missing; now surfaces as a real error.
- **Case-insensitive `.json` filtering** in the renderer.
- **`transcode_video` returns an explicit error** when the encoded
  file is still oversize (was silent success producing a corrupt
  reel).

## v3.23.3 — Fix gallery video upload on macOS

- **Video transcode now uses the OS-native encoder.** `transcode_video`
  hardcoded `libopenh264`, which the bundled macOS ffmpeg doesn't
  include, producing `Unknown encoder 'libopenh264'` on Upload videos.
  Now picks `h264_videotoolbox` on macOS, `h264_mf` on Windows, and
  `libopenh264` on Linux via the existing `HwEncoder` helper.

## v3.23.2 — Preview iframe fix on macOS

- **Preview now renders on Mac.** The Tauri CSP `frame-src` directive
  only allowed `'self' blob: data:`, so macOS WKWebView blocked the
  Preview iframe from loading `http://127.0.0.1:<port>/` (Windows
  WebView2 was more permissive and worked incidentally). Added
  `http://127.0.0.1:*` and `http://localhost:*` to `frame-src`.

## v3.23.1 — Fresh-machine setup fixes + Contact form phone/email

- **Templates now ship with Publish.** The CMS is the source of truth
  for both content and templates. Prior versions only pushed rendered
  HTML + content JSON; templates lived upstream only if manually
  synced. On a fresh clone (e.g. installing on a new Mac) this caused
  strict-undefined render errors when the local template referenced
  fields the local JSON didn't have. Publish now stages
  `templates/**` too.
- **Working copy auto-syncs on setup.** `website_working_copy_init`
  now fetches + fast-forwards `main` when the local repo already
  exists, so opening the CMS on a machine that's been offline for
  a while pulls in any templates / content changes made from other
  machines. No more manual "delete the working copy" step.
- **Contact form: phone and email are inline.** Phone (with auto-
  derived `tel:` href) and email fields now sit next to Address /
  Facebook on the Contact editor. Previously these lived only under
  Site (global).
- **Preview from Site (global) / SEO now lands on the home page.**
  Both keys point at data shared by every page, not a page of their
  own, so Preview opens the site index instead of a 404.
- **Gallery Videos template parse fix.** Removed a stray `{% endif %}`
  that was silently swallowed by the renderer and dropped the videos
  page from the render output.

## v3.23.0 — Gallery split (Photos + Videos), CMS enabled by default

- **Gallery is now a two-section area.** On the public site, `/gallery`
  renders a chooser page with **Photos** and **Videos** tiles. Photos
  open the existing photo gallery; Videos open a new playlist page
  cloned from the Virtual Tour player (auto-plays first video,
  click-to-switch playlist, per-video description).
- **New CMS Gallery Videos screen.** Website → Gallery is now a landing
  page with the same two tiles. **Photos** goes to the existing photo
  gallery editor; **Videos** opens a new Tour-style editor:
  - Upload one or more MP4/MOV/WEBM at a time (auto-transcoded to H.264
    where needed to stay under the GitHub 100 MB limit)
  - AI auto-suggests a friendly title and description per upload,
    tagged with the "Gallery" context so titles read naturally
  - Drag-drop to reorder (first video plays by default on the site)
  - Multi-select delete with confirmation
  - Preview button for the exact draft the visitor will see
- **Gallery videos have their own asset folder.** New videos live under
  `assets/video/gallery/` (not `assets/video/`) so gallery and tour
  stems can never collide.
- **Website CMS enabled by default.** No more `ECHELON_WEBSITE_CMS=1`
  requirement. The Website icon in the topbar and the CMS commands are
  now on out of the box for every DMG install (Mac and Windows). The
  env var is kept as an explicit opt-out (`ECHELON_WEBSITE_CMS=0`) for
  support scenarios.
- **Contact template map iteration fix.** MiniJinja 2 iterates dicts
  directly as key-value pairs; the AI-generated contact template was
  calling `.items()` which does not exist, causing a preview error.
  Working-copy template patched.

## v3.22.1 — Contact page edits, unified CMS UX, video auto-transcode

- **Contact page inline form.** Website → Contact now has a first-class
  form for the heading, address (updates the map + iframe title
  automatically) and Facebook link — no JSON editing required. AI prompt
  panel handles anything else.
- **Open social platforms via AI.** The AI Contact editor also has access
  to `site.json` and can add Instagram, TikTok, YouTube, LinkedIn, X,
  WhatsApp or any other platform to the contact page by adding a key to
  `site.socials`. The template renders a matching icon per platform with
  a globe fallback for unknown ones.
- **Consistent Preview.** Every CMS edit surface (Careers / Tour /
  Contact / Gallery / other pages) now has a **Preview →** button on the
  header row for one-click preview of the pending draft.
- **Tour videos multi-select delete.** Select-all checkbox and
  per-card checkboxes on the Virtual Tour videos screen, matching the
  Careers bulk-delete UX.
- **Video auto-transcode on upload.** Tour video uploads now transcode
  large files through a 3-tier ladder (1500k→1000k→700k @ 720p/540p) so
  publishes never trip GitHub's 100 MB hard limit. AI also auto-fills
  title + description from the filename via `gpt-5.4`.
- **Delete now sticks.** Fixed tour-video list/add/delete/reorder
  commands reading disk while `save_draft` wrote to the DB, so the UI
  reflected stale state after every mutation.
- **Website shortcut moved.** Removed the "Website" tile from the Home
  grid; it now lives as a globe icon in the top-right stack next to the
  notification bell and lock button.

## v3.22.0 — Website CMS: Virtual Tour goes multi-video with AI editing

The Virtual Tour page now supports a playlist of multiple videos and can
be edited with plain-English prompts, matching the Careers flow.

- **AI edit for Tour** — same purple panel: describe the change, submit,
  preview, publish. Works on heading, intro, per-video titles and
  descriptions, and the fallback strings.
- **Upload multiple videos** — new **Manage videos** screen from the tour
  editor (or `/website/tour-videos`). Pick one or many MP4 / MOV files;
  the app copies them into `assets/video/` and extracts a first-frame
  JPEG poster with ffmpeg (the sidecar already bundled for graduation).
- **Drag-drop reorder** — the top video plays first when a visitor lands
  on the page. Delete removes both the entry and the underlying files.
- **Playlist layout on the live site** — one big player with a thumbnail
  strip below. Clicking a thumb swaps in the new video and updates the
  "now playing" title + description.
- Schema: `content/tour.json` bumped to `schema_version: 2` with a
  `videos: [{id, title, description, src, poster}]` array. Backward
  compatible: v1 tour.json auto-migrates on first read.

## v3.21.1 — Website CMS: streamlined Careers AI flow

Simplifies the Careers AI editor per owner feedback ("the diff view was
too complex"). New flow: type a request → **Submit** (spinner while AI
works) → **Preview →** button appears → click Preview to see the actual
Careers page rendered with the AI's changes → **Publish →** ships live.

- AI panel no longer shows raw JSON, apply/discard buttons, or the "what
  changed" tree. Just prompt in, preview out. The generated content is
  auto-saved as a draft the moment the AI returns, so Preview always
  reflects the latest AI edit.
- Advanced users can still edit `careers.json` by hand under a collapsed
  **Advanced: edit JSON directly** section.
- `Preview.tsx` accepts `?page=<slug>` and iframes that specific page
  directly (`/pages/careers.html`). A new green **Publish →** button in
  the Preview header jumps straight to the Publish screen.

## v3.21.0 — Website CMS: AI-driven content edits on the Careers page

Adds an "Ask AI to edit this page" panel to the Careers content editor.
Owner describes the change in plain English (broad restyle or narrow
tweak — "add a Friday cook role, part-time, $22-25/hr"), the app calls
Azure OpenAI gpt-5.4 with the current `careers.json` and the request,
then shows the proposed replacement JSON + a plain-English summary.
Owner clicks **Apply to editor** to load it, then Save + Publish as
usual — nothing auto-commits.

- New backend command `website_ai_edit_content` in
  `website/ai_edit.rs`. Uses AOAI `response_format: json_schema` with
  a strict object shape `{content_json, summary}`. Read/write scope
  is limited to `content/careers.json`; other pages return an error.
- New frontend wrapper `websiteAiEditContent(page, prompt)` +
  `AiEditResponse` in `src/lib/website.ts`.
- `PageEditor.tsx` renders the AI panel only when the current page is
  in the allowlist (`careers` today). Preserves the existing raw-JSON
  editor for advanced users; AI is an addition, not a replacement.

## v3.20.3 — Website CMS Gallery: thumbnails, multi-select, batch delete

- **Thumbnails now render** in the Gallery editor. Adds
  `assetProtocol.enable` + scope to `tauri.conf.json` so the WebView
  can load `asset://` URLs from `%APPDATA%\org.echelondaycare.receipts\...`
  (Windows) and `~/Library/.../` (macOS).
- **Multi-select toolbar**: "Select all" checkbox + per-card checkbox,
  "Delete selected (N)" button, and "Delete all N" button.
- Batch delete runs one `websiteDeleteMedia` call per target, reports
  aggregate success/failure, then refreshes the grid.

Flow after this ship: Open Gallery → see current live photos as thumbnails
→ tick to delete some, or "Delete all" → drop new photos → Publish →
site updates in one click (v3.20.2 already covers the publish half).

## v3.20.2 — Website CMS: publish now commits rendered HTML + assets

Fixes a deploy-blocking gap: previously `website_publish` only committed
the CMS JSON under `content/*.json`. The site repo's
`content-render-validation` workflow requires committed `pages/*.html` to
match the render of that JSON — so every publish caused a Pages deploy
failure and no live update.

- `stage_rendered_html_and_assets` copies rendered top-level `*.html`,
  `pages/*.html`, `sitemap.xml`, `robots.txt`, and `assets/data/**` from
  the pipeline's render dir into the working copy, then stages them.
- Also runs `add_all` under `assets/` to pick up newly-uploaded media
  variants written by `website_upload_photos`.
- Wired into `run_pipeline_inner` immediately after `stage_content_writes`.

Result: Upload photos → Publish → Pages deploys → live site updates,
in one click, no manual `render.py` push required.

## v3.20.1 — Website CMS: 5-10× faster bulk photo upload

- `website_upload_photos` now runs up to 8 photo ingests in parallel
  (bounded by `available_parallelism() - 1`, capped at 8) instead of
  serially. Different photos overlap disk read + DB write + moderate
  encode phases while the per-photo rayon pool still saturates cores
  within a photo.
- AVIF speed preset bumped 4 → 8 (~2-3× faster encode, ~15-25% larger
  files). AVIF-at-8 is still smaller than WebP on typical photos, so
  the on-disk cost is acceptable for a self-hosted gallery.
- Expected wall-time for 50 photos: ~15-25s in release / DMG (was
  ~60s), ~2 min in Windows debug build (was ~10 min).

## v3.20.0 — Website CMS module: content editor + media pipeline (behind ECHELON_WEBSITE_CMS=1)

New in-app module for editing `EchelonDayCare/echelon-website` — text
content, gallery photos, logo/favicons/OG image — from the desktop
without ever touching git or an editor. **Gated behind the
`ECHELON_WEBSITE_CMS=1` env var** so the daycare owner sees nothing new
until we flip the switch.

**PR 2 (content):**
- Text editors for `site.json`, `home.json`, `about.json`, `services.json`,
  `contact.json`, `tour.json`, `careers.json`, `seo.json`.
- Immutable revision history (`site_revisions`) with pointer table
  (`site_pointers`) for active-draft / last-pushed / last-verified-live.
- Local MiniJinja preview server bound to a random loopback port,
  matching the site-repo's `scripts/render.py` byte-for-byte on
  schema-compatible inputs.
- PAT wizard: verify token against `GET /repos/.../echelon-website` and
  store in the OS keychain — the frontend never sees the token bytes.
- Publish state machine persisted in `site_publications`.

**PR 3 (media, this release):**
- Deterministic photo pipeline: BLAKE3-hashed filenames, EXIF/XMP/IPTC/ICC
  strip, 3 widths × 3 formats (AVIF q=50, WebP, JPG q=82) via Rayon.
- EXIF orientation baked into pixel data before strip, so phone photos
  taken in portrait render upright (browsers no longer need the stripped
  orientation tag).
- New DB tables: `site_media`, `site_media_variants`,
  `site_emergency_removes` (migration 015).
- Gallery editor: drag-drop upload zone, thumbnail grid with HTML5
  drag-reorder, click-to-edit modal (caption / alt / focal-point
  picker), delete + emergency-remove flows.
- Site assets editor: logo replace (auto-regenerates 16/32/180 px
  favicons), Open Graph image replace (1200 × 630 crop-to-fill).
- HEIC input supported via existing `libheif-rs` dep (converted to
  JPEG then fed to the pipeline).

Video and PDF ingestion are stubbed — real ffmpeg-sidecar + PDF
rasteriser wiring lands in PR 3.5. Publish-time git history rewrite
for emergency-removes lands in PR 4.

## v3.19.4 — Graduation deck: photo survives Mac PPT export + prints edge-to-edge on A4

Two fixes to the graduation certificate pipeline:

**1. Bake child photo into the certificate background.**
v3.19.3 shipped a rounded-corner PNG-with-alpha-mask + `roundRect`→`rect`
rewrite, but that still didn't survive PowerPoint-for-Mac's Save-as-Pictures
raster export — the child `<p:pic>` was still being dropped regardless of
attributes, shape geometry, position, filename, or content. After twelve
controlled variant tests confirming the drop was not caused by any XML
property we could tweak, the fix routes around the trigger entirely:

- Compose the child photo (with its rounded-corner alpha mask) directly
  onto the slide's background image at the correct position, producing a
  per-student baked background PNG.
- Remove the child `<p:pic>` shape from the slide XML entirely — there is
  no separate picture element for Mac PPT to drop.
- Rewire the slide's bg rId to the per-student baked file.

Result: the photo is now part of the background pixels themselves; Mac
PPT's Save-as-Pictures export cannot lose it. Deck size stays reasonable
(~1 MB/student) because the composite reuses the bg's compression.

**2. Resize the deck to A4 landscape.**
Printing the exported certificates on A4 paper left large white bands
top and bottom because the deck was 16:9 (1.78:1) while A4 landscape is
1.41:1. The fix rescales every shape's `<a:off>`, `<a:ext>`, `<a:chOff>`,
`<a:chExt>` non-uniformly on both axes and sets `<p:sldSz>` to A4
landscape (10,692,000 × 7,560,000 EMU). Square shapes (circular logos,
icons) are detected via `cx == cy` and scaled uniformly by `min(sx, sy)`
so they stay circular rather than becoming ovals. Applied across slides,
slide layouts, and slide masters. Printing from PowerPoint now fills the
A4 sheet edge-to-edge.

## v3.19.3 — Graduation deck: PowerPoint macOS Save-as-Pictures fix (real fix)

Supersedes the v3.19.2 attempt at the same bug. Inspecting a v3.19.2
output deck showed the real trigger: the child-photo shape in the
graduation template uses `<a:prstGeom prst="roundRect">` with a 25%
corner radius. **PowerPoint-for-Mac's built-in File → Save as Pictures
raster export silently drops any `<p:pic>` whose preset geometry is
not `rect`.** The cover-slide logo (plain `rect`) survived; every kid
photo (`roundRect`) did not.

**Fix — preserve rounded corners AND make the photo export:**

1. Detect the `roundRect` corner `adj` value once from the marker
   template.
2. Encode the child photo as **PNG with a transparent rounded-corner
   alpha mask** baked into the pixels (radius = `adj / 100000 *
   min(w, h) / 2` per the DrawingML spec). Anti-aliased signed-distance
   corner curve for smooth edges at any zoom.
3. Rewrite the shape's `prst="roundRect"` → `prst="rect"` so Mac PPT's
   raster export path picks up the picture.

Net visual result on-screen: identical. The rounded corners now live
in the PNG's alpha channel instead of the shape geometry, so the
certificate background (bluish, textured, gradient — anything)
shows through naturally at the corners.

Zero workflow change: photos still auto-picked from per-child folders.

Composite multi-photo path (2/3/4 photos per child) supported via the
same mask pipeline.

## v3.19.2 — Graduation deck: PowerPoint macOS Save-as-Pictures fix

Single-purpose bug-fix release. No schema migrations, no workflow changes.

**Fixed:** when a user opened a generated graduation deck in PowerPoint
for macOS and used the built-in **File → Save as Pictures** export, the
child photos went missing from the saved PNGs even though they displayed
correctly on-screen (the cover-slide logo was preserved).

**Root cause:** the cover-slide logo is a plain `<p:pic>` shape we
author ourselves — minimal, layout-independent, and clean. The child
photo lives inside the template author's `<p:pic>` shape (tagged
`{{Photo}}` in alt-text) which typically inherits from a slide layout —
carrying a `<p:ph type="pic"/>` reference, an inherited `<a:srcRect/>`
crop, and an `<a:extLst>` `useLocalDpi` hint inside `<a:blip>`.
PowerPoint-for-Mac's raster export path (older than the on-screen
renderer) drops images with those decorations under specific
placeholder-inheritance conditions.

**Fix:** after each per-child photo swap, the marker slide's `<p:pic>`
block is sanitized in place to strip the three offending decorations
(`<p:ph>`, `<a:srcRect>`, `<a:extLst>` inside `<a:blip>`). The sanitizer
is **surgical**: it preserves render-affecting `<a:blip>` color
transforms (`<a:duotone>`, `<a:lum>`, `<a:tint>`, `<a:alphaModFix>`,
`<a:clrChange>`, `<a:biLevel>`, `<a:grayscl>`) so a template designer
can still apply brand-tint or B&W effects and every renderer
(PowerPoint, LibreOffice, Keynote) shows them.

**No workflow change:** photos continue to be auto-picked from
per-child folders exactly as before.

## v3.19.1 — Sign-in sheet polish · Ask Echelon nav map refresh

Small polish release built on the same v3.19.0 codebase — no breaking
changes and no schema migrations.

**Sign-in sheet:**

- Interior grid lines are ~2× darker (`#d6d3d1` → `#78716c`) so photocopies
  and phone scans stay legible.
- Dropped the `DAY & DATE` kicker — the header now reads simply
  `Tuesday · 04 August 2026`.
- Header now shows both the SMTP sender email and the generic contact
  email side-by-side when they're set to different values (deduped
  case-insensitively). Both are always rendered lowercase, so a legacy
  uppercase value like `ECHELONDAYCARE@gmail.com` prints clean regardless
  of what's stored in settings.

**Ask Echelon:**

- Refreshed the `UI_NAV_MAP` knowledge base for every feature shipped
  between v3.3.0 and v3.19.0: sign-in sheets (daily + whole-month), the
  deposits screen, aging/subsidy/AGM/drills/credentials reports, the
  bulk-delete AI text panel (including the v3.19.0 hard-stop behaviour),
  Class Reel, per-child videos, slide deck, slide-image export (PNG/JPEG
  + LibreOffice requirement), email-reels-to-parents dialog, custom
  branded cover slide, per-child name cards, waitlist enroll/archive,
  Organizer Calendar, Vault, Quick add hours, and Configuration →
  Notifications. Added a `LAST AUDITED` header + explicit
  "must land here in the same PR" rule so the map can't drift silently
  again.

## v3.19.0 — Sign-in sheet whole-month print · code-review hardening

Two owner-visible upgrades and four internal quality fixes surfaced by
the v3.10.0..v3.18.0 code review.

**Owner-visible:**

- **Whole-month sign-in sheets.** The Monthly Attendance screen now has
  a "📅 Whole month · <month>" button next to the daily sign-in
  button. One click prints a sign-in sheet for every open day of the
  selected month (weekends and stat closures dropped automatically),
  ready to slip into the front-desk binder at the start of each month.
- **Sign-in sheet layout polish.** Dropped the DAILY CHILD SIGN-IN
  kicker, the "25 children" pill on the top-right, and the
  "Printed on …" strip at the top. Month names now render in full
  (August, not Aug). Blank-template header block sits 25 px higher;
  the two footer QR codes sit 10 px higher.
- **Quick add hours label.** On the Staff screen the "Add to <month>"
  button in the Quick add hours card now reflects the *picked date*,
  not the top-of-screen month picker. Rows were already saved to the
  correct month; only the label was lying.

**Internal quality (code-review v3.10.0..v3.18.0):**

- **P0 — Sanitize image data URLs before printing.** The centre logo
  and staff signature were being interpolated raw into `<img src="…">`
  across four print templates (daily/annual/subsidy receipts, sign-in
  sheet). A tainted `logo_data_url` could have executed HTML from the
  print DOM. Added `sanitizeImageDataUrl()` which whitelists
  `data:image/(png|jpeg|gif|webp|svg+xml);base64,…` under 2 MB and
  rejects anything else. All four sinks route through it and the
  attribute is also wrapped in `h(...)` belt-and-suspenders.
- **P1 — Bulk-delete parser: token-level person resolution.** The
  previous roster-driven scanner silently combined ambiguous first
  names ("Judy" when two Judys exist) and dropped typos ("Chlio") to
  an empty staff filter, which then fell back to "delete every shift
  in scope" — the exact opposite of intent. The parser now scans the
  prompt for capitalized person tokens, resolves each independently,
  and returns `unique | ambiguous | unresolved` per token. The
  Schedule AI panel hard-stops on any non-unique resolution and
  surfaces which token is the problem.
- **P2a — Per-run scratch directory for slide export.** Replaced the
  fixed `.soffice-tmp` folder (which two concurrent grad-slide
  exports used to `remove_dir_all` on each other) with a unique
  `tempfile::Builder::tempdir_in(output_dir)` per run.
- **P2b — Atomic-ish promote for slide export.** All `slide-NN.<ext>`
  files are now written into the tempdir first and only renamed into
  `output_dir` after the whole deck renders successfully. A failed
  soffice call, network blip, or process kill mid-run can no longer
  leave the owner with an empty output folder — the previous run's
  images stay intact.

## v3.18.0 — Daily kid sign-in / sign-out sheet

New one-click printable daily sign-in sheet lives on the **Monthly
Attendance** screen, next to "Print Blank Template". Pick a date and hit
**Daily sign-in sheet** — the app builds a portrait-Letter sheet with:

- The centre's logo and full letterhead (name, address, phone, and the
  SMTP sender email so what parents see on emails matches what's on the
  sign-in sheet at drop-off).
- Serif editorial header, subtle warm-neutral palette, no dashboard-navy
  slab.
- Auto-scaled table sized to fill a single page: `#`, Child, Time In ·
  Sign, Time Out · Sign, Comments. Row heights auto-scale 20–40 px so
  rosters from 15 to 40+ kids stay on one page.
- Active roster only (`activeOnly=true`), sorted first-name alphabetical.
- Footer: `☐ Playground checked: ______` remark line + `Staff on duty
  ______` signature line.

Prints straight through the existing browser-print pipeline — no new
PDF backend, no jsPDF layout math.

## v3.17.1 — Fix "Export slides as images" only writing the cover

v3.17.0 relied on LibreOffice's `impress_png_Export` `PageRange` filter
option to select which slide each `soffice --convert-to png` invocation
should render. That option turns out to be silently ignored across every
LO version — every call ended up writing slide 1 (the cover) regardless
of the requested page, so a 30-kid deck exported as 30 identical copies
of the "Class of 2026" cover. Fixed by rewriting the temp deck's
`sldIdLst` in `ppt/presentation.xml` to contain only the target slide
before each soffice call. LibreOffice always renders slide 1 of what
it's handed — with only one entry left in the list, "slide 1" IS the
requested slide. All other zip entries (masters, theme, media) pass
through byte-for-byte. Adds 4 new tests around the pptx slice logic.

## v3.17.0 — Export slides as images (PNG / JPEG)

One-click export of every rendered graduation slide as its own image
file. Adds a new `6-Slide-Images/` folder to the scaffold layout and a
new **🖼 Export slides as PNG** (or JPEG) button beside "Slides only" in
step 4. Handy for owners who want to share individual slides on the
class WhatsApp group or print handouts without cracking open PowerPoint
or Keynote.

Under the hood, we require LibreOffice on the machine (free download
from libreoffice.org, no license) so what parents receive is bit-for-bit
identical to what PowerPoint would render — including your custom
template's fonts, backgrounds, and photo placements. The app renders one
slide per invocation, so a 30-kid deck ≈ 45 seconds end-to-end. If
LibreOffice isn't installed we show a modal explaining what to install
instead of a mystery crash.

## v3.16.1 — Skip AppleDouble sidecars in template auto-detect

Fixes a Mac-only crash (`open pptx zip: invalid Zip archive: Could not
find EOCD`) when `4-Slide-Template-Optional/` contains a hidden
AppleDouble sidecar like `._template.pptx`. macOS leaves these behind
when files are copied via Finder, even after the real file is deleted
— `first_pptx_in` sorted the sidecar before the real template and
picked it as the "first pptx". Now dotfiles, AppleDouble sidecars
(`._name`), and Office lock files (`~$name`) are filtered out of every
`files_with_ext` result. The zip-open error now also names the path
it tried to open, so future issues are easier to diagnose.

## v3.16.0 — Fixed z-order on the bundled graduation template

Ships the owner-approved 2-slide certificate template as the new bundled
default. The `{{Year}}`, `{{Name}}`, and `{{Note}}` text placeholders on
the marker slide have been re-stacked so they render **on top of** the
certificate background picture. In prior versions the placeholders lived
at the bottom of the group's z-order, so PowerPoint/LibreOffice painted
the certificate PNG over them — the substituted text was present in the
output XML but visually hidden. Fresh installs (and existing users
without a custom `template.pptx`) now get names/years/notes visible on
every kid slide out of the box.

## v3.15.0 — Rounded corners on the photo tile

Reverts the v3.14.0 layout changes (slide dim / text / mask edits went
beyond what was requested) and applies **only** the one requested
change: the `{{Photo}}` picture placeholder now has rounded corners
(`prstGeom prst="roundRect"`, adj 25%). All other bundled-template
positioning, sizing, and copy is restored to v3.13.0.

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
