# Changelog

All notable changes shipped as a DMG. Only entries the owner has approved
for release are listed here — "code-complete, awaiting ship approval" work
lives in the session plan.md until it ships.

## v1.1.0 — Document Vault (code-complete, awaiting ship approval)

**First module built on the Phase-2 Data Contract** (UUID PKs, UTC ISO
timestamps, soft delete, optimistic concurrency, per-entity event log,
content-addressable blob storage).

### Added
- **Document Vault** sidebar module — upload, tag, and centrally track
  licences, insurance policies, internal policies, staff & child records,
  vendor contracts, financial docs, incident reports, board minutes, and more.
- Content-addressable blob store (SHA-256): re-uploading the same PDF is
  detected automatically and offers a "just update the metadata" path.
- Version history per document: uploading a new version preserves the old
  copy and marks the new one as current — old versions remain accessible.
- Bulk **Export ZIP** for licensing inspections. Human-readable filenames
  (`category/title__v1.pdf`) organised by category.
- Inline preview for PDFs and images; download for everything else.
- Home dashboard alert: "N documents expire within 60 days" (danger for
  already-expired, warn for upcoming).
- Full audit log per document (created / updated / deleted / new_version /
  downloaded / exported / restored).
- Soft-delete with a "Show deleted (restore within 30 days)" filter chip
  in the Library sidebar.

### Technical
- Migration 019 in `src/lib/db.ts`: new tables `documents`,
  `document_events`, `blobs`; new column `staff_credentials.document_id`.
- New `src/repo/documentsRepo.ts` — typed repository, no raw SQL leaks
  to UI code.
- New Rust command `documents_export_zip` (uses the `zip` crate).
- Optimistic concurrency: two simultaneous metadata edits — second save
  errors "Document was changed by another writer. Please reload."

### Deferred (documented debts, not yet built)
- Blob garbage collection when `ref_count = 0` — Phase 1 cleanup train.
- Full-text search inside PDF content — Phase 2.
- Staff → Credentials "attach source PDF" button — coming in v1.1.1
  once the Vault UX has real-world use behind it.
- Large-file (>25 MB) support — Phase 2 with Azure Blob.
