# Communications Module — Roadmap & Feature Gaps

The Communications module ships with everything the app can do on its own:

- **Compose Group Email** — personalized bulk email to any subset of parents
- **Templates** — reusable subject + body with merge tokens
- **Message History** — audit log of every email sent (group + receipts + annual + scheduled)
- **Contact Directory** — read-only parent contact list with copy-email / CSV export
- **Scheduled Messages** — send at a future date/time (fires on next app launch after due time)

This document lists features that were considered but **not implemented** because they need external accounts, credentials, funding, or install-time setup that only Luxmi can provide. If any of these become important, we can build them on request.

---

## 1. SMS / Text broadcasts

**Blocker:** Requires a paid SMS provider account (Twilio recommended in Canada).

**What Luxmi needs to do first:**
1. Sign up at https://www.twilio.com and verify the business.
2. Buy a Canadian phone number (~CAD $1.15/mo) that can send SMS to Canadian numbers.
3. Fund the account (SMS to Canada is roughly CAD $0.01–$0.03 per message).
4. Generate an **Account SID** and **Auth Token** in the Twilio console.
5. Provide those three values (SID, Token, phone number) to be stored in the app's keychain.

**What we'll build once we have credentials:**
- New `phone` field on the students table (already have `email`).
- SMS toggle on Compose alongside Email; separate `sms_body` (160 chars ideal).
- New `send_sms` Tauri command wrapping the Twilio REST API.
- SMS entries in Message History.
- Per-parent opt-out list (CRTC/CASL compliance — CASL applies to SMS too).

**Estimated build effort:** 1–2 days once credentials are in hand.

---

## 2. WhatsApp broadcasts

**Blocker:** Requires Meta Business API — much heavier than Twilio.

**What Luxmi needs to do first:**
1. Verify the daycare as a business at https://business.facebook.com (needs a phone number Meta can call, plus business registration documents).
2. Apply for WhatsApp Business API access via a Business Solution Provider (Twilio, 360dialog, Meta Cloud API direct).
3. Register a phone number that will only be used for WhatsApp (can't overlap with a regular WhatsApp app number).
4. **Submit each message template for Meta approval** — free-form messages are only allowed within 24 hours of the parent messaging you first. All proactive messages (closure notices, reminders) must use pre-approved templates.
5. Provide the access token and phone-number ID.

**Recommendation:** Not worth the effort for <100 parents. SMS covers the same "reach parents fast" need with far less setup. Revisit only if parents strongly prefer WhatsApp and won't respond to SMS.

**Estimated build effort:** 3–5 days plus 1–3 weeks of Meta approval time.

---

## 3. True background scheduling (send while app is closed)

**Blocker:** Requires registering the app as an OS-level scheduled task.

**Current behaviour:** Scheduled messages fire on the next app launch after their scheduled time. If Luxmi opens the app every weekday morning, weekly Friday reminders will always go out on time. Multi-day gaps could delay a scheduled send by however many days the app stays closed.

**What Luxmi needs to decide:**
- If "sends when I open the app" is fine → do nothing, works today.
- If "must send exactly on time even when Mac is asleep" is required → we'll add a one-time install step that registers a LaunchAgent (macOS) or Scheduled Task (Windows). This wakes the app briefly at the scheduled time, runs the sends, then exits.

**Trade-off:** Background scheduling means the app can send emails without Luxmi being at the computer. That's a change in trust posture — right now every send is user-confirmed. If Luxmi is comfortable with that, we can add it. Otherwise the current on-launch model is safer.

**Estimated build effort:** 1 day per platform.

---

## 4. Two-way inbox (IMAP)

**Blocker:** Would need constantly-running IMAP polling, credential storage, folder sync, thread/reply UI — essentially a mini email client.

**Recommendation:** **Don't build.** Luxmi already uses Gmail (or similar) which handles two-way conversations perfectly, with mobile apps, search, spam filtering, and 20 years of engineering polish. Rebuilding even 10% of that inside this app would take weeks and be worse than what Gmail already provides.

**What we *could* do instead if inbox visibility inside the app matters:**
- Add a **"Reply-to"** setting so parent replies go to a shared address (e.g., info@echelondaycare.com) that Luxmi and staff both monitor.
- Show a **link to Gmail** on each Message History entry (`https://mail.google.com/mail/u/0/#search/subject%3A"..."`).

---

## 5. Read receipts / open tracking

**Blocker:** Requires embedding a tracking pixel in outgoing emails and running a public URL that logs pixel loads.

**Recommendation:** **Do not build.** Reasons:
- Modern email clients (Apple Mail, Gmail, Outlook) block or pre-fetch tracking pixels, so the data is unreliable.
- Parents can perceive tracking as invasive — a daycare relationship depends on trust.
- Canadian privacy law (PIPEDA) generally requires disclosing this kind of tracking.
- CASL requires unsubscribe / consent for commercial electronic messages; adding covert tracking risks non-compliance.

**Better alternatives:**
- If Luxmi wants to know "did the parent see this?", add a **"Please reply to confirm"** line at the bottom of important emails.
- For fee reminders, follow-up manually after 3 days if no payment received.

---

## 6. Parent portal / self-service

**Blocker:** Would require hosting a web app, auth, and a permanent public URL. Currently this app is a purely local desktop tool.

**Recommendation:** Not in scope for the desktop-only app. If Luxmi ever wants a portal, it should be a separate web project.

---

## Summary of what's live today

| Feature | Status |
|---|---|
| Compose Group Email (personalized) | ✅ built |
| Templates (with 6 built-in starters) | ✅ built |
| Message History (all outgoing email) | ✅ built |
| Contact Directory | ✅ built |
| Scheduled Messages (fires on next app launch after due) | ✅ built |
| SMS / Text broadcasts | ❌ needs Twilio account |
| WhatsApp broadcasts | ❌ needs Meta Business + template approval |
| True background scheduling | ❌ needs OS-level install step |
| Two-way inbox | ❌ not recommended (use Gmail) |
| Read receipts | ❌ not recommended (privacy) |

If any of the ❌ items become priority, ask and we'll build them.
