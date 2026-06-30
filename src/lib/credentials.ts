// Staff credentials & drill log helpers.
import { db, execRetry } from "./db";
import type { StaffCredential, StaffDrill } from "../types";

export interface CredentialTypeDef {
  type: string;
  cadenceYears: number; // 0 = no expiry / one-off
  description: string;
}

// Default credential types per BC Child Care Licensing Regulation + best practice.
export const DEFAULT_CRED_TYPES: CredentialTypeDef[] = [
  { type: "ECE Certificate", cadenceYears: 5, description: "ECE / ECE Assistant / Responsible Adult" },
  { type: "Criminal Record Check", cadenceYears: 5, description: "Through BC Ministry of Public Safety" },
  { type: "Child Care First Aid", cadenceYears: 3, description: "Includes CPR-C / AED" },
  { type: "TB Clearance", cadenceYears: 1, description: "Annual TB screening / declaration" },
  { type: "Immunization Record", cadenceYears: 1, description: "Annual review (employer file)" },
  { type: "Policy / Orientation Sign-off", cadenceYears: 1, description: "Annual policy acknowledgement" },
];

export function defaultExpiryFromIssue(issuedISO: string, cadenceYears: number): string {
  if (!cadenceYears || !issuedISO) return "";
  const d = new Date(issuedISO);
  if (Number.isNaN(d.getTime())) return "";
  d.setFullYear(d.getFullYear() + cadenceYears);
  return d.toISOString().slice(0, 10);
}

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

export type CredStatus = "ok" | "expiring" | "expired" | "unknown";
export function credStatus(expiryISO: string | null | undefined, alertDays: number): CredStatus {
  const d = daysUntil(expiryISO);
  if (d === null) return "unknown";
  if (d < 0) return "expired";
  if (d <= alertDays) return "expiring";
  return "ok";
}

export async function listCredentials(staffId?: number): Promise<StaffCredential[]> {
  const d = await db();
  if (staffId !== undefined) {
    return d.select<StaffCredential[]>(
      `SELECT * FROM staff_credentials WHERE staff_id = ? ORDER BY expiry_date IS NULL, expiry_date ASC, type`,
      [staffId]
    );
  }
  return d.select<StaffCredential[]>(
    `SELECT * FROM staff_credentials ORDER BY expiry_date IS NULL, expiry_date ASC, type`
  );
}

export async function listAllCredentialsWithStaff(): Promise<(StaffCredential & { staff_name: string })[]> {
  const d = await db();
  return d.select<(StaffCredential & { staff_name: string })[]>(
    `SELECT c.*, s.name AS staff_name
       FROM staff_credentials c
       JOIN staff s ON s.id = c.staff_id
      WHERE s.active = 1
      ORDER BY c.expiry_date IS NULL, c.expiry_date ASC, s.name COLLATE NOCASE`
  );
}

export async function upsertCredential(c: Partial<StaffCredential> & { staff_id: number; type: string }): Promise<number> {
  if (c.id) {
    await execRetry(
      `UPDATE staff_credentials SET type=?, issued_date=?, expiry_date=?, file_path=?, notes=? WHERE id=?`,
      [c.type, c.issued_date || null, c.expiry_date || null, c.file_path || null, c.notes || null, c.id]
    );
    return c.id;
  }
  const r = await execRetry(
    `INSERT INTO staff_credentials(staff_id, type, issued_date, expiry_date, file_path, notes)
     VALUES(?, ?, ?, ?, ?, ?)`,
    [c.staff_id, c.type, c.issued_date || null, c.expiry_date || null, c.file_path || null, c.notes || null]
  );
  return Number(r.lastInsertId);
}

export async function deleteCredential(id: number): Promise<void> {
  await execRetry("DELETE FROM staff_credentials WHERE id=?", [id]);
}

// --- Drills ---
export const DRILL_TYPES = ["Fire", "Lockdown", "Earthquake", "Evacuation", "Shelter-in-place"] as const;

export async function listDrills(year?: number): Promise<StaffDrill[]> {
  const d = await db();
  if (year) {
    return d.select<StaffDrill[]>(
      `SELECT * FROM staff_drills WHERE substr(drill_date,1,4) = ? ORDER BY drill_date DESC`,
      [String(year)]
    );
  }
  return d.select<StaffDrill[]>(`SELECT * FROM staff_drills ORDER BY drill_date DESC`);
}

export async function upsertDrill(dr: Partial<StaffDrill> & { drill_date: string; drill_type: string }): Promise<number> {
  if (dr.id) {
    await execRetry(
      `UPDATE staff_drills SET drill_date=?, drill_type=?, duration_min=?, children_present=?, notes=? WHERE id=?`,
      [dr.drill_date, dr.drill_type, dr.duration_min ?? null, dr.children_present ?? null, dr.notes || null, dr.id]
    );
    return dr.id;
  }
  const r = await execRetry(
    `INSERT INTO staff_drills(drill_date, drill_type, duration_min, children_present, notes)
     VALUES(?, ?, ?, ?, ?)`,
    [dr.drill_date, dr.drill_type, dr.duration_min ?? null, dr.children_present ?? null, dr.notes || null]
  );
  return Number(r.lastInsertId);
}

export async function deleteDrill(id: number): Promise<void> {
  await execRetry("DELETE FROM staff_drills WHERE id=?", [id]);
}
