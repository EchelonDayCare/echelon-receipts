# Echelon Receipts

A tiny macOS desktop app for **Echelon Daycare Society** to issue, store, and reprint tuition receipts.

Built with **Tauri + React + TypeScript + SQLite**.

## Features

- **New Receipt** — pick a student, auto-fill both parents, set month/amount, save and print to PDF via macOS print dialog.
- **Receipt History** — searchable, filterable; reprint or void any past receipt. Receipt numbers are DB-unique.
- **Students** — per-year roster; import from Excel (`Student Name, Father's Name, Mother's Name, Email ID`); add/edit/inactivate manually.
- **Reports** — monthly totals, outstanding balances, CSV export.
- **Settings** — daycare name/address/email/phone, logo & signature images, default fee, next receipt #.
- **Ask Echelon help** — a global side panel with contextual AI guidance, screenshot questions,
  follow-up conversation, and a searchable offline feature guide. Existing data questions,
  charts, CSV exports and saved reports remain on the Ask Echelon page.

## Help with this screen

Choose **Ask Echelon** at the bottom-left of any unlocked screen. Ask a question or switch
to **Browse help** to search instructions without an Azure connection. Suggested questions
match the current screen and fill in the question box for you to review before sending.
Guidance includes important side effects, such as what clearing an outstanding balance does.
AI suggestions cannot settle balances, edit records, send messages, or run other actions.
Navigation buttons open only screens listed in the bundled guide.

AI help uses the existing Azure AI key under **Configuration → Staff**. Enable
**Ask Echelon AI help and data questions**, add the key if needed, then **Save Settings**.
The Azure deployment must support image input for screenshot questions; a failed image
request is reported rather than silently falling back to text.

Before asking, expand **Privacy & options** beside **Helping with** to review the current screen and any
explicitly supported date/year filters. The app never captures your screen, reads form fields,
or attaches student names automatically. Questions and up to five recent exchanges go to Azure;
text you type is not automatically redacted. Aggregate data access is **off by default** and uses
fixed, read-only queries rather than model-generated SQL. Automatic snapshots are limited to
saved receipt totals on receipt/report screens and active-student counts on the roster; use the
existing Data questions page for other records. When enabled, the answer shows the
exact totals and scope under **About this answer**. Totals are not a verification of a particular
student's account, screenshot, or historical balance.

Attach or paste up to two PNG/JPEG screenshots (4 MB each). Preview, crop, or remove them
before confirming the upload. To crop, drag over the area you want to keep and choose
**Use selected area**. **Fine-tune with the keyboard** keeps precise coordinates available
without requiring them for normal use. Screenshot pixels are **not** automatically redacted. Cropped
images are re-encoded, resized to at most 1600 pixels on the longest side, and only the retained
area is sent. Images are attached to that question only; reattach an image to inspect it again.
Chat and screenshot drafts are held in memory, not saved as local chat files; Azure processing
and retention follow your service configuration. **New chat** asks before clearing the conversation
and draft images. Locking the app clears them as well. **Stop** ignores a late answer without
losing your previous conversation or current question, but cannot recall an Azure request already sent.

Answers use readable headings, lists and emphasis, with **Copy answer**, direct **Open** navigation,
and related help instructions. Model-provided links and images are never interactive.
Use the follow-up suggestions or type your own question to continue. A screenshot can be sent
without typing a question: after image consent, **Send question** asks for an explanation automatically.
Ctrl/Command+Enter sends; Enter on its own adds a new line.

### Maintaining the feature guide

`src/lib/helpGuide.json` is the single bundled source for offline help and the Rust AI prompt.
Keep instructions, limitations, button labels and concrete navigation routes aligned with code
when changing a feature. The backend reports the compiled app version alongside each answer.
The guide tests check unique topic IDs and static navigation destinations; Rust tests check
request bounds, image validation, read-only evidence, privacy defaults and response topic filtering.

## How receipts look

Identical layout to the existing paper receipt: logo + "Echelon Daycare Society" header, Receipt # / Date, Received From (Father + Mother), Description + Amount table, Comments line, Received by (signature image), contact footer, "THANK YOU!" closing.

## Install (macOS)

1. Go to the [Actions tab](https://github.com/EchelonDayCare/echelon-receipts/actions), pick the latest successful **Build macOS DMG** run.
2. Download the artifact that matches your Mac:
   - **Echelon-Receipts-AppleSilicon** for M1/M2/M3/M4 Macs
   - **Echelon-Receipts-Intel** for older Intel Macs
3. Unzip → double-click the `.dmg` → drag **Echelon Receipts** to Applications.
4. First launch: right-click → Open → Open anyway (unsigned app — one-time warning).

## Dev (only if you want to hack on it)

Requires Node 20+, Rust stable, Xcode CLT (`xcode-select --install`).

```bash
npm install
npm run tauri dev      # run in dev mode
npm run tauri build    # build a local .dmg
```

## Data location

SQLite DB lives at:
`~/Library/Application Support/org.echelondaycare.receipts/echelon.db`

Back it up to iCloud Drive periodically.

## Code signing (M-8)

`src-tauri/tauri.conf.json` currently sets `bundle.macOS.signingIdentity` to
`"-"` (ad-hoc signing) — the DMG builds today are **not** signed with a real
Apple Developer ID. This is why first launch requires the right-click →
Open → "Open anyway" workaround above, and why Gatekeeper/notarization
checks don't apply. This is intentional for now: no Apple Developer
Program membership has been purchased yet.

When a Developer ID is available, switch to real signing + notarization:

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) (paid, individual or org).
2. Create a **Developer ID Application** certificate in Xcode / the Apple
   Developer portal, and install it in the signing machine's Keychain.
3. Set `signingIdentity` in `tauri.conf.json` → `bundle.macOS` to the
   certificate's identity string (e.g. `"Developer ID Application: Echelon
   Daycare Society (TEAMID)"`), or drive it via the `APPLE_SIGNING_IDENTITY`
   env var if scripting the build.
4. For notarization, set `APPLE_ID`, `APPLE_PASSWORD` (an app-specific
   password, not the account password) and `APPLE_TEAM_ID` env vars before
   `npm run tauri build` — Tauri calls `notarytool` automatically when these
   are present. See the [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).
5. Do **not** commit the certificate, private key, or any of the above
   secrets to this repo — use CI secrets / local Keychain only.

## License

Private — internal Echelon Daycare Society tool.
