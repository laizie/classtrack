import { getDb } from '../connection';
import { asRow } from '../rows';
import { blocksToPlainText } from '../../../shared/notes';
import { snapshotNoteContent, getNoteVersion } from './noteVersionRepo';
import type { Note, NoteWithCourse, CreateNoteInput, UpdateNoteInput } from '../../../shared/types';

const row = (r: unknown): Note => asRow<Note>(r);

export interface NoteFilters {
  archived?: boolean;
}

export function listNotes(filters: NoteFilters = {}): Note[] {
  // Default view hides archived (trashed) notes; { archived: true } shows only those.
  const sql = filters.archived
    ? 'SELECT * FROM notes WHERE archived_at IS NOT NULL ORDER BY updated_at DESC'
    : 'SELECT * FROM notes WHERE archived_at IS NULL ORDER BY updated_at DESC';
  return (getDb().prepare(sql).all() as unknown[]).map(row);
}

/**
 * All non-archived notes, newest first, each tagged with the course it's filed under.
 * The course comes from the note's most-recent 'course' link (null for a loose note).
 * Drives cross-class lists that color-code notes by class (e.g. the Notes landing page).
 */
export function listNotesWithCourse(): NoteWithCourse[] {
  const sql = `
    SELECT n.*,
      (SELECT l.entity_id
         FROM note_links l
        WHERE l.note_id = n.id AND l.entity_type = 'course'
        ORDER BY l.created_at DESC
        LIMIT 1) AS course_id
    FROM notes n
    WHERE n.archived_at IS NULL
    ORDER BY n.updated_at DESC`;
  return (getDb().prepare(sql).all() as unknown[]).map((r) => r as NoteWithCourse);
}

export function getNote(id: string): Note | null {
  const r = getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id);
  return r ? row(r) : null;
}

/** Direct sub-pages of a note (the Pages tree), newest-updated first. */
export function listChildNotes(parentId: string): Note[] {
  return (
    getDb()
      .prepare('SELECT * FROM notes WHERE parent_note_id = ? AND archived_at IS NULL ORDER BY updated_at DESC')
      .all(parentId) as unknown[]
  ).map(row);
}

/**
 * Top-level notes not attached to any course — the "Loose notes" bucket. Excludes archived
 * notes and sub-pages (those show under their parent), and anything with a course link.
 */
export function listLooseNotes(): Note[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM notes
         WHERE archived_at IS NULL
           AND parent_note_id IS NULL
           AND id NOT IN (SELECT note_id FROM note_links WHERE entity_type = 'course')
         ORDER BY is_pinned DESC, updated_at DESC`
      )
      .all() as unknown[]
  ).map(row);
}

// FTS5's MATCH grammar would choke on raw user input (bare punctuation, unbalanced
// quotes). We turn the query into a safe prefix search: each whitespace-separated token
// becomes a quoted phrase with a trailing '*', so "graph the" matches "graph theory".
function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => '"' + t.replace(/"/g, '""') + '"*')
    .join(' ');
}

export function searchNotes(query: string): Note[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  return (
    getDb()
      .prepare(
        `SELECT n.* FROM notes n
         JOIN notes_fts ON notes_fts.rowid = n.rowid
         WHERE notes_fts MATCH ? AND n.archived_at IS NULL
         ORDER BY rank`
      )
      .all(match) as unknown[]
  ).map(row);
}

export function createNote(input: CreateNoteInput): Note {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // New notes default to the day they were made (local date) so they land on the class
  // timeline; the editor lets the user change or clear it afterward. An explicit value
  // (e.g. a lecture note's session date) still wins.
  const d = new Date();
  const localToday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const noteDate = input.noteDate ?? localToday;
  const contentJson = input.contentJson ?? '[]';
  // content_text is derived, never trusted from the caller — recompute it here so search
  // can never drift from the actual document.
  const contentText = blocksToPlainText(contentJson);

  getDb()
    .prepare(
      `INSERT INTO notes (id, title, content_json, content_text, icon, parent_note_id, note_date, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(
      id,
      input.title?.trim() || 'Untitled',
      contentJson,
      contentText,
      input.icon ?? null,
      input.parentNoteId ?? null,
      noteDate,
      now,
      now,
    );
  return getNote(id)!;
}

export function updateNote(id: string, input: UpdateNoteInput): Note {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (input.title !== undefined) {
    fields.push('title = ?');
    values.push(input.title.trim() || 'Untitled');
  }
  if (input.contentJson !== undefined) {
    fields.push('content_json = ?');
    values.push(input.contentJson);
    // Keep the derived plaintext in lock-step with the document on every content change.
    fields.push('content_text = ?');
    values.push(blocksToPlainText(input.contentJson));
  }
  if (input.icon !== undefined) {
    fields.push('icon = ?');
    values.push(input.icon ?? null);
  }
  if (input.parentNoteId !== undefined) {
    fields.push('parent_note_id = ?');
    values.push(input.parentNoteId ?? null);
  }
  if (input.noteDate !== undefined) {
    fields.push('note_date = ?');
    values.push(input.noteDate ?? null);
  }
  if (input.pinned !== undefined) {
    // SQLite has no boolean — store 0/1, matching note_links.is_pinned.
    fields.push('is_pinned = ?');
    values.push(input.pinned ? 1 : 0);
  }
  if (input.archived !== undefined) {
    fields.push('archived_at = ?');
    values.push(input.archived ? new Date().toISOString() : null);
  }

  if (fields.length > 0) {
    // Any edit bumps updated_at — that's what the note list sorts by.
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    getDb().prepare(`UPDATE notes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  // Snapshot saved document states for restore (throttled inside snapshotNoteContent).
  if (input.contentJson !== undefined) {
    snapshotNoteContent(id, input.contentJson);
  }

  return getNote(id)!;
}

/**
 * Restore a note to a previous snapshot. The current content is snapshotted first (forced),
 * so the restore can itself be undone. Returns the restored note.
 */
export function restoreNoteVersion(noteId: string, versionId: string): Note {
  const version = getNoteVersion(versionId);
  if (!version || version.note_id !== noteId) throw new Error('Version not found for this note');

  const current = getNote(noteId);
  if (!current) throw new Error('Note not found');
  snapshotNoteContent(noteId, current.content_json, true);

  getDb()
    .prepare('UPDATE notes SET content_json = ?, content_text = ?, updated_at = ? WHERE id = ?')
    .run(version.content_json, blocksToPlainText(version.content_json), new Date().toISOString(), noteId);

  return getNote(noteId)!;
}

// A note plus every sub-page beneath it (recursive). Used before delete so the caller can
// clean up each note's image folder — the DB cascade removes the rows, but not the files.
export function listNoteAndDescendantIds(id: string): string[] {
  const rows = getDb()
    .prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM notes WHERE id = ?
         UNION ALL
         SELECT n.id FROM notes n JOIN descendants d ON n.parent_note_id = d.id
       )
       SELECT id FROM descendants`
    )
    .all(id) as { id: string }[];
  return rows.map((r) => r.id);
}

export function deleteNote(id: string): void {
  // ON DELETE CASCADE removes child sub-pages; the FTS triggers clean the index.
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(id);
}

/**
 * The content of every note in the database — archived ones included.
 *
 * Only used to work out which asset files are still referenced, so this deliberately
 * ignores the archived filter every other query here respects: archiving is a
 * recoverable trash, and a note sitting in it must keep its images for the day it's
 * restored.
 */
export function listAllContentJson(): string[] {
  const rows = getDb().prepare('SELECT content_json FROM notes').all() as { content_json: string }[];
  return rows.map((r) => r.content_json);
}
