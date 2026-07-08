import { describe, it, expect } from "vitest";
import { isOpenDay, eachDay, daysOpenInRange } from "./centreCalendar";

describe("isOpenDay", () => {
  it("honours the default M-F bitmap for unspecified dates", () => {
    const m = new Map<string, boolean>();
    // 2026-07-06 is a Monday, 2026-07-11 is a Saturday, 2026-07-12 is Sunday.
    expect(isOpenDay("2026-07-06", m, "0111110")).toBe(true);
    expect(isOpenDay("2026-07-10", m, "0111110")).toBe(true); // Fri
    expect(isOpenDay("2026-07-11", m, "0111110")).toBe(false); // Sat
    expect(isOpenDay("2026-07-12", m, "0111110")).toBe(false); // Sun
  });

  it("respects explicit overrides in both directions", () => {
    const m = new Map<string, boolean>([
      ["2026-07-11", true],  // Sat open (special session)
      ["2026-07-13", false], // Mon closed (statutory holiday)
    ]);
    expect(isOpenDay("2026-07-11", m, "0111110")).toBe(true);
    expect(isOpenDay("2026-07-13", m, "0111110")).toBe(false);
  });

  it("supports a Saturday-open centre via bitmap alone", () => {
    const m = new Map<string, boolean>();
    expect(isOpenDay("2026-07-11", m, "0111111")).toBe(true);
  });
});

describe("eachDay", () => {
  it("yields inclusive range including month/year boundaries", () => {
    expect(Array.from(eachDay("2026-01-30", "2026-02-02"))).toEqual([
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
    expect(Array.from(eachDay("2026-12-30", "2027-01-02"))).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("yields a single element when from == to", () => {
    expect(Array.from(eachDay("2026-07-08", "2026-07-08"))).toEqual(["2026-07-08"]);
  });
});

describe("daysOpenInRange", () => {
  it("counts a full 2026 calendar year of weekdays correctly", () => {
    const n = daysOpenInRange("2026-01-01", "2026-12-31", new Map(), "0111110");
    // 2026 is not a leap year and starts on a Thursday. Weekday count: 261.
    expect(n).toBe(261);
  });

  it("subtracts explicit closures and adds explicit opens", () => {
    const m = new Map<string, boolean>([
      ["2026-07-11", true],  // Sat open
      ["2026-07-13", false], // Mon closed
    ]);
    // 2026-07-06 (Mon) .. 2026-07-13 (Mon) inclusive = 8 days.
    // Default weekdays open: Mon, Tue, Wed, Thu, Fri = 5.
    // Sat 11 override open: +1 = 6.
    // Sun 12 default closed: 6.
    // Mon 13 override closed: 6.
    expect(daysOpenInRange("2026-07-06", "2026-07-13", m, "0111110")).toBe(6);
  });
});
