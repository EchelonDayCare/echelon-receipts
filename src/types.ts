export interface Student {
  id: number;
  name: string;
  father_name: string | null;
  mother_name: string | null;
  email: string | null;
  year: number;
  active: number;
  created_at: string;
}

export interface Receipt {
  id: number;
  receipt_no: number;
  date: string; // ISO yyyy-mm-dd
  student_id: number;
  student_name_snapshot: string;
  father_name_snapshot: string | null;
  mother_name_snapshot: string | null;
  description: string;
  amount: number;
  pending_amount: number;
  comments: string | null;
  voided: number;
  created_at: string;
}

export type SettingsMap = Record<string, string>;
