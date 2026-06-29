import { loadXLSX } from "./lazy";

export interface ImportedStudent {
  name: string;
  father_name: string | null;
  mother_name: string | null;
  email: string | null;
}

// Accept common header variations and map to canonical fields
const HEADERS = {
  name: ["student name", "student's name", "student", "child", "name"],
  father: ["father's name", "father name", "father", "dad"],
  mother: ["mother's name", "mother name", "mother", "mom"],
  email: ["email id", "email", "e-mail", "email address", "parent email"],
};

function norm(s: any): string {
  return String(s ?? "").trim().toLowerCase();
}
function pick(row: Record<string, any>, keys: string[]): string | null {
  for (const k of Object.keys(row)) {
    if (keys.includes(norm(k))) {
      const v = row[k];
      const s = v == null ? "" : String(v).trim();
      return s || null;
    }
  }
  return null;
}

export async function parseRosterFile(file: ArrayBuffer): Promise<ImportedStudent[]> {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(file, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
  const out: ImportedStudent[] = [];
  for (const r of rows) {
    const name = pick(r, HEADERS.name);
    if (!name) continue;
    out.push({
      name,
      father_name: pick(r, HEADERS.father),
      mother_name: pick(r, HEADERS.mother),
      email: pick(r, HEADERS.email),
    });
  }
  return out;
}
