// Attendance Analytics — centre-wide + per-child views over any date range.
// Replaces the old single-month AttendanceSummary. Backed by
// child_attendance + centre_calendar; no in/out time is required — a P
// mark counts as full attendance, H as half.
import { useEffect, useMemo, useState } from "react";
import { db, getSettings, listStudents, listYears } from "../../lib/db";
import { MARK_COLOR, MARK_LABEL, type MonthMark } from "../../lib/monthAttendance";
import { daysOpenInRange, getDefaultOpenDays, isBcHolidaysEnabled, mergeBcHolidayOverridesAsync } from "../../lib/centreCalendar";
import type { Student, SettingsMap } from "../../types";
import { printCurrentWindow } from "../../lib/print";

// ─── Types ────────────────────────────────────────────────────────────
interface StudentTotals {
  student_id: number;
  student_name: string;
  p_days: number;   // full days present
  h_days: number;   // half days
  a_days: number;   // absent
  s_days: number;   // sick
  v_days: number;   // vacation
  total_marks: number;
  attended_equiv: number; // P + 0.5*H
  attendance_rate: number; // attended_equiv / days_open, capped at 1
}

interface MonthlyBucket {
  ym: string;     // "YYYY-MM"
  p: number;
  h: number;
  a: number;
  s: number;
  v: number;
  days_open: number;
  active_children: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────
const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function firstOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }
function ymOf(dateStr: string): string { return dateStr.slice(0, 7); }
function monthsBetween(fromYm: string, toYm: string): string[] {
  const out: string[] = [];
  let [y, m] = fromYm.split("-").map((x) => parseInt(x, 10));
  const [ty, tm] = toYm.split("-").map((x) => parseInt(x, 10));
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}
// Bucket classification lives in a dedicated module so it can be unit-
// tested in isolation. See src/lib/attendanceBucket.ts + .test.ts.
import { rowToBucket } from "../../lib/attendanceBucket";

// ─── Component ────────────────────────────────────────────────────────
type ViewMode = "centre" | "child";

export default function AttendanceAnalytics() {
  const now = new Date();
  const [settings, setSettings] = useState<SettingsMap>({});
  const [years, setYears] = useState<number[]>([]);
  const [mode, setMode] = useState<ViewMode>("centre");

  // Default: last 3 months including current
  const defaultFrom = iso(firstOfMonth(new Date(now.getFullYear(), now.getMonth() - 2, 1)));
  const defaultTo = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)); // last day of current month
  const [dateFrom, setDateFrom] = useState<string>(defaultFrom);
  const [dateTo, setDateTo] = useState<string>(defaultTo);

  const [students, setStudents] = useState<Student[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<number | null>(null);

  // Aggregates
  const [studentTotals, setStudentTotals] = useState<StudentTotals[]>([]);
  const [monthlyBuckets, setMonthlyBuckets] = useState<MonthlyBucket[]>([]);
  const [childMarks, setChildMarks] = useState<{ work_date: string; mark: MonthMark }[]>([]);

  useEffect(() => {
    (async () => {
      const [s, ys] = await Promise.all([getSettings(), listYears()]);
      setSettings(s); setYears(ys);
    })();
  }, []);

  async function refresh() {
    if (!dateFrom || !dateTo || dateFrom > dateTo) return;

    // Pull all active students spanning the date range's years. We show a
    // union across years so cross-year date ranges don't lose kids.
    const yFrom = parseInt(dateFrom.slice(0, 4), 10);
    const yTo = parseInt(dateTo.slice(0, 4), 10);
    const yearSet = new Set<number>();
    for (let y = yFrom; y <= yTo; y++) yearSet.add(y);
    const perYear = await Promise.all(
      [...yearSet].map((y) => listStudents(y, false).catch(() => [] as Student[]))
    );
    const byId = new Map<number, Student>();
    perYear.flat().forEach((s) => { if (!byId.has(s.id)) byId.set(s.id, s); });
    const st = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    setStudents(st);
    if (selectedStudent === null && st.length > 0) setSelectedStudent(st[0].id);

    // Per-student aggregates for the range
    const d = await db();
    const rowsAll = await d.select<any[]>(
      `SELECT student_id, status, COALESCE(hours_decimal, 0) AS hours_decimal, work_date, attendance_mark
         FROM child_attendance
        WHERE work_date >= ? AND work_date <= ?`,
      [dateFrom, dateTo]
    );

    // Days centre open per month.
    //
    // Pre-v2.1.1 this counted `centre_calendar` rows with is_open=0 and
    // subtracted them from the calendar-day total. That was wrong because
    // weekend closures are seeded lazily by MonthlyAttendance's onMount:
    // reports run over months the user hadn't opened treated Sat/Sun as
    // open, materially under-reporting rates. Now we treat centre_calendar
    // strictly as an *override* table and derive the default open-days
    // pattern from centre_default_open_days (Mon-Fri by default). All
    // date iteration is UTC-anchored so day-of-week is stable.
    const cal = await d.select<any[]>(
      "SELECT day, is_open FROM centre_calendar WHERE day >= ? AND day <= ?",
      [dateFrom, dateTo]
    );
    const overrides = new Map<string, boolean>();
    for (const c of cal) overrides.set(String(c.day), !!c.is_open);
    const defaultOpen = await getDefaultOpenDays();
    const overridesWithHolidays = (await isBcHolidaysEnabled())
      ? await mergeBcHolidayOverridesAsync(overrides, dateFrom, dateTo)
      : overrides;

    const months = monthsBetween(ymOf(dateFrom), ymOf(dateTo));
    const buckets: MonthlyBucket[] = months.map((ym) => {
      const [y, m] = ym.split("-").map((x) => parseInt(x, 10));
      // ISO range of this month intersected with [dateFrom, dateTo].
      const monthStartIso = `${ym}-01`;
      const lastDom = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const monthEndIso = `${ym}-${String(lastDom).padStart(2, "0")}`;
      const fromIso = monthStartIso < dateFrom ? dateFrom : monthStartIso;
      const toIso = monthEndIso > dateTo ? dateTo : monthEndIso;
      const daysOpen = daysOpenInRange(fromIso, toIso, overridesWithHolidays, defaultOpen);
      return { ym, p: 0, h: 0, a: 0, s: 0, v: 0, days_open: daysOpen, active_children: 0 };
    });
    const bucketByYm = new Map(buckets.map((b) => [b.ym, b]));

    // Per-student totals
    const stTotals = new Map<number, StudentTotals>();
    for (const s of st) {
      stTotals.set(s.id, {
        student_id: s.id, student_name: s.name,
        p_days: 0, h_days: 0, a_days: 0, s_days: 0, v_days: 0,
        total_marks: 0, attended_equiv: 0, attendance_rate: 0,
      });
    }
    // Track distinct student_ids that have any mark per month
    const activeInMonth = new Map<string, Set<number>>();

    for (const r of rowsAll) {
      const rawBucket = rowToBucket(r);
      if (!rawBucket) continue;
      // v2.2.2+ P/A migration: collapse legacy H/S/V rows to A for both
      // the monthly bucket totals and per-student totals so KPI cards
      // ("Absent = a+s+v+h") and attendance_rate (p / days_open) agree.
      // Without this, legacy H marks made attendance_rate treat H as
      // half-present while KPIs counted H as full-absent → contradictory
      // percentages on the same screen.
      const bucket = rawBucket === "p" ? "p" : "a";
      const ym = String(r.work_date).slice(0, 7);
      const b = bucketByYm.get(ym);
      if (b) {
        b[bucket] = b[bucket] + 1;
        let set = activeInMonth.get(ym);
        if (!set) { set = new Set(); activeInMonth.set(ym, set); }
        set.add(r.student_id);
      }
      const t = stTotals.get(r.student_id);
      if (t) {
        if (bucket === "p") t.p_days++;
        else t.a_days++;
        t.total_marks++;
      }
    }
    // Attendance rate = P / days_open (in range). Capped at 1. H/S/V
    // legacy marks were already folded into A above so they no longer
    // contribute a half-day bonus that KPI cards contradict.
    const totalDaysOpen = buckets.reduce((n, b) => n + b.days_open, 0);
    for (const t of stTotals.values()) {
      t.attended_equiv = t.p_days;
      t.attendance_rate = totalDaysOpen > 0 ? Math.min(1, t.attended_equiv / totalDaysOpen) : 0;
    }
    // Fill active_children per month
    for (const b of buckets) {
      b.active_children = (activeInMonth.get(b.ym) || new Set()).size;
    }

    setStudentTotals([...stTotals.values()].sort((a, b) => b.attendance_rate - a.attendance_rate));
    setMonthlyBuckets(buckets);

    // Per-child calendar marks (only in child mode; harmless to always load)
    if (selectedStudent != null) {
      const marks: { work_date: string; mark: MonthMark }[] = [];
      for (const r of rowsAll) {
        if (r.student_id !== selectedStudent) continue;
        const b = rowToBucket(r);
        if (!b) continue;
        const mark: MonthMark = b === "p" ? "P" : "A";
        marks.push({ work_date: String(r.work_date), mark });
      }
      setChildMarks(marks);
    } else {
      setChildMarks([]);
    }
  }
  useEffect(() => { refresh();   }, [dateFrom, dateTo, selectedStudent]);

  // ─── Derived ─────────────────────────────────────────────────────
  const totals = useMemo(() => {
    return monthlyBuckets.reduce((acc, m) => ({
      p: acc.p + m.p, h: acc.h + m.h, a: acc.a + m.a, s: acc.s + m.s, v: acc.v + m.v,
      days_open: acc.days_open + m.days_open,
    }), { p: 0, h: 0, a: 0, s: 0, v: 0, days_open: 0 });
  }, [monthlyBuckets]);
  const activeChildren = studentTotals.filter((t) => t.total_marks > 0).length;
  const centreAttendanceRate = useMemo(() => {
    if (totals.days_open === 0 || activeChildren === 0) return 0;
    const denom = totals.days_open * activeChildren;
    const numer = totals.p + 0.5 * totals.h;
    return Math.min(1, numer / denom);
  }, [totals, activeChildren]);

  const selectedChild = useMemo(
    () => studentTotals.find((s) => s.student_id === selectedStudent) || null,
    [studentTotals, selectedStudent]
  );

  // ─── Actions ─────────────────────────────────────────────────────
  function exportCsv() {
    const lines: string[] = [];
    if (mode === "centre") {
      lines.push("Student,Present (P),Half (H),Absent (A),Sick (S),Vacation (V),Total marks,Attendance rate %");
      studentTotals.forEach((t) => {
        lines.push([t.student_name, t.p_days, t.h_days, t.a_days, t.s_days, t.v_days, t.total_marks, (t.attendance_rate * 100).toFixed(1)]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
      });
    } else if (selectedChild) {
      lines.push(`Child,${selectedChild.student_name}`);
      lines.push(`Range,${dateFrom} to ${dateTo}`);
      lines.push("");
      lines.push("Date,Mark");
      childMarks.slice().sort((a, b) => a.work_date.localeCompare(b.work_date)).forEach((m) => {
        lines.push([m.work_date, m.mark].map((v) => `"${v}"`).join(","));
      });
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance-${mode}-${dateFrom}_to_${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function printReport() { void printCurrentWindow(); }

  const daycareName = settings.daycare_name || "Echelon Daycare";
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  // ─── Trend chart data ────────────────────────────────────────────
  const chartMax = Math.max(1, ...monthlyBuckets.map((b) => b.p + b.h + b.a + b.s + b.v));
  const attendanceRateSeries = monthlyBuckets.map((b) => {
    const denom = b.days_open * Math.max(1, b.active_children);
    return denom > 0 ? Math.min(1, (b.p + 0.5 * b.h) / denom) : 0;
  });

  const rangeLabel = `${dateFrom} → ${dateTo}`;

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ marginTop: 0, marginBottom: 6 }}>Attendance Analytics</h1>
          <p style={{ color: "var(--muted)", margin: 0, maxWidth: 720 }}>
            Centre-wide and per-child attendance rates, absences and trends over any date range. Backed by the monthly attendance grid.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
          <button className="btn" onClick={printReport}>Print</button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="no-print" style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap", padding: 12, background: "#f8fafc", border: "1px solid var(--border, #e5e7eb)", borderRadius: 8 }}>
        <div style={{ display: "flex", gap: 4, padding: 3, background: "#e5e7eb", borderRadius: 8 }}>
          <button
            onClick={() => setMode("centre")}
            style={{ padding: "6px 14px", border: "none", borderRadius: 6, background: mode === "centre" ? "#fff" : "transparent", fontWeight: 600, cursor: "pointer", boxShadow: mode === "centre" ? "0 1px 3px rgba(0,0,0,0.08)" : "none" }}
          >Centre-wide</button>
          <button
            onClick={() => setMode("child")}
            style={{ padding: "6px 14px", border: "none", borderRadius: 6, background: mode === "child" ? "#fff" : "transparent", fontWeight: 600, cursor: "pointer", boxShadow: mode === "child" ? "0 1px 3px rgba(0,0,0,0.08)" : "none" }}
          >Child-wise</button>
        </div>
        <div style={{ height: 24, width: 1, background: "#d1d5db" }} />
        <label style={{ fontSize: 13, color: "var(--muted)" }}>From</label>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        <label style={{ fontSize: 13, color: "var(--muted)" }}>To</label>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        <div style={{ display: "flex", gap: 4 }}>
          <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => {
            const d = new Date();
            setDateFrom(iso(firstOfMonth(d)));
            setDateTo(iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)));
          }}>This month</button>
          <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => {
            const d = new Date();
            setDateFrom(iso(new Date(d.getFullYear(), d.getMonth() - 2, 1)));
            setDateTo(iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)));
          }}>Last 3 mo</button>
          <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => {
            const d = new Date();
            setDateFrom(`${d.getFullYear()}-01-01`);
            setDateTo(iso(d));
          }}>YTD</button>
          {years.map((y) => (
            <button key={y} className="btn secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => {
              setDateFrom(`${y}-01-01`); setDateTo(`${y}-12-31`);
            }}>{y}</button>
          ))}
        </div>
        {mode === "child" && (
          <>
            <div style={{ height: 24, width: 1, background: "#d1d5db" }} />
            <label style={{ fontSize: 13, color: "var(--muted)" }}>Child</label>
            <select value={selectedStudent ?? ""} onChange={(e) => setSelectedStudent(parseInt(e.target.value, 10) || null)}>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </>
        )}
      </div>

      <div className="report-sheet" style={{ background: "#fff", padding: 24, border: "1px solid var(--border, #e5e7eb)", borderRadius: 8 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{daycareName}</div>
          <div style={{ color: "var(--muted)" }}>
            Attendance Analytics — {mode === "centre" ? "Centre-wide" : `Child: ${selectedChild?.student_name || "—"}`}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Range: {rangeLabel} · Printed: {today}</div>
        </div>

        {mode === "centre" ? (
          <CentreView
            totals={totals} activeChildren={activeChildren}
            centreAttendanceRate={centreAttendanceRate}
            monthlyBuckets={monthlyBuckets}
            attendanceRateSeries={attendanceRateSeries}
            chartMax={chartMax}
            studentTotals={studentTotals}
          />
        ) : (
          <ChildView
            student={selectedChild}
            marks={childMarks}
            monthlyBuckets={monthlyBuckets}
            dateFrom={dateFrom} dateTo={dateTo}
            studentTotals={studentTotals}
          />
        )}
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          .report-sheet { border: none !important; padding: 0 !important; box-shadow: none !important; }
          .print-page { page-break-inside: avoid; }
          .print-page-break { page-break-before: always; }
          @page { margin: 0.5in; size: letter portrait; }
          h3 { margin-top: 12px !important; }
          table { font-size: 11px !important; }
        }
        .print-page-break { }
      `}</style>
    </div>
  );
}

// ─── Centre view ──────────────────────────────────────────────────────
function CentreView(props: {
  totals: { p: number; h: number; a: number; s: number; v: number; days_open: number };
  activeChildren: number;
  centreAttendanceRate: number;
  monthlyBuckets: MonthlyBucket[];
  attendanceRateSeries: number[];
  chartMax: number;
  studentTotals: StudentTotals[];
}) {
  const { totals, activeChildren, centreAttendanceRate, monthlyBuckets, attendanceRateSeries, studentTotals } = props;
  const totalAbs = totals.a + totals.s + totals.v;
  return (
    <>
      {/* ─── PAGE 1 · Summary ─────────────────────────────────────── */}
      <div className="print-page">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 20 }}>
          <Kpi label="Attendance rate" value={`${(centreAttendanceRate * 100).toFixed(1)}%`} accent="#166534" />
          <Kpi label="Days centre open" value={totals.days_open} />
          <Kpi label="Active children" value={activeChildren} />
          <Kpi label="Present (P)" value={totals.p} accent={MARK_COLOR.P} />
          <Kpi label="Absent (A)" value={totalAbs} accent={MARK_COLOR.A} />
        </div>

        {/* Monthly trend chart */}
        <h3 style={{ marginTop: 0 }}>Monthly attendance rate</h3>
        {monthlyBuckets.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No months in range.</p>
        ) : (
          <TrendBars months={monthlyBuckets.map((b) => b.ym)} values={attendanceRateSeries} format={(v) => `${(v * 100).toFixed(0)}%`} />
        )}
      </div>

      {/* ─── PAGE 2 · Details ─────────────────────────────────────── */}
      <div className="print-page print-page-break">
        {/* Per-month breakdown */}
        <h3 style={{ marginTop: 0 }}>Monthly breakdown</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <Th>Month</Th>
              <Th align="right">Days open</Th>
              <Th align="right">Active kids</Th>
              <Th align="right" color={MARK_COLOR.P}>P</Th>
              <Th align="right" color={MARK_COLOR.A}>A</Th>
              <Th align="right">Rate</Th>
            </tr>
          </thead>
          <tbody>
            {monthlyBuckets.map((b, i) => {
              const rate = attendanceRateSeries[i];
              return (
                <tr key={b.ym}>
                  <Td>{b.ym}</Td>
                  <Td align="right">{b.days_open}</Td>
                  <Td align="right">{b.active_children}</Td>
                  <Td align="right">{b.p + b.h}</Td>
                  <Td align="right">{b.a + b.s + b.v}</Td>
                  <Td align="right"><b>{(rate * 100).toFixed(1)}%</b></Td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Per-child leaderboard */}
        <h3 style={{ marginTop: 18 }}>Per-child summary</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <Th>Child</Th>
              <Th align="right" color={MARK_COLOR.P}>P</Th>
              <Th align="right" color={MARK_COLOR.A}>A</Th>
              <Th align="right">Rate</Th>
            </tr>
          </thead>
          <tbody>
            {studentTotals.length === 0 && (
              <tr><Td colSpan={4} center muted>No students in range.</Td></tr>
            )}
            {studentTotals.map((t) => (
              <tr key={t.student_id}>
                <Td>{t.student_name}</Td>
                <Td align="right">{t.p_days + t.h_days}</Td>
                <Td align="right">{t.a_days + t.s_days + t.v_days}</Td>
                <Td align="right"><b>{(t.attendance_rate * 100).toFixed(1)}%</b></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Child view ───────────────────────────────────────────────────────
function ChildView(props: {
  student: StudentTotals | null;
  marks: { work_date: string; mark: MonthMark }[];
  monthlyBuckets: MonthlyBucket[];
  dateFrom: string;
  dateTo: string;
  studentTotals: StudentTotals[];
}) {
  const { student, marks, monthlyBuckets, dateFrom, dateTo, studentTotals } = props;

  const marksByDate = useMemo(() => {
    const m = new Map<string, MonthMark>();
    for (const x of marks) m.set(x.work_date, x.mark);
    return m;
  }, [marks]);

  // Per-month split for this child
  const perMonth = useMemo(() => {
    return monthlyBuckets.map((b) => {
      let p = 0;
      let a = 0;
      for (const m of marks) {
        if (m.work_date.slice(0, 7) !== b.ym) continue;
        if (m.mark === "P") p++;
        else if (m.mark === "A") a++;
      }
      const denom = b.days_open;
      const rate = denom > 0 ? Math.min(1, p / denom) : 0;
      return { ym: b.ym, p, h: 0, a, s: 0, v: 0, days_open: b.days_open, rate };
    });
  }, [monthlyBuckets, marks]);

  if (!student) {
    return <p style={{ color: "var(--muted)" }}>Pick a child.</p>;
  }

  // Rank position within centre for context
  const rank = studentTotals.findIndex((t) => t.student_id === student.student_id) + 1;

  return (
    <>
      {/* ─── PAGE 1 · Child summary ────────────────────────────────── */}
      <div className="print-page">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 20 }}>
          <Kpi label="Attendance rate" value={`${(student.attendance_rate * 100).toFixed(1)}%`} accent="#166534" />
          <Kpi label="Rank (in centre)" value={rank > 0 ? `${rank} of ${studentTotals.length}` : "—"} />
          <Kpi label="Present (P)" value={student.p_days} accent={MARK_COLOR.P} />
          <Kpi label="Absent (A)" value={student.a_days + student.s_days + student.v_days + student.h_days} accent={MARK_COLOR.A} />
        </div>

        {/* Trend chart */}
        <h3 style={{ marginTop: 0 }}>Monthly attendance rate — {student.student_name}</h3>
        {perMonth.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No months in range.</p>
        ) : (
          <TrendBars months={perMonth.map((m) => m.ym)} values={perMonth.map((m) => m.rate)} format={(v) => `${(v * 100).toFixed(0)}%`} />
        )}
      </div>

      {/* ─── PAGE 2 · Details ─────────────────────────────────────── */}
      <div className="print-page print-page-break">
        {/* Calendar grid: one row per month, day columns coloured by mark */}
        <h3 style={{ marginTop: 0 }}>Day-by-day marks</h3>
        <CalendarGrid marksByDate={marksByDate} dateFrom={dateFrom} dateTo={dateTo} />

        {/* Per-month breakdown */}
        <h3 style={{ marginTop: 18 }}>Monthly breakdown</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <Th>Month</Th>
              <Th align="right">Days open</Th>
              <Th align="right" color={MARK_COLOR.P}>P</Th>
              <Th align="right" color={MARK_COLOR.A}>A</Th>
              <Th align="right">Rate</Th>
            </tr>
          </thead>
          <tbody>
            {perMonth.map((m) => (
              <tr key={m.ym}>
                <Td>{m.ym}</Td>
                <Td align="right">{m.days_open}</Td>
                <Td align="right">{m.p + m.h}</Td>
                <Td align="right">{m.a + m.s + m.v}</Td>
                <Td align="right"><b>{(m.rate * 100).toFixed(1)}%</b></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Small presentational helpers ─────────────────────────────────────
function Kpi({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div style={{ padding: 14, background: "#f9fafb", border: "1px solid var(--border, #e5e7eb)", borderRadius: 8 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: accent || "var(--fg, #111827)" }}>{value}</div>
    </div>
  );
}

function Th({ children, align, color }: { children: React.ReactNode; align?: "left"|"right"|"center"; color?: string }) {
  return <th style={{ padding: 6, border: "1px solid var(--border, #e5e7eb)", textAlign: align || "left", color, fontWeight: 600 }}>{children}</th>;
}
function Td({ children, align, colSpan, center, muted }: { children: React.ReactNode; align?: "left"|"right"|"center"; colSpan?: number; center?: boolean; muted?: boolean }) {
  return <td colSpan={colSpan} style={{ padding: 6, border: "1px solid var(--border, #e5e7eb)", textAlign: center ? "center" : (align || "left"), color: muted ? "var(--muted)" : undefined }}>{children}</td>;
}

function TrendBars({ months, values, format }: { months: string[]; values: number[]; format: (v: number) => string }) {
  const max = Math.max(0.001, ...values);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 140, borderBottom: "1px solid var(--border, #e5e7eb)", paddingBottom: 4 }}>
      {months.map((ym, i) => {
        const h = (values[i] / max) * 120;
        return (
          <div key={ym} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ fontSize: 10, color: "var(--muted)" }}>{format(values[i])}</div>
            <div title={`${ym}: ${format(values[i])}`}
                 style={{ width: "100%", maxWidth: 40, height: Math.max(2, h), background: "#3b82f6", borderRadius: "4px 4px 0 0" }} />
            <div style={{ fontSize: 10, color: "var(--muted)" }}>{MONTH_NAMES[parseInt(ym.slice(5, 7), 10)]}'{ym.slice(2, 4)}</div>
          </div>
        );
      })}
    </div>
  );
}

function CalendarGrid({ marksByDate, dateFrom, dateTo }: { marksByDate: Map<string, MonthMark>; dateFrom: string; dateTo: string }) {
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  // Group by yyyy-mm
  const months: { ym: string; year: number; month: number }[] = [];
  {
    const start = new Date(from.getFullYear(), from.getMonth(), 1);
    const end = new Date(to.getFullYear(), to.getMonth(), 1);
    for (let d = start; d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      months.push({ ym: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, year: d.getFullYear(), month: d.getMonth() + 1 });
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {months.map(({ ym, year, month }) => {
        const daysInMonth = new Date(year, month, 0).getDate();
        return (
          <div key={ym}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{MONTH_NAMES[month]} {year}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(31, 1fr)", gap: 2 }}>
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => {
                const iso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                if (iso < dateFrom || iso > dateTo) {
                  return <div key={d} style={{ height: 24 }} />;
                }
                const mark = marksByDate.get(iso);
                const color = mark ? MARK_COLOR[mark] : undefined;
                return (
                  <div key={d}
                    title={mark ? `${iso}: ${MARK_LABEL[mark]}` : iso}
                    style={{
                      height: 24, borderRadius: 3,
                      border: "1px solid #e5e7eb",
                      background: mark ? `${color}22` : "#fff",
                      color: mark ? color : "#9ca3af",
                      fontSize: 11, fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>{mark ?? d}</div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
