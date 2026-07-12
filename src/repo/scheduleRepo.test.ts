import { describe, it, expect } from "vitest";
import { mondayOf, addDays, shiftHours } from "./scheduleRepo";

describe("scheduleRepo date helpers", () => {
  it("mondayOf returns the Monday of the containing ISO week", () => {
    // 2026-07-06 is a Monday.
    expect(mondayOf(new Date(2026, 6, 6))).toBe("2026-07-06");
    // 2026-07-08 is a Wednesday in the same week.
    expect(mondayOf(new Date(2026, 6, 8))).toBe("2026-07-06");
    // 2026-07-12 is the Sunday closing that week.
    expect(mondayOf(new Date(2026, 6, 12))).toBe("2026-07-06");
    // 2026-07-13 is the next Monday.
    expect(mondayOf(new Date(2026, 6, 13))).toBe("2026-07-13");
  });

  it("addDays adds/subtracts calendar days across month boundaries", () => {
    expect(addDays("2026-07-30", 3)).toBe("2026-08-02");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-07-06", 0)).toBe("2026-07-06");
  });

  it("shiftHours computes worked hours minus explicit break minutes", () => {
    expect(shiftHours({ startTime: "09:00", endTime: "17:00", breakMinutes: 30 })).toBeCloseTo(7.5, 5);
    // 4-hour shift with no break — under the 5h auto-deduct threshold.
    expect(shiftHours({ startTime: "08:00", endTime: "12:00", breakMinutes: 0 })).toBe(4);
  });

  it("shiftHours auto-deducts 30 min unpaid lunch when raw shift ≥ 5h and break is 0", () => {
    // v2.6.3: matches Hours-tab paidHours rule so the Schedule Total column
    // reads the same number payroll sees.
    // 08:00–14:00 = 6h raw → deduct 30 min → 5.5h.
    expect(shiftHours({ startTime: "08:00", endTime: "14:00", breakMinutes: 0 })).toBeCloseTo(5.5, 5);
    // 08:00–16:00 = 8h raw → deduct 30 min → 7.5h.
    expect(shiftHours({ startTime: "08:00", endTime: "16:00", breakMinutes: 0 })).toBeCloseTo(7.5, 5);
    // Exactly 5h shift: still triggers the deduction (matches paidHours).
    expect(shiftHours({ startTime: "08:00", endTime: "13:00", breakMinutes: 0 })).toBeCloseTo(4.5, 5);
    // 4h59 shift: no deduction (below threshold).
    expect(shiftHours({ startTime: "08:00", endTime: "12:59", breakMinutes: 0 })).toBeCloseTo(4 + 59 / 60, 5);
  });

  it("shiftHours prefers explicit breakMinutes over the auto rule", () => {
    // Explicit 45-min break on a 6h shift → 5.25h (auto rule would give 5.5h).
    expect(shiftHours({ startTime: "08:00", endTime: "14:00", breakMinutes: 45 })).toBeCloseTo(5.25, 5);
    // Explicit 15-min break on an 8h shift → 7.75h (not the auto 7.5h).
    expect(shiftHours({ startTime: "08:00", endTime: "16:00", breakMinutes: 15 })).toBeCloseTo(7.75, 5);
  });

  it("shiftHours never returns negative hours for a malformed/backwards range", () => {
    expect(shiftHours({ startTime: "17:00", endTime: "09:00", breakMinutes: 0 })).toBe(0);
  });
});
