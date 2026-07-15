// v3.0.7 — Attendance OCR audit log.
//
// Every extract_month_attendance call is recorded to `attendance_ai_events`
// so we can reconstruct what happened when a scan misbehaves. Motivating
// incident: Jul 2026 KidsJuly.jpeg where primary silently returned 2 of 25
// rows and the review modal treated that as truth (see Migration 034).
//
// Never throws — audit failure MUST NOT block the OCR flow.

import { db } from "./db";

export interface AttendanceAiEventInput {
  imageSha256?: string | null;
  imageFilename?: string | null;
  targetMonth: string;
  rosterSize: number;
  rotationApplied?: number | null; // 0/90/180/270
  qrYear?: number | null;
  qrMonth?: number | null;
  primaryModel?: string | null;
  primaryOk?: boolean | null;
  primaryRowCount?: number | null;
  primaryMarkCount?: number | null;
  primaryLatencyMs?: number | null;
  primaryError?: string | null;
  secondaryModel?: string | null;
  secondaryOk?: boolean | null;
  secondaryRowCount?: number | null;
  secondaryMarkCount?: number | null;
  secondaryLatencyMs?: number | null;
  secondaryError?: string | null;
  consensusAction?: string | null;
  importedRowCount?: number | null;
  importedMarkCount?: number | null;
  uncertainCount?: number | null;
}

export async function logAttendanceAiEvent(ev: AttendanceAiEventInput): Promise<void> {
  try {
    const d = await db();
    await d.execute(
      `INSERT INTO attendance_ai_events (
        image_sha256, image_filename, target_month, roster_size,
        rotation_applied, qr_year, qr_month,
        primary_model, primary_ok, primary_row_count, primary_mark_count, primary_latency_ms, primary_error,
        secondary_model, secondary_ok, secondary_row_count, secondary_mark_count, secondary_latency_ms, secondary_error,
        consensus_action, imported_row_count, imported_mark_count, uncertain_count
      ) VALUES (?,?,?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)`,
      [
        ev.imageSha256 ?? null,
        ev.imageFilename ?? null,
        ev.targetMonth,
        ev.rosterSize,
        ev.rotationApplied ?? 0,
        ev.qrYear ?? null,
        ev.qrMonth ?? null,
        ev.primaryModel ?? null,
        ev.primaryOk == null ? null : (ev.primaryOk ? 1 : 0),
        ev.primaryRowCount ?? null,
        ev.primaryMarkCount ?? null,
        ev.primaryLatencyMs ?? null,
        truncate(ev.primaryError, 4000),
        ev.secondaryModel ?? null,
        ev.secondaryOk == null ? null : (ev.secondaryOk ? 1 : 0),
        ev.secondaryRowCount ?? null,
        ev.secondaryMarkCount ?? null,
        ev.secondaryLatencyMs ?? null,
        truncate(ev.secondaryError, 4000),
        ev.consensusAction ?? null,
        ev.importedRowCount ?? null,
        ev.importedMarkCount ?? null,
        ev.uncertainCount ?? null,
      ]
    );
  } catch (e) {
    console.warn("[attendance-ai-audit] log failed (non-fatal):", e);
  }
}

function truncate(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}

export interface AttendanceAiEventRow {
  id: number;
  created_at: string;
  image_filename: string | null;
  target_month: string | null;
  roster_size: number | null;
  rotation_applied: number | null;
  qr_year: number | null;
  qr_month: number | null;
  primary_model: string | null;
  primary_ok: number | null;
  primary_row_count: number | null;
  primary_mark_count: number | null;
  primary_latency_ms: number | null;
  primary_error: string | null;
  secondary_model: string | null;
  secondary_ok: number | null;
  secondary_row_count: number | null;
  secondary_mark_count: number | null;
  secondary_latency_ms: number | null;
  secondary_error: string | null;
  consensus_action: string | null;
  imported_row_count: number | null;
  imported_mark_count: number | null;
  uncertain_count: number | null;
}

export async function listRecentAttendanceAiEvents(limit = 50): Promise<AttendanceAiEventRow[]> {
  const d = await db();
  return d.select<AttendanceAiEventRow[]>(
    `SELECT id, created_at, image_filename, target_month, roster_size,
            rotation_applied, qr_year, qr_month,
            primary_model, primary_ok, primary_row_count, primary_mark_count, primary_latency_ms, primary_error,
            secondary_model, secondary_ok, secondary_row_count, secondary_mark_count, secondary_latency_ms, secondary_error,
            consensus_action, imported_row_count, imported_mark_count, uncertain_count
     FROM attendance_ai_events
     ORDER BY id DESC
     LIMIT ?`,
    [limit]
  );
}
