import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useCreateBlockNote,
  SuggestionMenuController,
  SideMenuController,
  SideMenu,
  getDefaultReactSlashMenuItems,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { filterSuggestionItems } from '@blocknote/core';
// eslint-disable-next-line import/no-unresolved -- subpath export; resolved by TS via the package "exports" map
import { en } from '@blocknote/core/locales';
import { History, CalendarDays, X, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { studeoSchema } from './codeBlock';
import ImageLightbox from './ImageLightbox';
import NoteLinkBar from './NoteLinkBar';
import LinkPickerDialog, { type PickItem } from './LinkPickerDialog';
import NotePickerDialog from './NotePickerDialog';
import VersionHistoryDialog from './VersionHistoryDialog';
import SlideImportDialog, { type SlideImportState } from './SlideImportDialog';
import { renderPdfSlides, pdfPageCount } from '../../lib/pdf';
import { clampSlideText } from './slideBlock';
import { studeoSlashItems } from './noteSlashItems';
import { TurnIntoDragHandleMenu } from './TurnIntoMenu';
import { useCaretAutoScroll } from './useCaretAutoScroll';
import { useUpdateNote, useRestoreNoteVersion } from '../../lib/queries/useNotes';
import { useCreateNoteLink } from '../../lib/queries/useNoteLinks';
import { useCourses } from '../../lib/queries/useCourses';
import { useAssignments } from '../../lib/queries/useAssignments';
import { useCreateTask } from '../../lib/queries/useTasks';
import { useSettingsStore } from '../../store/useSettingsStore';
import { isDarkTheme } from '../../../shared/themes';
import { computeDeadlineLabel, formatDueDate } from '../../../shared/deadlines';
import { detectCodeLanguage } from '../../../shared/detectLanguage';
import type { Note, NoteVersion } from '../../../shared/types';
import './blocknote-theme.css';
// eslint-disable-next-line import/no-unresolved -- Vite resolves CSS side-effect imports at build time
import '@blocknote/core/fonts/inter.css';
// eslint-disable-next-line import/no-unresolved -- Vite resolves CSS side-effect imports at build time
import '@blocknote/mantine/style.css';

const AUTOSAVE_MS = 600;

// Best-effort file extension: prefer the filename, fall back to the MIME subtype
// (e.g. a pasted screenshot arrives as "image/png" with no name). Main validates it.
function fileExt(file: File): string {
  const fromName = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
  if (fromName) return fromName;
  const sub = file.type.split('/')[1] ?? '';
  return sub;
}

// Today as a local YYYY-MM-DD (tasks store a date-only due date).
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Cozy relative "edited" time for the note meta line. updated_at is a full ISO
// string (new Date().toISOString() in the repo), so Date parsing is reliable.
function formatEditedAt(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const min = Math.round((Date.now() - then.getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day} days ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Plain text of a BlockNote block's inline content. The content shape is BlockNote-internal,
// so this reads it loosely rather than importing its generic types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote inline content is loosely typed here
function blockPlainText(content: any): string {
  if (!Array.isArray(content)) return '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- inline item shape varies (text/link)
  return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('').trim();
}

// Ids of every slide block in a document, at any nesting depth. Drives the collapse-all
// control, which only appears once a note actually holds slides. Walks loosely rather than
// against BlockNote's generic Block type, for the same reason blockPlainText does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote blocks are generically typed
function collectSlideIds(blocks: any[]): string[] {
  const ids: string[] = [];
  for (const block of blocks ?? []) {
    if (block?.type === 'slide') ids.push(block.id);
    if (Array.isArray(block?.children)) ids.push(...collectSlideIds(block.children));
  }
  return ids;
}

// A note with an empty/blank document should start with BlockNote's default empty paragraph
// (pass undefined), not an empty array — an empty array is not valid initial content.
function parseInitial(contentJson: string) {
  try {
    const blocks = JSON.parse(contentJson);
    return Array.isArray(blocks) && blocks.length > 0 ? blocks : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The editing surface for a single note. Mounted with `key={note.id}` by the page so that
 * switching notes remounts a fresh editor (BlockNote's initial content is set once at
 * creation). Saves are debounced and also flushed on unmount (navigate-away).
 */
export default function NoteEditor({ note }: { note: Note }) {
  const navigate = useNavigate();
  const theme = useSettingsStore((s) => s.theme);
  const updateNote = useUpdateNote();
  const linkNote = useCreateNoteLink();
  const createTask = useCreateTask();
  const restoreVersion = useRestoreNoteVersion();
  const { data: courses } = useCourses();
  const { data: assignments } = useAssignments();

  // "Untitled" is the DB default/placeholder — show it as an empty field, not literal text.
  const initialTitle = note.title === 'Untitled' ? '' : note.title;
  const [title, setTitle] = useState(initialTitle);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // Slash-command UI: which link picker is open, the /Due date prompt, and a transient toast.
  const [picker, setPicker] = useState<'course' | 'assignment' | null>(null);
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [noteDate, setNoteDate] = useState(note.note_date);
  const [flash, setFlash] = useState<string | null>(null);
  // Slide import: progress for the dialog, and whether the note holds any slides at all
  // (which is what decides if the collapse-all control is worth showing).
  const [slideImport, setSlideImport] = useState<SlideImportState | null>(null);
  const [hasSlides, setHasSlides] = useState(
    () => collectSlideIds(parseInitial(note.content_json) ?? []).length > 0,
  );
  const slideAbort = useRef<AbortController | null>(null);

  function showFlash(message: string) {
    setFlash(message);
    setTimeout(() => setFlash((m) => (m === message ? null : m)), 2200);
  }

  const editor = useCreateBlockNote({
    schema: studeoSchema,
    // Friendlier, cozier empty-state prompts than BlockNote's stock copy.
    dictionary: {
      ...en,
      placeholders: {
        ...en.placeholders,
        emptyDocument: 'Start writing… press / for blocks',
        default: 'Write, or press / for blocks',
      },
    },
    initialContent: parseInitial(note.content_json),
    // Drag-drop / paste / file-picker all funnel here. We persist the bytes via the media
    // IPC and hand BlockNote back a studeo-asset:// URL to store in the image block.
    uploadFile: async (file: File) => {
      const data = new Uint8Array(await file.arrayBuffer());
      return window.api.media.save({ noteId: note.id, ext: fileExt(file), data });
    },
  });

  // ── Debounced content autosave ──────────────────────────────────────────────
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const latestJson = useRef(note.content_json);
  // Keep mutate in a ref so the unmount-flush effect can stay [] without going stale.
  const mutate = useRef(updateNote.mutate);
  mutate.current = updateNote.mutate;

  function flushContent() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    mutate.current({ id: note.id, input: { contentJson: latestJson.current } });
  }

  function handleChange() {
    latestJson.current = JSON.stringify(editor.document);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flushContent, AUTOSAVE_MS);
    autoDetectCodeLanguages();
    // Cheap enough to recompute here (a shallow walk of the block tree), and it keeps the
    // collapse-all control honest when the last slide is deleted or the first is pasted in.
    const nowHasSlides = collectSlideIds(editor.document).length > 0;
    setHasSlides((was) => (was === nowHasSlides ? was : nowHasSlides));
  }

  // Auto-pick a language for code blocks the user hasn't set one on, so syntax highlighting
  // turns on as they type. We only ever do this once per block (and never touch a block that
  // already has a non-default language), so a manual choice from the picker is never fought.
  const autoLangDone = useRef<Set<string>>(new Set());
  function autoDetectCodeLanguages() {
    for (const block of editor.document) {
      if (block.type !== 'codeBlock') continue;
      if (autoLangDone.current.has(block.id)) continue;
      if (block.props.language && block.props.language !== 'text') {
        autoLangDone.current.add(block.id); // already set (saved note or manual pick) — leave it
        continue;
      }
      const text = Array.isArray(block.content)
        ? block.content.map((ic) => (ic.type === 'text' ? ic.text : '')).join('')
        : '';
      const lang = detectCodeLanguage(text);
      if (lang) {
        autoLangDone.current.add(block.id);
        // Defer: don't mutate the doc while BlockNote is dispatching the current change.
        queueMicrotask(() => editor.updateBlock(block, { props: { language: lang } }));
      }
    }
  }

  // Flush any pending edit when the editor unmounts (route change / app close), and stop
  // any slide import still running — it inserts blocks into this editor, so letting it
  // continue past unmount would be writing into a document nobody is looking at.
  // Runs once: mutate is read through a ref, so an empty dep list can't go stale.
  useEffect(() => {
    return () => {
      slideAbort.current?.abort();
      flushContent();
    };
  }, []);

  function saveTitle() {
    if (title.trim() === initialTitle) return;
    updateNote.mutate({ id: note.id, input: { title } });
  }

  // Setting a date places this note on its class Timeline (in the matching week); clearing
  // it moves the note back to the freeform Pages list.
  function applyNoteDate(date: string | null) {
    setDateOpen(false);
    setNoteDate(date);
    updateNote.mutate({ id: note.id, input: { noteDate: date } });
    if (date) showFlash('Added to the class timeline');
  }

  // ── Slash-command actions ─────────────────────────────────────────────────────
  function linkSelected(entityType: 'course' | 'assignment', entityId: string) {
    linkNote.mutate({ noteId: note.id, entityType, entityId });
    setPicker(null);
    showFlash(entityType === 'course' ? 'Linked to course' : 'Linked to assignment');
  }

  function insertDue(date: string) {
    setDueOpen(false);
    if (!date) return;
    const info = computeDeadlineLabel(date);
    editor.insertInlineContent([
      { type: 'text', text: `📅 Due ${formatDueDate(date)} · ${info.label}`, styles: { bold: true } },
      ' ', // trailing plain space so typing continues un-bolded
    ]);
  }

  function checklistToTask() {
    const text = blockPlainText(editor.getTextCursorPosition().block.content);
    if (!text) { showFlash('Nothing on this line to add'); return; }
    createTask.mutate({ name: text, dueDate: todayStr() });
    showFlash('Added to Tasks (due today)');
  }

  // Drop an empty equation in and let it focus its own source box (mathBlock.tsx).
  // The slash command runs on a block that already holds the leftover "/" text, so
  // an empty paragraph is replaced rather than left behind above the equation —
  // the same swap every built-in block command does.
  function insertMath() {
    const current = editor.getTextCursorPosition().block;
    const isEmptyParagraph =
      current.type === 'paragraph' && blockPlainText(current.content) === '';
    if (isEmptyParagraph) {
      editor.replaceBlocks([current], [{ type: 'math' }]);
    } else {
      editor.insertBlocks([{ type: 'math' }], current, 'after');
    }
  }

  // ── Slide deck import ────────────────────────────────────────────────────────
  // Main picks and reads the PDF (filesystem access stays on the trusted side); the
  // renderer rasterizes each page, because rasterizing needs a canvas and main has none
  // by design — see pdfSlides.ts. Pages land in the note one at a time as they finish,
  // so a long deck fills in visibly instead of appearing all at once at the end.
  async function importSlides() {
    if (slideImport) return; // one import at a time

    let picked;
    try {
      picked = await window.api.pdf.pick('Choose a slides PDF');
    } catch (err) {
      showFlash(err instanceof Error ? err.message : "Couldn't open that PDF");
      return;
    }
    if (picked.canceled) return;

    const deck = picked.fileName;
    const controller = new AbortController();
    slideAbort.current = controller;
    setSlideImport({ deck, page: 0, total: 0 });

    // The slash command runs on a block still holding the leftover "/" text. Remember it
    // so an empty one can be cleared afterwards rather than stranded above the deck —
    // the same swap every built-in block command does.
    const anchor = editor.getTextCursorPosition().block;
    const anchorWasEmpty =
      anchor.type === 'paragraph' && blockPlainText(anchor.content) === '';
    let after = anchor.id;
    let added = 0;

    try {
      // Counted up front so the progress bar can be truthful rather than indeterminate.
      const total = await pdfPageCount(picked.data);
      setSlideImport({ deck, page: 0, total });

      await renderPdfSlides(
        picked.data,
        async (slide, progress) => {
          // Reuses the note's existing image pipeline, so slides are ordinary note assets:
          // stored as files (never inlined into the document JSON) and swept up with the
          // rest of the note's folder when the note is deleted.
          const src = await window.api.media.save({
            noteId: note.id,
            ext: slide.ext,
            data: slide.data,
          });
          const inserted = editor.insertBlocks(
            [
              {
                type: 'slide',
                props: {
                  src,
                  page: slide.page,
                  deck,
                  aspect: slide.aspect,
                  text: clampSlideText(slide.text),
                },
                // One empty paragraph so there is already somewhere to type *inside* the
                // slide. Without it your first keystroke would land on a sibling block and
                // the note would never actually be attached to the slide.
                children: [{ type: 'paragraph' }],
              },
            ],
            after,
            'after',
          );
          after = inserted[0].id;
          added++;
          setSlideImport({ deck, page: progress.page, total: progress.total });
        },
        controller.signal,
      );

      if (controller.signal.aborted) {
        showFlash(added > 0 ? `Stopped — kept ${added} slide${added === 1 ? '' : 's'}` : 'Import stopped');
      } else if (added === 0) {
        showFlash("That PDF has no pages we could read");
      } else {
        showFlash(`Added ${added} slide${added === 1 ? '' : 's'}`);
      }
    } catch (err) {
      showFlash(err instanceof Error ? err.message : "Couldn't import that deck");
    } finally {
      // Clear the leftover empty paragraph exactly once, on every exit path — finished,
      // stopped, or failed. Doing it in both the try and the catch meant a throw *after*
      // the first removal would remove an id that no longer exists, and that second throw
      // escapes the catch as an unhandled rejection.
      if (added > 0 && anchorWasEmpty) editor.removeBlocks([anchor.id]);
      slideAbort.current = null;
      setSlideImport(null);
    }
  }

  /** Fold every slide in the note shut (or open them all again). With a long deck this is
   *  the difference between a note you can skim and one you scroll for a minute. */
  function setAllSlidesCollapsed(collapsed: boolean) {
    const ids = collectSlideIds(editor.document);
    for (const id of ids) editor.updateBlock(id, { props: { collapsed } });
    if (ids.length > 0) showFlash(collapsed ? 'Slides collapsed' : 'Slides expanded');
  }

  const slashActions = {
    onLinkCourse: () => setPicker('course'),
    onLinkAssignment: () => setPicker('assignment'),
    onInsertDue: () => setDueOpen(true),
    onChecklistToTask: checklistToTask,
    onLinkNotes: () => setNotePickerOpen(true),
    onInsertMath: insertMath,
    onImportSlides: importSlides,
  };

  // Insert a bullet list of links to other notes (study guide / exam review). Links use the
  // app's hash routes so the in-editor click handler can navigate to them in-app.
  function insertNoteLinks(notes: Note[]) {
    setNotePickerOpen(false);
    if (notes.length === 0) return;
    const blocks = notes.map((n) => ({
      type: 'bulletListItem' as const,
      content: [
        {
          type: 'link' as const,
          href: `#/notes/${n.id}`,
          content: [{ type: 'text' as const, text: n.title || 'Untitled', styles: {} }],
        },
      ],
    }));
    editor.insertBlocks(blocks, editor.getTextCursorPosition().block, 'after');
    showFlash(`Linked ${notes.length} note${notes.length === 1 ? '' : 's'}`);
  }

  // Restore a snapshot: the backend swaps the stored content (snapshotting current first so
  // it's reversible), then we sync the LIVE editor via replaceBlocks — no remount, so the
  // unmount-flush can't clobber the restored content.
  async function handleRestore(version: NoteVersion) {
    setRestoringId(version.id);
    try {
      const restored = await restoreVersion.mutateAsync({ noteId: note.id, versionId: version.id });
      const blocks = parseInitial(restored.content_json) ?? [{ type: 'paragraph' }];
      editor.replaceBlocks(editor.document, blocks);
      latestJson.current = restored.content_json;
      dirty.current = false;
      setHistoryOpen(false);
      showFlash('Restored earlier version');
    } finally {
      setRestoringId(null);
    }
  }

  // Typing past the bottom of the window used to leave the caret off-screen —
  // this keeps it in view without hijacking ordinary clicks or scrolling.
  const editorHostRef = useRef<HTMLDivElement>(null);
  useCaretAutoScroll(editorHostRef);

  const courseItems: PickItem[] = (courses ?? []).map((c) => ({
    id: c.id, label: c.name, sublabel: c.abbreviation,
  }));
  const assignmentItems: PickItem[] = (assignments ?? []).map((a) => ({
    id: a.id, label: a.name, sublabel: courses?.find((c) => c.id === a.course_id)?.abbreviation,
  }));

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-10">
      {/* The note as a warm "sheet" floating on the app background. The editor
          supplies its own 54px inline padding (blocknote-theme.css) so the block
          handles have a gutter to live in, so the sheet only adds the small
          remainder — the text column lands where it always did. The title and
          meta line sit outside the editor, so they re-add it themselves. */}
      <div className="rounded-2xl border border-line bg-paper px-4 py-12 shadow-sm">
      {/* Re-adds the editor's own inline padding so the title, links and meta line
          sit on the same left edge as the body text below them. */}
      <div className="px-[54px]">
      <div className="mb-2 flex items-center justify-end gap-1">
        <button
          onClick={() => setDateOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-hi hover:text-ink transition-colors"
          title="Set a date to place this note on the class timeline"
        >
          <CalendarDays size={13} />
          {noteDate ? formatDueDate(noteDate) : 'Set date'}
        </button>
        {noteDate && (
          <button
            onClick={() => applyNoteDate(null)}
            className="rounded-md p-1 text-muted hover:bg-surface-hi hover:text-ink transition-colors"
            title="Remove from timeline"
            aria-label="Remove date"
          >
            <X size={12} />
          </button>
        )}
        {/* Only worth its space in a note that actually has a deck in it, so it appears
            with the first slide and leaves again with the last. */}
        {hasSlides && (
          <>
            <button
              onClick={() => setAllSlidesCollapsed(true)}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-hi hover:text-ink transition-colors"
              title="Collapse every slide"
            >
              <ChevronsDownUp size={13} />
              Collapse
            </button>
            <button
              onClick={() => setAllSlidesCollapsed(false)}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-hi hover:text-ink transition-colors"
              title="Expand every slide"
            >
              <ChevronsUpDown size={13} />
              Expand
            </button>
          </>
        )}
        <button
          onClick={() => setHistoryOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-hi hover:text-ink transition-colors"
          title="Version history"
        >
          <History size={13} />
          History
        </button>
      </div>
      <NoteLinkBar noteId={note.id} />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Untitled"
        aria-label="Note title"
        className="w-full bg-transparent font-serif text-4xl font-semibold tracking-tight text-ink placeholder:text-muted focus:outline-none"
      />
      <p className="mb-4 mt-1.5 text-xs text-muted">Edited {formatEditedAt(note.updated_at)}</p>
      </div>
      <div
        ref={editorHostRef}
        className="studeo-bn"
        // Electron's spellchecker underlined half of every lecture note in red —
        // course codes, surnames, notation, any term the class is actually about —
        // and the app has no context menu, so there was no way to accept a
        // correction or add a word. All cost, no affordance. Off for note prose
        // only; the rest of the app's inputs keep it. (`spellcheck` is inherited,
        // so this covers the contenteditable BlockNote renders inside.)
        spellCheck={false}
        onClick={(e) => {
          // Follow in-app note links (study guides) without leaving the window.
          const anchor = (e.target as HTMLElement).closest('a');
          const href = anchor?.getAttribute('href') ?? '';
          if (href.startsWith('#/')) {
            e.preventDefault();
            navigate(href.slice(1));
          }
        }}
        onDoubleClick={(e) => {
          // Double-click an image to preview it full-screen (single click stays free for
          // BlockNote's own select/resize handling).
          const target = e.target as HTMLElement;
          if (target.tagName === 'IMG') setLightboxSrc((target as HTMLImageElement).src);
        }}
      >
        <BlockNoteView
          editor={editor}
          // By FAMILY, not by name. This read `theme === 'light' ? … : 'dark'`,
          // i.e. "light is the only light theme" — true until blush and linen
          // existed, after which both were handed BlockNote's dark scheme and
          // its #cfcfcf editor text landed on their pale paper.
          theme={isDarkTheme(theme) ? 'dark' : 'light'}
          onChange={handleChange}
          slashMenu={false}
          sideMenu={false}
        >
          {/* Replaces the stock ⠿ menu (colours + delete) with one that can also change
              what a line is — see TurnIntoMenu.tsx. */}
          <SideMenuController
            sideMenu={(props) => <SideMenu {...props} dragHandleMenu={TurnIntoDragHandleMenu} />}
          />
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              filterSuggestionItems(
                [...getDefaultReactSlashMenuItems(editor), ...studeoSlashItems(slashActions)],
                query,
              )
            }
          />
        </BlockNoteView>
      </div>
      </div>

      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}

      {picker === 'course' && (
        <LinkPickerDialog
          title="Link a course"
          items={courseItems}
          onSelect={(id) => linkSelected('course', id)}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'assignment' && (
        <LinkPickerDialog
          title="Link an assignment"
          items={assignmentItems}
          onSelect={(id) => linkSelected('assignment', id)}
          onClose={() => setPicker(null)}
        />
      )}
      {notePickerOpen && (
        <NotePickerDialog excludeId={note.id} onInsert={insertNoteLinks} onClose={() => setNotePickerOpen(false)} />
      )}
      {dueOpen && <DueDatePrompt onConfirm={insertDue} onClose={() => setDueOpen(false)} />}
      {dateOpen && (
        <DueDatePrompt
          title="Note date"
          confirmLabel="Set"
          initial={noteDate ?? ''}
          onConfirm={applyNoteDate}
          onClose={() => setDateOpen(false)}
        />
      )}
      {slideImport && (
        <SlideImportDialog state={slideImport} onCancel={() => slideAbort.current?.abort()} />
      )}
      {historyOpen && (
        <VersionHistoryDialog
          noteId={note.id}
          restoringId={restoringId}
          onRestore={handleRestore}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {flash && (
        <div className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-xs font-medium text-bg shadow-lg">
          {flash}
        </div>
      )}
    </div>
  );
}

/** Minimal date prompt, reused by the /Due slash command and the note-date control. */
function DueDatePrompt({
  onConfirm,
  onClose,
  title = 'Due date',
  confirmLabel = 'Insert',
  initial = '',
}: {
  onConfirm: (date: string) => void;
  onClose: () => void;
  title?: string;
  confirmLabel?: string;
  initial?: string;
}) {
  const [date, setDate] = useState(initial);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[20vh]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/30 animate-fade" />
      <div className="relative w-full max-w-xs mx-4 rounded-2xl bg-surface p-5 shadow-2xl animate-pop">
        <label htmlFor="note-date-picker" className="mb-2 block text-sm font-medium text-ink-soft">{title}</label>
        <input
          id="note-date-picker"
          type="date"
          autoFocus
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full rounded-lg border border-line bg-inset px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-muted hover:text-ink transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(date)}
            disabled={!date}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm text-accent-ink hover:bg-accent-deep active:scale-[0.98] disabled:opacity-50 transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
