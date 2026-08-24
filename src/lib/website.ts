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
  "gallery-videos",
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

export function websiteCheckDraftStaleness(
  file: EditableFile,
): Promise<boolean> {
  return invoke<boolean>("website_check_draft_staleness", { file });
}

export function websiteSaveDraft(req: {
  file: EditableFile;
  content_json: string;
  author?: string;
}): Promise<SaveDraftResponse> {
  return invoke<SaveDraftResponse>("website_save_draft", { req });
}

export interface AiEditResponse {
  page: string;
  original_json: string;
  proposed_json: string;
  summary: string;
  model: string;
  site_original_json?: string | null;
  site_proposed_json?: string | null;
}

export function websiteAiEditContent(
  page: EditableFile,
  userPrompt: string,
): Promise<AiEditResponse> {
  return invoke<AiEditResponse>("website_ai_edit_content", {
    request: { page, user_prompt: userPrompt },
  });
}

// ── Virtual Tour videos (v3.22.0) ─────────────────────────────────────
export interface TourVideo {
  id: string;
  title: string;
  description: string;
  src: string;
  poster: string;
}
export interface TourAddResponse {
  added: TourVideo[];
  revision_id: number;
}
export function websiteTourListVideos(): Promise<TourVideo[]> {
  return invoke<TourVideo[]>("website_tour_list_videos");
}
export function websiteTourAddVideos(paths: string[]): Promise<TourAddResponse> {
  return invoke<TourAddResponse>("website_tour_add_videos", {
    request: { paths },
  });
}
export function websiteTourDeleteVideo(id: string): Promise<number> {
  return invoke<number>("website_tour_delete_video", {
    request: { id },
  });
}
export function websiteTourReorderVideos(ids: string[]): Promise<number> {
  return invoke<number>("website_tour_reorder_videos", {
    request: { ids },
  });
}

// ── Gallery videos (v3.23.0) ─────────────────────────────────────────
export function websiteGalleryVideosList(): Promise<TourVideo[]> {
  return invoke<TourVideo[]>("website_gallery_videos_list");
}
export function websiteGalleryVideosAdd(paths: string[]): Promise<TourAddResponse> {
  return invoke<TourAddResponse>("website_gallery_videos_add", {
    request: { paths },
  });
}
export function websiteGalleryVideosDelete(id: string): Promise<number> {
  return invoke<number>("website_gallery_videos_delete", {
    request: { id },
  });
}
export function websiteGalleryVideosReorder(ids: string[]): Promise<number> {
  return invoke<number>("website_gallery_videos_reorder", {
    request: { ids },
  });
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

// ─────────────────────────────────────────────────────────────────────
// Media pipeline (PR 3)
// ─────────────────────────────────────────────────────────────────────

export type MediaKind =
  | "photo"
  | "video"
  | "pdf"
  | "logo"
  | "favicon"
  | "og_image";

export type MediaVariant = {
  id: number;
  width: number;
  format: string;
  filename: string;
  bytes_len: number;
};

export type MediaRecord = {
  id: number;
  base_hash: string;
  source_filename: string;
  kind: string;
  caption: string | null;
  alt: string | null;
  focal_x: number | null;
  focal_y: number | null;
  width: number | null;
  height: number | null;
  original_bytes_len: number | null;
  exif_stripped: boolean;
  created_at: string;
  deleted_at: string | null;
  variants: MediaVariant[];
};

export function websiteListMedia(kind?: MediaKind): Promise<MediaRecord[]> {
  return invoke<MediaRecord[]>("website_list_media", { kind });
}

export function websiteUploadPhoto(
  sourcePath: string,
  caption?: string,
  alt?: string,
): Promise<MediaRecord> {
  return invoke<MediaRecord>("website_upload_photo", {
    sourcePath,
    caption,
    alt,
  });
}

export function websiteUploadPhotos(
  sourcePaths: string[],
): Promise<MediaRecord[]> {
  return invoke<MediaRecord[]>("website_upload_photos", { sourcePaths });
}

export function websiteReorderGallery(
  orderedMediaIds: number[],
): Promise<void> {
  return invoke("website_reorder_gallery", { orderedMediaIds });
}

export function websiteEditMedia(
  mediaId: number,
  caption?: string,
  alt?: string,
  focal?: [number, number] | null,
): Promise<MediaRecord> {
  return invoke<MediaRecord>("website_edit_media", {
    mediaId,
    caption,
    alt,
    focal: focal ?? null,
  });
}

export function websiteDeleteMedia(mediaId: number): Promise<void> {
  return invoke("website_delete_media", { mediaId });
}

export function websiteBulkDeleteMedia(mediaIds: number[]): Promise<number> {
  return invoke<number>("website_bulk_delete_media", { mediaIds });
}

/// True iff the working-copy git tree has un-pushed changes under
/// `assets/img/`, `assets/video/`, or `content/gallery.json` — i.e.
/// there are pending media edits the Overview/Publish screens should
/// badge alongside JSON-draft rows.
export function websiteHasPendingMedia(): Promise<boolean> {
  return invoke<boolean>("website_has_pending_media");
}

export function websiteEmergencyRemove(
  mediaId: number,
  reason: string,
): Promise<void> {
  return invoke("website_emergency_remove", { mediaId, reason });
}

export function websiteReplaceLogo(sourcePath: string): Promise<MediaRecord> {
  return invoke<MediaRecord>("website_replace_logo", { sourcePath });
}

export function websiteReplaceFavicon(
  sourcePath: string,
): Promise<MediaRecord> {
  return invoke<MediaRecord>("website_replace_favicon", { sourcePath });
}

export function websiteReplaceOgImage(
  sourcePath: string,
): Promise<MediaRecord> {
  return invoke<MediaRecord>("website_replace_og_image", { sourcePath });
}

export function websiteReplaceAboutPhoto(
  slot: 1 | 2 | 3,
  sourcePath: string,
): Promise<string> {
  return invoke<string>("website_replace_about_photo", { slot, sourcePath });
}

export function websiteReplaceHomeGalleryPhoto(
  slug: string,
  sourcePath: string,
): Promise<string> {
  return invoke<string>("website_replace_home_gallery_photo", { slug, sourcePath });
}

export function websiteReplaceHomeHeroBanner(
  sourcePath: string,
): Promise<string> {
  return invoke<string>("website_replace_home_hero_banner", { sourcePath });
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
