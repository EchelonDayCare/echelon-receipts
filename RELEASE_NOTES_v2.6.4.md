# Echelon Receipts v2.6.4

Bug-fix + hardening release focused on the AI scheduling parser and print
reliability across Windows/WebView2.

## AI scheduling — bigger requests, faster replacement

- **"Everyone on vacation all July"** no longer truncates mid-response.
  Bumped the AI parser output cap from 1,500 → 16,000 tokens and the
  HTTP timeout from 60s → 120s, so month-scale requests for the whole
  staff roster complete cleanly.
- **Symmetric shift ↔ vacation replacement.** When you say
  "Judy 8–11 Mon–Fri" after Judy was already marked on vacation, the AI
  now cancels the vacation cell and creates the new shift automatically
  (same as it does for vacation-over-shift). No more
  "already has a shift on this day" errors.
- **Duplicate row protection.** If the review grid ends up with two
  rows for the same staff+day (e.g. you manually edited a date to
  collide with another kept row), only the LAST edit is saved and a
  message tells you what got dropped. Previously the save loop would
  fail with a `StaleWriteError`.
- **Rollback on partial failure.** If a shift-replacement can't create
  the new row, the original shift is restored to its exact previous
  status from the audit trail (not silently downgraded to "planned").

## Print reliability

Print behavior on some Windows / WebView2 installations was silently
no-oping — the button appeared to work but nothing happened. This
release re-plumbs every Print button in the app:

- **Verified native print.** After firing the native print command,
  the helper listens for the webview's `beforeprint` event; if it
  doesn't fire within 600ms we know the OS dialog didn't actually open
  and we escalate automatically.
- **Browser-preview fallback.** When native print silently no-ops on
  Windows/WebView2, the helper opens a self-contained HTML preview in
  your default browser and auto-triggers its print dialog. Works on
  every OS.
- **Actionable failure message.** If nothing worked, you now see a
  clear alert with fallback options (Ctrl+P, Export CSV, screenshot)
  instead of a silent no-op.
- **Master recovery-code print** (Setup Wizard + Settings → Security)
  now uses a purpose-built minimal print template that shows only the
  code + a warning line, and reports failure explicitly if the dialog
  can't open — so you know to fall back to "Copy to clipboard" or
  "Email to me" rather than assuming it printed.
- **PII hygiene.** Print snapshots that get written to disk when the
  browser fallback fires are stored in the app's own local-data
  directory (in-scope on both Windows and macOS), auto-deleted 45s
  after opening, and pruned to the 5 newest on every fallback.

## Schedule — polish

- Month-view Print button now emits a compact 31-day grid instead of
  the wide horizontal layout that was hard to read on paper.
- Print rendering handles closed days and absence letters (V / S / D)
  consistently between week and month views.

## Under the hood

- The old global `window.print` monkey-patch in `main.tsx` is gone. All
  print callers now go through the centralized helper, which is safer
  and easier to reason about (and avoids a subtle full-DOM leakage
  vector introduced by the previous fallback).
- 3-round code review with two independent AI reviewers (Codex
  `gpt-5.3-codex` at high effort, plus Claude Sonnet 5 at high effort)
  before shipping. Every high-severity finding is addressed in this
  release.

## Verified

- 45 / 45 vitest suites pass
- `tsc --noEmit` clean
- `cargo check` clean (Rust 2m 24s)
- Windows MSI + macOS DMG built via CI

## Housekeeping after upgrade (Windows only)

If you're upgrading from v2.6.3 and had used Print at all on that
version, you may have plaintext HTML files left over from that
build's browser fallback in your `%TEMP%\echelon-print-*.html`.
Delete them at your convenience:

```powershell
Get-ChildItem $env:TEMP -Filter "echelon-print-*.html" | Remove-Item
```

v2.6.4 no longer writes to raw `%TEMP%` — it uses your app data
directory and auto-cleans up after 45 seconds.
