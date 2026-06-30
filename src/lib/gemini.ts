// Gemini OCR wrapper.
import { invoke } from "@tauri-apps/api/core";

export interface ExtractedRow {
  staff_name: string;
  work_date: string;
  in_time: string | null;
  out_time: string | null;
}
export interface ExtractResult {
  rows: ExtractedRow[];
  raw_text: string;
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

export async function extractTimesheet(opts: {
  apiKey: string;
  imageBytes: Uint8Array;
  mimeType: string;
  monthYear: string; // "YYYY-MM"
  knownStaffNames: string[];
}): Promise<ExtractResult> {
  const image_b64 = bytesToB64(opts.imageBytes);
  return await invoke<ExtractResult>("extract_timesheet", {
    args: {
      api_key: opts.apiKey,
      image_b64,
      mime_type: opts.mimeType,
      month_year: opts.monthYear,
      known_staff_names: opts.knownStaffNames,
    },
  });
}
