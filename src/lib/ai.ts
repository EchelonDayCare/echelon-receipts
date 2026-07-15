// Azure AI Foundry OCR wrappers — used by child attendance sign-in sheets
// and Visa / credit-card statement import. Both route through the
// Mistral Document AI endpoint (see src-tauri/src/azure_ai.rs).
import { invoke } from "@tauri-apps/api/core";

// Row shape shared with the staff-timesheet consensus flow.
export interface ExtractedRow {
  staff_name: string;
  work_date: string;
  in_time: string | null;
  out_time: string | null;
  no_lunch?: boolean;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

export function fileToMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "pdf") return "application/pdf";
  return "image/jpeg";
}

// ─── Child attendance sign-in sheet ─────────────────────────────────────
export interface ExtractedAttendanceRow {
  child_name: string;
  work_date: string;
  in_time: string | null;
  out_time: string | null;
  status: string | null;
  signed_in_by: string | null;
  signed_out_by: string | null;
}
export interface ExtractAttendanceResult {
  rows: ExtractedAttendanceRow[];
  raw_text: string;
}

export async function extractAttendance(opts: {
  imageBytes: Uint8Array;
  mimeType: string;
  targetDate: string;
  knownStudentNames: string[];
}): Promise<ExtractAttendanceResult> {
  const image_b64 = bytesToB64(opts.imageBytes);
  return await invoke<ExtractAttendanceResult>("extract_attendance", {
    args: {
      image_b64,
      mime_type: opts.mimeType,
      target_date: opts.targetDate,
      known_student_names: opts.knownStudentNames,
    },
  });
}

// ─── Monthly child attendance grid ──────────────────────────────────────
export interface ExtractedMonthAttendanceRow {
  child_name: string;
  marks: Record<string, "P" | "A" | "H" | "S" | "V">;
}
export interface MonthUncertainCell {
  child_name: string;
  day: string;
  /** Ordered by provider: [primary_vote, secondary_vote]. "-" = provider saw blank/omitted. */
  votes: string[];
  /** Value the merger picked (may be "-" meaning "no mark written"). */
  picked: string;
}
export interface MonthProviderMeta {
  provider: string;
  ok: boolean;
  latency_ms: number;
  row_count: number;
  mark_count: number;
  error: string | null;
}
export interface ExtractMonthAttendanceResult {
  month: string;
  days_centre_open: number | null;
  rows: ExtractedMonthAttendanceRow[];
  raw_text: string;
  /** Cells where the two vision providers disagreed. Highlight these in the review modal. */
  uncertain_cells?: MonthUncertainCell[];
  /** Per-provider metadata (deployment name, latency, row/mark counts). */
  providers?: MonthProviderMeta[];
  /** v3.0.7: Which model's rows drove the import.
   *  - "primary"            — primary model (normal)
   *  - "secondary_promoted" — primary silently under-read; secondary promoted
   *  - "primary_only"       — secondary failed; primary passed through
   *  - "secondary_only"     — primary hard-failed; secondary was used
   */
  consensus_action?: string;
}

export async function extractMonthAttendance(opts: {
  imageBytes: Uint8Array;
  mimeType: string;
  targetMonth: string; // YYYY-MM
  knownStudentNames: string[];
  /** Weekend days (1..31) for the target month. Used as corroboration hints in the OCR prompt. */
  weekendDays?: number[];
  /** STAT holidays (1..31) for the target month. */
  statDays?: number[];
  /** Custom centre-closed days (1..31). */
  closedDays?: number[];
}): Promise<ExtractMonthAttendanceResult> {
  const image_b64 = bytesToB64(opts.imageBytes);
  return await invoke<ExtractMonthAttendanceResult>("extract_month_attendance", {
    args: {
      image_b64,
      mime_type: opts.mimeType,
      target_month: opts.targetMonth,
      known_student_names: opts.knownStudentNames,
      weekend_days: opts.weekendDays ?? [],
      stat_days: opts.statDays ?? [],
      closed_days: opts.closedDays ?? [],
    },
  });
}

// v3.1.0 — Deterministic local OCR for the kid attendance sheet.
// Takes an image PATH (not bytes) so the Rust side can decode directly.
export async function extractKidAttendanceLocal(opts: {
  imagePath: string;
  targetMonth: string;
  weekendDays: number[];
  statDays: number[];
  closedDays: number[];
  roster: { student_id: number; student_name: string }[];
}): Promise<ExtractMonthAttendanceResult> {
  return await invoke<ExtractMonthAttendanceResult>("extract_kid_attendance_local", {
    args: {
      image_path: opts.imagePath,
      target_month: opts.targetMonth,
      weekend_days: opts.weekendDays,
      stat_days: opts.statDays,
      closed_days: opts.closedDays,
      roster: opts.roster,
    },
  });
}

// ─── Staff credential OCR ───────────────────────────────────────────────
export interface ExtractCredentialResult {
  staff_name_guess: string | null;
  credential_type_guess: string | null;
  issuer: string | null;
  issued_date: string | null;   // YYYY-MM-DD
  expiry_date: string | null;   // YYYY-MM-DD
  certificate_number: string | null;
  notes: string | null;
  raw_text: string;
}

export async function extractCredential(opts: {
  fileBytes: Uint8Array;
  mimeType: string;
  knownStaffNames: string[];
  knownCredentialTypes: string[];
}): Promise<ExtractCredentialResult> {
  const file_b64 = bytesToB64(opts.fileBytes);
  return await invoke<ExtractCredentialResult>("extract_credential", {
    args: {
      file_b64,
      mime_type: opts.mimeType,
      known_staff_names: opts.knownStaffNames,
      known_credential_types: opts.knownCredentialTypes,
    },
  });
}
