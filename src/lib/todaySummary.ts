// Today aggregator — pulls date-keyed items from the four scattered
// domain repos and shapes them into the three owner-oriented buckets
// the Today drawer expects. Sol's review pushed us away from
// repo-shaped sections; this file is what makes that possible.
//
// v2.6.7: introduced for the Today drawer feature.

import { listShiftsForMonth, type StaffShift, shiftHours } from "../repo/scheduleRepo";
import { listAllMeetings, type Meeting } from "../repo/meetingsRepo";
import { listUpcoming, type UpcomingItem } from "../repo/organizerRepo";
import { calendarForMonth } from "./monthAttendance";
import { monthGrid, type MonthMark } from "./monthAttendance";
import { listStaff } from "./staff";

export type TodayCentre =
  | { isOpen: true }
  | { isOpen: false; reason: string | null };

export type TodayScheduleItem =
  | { kind: "shift"; time: string; endTime: string | null; staffName: string; role: string | null; status: string; hours: number }
  | { kind: "meeting"; time: string | null; title: string; kindLabel: string; attendees: string | null; id: string };

export type TodayAttentionItem = {
  kind: "overdue" | "due-today";
  title: string;
  detail: string | null;
  route: string | null;
  severity: "danger" | "warn" | "info";
  source: string; // "credential" | "drill" | "aging" | ...
  daysAway: number;
};

export type TodayAttendanceSnapshot = {
  totalStudents: number;
  markedP: number;
  markedA: number;
  unmarked: number;
  monthRoute: string;
  monthLabel: string; // e.g. "June 2026" — the month the snapshot describes
  targetIsPriorMonth: boolean; // true when snapshot is for a completed month (not the viewed month)
  fullyUnloaded: boolean; // true when zero cells are marked in the target month
};

export type TodaySummary = {
  iso: string;
  isToday: boolean;
  centre: TodayCentre;
  attention: TodayAttentionItem[];
  schedule: TodayScheduleItem[];
  attendance: TodayAttendanceSnapshot | null;
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseIsoYm(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y, month: m, day: d };
}

function prevMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function meetingKindLabel(k: Meeting["kind"]): string {
  switch (k) {
    case "board": return "Board";
    case "parent": return "Parent";
    case "staff": return "Staff";
    case "vendor": return "Vendor";
    case "inspection": return "Inspection";
    default: return "Meeting";
  }
}

// Compare HH:MM strings (or null → sort last).
function timeCompare(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export async function loadTodaySummary(iso: string): Promise<TodaySummary> {
  const { year, month } = parseIsoYm(iso);
  const isToday = iso === todayISO();

  // Fetch in parallel. All four repos already exist; we don't add schema.
  const [shifts, staff, meetings, upcoming, calendar, marks] = await Promise.all([
    listShiftsForMonth(year, month).catch(() => [] as StaffShift[]),
    listStaff(false).catch(() => []),
    listAllMeetings().catch(() => [] as Meeting[]),
    // 60-day horizon so we catch overdue (negative) + due-soon items.
    listUpcoming(60).catch(() => [] as UpcomingItem[]),
    calendarForMonth(year, month).catch(() => []),
    monthGrid(year, month).catch(() => []),
  ]);

  // Build staff-name map. StaffShift.staffId is the string form of Staff.id.
  const staffById = new Map<string, { name: string; role: string | null }>();
  for (const s of staff) staffById.set(String(s.id), { name: s.name, role: s.role });

  // Centre status.
  const dayEntry = calendar.find((c) => c.day === iso);
  const centre: TodayCentre = dayEntry && !dayEntry.is_open
    ? { isOpen: false, reason: dayEntry.reason || null }
    : { isOpen: true };

  // Needs attention: overdue (daysAway<0) plus due-today (daysAway===0).
  // We only surface items with a real due date in this window; Organizer
  // is the deeper view for anything further out.
  const attention: TodayAttentionItem[] = upcoming
    .filter((u) => u.daysAway <= 0)
    .map<TodayAttentionItem>((u) => ({
      kind: u.daysAway < 0 ? "overdue" : "due-today",
      title: u.title,
      detail: u.detail,
      route: u.link,
      severity: u.severity,
      source: u.source,
      daysAway: u.daysAway,
    }))
    // Overdue first (most negative first), then due-today.
    .sort((a, b) => a.daysAway - b.daysAway);

  // Today's schedule: shifts + meetings for this date, merged chronologically.
  // Cancelled shifts are dropped — the owner doesn't care about them today.
  const dayShifts = shifts.filter((s) => s.shiftDate === iso && s.status !== "cancelled");
  const dayMeetings = meetings.filter((m) => m.meetingDate === iso);

  const scheduleItems: TodayScheduleItem[] = [
    ...dayShifts.map<TodayScheduleItem>((s) => {
      const meta = staffById.get(s.staffId);
      return {
        kind: "shift" as const,
        time: s.startTime,
        endTime: s.endTime,
        staffName: meta?.name ?? "Staff",
        role: meta?.role ?? null,
        status: s.status,
        hours: shiftHours(s),
      };
    }),
    ...dayMeetings.map<TodayScheduleItem>((m) => ({
      kind: "meeting" as const,
      time: m.meetingTime,
      title: m.subject,
      kindLabel: meetingKindLabel(m.kind),
      attendees: m.attendeesText,
      id: m.id,
    })),
  ].sort((a, b) => timeCompare(a.time ?? null, b.time ?? null));

  // Attendance snapshot — describes a full completed month.
  // Rationale: attendance is marked once at month-end via OCR of the sign-in
  // sheet, so a nudge only makes sense for a month that has already ended.
  //
  // Target month:
  //   - Viewed month is prior calendar month or older → target = viewed month.
  //   - Viewed month is current or future → target = previous calendar month.
  //
  // "unmarked" counts (active student × open day) cells in the target month
  // that have no P/A mark. "fullyUnloaded" is true when nothing at all is
  // marked — signalling the OCR import for that month hasn't run yet.
  let attendance: TodayAttendanceSnapshot | null = null;
  const today = todayISO();
  const todayYm = parseIsoYm(today);
  const viewedYm = parseIsoYm(iso);
  const viewedIsPrior =
    viewedYm.year < todayYm.year ||
    (viewedYm.year === todayYm.year && viewedYm.month < todayYm.month);

  const targetYm = viewedIsPrior
    ? { year: viewedYm.year, month: viewedYm.month }
    : prevMonth(todayYm.year, todayYm.month);

  // Reuse the already-fetched grid/calendar when target matches viewed month.
  const [targetMarks, targetCalendar] =
    targetYm.year === year && targetYm.month === month
      ? [marks, calendar]
      : await Promise.all([
          monthGrid(targetYm.year, targetYm.month).catch(() => []),
          calendarForMonth(targetYm.year, targetYm.month).catch(() => []),
        ]);

  // Which day-of-month keys count as "open days" in the target month.
  const daysInTarget = new Date(targetYm.year, targetYm.month, 0).getDate();
  const closedDays = new Set<string>();
  for (const c of targetCalendar) {
    if (c.is_open === false) {
      const dayNum = Number(c.day.split("-")[2]);
      if (Number.isFinite(dayNum)) closedDays.add(String(dayNum));
    }
  }
  const openDayKeys: string[] = [];
  for (let d = 1; d <= daysInTarget; d++) {
    const key = String(d);
    if (!closedDays.has(key)) openDayKeys.push(key);
  }

  let markedP = 0, markedA = 0, unmarked = 0;
  let rosterCount = 0;
  for (const cell of targetMarks) {
    if (!cell.active) continue;
    rosterCount += 1;
    for (const key of openDayKeys) {
      const m: MonthMark | undefined = cell.marks[key];
      if (m === "P") markedP += 1;
      else if (m === "A") markedA += 1;
      else unmarked += 1;
    }
  }

  if (rosterCount > 0 && openDayKeys.length > 0) {
    const fullyUnloaded = markedP === 0 && markedA === 0;
    attendance = {
      totalStudents: rosterCount,
      markedP,
      markedA,
      unmarked,
      monthRoute: `/students/attendance?year=${targetYm.year}&month=${targetYm.month}`,
      monthLabel: monthLabel(targetYm.year, targetYm.month),
      targetIsPriorMonth: !(targetYm.year === viewedYm.year && targetYm.month === viewedYm.month),
      fullyUnloaded,
    };
    // Only surface when there's actually something to nudge about.
    if (unmarked === 0) attendance = null;
  }

  return { iso, isToday, centre, attention, schedule: scheduleItems, attendance };
}

// Small helper the Home card calls to show a badge count. Cheap: reuses
// the same summary the drawer will fetch.
export function attentionSeverity(items: TodayAttentionItem[]): "clear" | "info" | "warn" | "danger" {
  if (items.length === 0) return "clear";
  if (items.some((i) => i.severity === "danger")) return "danger";
  if (items.some((i) => i.severity === "warn")) return "warn";
  return "info";
}
