# Echelon Receipts

A tiny macOS desktop app for **Echelon Daycare Society** to issue, store, and reprint tuition receipts.

Built with **Tauri + React + TypeScript + SQLite**.

## Features

- **New Receipt** — pick a student, auto-fill both parents, set month/amount, save and print to PDF via macOS print dialog.
- **Receipt History** — searchable, filterable; reprint or void any past receipt. Receipt numbers are DB-unique.
- **Students** — per-year roster; import from Excel (`Student Name, Father's Name, Mother's Name, Email ID`); add/edit/inactivate manually.
- **Reports** — monthly totals, outstanding balances, CSV export.
- **Settings** — daycare name/address/email/phone, logo & signature images, default fee, next receipt #.

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
