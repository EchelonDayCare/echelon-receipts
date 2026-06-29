export interface Student {
  id: number;
  name: string;
  father_name: string | null;
  mother_name: string | null;
  email: string | null;
  year: number;
  active: number;
  created_at: string;
  person_id: string | null;
  gross_override: number | null;
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
  emailed_at: string | null;
  emailed_to: string | null;
  is_refund: number;
  gross_amount: number | null;
  ccfri_amount: number | null;
  accb_amount: number | null;
  void_reason: string | null;
  voided_at: string | null;
}

export interface AccbEntry {
  id: number;
  student_id: number;
  year: number;
  month: number;
  amount: number;
  notes: string | null;
  created_at: string;
}

export interface FeeBreakdown {
  gross: number;
  ccfri: number;
  accb: number;
  parent_pays: number;
  enabled: boolean;
}

export interface AnnualReceipt {
  id: number;
  ar_number: string;
  person_id: string;
  student_name: string;
  father_name: string | null;
  mother_name: string | null;
  calendar_year: number;
  recipient_label: string;
  total_amount: number;
  receipt_count: number;
  receipt_ids_json: string;
  payload_hash: string;
  issued_at: string;
  emailed_at: string | null;
  emailed_to: string | null;
  superseded_by: number | null;
  notes: string | null;
}

export type SettingsMap = Record<string, string>;
