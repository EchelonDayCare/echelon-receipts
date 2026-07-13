// Emailing the AppLock recovery code as a "worst case" recovery path.
//
// The recovery code IS the master out-of-band credential — anyone holding
// it can decrypt echelon.db on any machine (no device_secret required).
// Traditional advice is "print it and lock it away", but Luxmi asked for a
// path that survives losing both the PIN and the printed slip. Email fits
// that: it's on her phone, her laptop, and iCloud, all protected by her
// email account password (typically with 2FA).
//
// Trade-off (documented in the UI too):
//   Threat gained: anyone who compromises her email inbox can now decrypt
//   the DB. This is acceptable because (a) email accounts are usually
//   better protected than a piece of paper in a drawer, and (b) the same
//   is true of any consumer recovery-key email pattern (1Password, etc).
//
// Threat model unchanged in the DB itself: the recovery code is still an
// Argon2id-wrapped MDK slot in security.json; email is only a delivery
// medium for that code.

import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "./db";
import { deliverabilityExtras } from "./email";

export type EmailRecoveryResult =
  | { ok: true; recipient: string }
  | { ok: false; error: string };

export async function emailRecoveryCode(code: string): Promise<EmailRecoveryResult> {
  const s = await getSettings();
  const recipient = (
    s.backup_recipient_email?.trim() ||
    s.sender_email?.trim() ||
    s.contact_email?.trim() ||
    ""
  );
  if (!recipient) return { ok: false, error: "No recipient email configured. Set one in Settings → Receipts & Email." };
  const host = (s.smtp_host || "").trim();
  const port = parseInt(s.smtp_port || "587", 10);
  if (!host || !port) return { ok: false, error: "SMTP host/port not configured." };
  if (s.smtp_password_set !== "1") return { ok: false, error: "SMTP password not set." };

  const sender = (s.sender_email || s.contact_email || "").trim();
  const daycare = s.daycare_name || "Echelon Daycare";
  const stamp = new Date().toISOString().slice(0, 10);

  const body =
`This email contains the recovery code for your Echelon Receipts app.
Keep it. Anyone with this code can decrypt your daycare database on any
machine — treat this email like a spare house key.

Recovery code (${stamp}):

    ${code}

How to use it:
  1. Open Echelon Receipts on any machine (fresh install is fine).
  2. On the PIN screen, click "Forgot PIN? Use recovery code".
  3. Paste the code above and unlock.
  4. Immediately set a fresh PIN in Settings → Security.

Security notes:
  • This code was auto-mailed to you as a safety net in case you lose
    both your PIN and the printed recovery slip.
  • Generating a new recovery code from Settings invalidates every
    previous one, including this email — old copies stop working.
  • Delete this email if you re-generate the code and don't want an
    old copy lingering in your inbox.
`;

  try {
    await invoke("send_email", {
      args: {
        smtp_host: host,
        smtp_port: port,
        smtp_user: (s.smtp_user || sender).trim(),
        from_name: s.sender_name || daycare,
        from_email: sender,
        to: [recipient],
        cc: [],
        bcc: [],
        subject: `[Echelon Recovery Code] ${daycare} — ${stamp}`,
        body_text: body,
        attachments: [],
        ...deliverabilityExtras(s, sender),
      },
    });
    return { ok: true, recipient };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
