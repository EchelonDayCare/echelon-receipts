// Human-readable inactive-status suffix for roster/grid displays.
// Shows the effective date when we know it (Migration 030 stamped
// withdrawn_at / terminated_at); falls back to a plain marker for rows
// that were flipped inactive before the migration.
export function inactiveLabel(kind: "student" | "staff", stampedAt: string | null | undefined): string {
  if (!stampedAt) return kind === "student" ? "(inactive)" : "(inactive)";
  const d = new Date(stampedAt);
  if (Number.isNaN(d.getTime())) return "(inactive)";
  const s = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return kind === "student" ? `(withdrew ${s})` : `(terminated ${s})`;
}
