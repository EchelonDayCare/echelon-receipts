// Calendar occurrence model + aggregator (Slice 1 of Outlook-style calendar).
//
// Design: this file speaks "temporal" not "domain". Every visible thing on
// the calendar is an Occurrence — a point-in-time or all-day marker. We
// deliberately do NOT surface domain shapes (Meeting, StaffShift, Followup,
// UpcomingItem) to the views; they'd force per-kind rendering branches and
// make it hard to compose the aggregate.
//
// Two semantic layers per Sol's review:
//   • event: meetings + shifts (scheduled activity)
//   • closure: centre closed days
//   • deadline / reminder: renewals, drills, taxes, follow-ups (things that
//     need action). Same shape, different visual treatment.

import { listShiftsForMonth, shiftHours, type StaffShift } from "../../../repo/scheduleRepo";
import { listAllMeetings, type Meeting } from "../../../repo/meetingsRepo";
import { listOpenFollowups, type Followup } from "../../../repo/followupsRepo";
import { listUpcoming, type UpcomingItem } from "../../../repo/organizerRepo";
import { calendarForMonth } from "../../../lib/monthAttendance";
import { listStaff } from "../../../lib/staff";

export type OccSemantic = "event" | "deadline" | "reminder" | "closure";
export type OccKind =
  | "meeting" | "shift" | "followup" | "closure"
  | "credential" | "drill" | "document" | "aging"
  | "agm" | "tax" | "ccfri" | "subsidy_annual" | "action";

export type Occurrence = {
  id: string;                    // stable: `${sourceKind}:${sourceId}:${iso}`
  sourceKind: OccKind;
  sourceId: string;
  semantic: OccSemantic;
  dateISO: string;               // YYYY-MM-DD, always local (America/Vancouver)
  start?: string;                // HH:MM 24h — omitted for allDay
  end?: string;                  // HH:MM 24h — omitted for allDay
  allDay: boolean;
  title: string;
  subtitle?: string | null;
  color: string;                 // capsule / pill accent
  status?: "ok" | "warn" | "danger";
  route?: string | null;         // deep-link when clicked
};

// Palette. Small and desaturated so the calendar reads as owner-tool.
const MEETING_COLORS: Record<string, string> = {
  board: "#7c3aed", parent: "#0369a1", staff: "#9333ea",
  vendor: "#c2410c", inspection: "#dc2626", other: "#64748b",
};
const RENEWAL_COLORS: Record<string, string> = {
  credential: "#0891b2", drill: "#dc2626", document: "#6b7280",
  aging: "#b45309", agm: "#7c3aed", tax: "#4338ca",
  ccfri: "#059669", subsidy_annual: "#059669", action: "#0369a1",
};
const PRIORITY_COLORS: Record<string, string> = {
  high: "#dc2626", normal: "#2563eb", low: "#94a3b8",
};

function staffColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 42%)`;
}

function severityToStatus(sev: UpcomingItem["severity"]): "ok" | "warn" | "danger" {
  return sev === "danger" ? "danger" : sev === "warn" ? "warn" : "ok";
}

function parseHM(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;
  const h = Number(m[1]); const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

export function occurrenceSort(a: Occurrence, b: Occurrence): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const am = parseHM(a.start) ?? -1;
  const bm = parseHM(b.start) ?? -1;
  if (am !== bm) return am - bm;
  return a.title.localeCompare(b.title);
}

export type MonthOccurrenceMap = Map<string, Occurrence[]>;

export type OccurrenceFilters = {
  meetings?: boolean;
  shifts?: boolean;
  followups?: boolean;
  closures?: boolean;
  renewals?: boolean;
};

export async function loadMonthOccurrences(
  year: number,
  month: number,
  filters: OccurrenceFilters = {},
): Promise<MonthOccurrenceMap> {
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

  const todayISO = new Date().toISOString().slice(0, 10);
  const daysToMonthEnd = Math.max(
    60,
    Math.ceil((new Date(monthEnd).getTime() - new Date(todayISO).getTime()) / 86_400_000) + 7,
  );

  const [shifts, meetings, followups, upcoming, closures, staff] = await Promise.all([
    (filters.shifts ?? true) ? listShiftsForMonth(year, month).catch(() => [] as StaffShift[]) : Promise.resolve([] as StaffShift[]),
    (filters.meetings ?? true) ? listAllMeetings().catch(() => [] as Meeting[]) : Promise.resolve([] as Meeting[]),
    (filters.followups ?? true) ? listOpenFollowups().catch(() => [] as Followup[]) : Promise.resolve([] as Followup[]),
    (filters.renewals ?? true) ? listUpcoming(daysToMonthEnd).catch(() => [] as UpcomingItem[]) : Promise.resolve([] as UpcomingItem[]),
    (filters.closures ?? true) ? calendarForMonth(year, month).catch(() => []) : Promise.resolve([]),
    listStaff(false).catch(() => []),
  ]);

  const staffById = new Map<string, { name: string; role: string | null }>();
  for (const s of staff) staffById.set(String(s.id), { name: s.name, role: s.role });

  const map: MonthOccurrenceMap = new Map();
  const push = (iso: string, o: Occurrence) => {
    const arr = map.get(iso);
    if (arr) arr.push(o); else map.set(iso, [o]);
  };

  for (const s of shifts) {
    if (s.status === "cancelled") continue;
    if (s.shiftDate < monthStart || s.shiftDate > monthEnd) continue;
    const meta = staffById.get(String(s.staffId));
    const name = meta?.name ?? "Staff";
    const role = meta?.role;
    const hours = shiftHours(s);
    push(s.shiftDate, {
      id: `shift:${s.id}:${s.shiftDate}`,
      sourceKind: "shift",
      sourceId: String(s.id),
      semantic: "event",
      dateISO: s.shiftDate,
      start: s.startTime,
      end: s.endTime,
      allDay: false,
      title: name,
      subtitle: role ? `${role} · ${hours.toFixed(1)}h` : `${hours.toFixed(1)}h`,
      color: staffColor(String(s.staffId)),
      route: `/staff/schedule`,
    });
  }

  for (const m of meetings) {
    if (m.meetingDate < monthStart || m.meetingDate > monthEnd) continue;
    const timed = !!m.meetingTime;
    push(m.meetingDate, {
      id: `meeting:${m.id}:${m.meetingDate}`,
      sourceKind: "meeting",
      sourceId: m.id,
      semantic: "event",
      dateISO: m.meetingDate,
      start: timed ? m.meetingTime! : undefined,
      allDay: !timed,
      title: m.subject,
      subtitle: m.attendeesText || null,
      color: MEETING_COLORS[m.kind] ?? MEETING_COLORS.other,
      route: `/organizer`,
    });
  }

  for (const fu of followups) {
    if (!fu.dueDate) continue;
    if (fu.dueDate < monthStart || fu.dueDate > monthEnd) continue;
    push(fu.dueDate, {
      id: `followup:${fu.id}:${fu.dueDate}`,
      sourceKind: "followup",
      sourceId: fu.id,
      semantic: "reminder",
      dateISO: fu.dueDate,
      allDay: true,
      title: fu.title,
      subtitle: null,
      color: PRIORITY_COLORS[fu.priority] ?? PRIORITY_COLORS.normal,
      status: fu.priority === "high" ? "warn" : undefined,
      route: `/organizer`,
    });
  }

  for (const c of closures) {
    if (c.is_open !== false) continue;
    if (c.day < monthStart || c.day > monthEnd) continue;
    push(c.day, {
      id: `closure:${c.day}:${c.day}`,
      sourceKind: "closure",
      sourceId: c.day,
      semantic: "closure",
      dateISO: c.day,
      allDay: true,
      title: "Centre closed",
      subtitle: c.reason || null,
      color: "#6b7280",
      route: `/config/holidays`,
    });
  }

  for (const u of upcoming) {
    if (u.dueDate < monthStart || u.dueDate > monthEnd) continue;
    if (u.source === "followup") continue; // already loaded fresh above
    push(u.dueDate, {
      id: `${u.source}:${u.id}:${u.dueDate}`,
      sourceKind: u.source as OccKind,
      sourceId: u.id,
      semantic: "deadline",
      dateISO: u.dueDate,
      allDay: true,
      title: u.title,
      subtitle: u.detail,
      color: RENEWAL_COLORS[u.source] ?? "#64748b",
      status: severityToStatus(u.severity),
      route: u.link,
    });
  }

  for (const arr of map.values()) arr.sort(occurrenceSort);
  return map;
}

export function formatTime(hm?: string): string {
  if (!hm) return "";
  const m = /^(\d{1,2}):(\d{2})/.exec(hm);
  if (!m) return hm;
  const h = Number(m[1]); const mm = m[2];
  const period = h >= 12 ? "p" : "a";
  const h12 = ((h + 11) % 12) + 1;
  return mm === "00" ? `${h12}${period}` : `${h12}:${mm}${period}`;
}
