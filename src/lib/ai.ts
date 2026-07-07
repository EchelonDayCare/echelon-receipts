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
export interface ExtractMonthAttendanceResult {
  month: string;
  days_centre_open: number | null;
  rows: ExtractedMonthAttendanceRow[];
  raw_text: string;
}

export async function extractMonthAttendance(opts: {
  imageBytes: Uint8Array;
  mimeType: string;
  targetMonth: string; // YYYY-MM
  knownStudentNames: string[];
}): Promise<ExtractMonthAttendanceResult> {
  const image_b64 = bytesToB64(opts.imageBytes);
  return await invoke<ExtractMonthAttendanceResult>("extract_month_attendance", {
    args: {
      image_b64,
      mime_type: opts.mimeType,
      target_month: opts.targetMonth,
      known_student_names: opts.knownStudentNames,
    },
  });
}
