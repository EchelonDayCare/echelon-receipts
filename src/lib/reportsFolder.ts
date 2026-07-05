// Central "Reports" folder resolver.
//
// The user picks ONE root folder in Settings ("reports_folder"). Every report
// the app generates goes into a well-known subfolder underneath it so files
// don't pile up in one place and are easy to browse:
//
//   <reports_folder>/
//     AGM Minutes/
//       AGM-2024-25.docx
//       AGM-2025-26.docx
//
// This file owns the naming so future reports can just call
// `resolveReportPath("Attendance", "attendance-2026-06.pdf")` and get a
// mkdir-p'd path back. When wiring a new report kind, ADD the entry to
// REPORT_SUBFOLDERS in the same commit that wires up its caller — dead
// entries hide unimplemented paths.

import { join } from "@tauri-apps/api/path";
import { mkdir, exists } from "@tauri-apps/plugin-fs";
import { getSettings } from "./db";

/** Well-known subfolder names for each report type. Change here, not per-call. */
export const REPORT_SUBFOLDERS = {
  agmMinutes: "AGM Minutes",
} as const;
export type ReportKind = keyof typeof REPORT_SUBFOLDERS;

export class NoReportsFolderError extends Error {
  constructor() {
    super("No Reports folder is configured. Open Settings and pick a folder under 'Reports folder' before generating.");
    this.name = "NoReportsFolderError";
  }
}

export class InvalidReportFilenameError extends Error {
  constructor(filename: string) {
    super(`Refusing to write to unsafe filename: ${JSON.stringify(filename)}`);
    this.name = "InvalidReportFilenameError";
  }
}

/**
 * Reject filenames that could escape the reports folder or contain characters
 * that behave differently across filesystems. Called by resolveReportPath.
 * yearLabel + prefix are the two variable pieces that come from user data;
 * this defends against a tampered restore file whose payload_json overwrites
 * yearLabel with something malicious.
 */
function validateFilename(filename: string): void {
  if (!filename || filename.length > 200) throw new InvalidReportFilenameError(filename);
  if (filename.startsWith(".") || filename.includes("..")) throw new InvalidReportFilenameError(filename);
  if (/[\\/\0:*?"<>|\r\n]/.test(filename)) throw new InvalidReportFilenameError(filename);
}

/**
 * Resolve the full path where a report should be written and ensure the
 * subfolder exists. Throws `NoReportsFolderError` if the user hasn't set
 * the reports root — the caller should catch this and steer the user to
 * Settings.
 */
export async function resolveReportPath(kind: ReportKind, filename: string): Promise<string> {
  validateFilename(filename);
  const settings = await getSettings();
  const root = (settings.reports_folder || "").trim();
  if (!root) throw new NoReportsFolderError();

  const sub = REPORT_SUBFOLDERS[kind];
  const dir = await join(root, sub);
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return join(dir, filename);
}

/** True when the user has picked a reports folder. Useful for UI banners. */
export async function isReportsFolderConfigured(): Promise<boolean> {
  const s = await getSettings();
  return !!(s.reports_folder || "").trim();
}
