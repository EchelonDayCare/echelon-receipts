import { describe, it, expect } from "vitest";
import { parseDeleteIntent } from "./scheduleDeleteIntent";

// Anchor day for deterministic scope math: Wednesday 2026-08-05.
// Monday of this week = 2026-08-03; Sunday = 2026-08-09.
const TODAY = new Date(2026, 7, 5);
const ROSTER = [
  { id: "s1", name: "Chloe" },
  { id: "s2", name: "Judy Chen" },
  { id: "s3", name: "Kiran" },
];

describe("parseDeleteIntent", () => {
  it("returns null for non-delete prompts", () => {
    expect(parseDeleteIntent("Judy 9-5 Friday", ROSTER, TODAY)).toBeNull();
    expect(parseDeleteIntent("Priya morning 7-2 Mon-Fri", ROSTER, TODAY)).toBeNull();
    expect(parseDeleteIntent("", ROSTER, TODAY)).toBeNull();
  });

  it("returns null for delete-adjacent text with no scope word", () => {
    expect(parseDeleteIntent("delete this", ROSTER, TODAY)).toBeNull();
    expect(parseDeleteIntent("cancel the shift please", ROSTER, TODAY)).toBeNull();
  });

  it("returns null for destructive-sounding text without object hint in a long prompt", () => {
    expect(parseDeleteIntent("delete the email I sent to my staff last week please", ROSTER, TODAY)).toBeNull();
  });

  it("parses 'delete all shifts today' as a single-day scope", () => {
    const r = parseDeleteIntent("delete all shifts today", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.scope.kind).toBe("day");
    expect(r!.scope.startIso).toBe("2026-08-05");
    expect(r!.scope.endIso).toBe("2026-08-05");
    expect(r!.scope.label).toBe("today");
    expect(r!.staffIds).toEqual([]);
  });

  it("parses 'clear yesterday' (short prompt, no object needed)", () => {
    const r = parseDeleteIntent("clear yesterday", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.scope.kind).toBe("day");
    expect(r!.scope.startIso).toBe("2026-08-04");
    expect(r!.scope.endIso).toBe("2026-08-04");
  });

  it("parses 'remove shifts tomorrow'", () => {
    const r = parseDeleteIntent("remove shifts tomorrow", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.scope.startIso).toBe("2026-08-06");
    expect(r!.scope.endIso).toBe("2026-08-06");
  });

  it("parses 'delete all shifts this week' → Mon-Sun of current week", () => {
    const r = parseDeleteIntent("delete all shifts this week", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.scope.kind).toBe("week");
    expect(r!.scope.startIso).toBe("2026-08-03");
    expect(r!.scope.endIso).toBe("2026-08-09");
    expect(r!.staffIds).toEqual([]);
  });

  it("parses 'wipe schedule next week'", () => {
    const r = parseDeleteIntent("wipe schedule next week", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.scope.startIso).toBe("2026-08-10");
    expect(r!.scope.endIso).toBe("2026-08-16");
  });

  it("parses 'delete last week's shifts'", () => {
    const r = parseDeleteIntent("delete last week's shifts", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.scope.startIso).toBe("2026-07-27");
    expect(r!.scope.endIso).toBe("2026-08-02");
  });

  it("parses 'cancel all shifts this month' → 08/01–08/31", () => {
    const r = parseDeleteIntent("cancel all shifts this month", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.scope.kind).toBe("month");
    expect(r!.scope.startIso).toBe("2026-08-01");
    expect(r!.scope.endIso).toBe("2026-08-31");
  });

  it("parses 'clear all shifts last month' → 07/01–07/31", () => {
    const r = parseDeleteIntent("clear all shifts last month", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.scope.startIso).toBe("2026-07-01");
    expect(r!.scope.endIso).toBe("2026-07-31");
  });

  it("parses 'delete shifts next month' spanning the year boundary", () => {
    const dec15 = new Date(2026, 11, 15);
    const r = parseDeleteIntent("delete shifts next month", ROSTER, dec15);
    expect(r).not.toBeNull();
    expect(r!.scope.startIso).toBe("2027-01-01");
    expect(r!.scope.endIso).toBe("2027-01-31");
  });

  it("keeps Monday scope when today IS Monday", () => {
    const monday = new Date(2026, 7, 3);
    const r = parseDeleteIntent("delete all shifts this week", ROSTER, monday);
    expect(r!.scope.startIso).toBe("2026-08-03");
    expect(r!.scope.endIso).toBe("2026-08-09");
  });

  it("keeps Monday scope when today IS Sunday (walk back 6 days)", () => {
    const sunday = new Date(2026, 7, 9);
    const r = parseDeleteIntent("delete all shifts this week", ROSTER, sunday);
    expect(r!.scope.startIso).toBe("2026-08-03");
    expect(r!.scope.endIso).toBe("2026-08-09");
  });

  it("is case-insensitive", () => {
    const r = parseDeleteIntent("DELETE ALL SHIFTS THIS WEEK", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.scope.startIso).toBe("2026-08-03");
  });

  it("matches roster staff by first name", () => {
    const r = parseDeleteIntent("Delete all shifts of Judy for this week", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.staffIds).toEqual(["s2"]);
  });

  it("matches roster staff by full name", () => {
    const r = parseDeleteIntent("Delete all shifts of Judy Chen for this week", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.staffIds).toEqual(["s2"]);
  });

  it("matches multiple named staff", () => {
    const r = parseDeleteIntent("Delete Chloe and Judy shifts this week", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.staffIds.sort()).toEqual(["s1", "s2"]);
  });

  it("tolerates the 'shifty' typo (still hits the object-hint regex)", () => {
    const r = parseDeleteIntent("Delete all shifty of Judy for this week", ROSTER, TODAY);
    expect(r).not.toBeNull();
    expect(r!.staffIds).toEqual(["s2"]);
    expect(r!.scope.startIso).toBe("2026-08-03");
  });

  it("returns empty staffIds when no roster names are mentioned", () => {
    const r = parseDeleteIntent("delete all shifts this week", ROSTER, TODAY);
    expect(r!.staffIds).toEqual([]);
  });
});

