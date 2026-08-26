import { getDb } from '../connection';
import { asRow } from '../rows';
import type { NoteVersion } from '../../../shared/types';

const row = (r: unknown): NoteVersion => asRow<NoteVersion>(r);

// Snapshots are time-throttled so a typing burst (autosave fires ~every 600ms of pause)
// collapses into one snapshot rather than dozens. We also keep only the most recent few
// per note — this is lightweight "undo to earlier today", not full history.
const SNAPSHOT_THROTTLE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_VERSIONS = 30;

export function listNoteVersions(noteId: string): NoteVersion[] {
  return (
    getDb()
      .prepare('SELECT * FROM note_versions WHERE note_id = ? ORDER BY created_at DESC')
      .all(noteId) as unknown[]
  ).map(row);
}

export function getNoteVersion(id: string): NoteVersion | null {
  const r = getDb().prepare('SELECT * FROM note_versions WHERE id = ?').get(id);
  return r ? row(r) : null;
}

function latestVersionTime(noteId: string): number | null {
  const r = getDb()
    .prepare('SELECT created_at FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(noteId) as { created_at: string } | undefined;
  return r ? new Date(r.created_at).getTime() : null;
}

function prune(noteId: string): void {
  getDb()
    .prepare(
      `DELETE FROM note_versions
       WHERE note_id = ? AND id NOT IN (
         SELECT id FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT ?
       )`
    )
    .run(noteId, noteId, MAX_VERSIONS);
}

/**
 * Record a snapshot of a note's content. Skipped if a snapshot was taken within the throttle
 * window, unless `force` is set (used before a restore, so the restore is itself reversible).
 */
export function snapshotNoteContent(noteId: string, contentJson: string, force = false): void {
  if (!force) {
    const last = latestVersionTime(noteId);
    if (last !== null && Date.now() - last < SNAPSHOT_THROTTLE_MS) return;
  }
  getDb()
    .prepare('INSERT INTO note_versions (id, note_id, content_json, created_at) VALUES (?, ?, ?, ?)')
    .run(crypto.randomUUID(), noteId, contentJson, new Date().toISOString());
  prune(noteId);
}

/**
 * The content of every stored snapshot. Feeds the asset sweep: a version is a document
 * that can still be put back on screen, so anything it points at is still live — even
 * when the note's current content has long since dropped it.
 */
export function listAllVersionContentJson(): string[] {
  const rows = getDb()
    .prepare('SELECT content_json FROM note_versions')
    .all() as { content_json: string }[];
  return rows.map((r) => r.content_json);
}
