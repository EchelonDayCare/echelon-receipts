// Organizer repo — computed "Upcoming" list. Reads from many existing
// tables (staff_credentials, staff_drills, documents, receipts A/R) plus
// the current fiscal-year setting for the annual AGM/tax deadlines.
// Nothing here writes; write paths live in meetingsRepo / followupsRepo /
// documentsRepo / scheduleRepo. This is a pure aggregation view.
import { db, getSettings } from "../lib/db";
import { listOpenActionsGlobal } from "./meetingsRepo";
import { listOpenFollowups } from "./followupsRepo";

export type UpcomingSource =
  | "credential" | "drill" | "document" | "aging"
  | "agm" | "tax" | "ccfri" | "subsidy_annual"
  | "action" | "followup";

export type UpcomingItem = {
  id: string;                 // stable-ish key for React
  source: UpcomingSource;
  title: string;
  detail: string | null;
  dueDate: string;            // YYYY-MM-DD
  daysAway: number;           // negative if overdue
  link: string | null;        // in-app route
  severity: "danger" | "warn" | "info";
};

const DAY_MS = 86_400_000;
function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function daysBetween(iso: string, from = todayISO()): number {
  const [ay, am, ad] = from.split("-").map(Number);
  const [by, bm, bd] = iso.split("-").map(Number);
  const a = new Date(ay, am - 1, ad).getTime();
  const b = new Date(by, bm - 1, bd).getTime();
  return Math.round((b - a) / DAY_MS);
}

function severity(days: number, dangerThreshold = 7, warnThreshold = 30): UpcomingItem["severity"] {
  if (days < 0 || days <= dangerThreshold) return "danger";
  if (days <= warnThreshold) return "warn";
  return "info";
}

export async function listUpcoming(windowDays: number): Promise<UpcomingItem[]> {
  const items: UpcomingItem[] = [];
  const d = await db();
  const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() + windowDays);
  const cutoffISO = cutoffDate.toISOString().slice(0, 10);

  // ── Staff credential expiries ────────────────────────────────────────
  try {
    const creds = await d.select<{ id: number; staff_id: number; type: string; expiry_date: string | null; name: string | null }[]>(
      `SELECT c.id, c.staff_id, c.type, c.expiry_date, s.name
         FROM staff_credentials c
         LEFT JOIN staff s ON s.id = c.staff_id
        WHERE c.expiry_date IS NOT NULL AND c.expiry_date <= ?`,
      [cutoffISO],
    );
    for (const c of creds) {
      const days = daysBetween(c.expiry_date!);
      items.push({
        id: `cred-${c.id}`, source: "credential",
        title: `${c.type} — ${c.name ?? "Staff"}`,
        detail: days < 0 ? `Expired ${-days}d ago` : `Expires in ${days}d`,
        dueDate: c.expiry_date!, daysAway: days, link: "/staff/credentials",
        severity: severity(days),
      });
    }
  } catch { /* table may not exist on very old DBs */ }

  // ── Drills — cadence from settings ───────────────────────────────────
  try {
    const settings = await getSettings();
    const cadence: Array<[string, string]> = [
      ["Fire", "drill_cadence_fire_days"],
      ["Earthquake", "drill_cadence_earthquake_days"],
      ["Lockdown", "drill_cadence_lockdown_days"],
      ["Evacuation", "drill_cadence_evacuation_days"],
    ];
    const lastRows = await d.select<{ drill_type: string; last_date: string }[]>(
      "SELECT drill_type, MAX(drill_date) AS last_date FROM staff_drills GROUP BY drill_type",
    );
    const lastByType = new Map(lastRows.map((r) => [r.drill_type.toLowerCase(), r.last_date]));
    for (const [label, key] of cadence) {
      const cadenceDays = Number(settings[key] ?? "0");
      if (!cadenceDays) continue;
      const last = lastByType.get(label.toLowerCase());
      const nextIso = last
        ? new Date(new Date(last).getTime() + cadenceDays * DAY_MS).toISOString().slice(0, 10)
        : todayISO();
      const days = daysBetween(nextIso);
      if (days > windowDays) continue;
      items.push({
        id: `drill-${label}`, source: "drill",
        title: `${label} drill due`,
        detail: last ? `Last: ${last} · every ${cadenceDays}d` : "No drill on record yet",
        dueDate: nextIso, daysAway: days, link: "/reports/drills",
        severity: severity(days, 0, 14),
      });
    }
  } catch { /* leave */ }

  // ── Document expiries ────────────────────────────────────────────────
  try {
    const docs = await d.select<{ id: string; title: string; expiry_date: string | null }[]>(
      `SELECT id, title, expiry_date FROM documents
        WHERE deleted_at IS NULL AND expiry_date IS NOT NULL AND expiry_date <= ?`,
      [cutoffISO],
    );
    for (const doc of docs) {
      const days = daysBetween(doc.expiry_date!);
      items.push({
        id: `doc-${doc.id}`, source: "document",
        title: doc.title,
        detail: days < 0 ? `Expired ${-days}d ago` : `Expires in ${days}d`,
        dueDate: doc.expiry_date!, daysAway: days, link: "/vault",
        severity: severity(days),
      });
    }
  } catch { /* v1.1.0 not yet applied */ }

  // ── Aging A/R: count of families with balance > $250 for 60+ days ────
  try {
    // Look for outstanding invoices/receipts. Falls back gracefully if the
    // table name isn't present. We just surface a single roll-up entry.
    const rows = await d.select<{ n: number; total: number }[]>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(balance), 0) AS total
         FROM (
           SELECT student_id,
                  COALESCE(SUM(pending_amount), 0) AS balance
             FROM receipts
            WHERE COALESCE(voided, 0) = 0
              AND date <= date('now', '-60 days')
            GROUP BY student_id
         ) t
         WHERE balance > 250`,
    );
    if (rows[0] && rows[0].n > 0) {
      items.push({
        id: "aging-rollup", source: "aging",
        title: `${rows[0].n} famil${rows[0].n === 1 ? "y" : "ies"} with outstanding balance`,
        detail: `Total owed: $${Number(rows[0].total).toFixed(2)}`,
        dueDate: todayISO(), daysAway: 0, link: "/reports/aging",
        severity: "warn",
      });
    }
  } catch { /* schema may vary */ }

  // ── AGM statutory deadline: fiscal-year-end + 6 months ────────────────
  try {
    const settings = await getSettings();
    const fyEndMonth = Number(settings.fiscal_year_end_month ?? settings.fiscal_year_end ?? "0");
    if (fyEndMonth >= 1 && fyEndMonth <= 12) {
      const now = new Date();
      // Fiscal year end this cycle: last day of fyEndMonth in current or prior year.
      const endThisCycle = new Date(now.getFullYear(), fyEndMonth, 0); // day 0 of next month = last of month
      const fyEnd = endThisCycle < now ? endThisCycle : new Date(now.getFullYear() - 1, fyEndMonth, 0);
      const agmDeadline = new Date(fyEnd); agmDeadline.setMonth(agmDeadline.getMonth() + 6);
      const iso = agmDeadline.toISOString().slice(0, 10);
      const days = daysBetween(iso);
      if (days <= windowDays) {
        items.push({
          id: "agm-annual", source: "agm",
          title: "AGM statutory deadline",
          detail: `Fiscal year end ${fyEnd.toISOString().slice(0, 10)} + 6 mo`,
          dueDate: iso, daysAway: days, link: "/reports/agm",
          severity: severity(days, 14, 60),
        });
      }
    }
  } catch { /* no fiscal setting */ }

  // ── T-slips (T4 / T4A) — Feb 28 annually ─────────────────────────────
  {
    const now = new Date();
    const y = now.getMonth() >= 2 ? now.getFullYear() + 1 : now.getFullYear();
    const iso = `${y}-02-28`;
    const days = daysBetween(iso);
    if (days <= windowDays) {
      items.push({
        id: `tslips-${y}`, source: "tax",
        title: "T-slips (T4 / T4A) — CRA deadline",
        detail: "File and distribute to staff by Feb 28",
        dueDate: iso, daysAway: days, link: "/reports/agm",
        severity: severity(days, 14, 60),
      });
    }
  }

  // ── CCFRI monthly attestation (only when subsidies enabled) ──────────
  try {
    const settings = await getSettings();
    if ((settings.subsidies_enabled ?? "0") === "1") {
      const now = new Date();
      // 15th of next month.
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 15);
      const iso = next.toISOString().slice(0, 10);
      const days = daysBetween(iso);
      if (days <= windowDays) {
        items.push({
          id: `ccfri-${iso}`, source: "ccfri",
          title: "CCFRI monthly attestation",
          detail: "Submit prior month's parent-fee-reduction data",
          dueDate: iso, daysAway: days, link: "/reports/subsidy",
          severity: severity(days, 5, 20),
        });
      }
    }
  } catch { /* leave */ }

  // ── Meeting action items (open) ──────────────────────────────────────
  const actions = await listOpenActionsGlobal(50);
  for (const a of actions) {
    if (!a.dueDate) continue;
    const days = daysBetween(a.dueDate);
    if (days > windowDays) continue;
    items.push({
      id: `action-${a.id}`, source: "action",
      title: a.description,
      detail: a.ownerText ? `Owner: ${a.ownerText}` : null,
      dueDate: a.dueDate, daysAway: days, link: "/organizer",
      severity: severity(days),
    });
  }

  // ── Open follow-ups ──────────────────────────────────────────────────
  const followups = await listOpenFollowups();
  for (const f of followups) {
    if (!f.dueDate) continue;
    const days = daysBetween(f.dueDate);
    if (days > windowDays) continue;
    items.push({
      id: `followup-${f.id}`, source: "followup",
      title: f.title,
      detail: f.notes,
      dueDate: f.dueDate, daysAway: days, link: "/organizer",
      severity: severity(days),
    });
  }

  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return items;
}

export async function countDueToday(): Promise<number> {
  const items = await listUpcoming(60);
  return items.filter((i) => i.daysAway <= 0).length;
}
export async function countDueThisWeek(): Promise<number> {
  const items = await listUpcoming(60);
  return items.filter((i) => i.daysAway <= 7 && i.daysAway >= 0).length;
}
