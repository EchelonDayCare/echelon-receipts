import { describe, expect, it } from "vitest";
import { rowToBucket, statusToBucket } from "./attendanceBucket";

describe("attendanceBucket", () => {
  describe("attendance_mark takes precedence (post-Migration-027 contract)", () => {
    it("returns h when mark=H even if status=present and hours>0", () => {
      expect(rowToBucket({ status: "present", hours_decimal: 8, attendance_mark: "H" })).toBe("h");
    });
    it("returns p when mark=P even if status=absent", () => {
      expect(rowToBucket({ status: "absent", hours_decimal: 0, attendance_mark: "P" })).toBe("p");
    });
    it("returns a when mark=A regardless of status", () => {
      expect(rowToBucket({ status: "present", hours_decimal: 4, attendance_mark: "A" })).toBe("a");
    });
    it("accepts lowercase attendance_mark values", () => {
      expect(rowToBucket({ status: null, hours_decimal: 0, attendance_mark: "s" })).toBe("s");
    });
  });

  describe("daily-flow fallback when mark is NULL", () => {
    it("stamp-in-in-progress (present, hours=0, mark=NULL) is a full-day, NOT half-day", () => {
      // Regression: pre-fix this returned "h" via statusToBucket(present,0).
      // The whole point of Migration 027 is that half-day comes ONLY from
      // the explicit mark. This row is a child who arrived but hasn't
      // stamped out yet — count them as present.
      expect(rowToBucket({ status: "present", hours_decimal: 0, attendance_mark: null })).toBe("p");
    });
    it("completed stamp-in/out (present, hours>0, mark=NULL) is present", () => {
      expect(rowToBucket({ status: "present", hours_decimal: 8.5, attendance_mark: null })).toBe("p");
    });
    it("absent status maps to a", () => {
      expect(rowToBucket({ status: "absent", hours_decimal: 0, attendance_mark: null })).toBe("a");
    });
    it("sick status maps to s", () => {
      expect(rowToBucket({ status: "sick", hours_decimal: 0, attendance_mark: null })).toBe("s");
    });
    it("holiday status maps to v", () => {
      expect(rowToBucket({ status: "holiday", hours_decimal: 0, attendance_mark: null })).toBe("v");
    });
    it("null status with no mark returns null (no row for reporting)", () => {
      expect(rowToBucket({ status: null, hours_decimal: 0, attendance_mark: null })).toBeNull();
    });
    it("unknown status with no mark returns null", () => {
      expect(rowToBucket({ status: "unknown", hours_decimal: 5, attendance_mark: null })).toBeNull();
    });
  });

  describe("statusToBucket (fallback used only when mark is NULL)", () => {
    it("does NOT depend on hours anymore", () => {
      expect(statusToBucket("present")).toBe("p");
    });
    it("is case-insensitive", () => {
      expect(statusToBucket("PRESENT")).toBe("p");
      expect(statusToBucket("Absent")).toBe("a");
    });
    it("returns null for empty/unknown", () => {
      expect(statusToBucket("")).toBeNull();
      expect(statusToBucket(null)).toBeNull();
      expect(statusToBucket("garbage")).toBeNull();
    });
  });
});
