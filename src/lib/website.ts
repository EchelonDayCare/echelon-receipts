// Website CMS invoke wrappers.
//
// Mirror the Rust command shapes in src-tauri/src/website/commands.rs.
// The frontend never manipulates working-copy paths directly — every
// filesystem, git, keychain, and preview action goes through one of
// these wrappers.

import { invoke } from "@tauri-apps/api/core";

export const EDITABLE_FILES = [
  "site",
  "home",
  "about",
  "services",
  "contact",
  "tour",
  "careers",
  "seo",
] as const;
export type EditableFile = (typeof EDITABLE_FILES)[number];

export type WorkingCopyStatus = {
  root: string;
  cloned: boolean;
  head_sha: string | null;
  content_present: boolean;
  templates_present: boolean;
};

export type ContentFile = {
  file: EditableFile;
  content_json: string;
  source: "draft" | "working_copy";
  active_draft_rev: number | null;
};

export type SaveDraftResponse = {
  revision_id: number;
  file: EditableFile;
};

export type RevisionRow = {
  id: number;
  file: string;
  created_at: string;
  author: string | null;
  preview: string;
};

export type PointerRow = {
  file: string;
  active_draft_rev: number | null;
  last_pushed_rev: number | null;
  last_verified_live_rev: number | null;
  updated_at: string;
};

export type PublicationRow = {
  id: number;
  started_at: string;
  ended_at: string | null;
  state: string;
  commit_sha: string | null;
  error: string | null;
  verified_url: string | null;
};

export type PipelineOutcome = {
  publication_id: number;
  final_state: string;
  commit_sha: string | null;
  verified_url: string | null;
  error: string | null;
  pages_written: string[];
};

export type PreviewInfo = {
  url: string;
  port: number;
  render_dir: string;
  pages: string[];
};

export type PatVerification = {
  ok: boolean;
  message: string;
  can_push: boolean;
  user_login: string | null;
};

// Feature flag — read once at boot. Cached so we don't spam the
// backend every render tick.
let _featureCache: boolean | null = null;
export async function isWebsiteCmsEnabled(): Promise<boolean> {
  if (_featureCache !== null) return _featureCache;
  try {
    _featureCache = await invoke<boolean>("website_feature_enabled");
  } catch {
    _featureCache = false;
  }
  return _featureCache;
}

export function websiteWorkingCopyStatus(): Promise<WorkingCopyStatus> {
  return invoke<WorkingCopyStatus>("website_working_copy_status");
}

export function websiteWorkingCopyInit(): Promise<WorkingCopyStatus> {
  return invoke<WorkingCopyStatus>("website_working_copy_init");
}

export function websiteWorkingCopyPull(): Promise<string> {
  return invoke<string>("website_working_copy_pull");
}

export function websiteLoadContent(file: EditableFile): Promise<ContentFile> {
  return invoke<ContentFile>("website_load_content", { file });
}

export function websiteSaveDraft(req: {
  file: EditableFile;
  content_json: string;
  author?: string;
}): Promise<SaveDraftResponse> {
  return invoke<SaveDraftResponse>("website_save_draft", { req });
}

export function websiteListRevisions(
  file: EditableFile,
  limit = 100,
): Promise<RevisionRow[]> {
  return invoke<RevisionRow[]>("website_list_revisions", { file, limit });
}

export function websiteLoadRevision(revId: number): Promise<string> {
  return invoke<string>("website_load_revision", { revId });
}

export function websiteRestoreRevision(
  revId: number,
  author?: string,
): Promise<number> {
  return invoke<number>("website_restore_revision", { revId, author });
}

export function websiteListPointers(): Promise<PointerRow[]> {
  return invoke<PointerRow[]>("website_list_pointers");
}

export function websiteStartPreview(): Promise<PreviewInfo> {
  return invoke<PreviewInfo>("website_start_preview");
}

export function websiteStopPreview(): Promise<void> {
  return invoke("website_stop_preview");
}

export function websitePublish(req: {
  commit_message: string;
  author_display?: string;
  dry_run?: boolean;
}): Promise<PipelineOutcome> {
  return invoke<PipelineOutcome>("website_publish", { req });
}

export function websiteListPublications(limit = 50): Promise<PublicationRow[]> {
  return invoke<PublicationRow[]>("website_list_publications", { limit });
}

export function websitePatStatus(): Promise<{ connected: boolean }> {
  return invoke<{ connected: boolean }>("website_pat_status");
}

export function websitePatVerifyAndStore(
  token: string,
): Promise<PatVerification> {
  return invoke<PatVerification>("website_pat_verify_and_store", { token });
}

export function websitePatDisconnect(): Promise<void> {
  return invoke("website_pat_disconnect");
}

/// Small helper: try to pretty-print a JSON blob for the editor
/// textarea. If parse fails, hand back the raw string so the user
/// can still salvage their edits.
export function tryPrettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
