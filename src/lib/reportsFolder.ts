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
//     Attendance/               (future)
//     Aging (AR)/               (future)
//     Staff Credentials/        (future)
//     Drill Log/                (future)
//
// This file owns the naming so future reports can just call
// `resolveReportPath("Attendance", "attendance-2026-06.pdf")` and get a
// mkdir-p'd path back.

import { join } from "@tauri-apps/api/path";
import { mkdir, exists } from "@tauri-apps/plugin-fs";
import { getSettings } from "./db";

/** Well-known subfolder names for each report type. Change here, not per-call. */
export const REPORT_SUBFOLDERS = {
  agmMinutes:        "AGM Minutes",
  boardPackage:      "Board Packages",
  attendance:        "Attendance",
  aging:             "Aging (AR)",
  staffCredentials:  "Staff Credentials",
  drillLog:          "Drill Log",
  monthlyRevenue:    "Monthly Revenue",
  subsidyRecon:      "Subsidy Reconciliation",
} as const;
export type ReportKind = keyof typeof REPORT_SUBFOLDERS;

export class NoReportsFolderError extends Error {
  constructor() {
    super("No Reports folder is configured. Open Settings and pick a folder under 'Reports folder' before generating.");
    this.name = "NoReportsFolderError";
  }
}

/**
 * Resolve the full path where a report should be written and ensure the
 * subfolder exists. Throws `NoReportsFolderError` if the user hasn't set
 * the reports root — the caller should catch this and steer the user to
 * Settings.
 */
export async function resolveReportPath(kind: ReportKind, filename: string): Promise<string> {
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
