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

  it("shiftHours computes worked hours minus break minutes", () => {
    expect(shiftHours({ startTime: "09:00", endTime: "17:00", breakMinutes: 30 })).toBeCloseTo(7.5, 5);
    expect(shiftHours({ startTime: "08:00", endTime: "12:00", breakMinutes: 0 })).toBe(4);
  });

  it("shiftHours never returns negative hours for a malformed/backwards range", () => {
    expect(shiftHours({ startTime: "17:00", endTime: "09:00", breakMinutes: 0 })).toBe(0);
  });
});
