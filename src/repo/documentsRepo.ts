// Document Vault repository (v1.1.0). Only screen-friendly typed calls live
// here — UI never issues raw SQL against documents/blobs. See
// C:/…/session-state/…/spec-1-document-vault.md for the full contract.
import { db, execRetry, serializeWrite } from "../lib/db";
import { uuidv4, nowIso, sha256Hex, StaleWriteError } from "./ids";

export type DocCategory =
  | "license" | "insurance" | "policy" | "staff" | "child"
  | "vendor" | "financial" | "incident" | "board" | "other";

export const DOC_CATEGORIES: { value: DocCategory; label: string }[] = [
  { value: "license",   label: "License" },
  { value: "insurance", label: "Insurance" },
  { value: "policy",    label: "Policy" },
  { value: "staff",     label: "Staff" },
  { value: "child",     label: "Child" },
  { value: "vendor",    label: "Vendor" },
  { value: "financial", label: "Financial" },
  { value: "incident",  label: "Incident" },
  { value: "board",     label: "Board" },
  { value: "other",     label: "Other" },
];

export type LinkedKind = "student" | "staff" | "vendor";

export type Document = {
  id: string;
  title: string;
  category: DocCategory;
  linkedKind: LinkedKind | null;
  linkedId: string | null;
  blobKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  issuedDate: string | null;
  expiryDate: string | null;
  issuer: string | null;
  referenceNo: string | null;
  notes: string | null;
  tags: string[];
  parentDocumentId: string | null;
  versionNo: number;
  isCurrent: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
  deletedAt: string | null;
};

export type DocFilter = {
  category?: DocCategory;
  linkedKind?: LinkedKind;
  linkedId?: string;
  search?: string;
  expiringWithinDays?: number;   // includes already-expired
  tags?: string[];
  includeOldVersions?: boolean;  // default false
  includeDeleted?: boolean;      // default false — restore filter uses this
  onlyDeleted?: boolean;         // for the Deleted view
};

export type NewDocument = {
  title: string;
  category: DocCategory;
  linkedKind: LinkedKind | null;
  linkedId: string | null;
  blobKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  issuedDate?: string | null;
  expiryDate?: string | null;
  issuer?: string | null;
  referenceNo?: string | null;
  notes?: string | null;
  tags?: string[];
};

type Row = {
  id: string; title: string; category: string;
  linked_kind: string | null; linked_id: string | null;
  blob_key: string; file_name: string; mime_type: string; size_bytes: number;
  issued_date: string | null; expiry_date: string | null;
  issuer: string | null; reference_no: string | null; notes: string | null;
  tags_json: string;
  parent_document_id: string | null;
  version_no: number; is_current: number;
  created_at: string; updated_at: string; updated_by: string;
  version: number; deleted_at: string | null;
};

function rowToDoc(r: Row): Document {
  let tags: string[] = [];
  try { tags = JSON.parse(r.tags_json || "[]"); } catch { /* keep [] */ }
  return {
    id: r.id, title: r.title, category: r.category as DocCategory,
    linkedKind: (r.linked_kind as LinkedKind | null) ?? null,
    linkedId: r.linked_id, blobKey: r.blob_key,
    fileName: r.file_name, mimeType: r.mime_type, sizeBytes: r.size_bytes,
    issuedDate: r.issued_date, expiryDate: r.expiry_date,
    issuer: r.issuer, referenceNo: r.reference_no, notes: r.notes,
    tags, parentDocumentId: r.parent_document_id,
    versionNo: r.version_no, isCurrent: r.is_current === 1,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
    version: r.version,
    deletedAt: r.deleted_at,
  };
}

async function writeEvent(entityId: string, eventType: string, payload?: unknown) {
  await execRetry(
    "INSERT INTO document_events (id, entity_id, event_type, payload_json, actor, created_at) VALUES (?, ?, ?, ?, 'owner', ?)",
    [uuidv4(), entityId, eventType, payload === undefined ? null : JSON.stringify(payload), nowIso()],
  );
}

export async function findDuplicateByHash(sha256: string): Promise<Document | null> {
  const d = await db();
  const rows = await d.select<Row[]>(
    // Prefer the current row for that blob if one exists so callers can offer
    // "update metadata" against the live version instead of an old revision.
    `SELECT * FROM documents WHERE blob_key = ? AND deleted_at IS NULL
       ORDER BY is_current DESC, version_no DESC LIMIT 1`,
    [sha256],
  );
  return rows.length ? rowToDoc(rows[0]) : null;
}

export async function ensureBlob(bytes: Uint8Array, mimeType: string): Promise<{ blobKey: string; sizeBytes: number }> {
  const blobKey = await sha256Hex(bytes);
  await serializeWrite(async () => {
    const d = await db();
    const existing = await d.select<{ blob_key: string }[]>(
      "SELECT blob_key FROM blobs WHERE blob_key = ?", [blobKey],
    );
    if (existing.length === 0) {
      // tauri-plugin-sql accepts number[] for BLOB params; force to plain
      // array so it round-trips regardless of plugin version.
      const arr = Array.from(bytes);
      await d.execute(
        "INSERT INTO blobs (blob_key, content, size_bytes, mime_type, ref_count, created_at) VALUES (?, ?, ?, ?, 0, ?)",
        [blobKey, arr, bytes.length, mimeType, nowIso()],
      );
    }
  });
  return { blobKey, sizeBytes: bytes.length };
}

export async function getBlob(blobKey: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const d = await db();
  const rows = await d.select<{ content: number[]; mime_type: string }[]>(
    "SELECT content, mime_type FROM blobs WHERE blob_key = ?", [blobKey],
  );
  if (!rows.length) return null;
  return { bytes: new Uint8Array(rows[0].content), mimeType: rows[0].mime_type };
}

async function bumpRefCount(blobKey: string, delta: number): Promise<void> {
  // C-5: single atomic UPDATE instead of a SELECT-then-UPDATE pair — this
  // eliminates the read-modify-write race between two concurrent callers
  // adjusting the same blob's ref_count. Guarded so a double-decrement bug
  // elsewhere can't drive the count negative (fails closed: 0 rows affected,
  // logged, and left alone rather than corrupting the count silently).
  //
  // We deliberately do NOT delete the blob row when the count reaches 0
  // here: a soft-deleted document can still be restored within the undo
  // window and needs its blob content intact. Permanent blob cleanup
  // belongs in a future hard-delete/purge job (data-contract.md §3), not in
  // this per-mutation helper.
  const res = await execRetry(
    "UPDATE blobs SET ref_count = ref_count + ? WHERE blob_key = ? AND ref_count + ? >= 0",
    [delta, blobKey, delta],
  );
  if (res.rowsAffected === 0) {
    console.warn(`[documentsRepo] bumpRefCount(${blobKey}, ${delta}) affected 0 rows (missing blob, or count would go negative).`);
  }
}

export async function createDocument(doc: NewDocument): Promise<Document> {
  const id = uuidv4();
  const now = nowIso();
  const tags = JSON.stringify(doc.tags ?? []);
  const eventId = uuidv4();
  // M-4: insert + blob ref-count bump + audit event run as one serialized
  // unit so no other writer's statements can interleave between them. We
  // use serializeWrite (not a literal SQL BEGIN/COMMIT) because
  // tauri-plugin-sql's sqlx pool may hand subsequent statements to a
  // different physical connection — see the serializeWrite doc comment at
  // the top of lib/db.ts for why a raw multi-statement transaction here is
  // unsafe on this stack.
  await serializeWrite(async () => {
    const d = await db();
    await d.execute(
      `INSERT INTO documents (
        id, title, category, linked_kind, linked_id,
        blob_key, file_name, mime_type, size_bytes,
        issued_date, expiry_date, issuer, reference_no, notes, tags_json,
        parent_document_id, version_no, is_current,
        created_at, updated_at, updated_by, version, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 1, ?, ?, 'owner', 1, NULL)`,
      [
        id, doc.title, doc.category, doc.linkedKind, doc.linkedId,
        doc.blobKey, doc.fileName, doc.mimeType, doc.sizeBytes,
        doc.issuedDate ?? null, doc.expiryDate ?? null,
        doc.issuer ?? null, doc.referenceNo ?? null, doc.notes ?? null, tags,
        now, now,
      ],
    );
    await d.execute(
      "UPDATE blobs SET ref_count = ref_count + 1 WHERE blob_key = ?",
      [doc.blobKey],
    );
    await d.execute(
      "INSERT INTO document_events (id, entity_id, event_type, payload_json, actor, created_at) VALUES (?, ?, ?, ?, 'owner', ?)",
      [eventId, id, "created", JSON.stringify({ title: doc.title, category: doc.category, blobKey: doc.blobKey }), now],
    );
  });
  const created = await getDocument(id);
  if (!created) throw new Error("createDocument: row disappeared after insert");
  return created;
}

export async function getDocument(id: string): Promise<Document | null> {
  const d = await db();
  const rows = await d.select<Row[]>("SELECT * FROM documents WHERE id = ?", [id]);
  return rows.length ? rowToDoc(rows[0]) : null;
}

export async function listDocuments(filter: DocFilter = {}): Promise<Document[]> {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (filter.onlyDeleted) clauses.push("deleted_at IS NOT NULL");
  else if (!filter.includeDeleted) clauses.push("deleted_at IS NULL");
  if (!filter.includeOldVersions) clauses.push("is_current = 1");
  if (filter.category) { clauses.push("category = ?"); args.push(filter.category); }
  if (filter.linkedKind) { clauses.push("linked_kind = ?"); args.push(filter.linkedKind); }
  if (filter.linkedId) { clauses.push("linked_id = ?"); args.push(filter.linkedId); }
  if (filter.search) {
    const q = `%${filter.search}%`;
    clauses.push("(title LIKE ? OR issuer LIKE ? OR notes LIKE ? OR file_name LIKE ?)");
    args.push(q, q, q, q);
  }
  if (filter.expiringWithinDays !== undefined) {
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + filter.expiringWithinDays);
    clauses.push("expiry_date IS NOT NULL AND expiry_date <= ?");
    args.push(horizon.toISOString().slice(0, 10));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const d = await db();
  const rows = await d.select<Row[]>(
    `SELECT * FROM documents ${where}
      ORDER BY COALESCE(expiry_date, '9999-12-31') ASC, updated_at DESC`,
    args,
  );
  const docs = rows.map(rowToDoc);
  if (filter.tags?.length) {
    const wanted = new Set(filter.tags.map((t) => t.toLowerCase()));
    return docs.filter((doc) => doc.tags.some((t) => wanted.has(t.toLowerCase())));
  }
  return docs;
}

export async function expiringSoon(days: number): Promise<Document[]> {
  return listDocuments({ expiringWithinDays: days });
}

export async function getVersionHistory(documentId: string): Promise<Document[]> {
  const cur = await getDocument(documentId);
  if (!cur) return [];
  const rootId = cur.parentDocumentId ?? cur.id;
  const d = await db();
  const rows = await d.select<Row[]>(
    `SELECT * FROM documents WHERE (id = ? OR parent_document_id = ?) ORDER BY version_no DESC`,
    [rootId, rootId],
  );
  return rows.map(rowToDoc);
}

export type DocPatch = Partial<Pick<Document,
  "title" | "category" | "linkedKind" | "linkedId" | "issuedDate" | "expiryDate" |
  "issuer" | "referenceNo" | "notes" | "tags"
>>;

export async function updateDocumentMetadata(id: string, patch: DocPatch, expectedVersion: number): Promise<Document> {
  const cur = await getDocument(id);
  if (!cur) throw new Error("Document not found");
  const merged: Document = {
    ...cur,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.category !== undefined ? { category: patch.category } : {}),
    ...(patch.linkedKind !== undefined ? { linkedKind: patch.linkedKind } : {}),
    ...(patch.linkedId !== undefined ? { linkedId: patch.linkedId } : {}),
    ...(patch.issuedDate !== undefined ? { issuedDate: patch.issuedDate } : {}),
    ...(patch.expiryDate !== undefined ? { expiryDate: patch.expiryDate } : {}),
    ...(patch.issuer !== undefined ? { issuer: patch.issuer } : {}),
    ...(patch.referenceNo !== undefined ? { referenceNo: patch.referenceNo } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
  };
  const now = nowIso();
  const res = await execRetry(
    `UPDATE documents
        SET title = ?, category = ?, linked_kind = ?, linked_id = ?,
            issued_date = ?, expiry_date = ?, issuer = ?, reference_no = ?,
            notes = ?, tags_json = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?`,
    [
      merged.title, merged.category, merged.linkedKind, merged.linkedId,
      merged.issuedDate, merged.expiryDate, merged.issuer, merged.referenceNo,
      merged.notes, JSON.stringify(merged.tags), now,
      id, expectedVersion,
    ],
  );
  if (res.rowsAffected === 0) throw new StaleWriteError("Document");
  await writeEvent(id, "updated", { patch });
  const after = await getDocument(id);
  if (!after) throw new Error("Document disappeared after update");
  return after;
}

export async function uploadNewVersion(currentDocumentId: string, bytes: Uint8Array, newFileName: string, mimeType: string): Promise<Document> {
  const cur = await getDocument(currentDocumentId);
  if (!cur) throw new Error("Document not found");
  const rootId = cur.parentDocumentId ?? cur.id;
  const { blobKey, sizeBytes } = await ensureBlob(bytes, mimeType);
  const d = await db();
  const mxRows = await d.select<{ mx: number }[]>(
    `SELECT COALESCE(MAX(version_no), 0) AS mx FROM documents
      WHERE (id = ? OR parent_document_id = ?)`,
    [rootId, rootId],
  );
  const mx = mxRows[0]?.mx ?? 0;
  const newId = uuidv4();
  const now = nowIso();
  await serializeWrite(async () => {
    const dd = await db();
    // Mark all prior members of the family as not-current, then insert new
    // version pointing at rootId (never at another version — flat family).
    await dd.execute(
      "UPDATE documents SET is_current = 0, updated_at = ? WHERE id = ? OR parent_document_id = ?",
      [now, rootId, rootId],
    );
    await dd.execute(
      `INSERT INTO documents (
        id, title, category, linked_kind, linked_id,
        blob_key, file_name, mime_type, size_bytes,
        issued_date, expiry_date, issuer, reference_no, notes, tags_json,
        parent_document_id, version_no, is_current,
        created_at, updated_at, updated_by, version, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'owner', 1, NULL)`,
      [
        newId, cur.title, cur.category, cur.linkedKind, cur.linkedId,
        blobKey, newFileName, mimeType, sizeBytes,
        cur.issuedDate, cur.expiryDate, cur.issuer, cur.referenceNo, cur.notes,
        JSON.stringify(cur.tags),
        rootId, mx + 1,
        now, now,
      ],
    );
  });
  await bumpRefCount(blobKey, +1);
  await writeEvent(newId, "new_version", { previousId: currentDocumentId, versionNo: mx + 1 });
  const after = await getDocument(newId);
  if (!after) throw new Error("New version disappeared after insert");
  return after;
}

export async function softDeleteDocument(id: string): Promise<void> {
  const cur = await getDocument(id);
  if (!cur) return;
  const now = nowIso();
  await execRetry(
    "UPDATE documents SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL",
    [now, now, id],
  );
  await bumpRefCount(cur.blobKey, -1);
  await writeEvent(id, "deleted", { title: cur.title });
}

export async function restoreDocument(id: string): Promise<Document> {
  const cur = await getDocument(id);
  if (!cur) throw new Error("Document not found");
  const now = nowIso();
  await execRetry(
    "UPDATE documents SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?",
    [now, id],
  );
  await bumpRefCount(cur.blobKey, +1);
  await writeEvent(id, "restored", {});
  const after = await getDocument(id);
  if (!after) throw new Error("Document disappeared after restore");
  return after;
}

export type DocEvent = {
  id: string; entityId: string; eventType: string;
  payload: unknown; actor: string; channel: string | null;
  messageRef: string | null; createdAt: string;
};

export async function listDocumentEvents(documentId: string): Promise<DocEvent[]> {
  const d = await db();
  const rows = await d.select<{
    id: string; entity_id: string; event_type: string; payload_json: string | null;
    actor: string; channel: string | null; message_ref: string | null; created_at: string;
  }[]>("SELECT * FROM document_events WHERE entity_id = ? ORDER BY created_at DESC", [documentId]);
  return rows.map((r) => ({
    id: r.id, entityId: r.entity_id, eventType: r.event_type,
    payload: r.payload_json ? safeJson(r.payload_json) : null,
    actor: r.actor, channel: r.channel, messageRef: r.message_ref, createdAt: r.created_at,
  }));
}
function safeJson(s: string) { try { return JSON.parse(s); } catch { return s; } }

// Distinct tag list across live current versions (for the filter chip cloud).
export async function listAllTags(): Promise<string[]> {
  const docs = await listDocuments({});
  const set = new Set<string>();
  docs.forEach((doc) => doc.tags.forEach((t) => set.add(t)));
  return Array.from(set).sort();
}

// Records an event for consumer-side actions that don't mutate document rows.
export async function recordEvent(documentId: string, eventType: string, payload?: unknown): Promise<void> {
  await writeEvent(documentId, eventType, payload);
}
