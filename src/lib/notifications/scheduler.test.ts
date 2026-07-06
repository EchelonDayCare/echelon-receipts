import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isWithinQuietHours } from "./scheduler";

describe("notifications/scheduler isWithinQuietHours (L-4)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function atLocalTime(h: number, m: number) {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    vi.setSystemTime(d);
  }

  it("returns false when either bound is empty (not configured)", () => {
    expect(isWithinQuietHours("", "07:00")).toBe(false);
    expect(isWithinQuietHours("22:00", "")).toBe(false);
    expect(isWithinQuietHours("", "")).toBe(false);
  });

  it("returns false for a degenerate start===end config (treated as always on)", () => {
    expect(isWithinQuietHours("08:00", "08:00")).toBe(false);
  });

  it("handles a same-day window (start < end)", () => {
    atLocalTime(13, 0);
    expect(isWithinQuietHours("12:00", "14:00")).toBe(true);
    atLocalTime(15, 0);
    expect(isWithinQuietHours("12:00", "14:00")).toBe(false);
  });

  it("handles a window that wraps past midnight (start > end)", () => {
    atLocalTime(23, 30);
    expect(isWithinQuietHours("22:00", "07:00")).toBe(true);
    atLocalTime(3, 0);
    expect(isWithinQuietHours("22:00", "07:00")).toBe(true);
    atLocalTime(12, 0);
    expect(isWithinQuietHours("22:00", "07:00")).toBe(false);
  });

  it("returns false for malformed HH:MM input rather than throwing", () => {
    expect(isWithinQuietHours("not-a-time", "07:00")).toBe(false);
  });
});
