// Per-week per-staff publish tracker — owner ticks off acks manually.
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listRecentPublishes, markPublishAcknowledged, type PublishRow } from "../../repo/scheduleRepo";
import { buildWhatsappDeepLink } from "../../lib/whatsapp";
import { db } from "../../lib/db";
import ScheduleSubNav from "./ScheduleSubNav";

export default function ScheduleConfirmations() {
  const [rows, setRows] = useState<(PublishRow & { staffName: string; staffPhone: string | null })[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await listRecentPublishes(60);
      const d = await db();
      // M-5: staff_weekly_publish.wa_me_url is a point-in-time audit snapshot
      // (it's also what's recorded on the shift's audit event) — it can
      // legitimately go stale if the staff member's phone number changes
      // later. Look up the *current* phone here so "Re-send" always derives
      // a fresh link instead of trusting the possibly-outdated stored one.
      const staffRows = await d.select<{ id: number; name: string; whatsapp_phone_e164: string | null }[]>(
        "SELECT id, name, whatsapp_phone_e164 FROM staff",
      );
      const byId = new Map(staffRows.map((r) => [String(r.id), r]));
      setRows(list.map((r) => {
        const st = byId.get(r.staffId);
        return { ...r, staffName: st?.name ?? `Staff #${r.staffId}`, staffPhone: st?.whatsapp_phone_e164 ?? null };
      }));
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  };
  useEffect(() => { void refresh(); }, []);

  async function ack(id: string, version: number) {
    setBusy(true);
    try {
      await markPublishAcknowledged(id, version, "");
      await refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function unack(id: string, version: number) {
    setBusy(true);
    try {
      const d = await db();
      const now = new Date().toISOString();
      await d.execute(
        "UPDATE staff_weekly_publish SET acknowledged_at = NULL, ack_notes = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
        [now, id, version],
      );
      await refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function resend(r: PublishRow & { staffPhone: string | null }) {
    if (!r.staffPhone) { setErr("No WhatsApp phone on file for this staff member."); return; }
    try { await openUrl(buildWhatsappDeepLink(r.staffPhone, r.messageBody)); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  return (
    <div style={{ padding: 24 }}>
      <ScheduleSubNav />
      <h1 style={{ marginTop: 0 }}>Schedule confirmations</h1>
      {err && <div style={{ padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5", border: "1px solid rgba(220,38,38,.35)", marginBottom: 12 }}>{err}</div>}
      {rows.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>No published weeks yet.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              <th style={{ padding: 8 }}>Staff</th>
              <th style={{ padding: 8 }}>Week starting</th>
              <th style={{ padding: 8 }}>Published</th>
              <th style={{ padding: 8 }}>Acknowledged</th>
              <th style={{ padding: 8 }}>Notes</th>
              <th style={{ padding: 8, width: 180 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--border, #1e293b)" }}>
                <td style={{ padding: 8 }}>{r.staffName}</td>
                <td style={{ padding: 8 }}>{r.weekStartDate}</td>
                <td style={{ padding: 8 }}>{new Date(r.publishedAt).toLocaleString()}</td>
                <td style={{ padding: 8, color: r.acknowledgedAt ? "#22c55e" : "#d97706" }}>
                  {r.acknowledgedAt ? new Date(r.acknowledgedAt).toLocaleString() : "—"}
                </td>
                <td style={{ padding: 8 }}>{r.ackNotes ?? "—"}</td>
                <td style={{ padding: 8, display: "flex", gap: 6 }}>
                  <button className="btn" onClick={() => resend(r)} title="Re-open wa.me with the current phone number">Re-send</button>
                  {!r.acknowledgedAt ? (
                    <button className="btn" onClick={() => ack(r.id, r.version)} disabled={busy} title="Mark this week's schedule as confirmed">Confirm</button>
                  ) : (
                    <button className="btn secondary" onClick={() => unack(r.id, r.version)} disabled={busy} title="Undo confirmation (e.g. staff wants a change)">Undo</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
