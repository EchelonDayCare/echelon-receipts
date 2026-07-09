export interface Student {
  id: number;
  name: string;
  father_name: string | null;
  mother_name: string | null;
  email: string | null;
  year: number;
  active: number;
  withdrawn_at: string | null;
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
  issuer_snapshot_json: string | null;
  deposited_at?: string | null;
  deposit_id?: number | null;
}

export interface Deposit {
  id: number;
  deposit_date: string;
  cheque_count: number;
  total_amount: number;
  notes: string | null;
  voided: number;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
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
  issuer_snapshot_json?: string | null;
}

export type SettingsMap = Record<string, string>;

export interface Staff {
  id: number;
  name: string;
  role: string | null;
  hourly_rate: number | null;
  active: number;
  terminated_at: string | null;
  whatsapp_phone_e164: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface StaffHour {
  id: number;
  staff_id: number;
  work_date: string;
  in_time: string | null;
  out_time: string | null;
  hours_decimal: number;
  source: string;
  sheet_image_path: string | null;
  notes: string | null;
  no_lunch?: number;
  created_at: string;
}

export interface StaffCredential {
  id: number;
  staff_id: number;
  type: string;
  issued_date: string | null;
  expiry_date: string | null;
  file_path: string | null;
  notes: string | null;
  created_at: string;
}


export interface StaffMeeting {
  id: number;
  meeting_date: string;
  title: string;
  agenda: string | null;
  notes: string | null;
  attendees_json: string | null;
  voided: number;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface StaffMeetingAction {
  id: number;
  meeting_id: number;
  text: string;
  owner_staff_id: number | null;
  due_date: string | null;
  done: number;
  done_at: string | null;
  created_at: string;
}
