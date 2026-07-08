// Turn a raw staff_shift_events row into a human-readable line.
// Kept pure so it's easy to unit-test.
import type { ShiftEvent } from "../repo/scheduleRepo";

export type StaffLookup = (id: number | string | null | undefined) => string;

type Payload = Record<string, unknown> | null;

function asPayload(p: unknown): Payload {
  if (p && typeof p === "object" && !Array.isArray(p)) return p as Payload;
  return null;
}
function s(p: Payload, k: string): string | null {
  const v = p?.[k];
  return typeof v === "string" ? v : null;
}
function n(p: Payload, k: string): number | null {
  const v = p?.[k];
  return typeof v === "number" ? v : null;
}
function timeRange(p: Payload): string | null {
  const start = s(p, "start_time") ?? s(p, "startTime");
  const end   = s(p, "end_time")   ?? s(p, "endTime");
  if (!start && !end) return null;
  return `${start ?? "?"}–${end ?? "?"}`;
}

/** Prose describing what happened, without any staff attribution. */
export function describeShiftEvent(ev: ShiftEvent, staffName: StaffLookup): string {
  const p = asPayload(ev.payload);
  const who = staffName(s(p, "staff_id") ?? n(p, "staff_id"));
  const date = s(p, "shift_date") ?? s(p, "date") ?? "";
  const range = timeRange(p);
  const role = s(p, "role");
  const status = s(p, "status");
  const reason = s(p, "reason");

  const bits: string[] = [];

  switch (ev.eventType) {
    case "shift.created":
      bits.push(`New shift for ${who || "staff"}`);
      if (date) bits.push(`on ${date}`);
      if (range) bits.push(range);
      if (role) bits.push(`(${role})`);
      break;
    case "shift.updated":
      bits.push(`Updated ${who || "shift"}`);
      if (date) bits.push(`on ${date}`);
      if (range) bits.push(`→ ${range}`);
      break;
    case "shift.deleted":
    case "shift.soft_deleted":
      bits.push(`Deleted ${who ? `${who}'s shift` : "shift"}`);
      if (date) bits.push(`on ${date}`);
      if (reason) bits.push(`— ${reason}`);
      break;
    case "shift.status_changed":
      bits.push(`${who || "Staff"}`);
      if (date) bits.push(`${date}`);
      if (status) bits.push(`marked ${status}`);
      break;
    case "shift.published":
    case "week.published":
      bits.push(`Published week to ${who || "staff"}`);
      if (n(p, "shift_count")) bits.push(`(${n(p, "shift_count")} shifts)`);
      break;
    case "shift.acknowledged":
    case "week.acknowledged":
      bits.push(`${who || "Staff"} confirmed the schedule`);
      break;
    default:
      bits.push(ev.eventType.replace(/[._]/g, " "));
      if (who) bits.push(`— ${who}`);
      if (date) bits.push(date);
      if (range) bits.push(range);
  }

  return bits.join(" ").trim();
}
