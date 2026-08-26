import { useRef, useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import { ChevronDown, ChevronRight, Scan } from 'lucide-react';

/**
 * One page of an imported lecture deck, with your own notes hanging off it.
 *
 * The important idea here is structural, not visual. A slide block holds its notes as its
 * BlockNote **children** — the same nesting a bullet list uses — rather than as loose
 * paragraphs that merely happen to sit below it. That's what makes the connection real:
 * drag the slide and its notes travel with it, collapse the slide and its notes go with
 * it, and the association survives every edit, reorder and round-trip through the
 * database. A purely visual grouping ("everything until the next slide") would come apart
 * the first time you moved something.
 *
 * This works because a BlockNote block container is defined as `blockContent blockGroup?`
 * — EVERY block may carry a nested group of children, including a `content: 'none'` custom
 * block like this one that can't hold text of its own. The children are rendered by the
 * editor as a sibling of this component's output, not inside it, which is why the indent
 * rail and the collapse behaviour are done in CSS (blocknote-theme.css) against
 * `[data-content-type='slide'] + .bn-block-group` rather than here.
 *
 * Why props and not inline content: everything this block holds (the image URL, the page
 * number, the page's extracted text) is data about the slide, not prose the user writes.
 * Held as inline content it would be editable, formattable and deletable by accident.
 * Same reasoning as the equation block's `latex` prop — see mathBlock.tsx.
 */

/** Longest slide text we keep. BlockNote mirrors any non-default prop into a `data-`
 *  attribute on the DOM node, so this string is paid for in the document AND in the DOM.
 *  Real slides run a few hundred characters; this only bites on a page of dense prose,
 *  where the first 2000 characters are more than enough to find it by search. */
const MAX_SLIDE_TEXT = 2000;

/** Slide width, as a percentage of the note's text column.
 *
 *  A percentage rather than pixels so a slide keeps its proportions when the window
 *  changes size — the note body is already a fluid measure, and a slide pinned to 640px
 *  would be two-thirds of the column on a laptop and a third of it on a monitor.
 *
 *  The floor isn't arbitrary: below about a quarter of the column the body text on a
 *  lecture slide stops being readable at all, at which point you have a thumbnail, not a
 *  slide. Anyone who wants that can collapse it instead. */
const MIN_WIDTH = 25;
const MAX_WIDTH = 100;
const DEFAULT_WIDTH = 65;

const clampWidth = (n: number): number =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));

export function clampSlideText(text: string): string {
  return text.length > MAX_SLIDE_TEXT ? text.slice(0, MAX_SLIDE_TEXT) : text;
}

/** How much is written under this slide. Used only for the collapsed summary, so a stale
 *  answer is cosmetic. Slides are imported with one empty paragraph child so there's
 *  somewhere to start typing — which is why an empty child doesn't count. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote child blocks are generically typed
function noteCount(children: any[]): number {
  if (!Array.isArray(children)) return 0;
  return children.filter((child) => {
    if (Array.isArray(child?.children) && child.children.length > 0) return true;
    const content = child?.content;
    // A block with non-inline content (an image, an equation) counts as written.
    if (!Array.isArray(content)) return content !== undefined && content !== null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- inline item shape varies
    return content.some((item: any) => typeof item?.text === 'string' && item.text.trim() !== '');
  }).length;
}

/** Every slide block in the document, at any nesting depth. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote blocks are generically typed
function eachSlide(blocks: any[], visit: (id: string) => void): void {
  for (const b of blocks ?? []) {
    if (b?.type === 'slide') visit(b.id);
    if (Array.isArray(b?.children)) eachSlide(b.children, visit);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the block/editor pair is BlockNote's own generic
function SlideView({ block, editor }: { block: any; editor: any }) {
  const { src, page, deck, aspect, collapsed, width } = block.props;
  const written = noteCount(block.children);
  const hostRef = useRef<HTMLDivElement>(null);

  // While dragging, the width lives here rather than in the document: a block update per
  // pointermove would put a hundred entries in the undo stack for one drag, and every one
  // of them would be a save. The prop is written once, on release.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const shown = dragWidth ?? width ?? DEFAULT_WIDTH;

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    // Measure the column the slide sits in, so a drag in pixels becomes a share of the
    // measure — which is what the width prop actually means.
    const column = hostRef.current?.parentElement?.clientWidth ?? 0;
    if (!column) return;

    const startX = e.clientX;
    const startWidth = shown;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    let latest = startWidth;

    const onMove = (ev: PointerEvent) => {
      latest = clampWidth(startWidth + ((ev.clientX - startX) / column) * 100);
      setDragWidth(latest);
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      setDragWidth(null);
      if (latest !== width) editor.updateBlock(block, { props: { width: latest } });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  /** Give every slide in the note this slide's width. The editor handed to a custom
   *  block is typed against a schema containing only that block, so it's widened once
   *  here to reach the whole document — the same cast the equation block makes. */
  function applyWidthToAll() {
    const host = editor as unknown as BlockNoteEditor;
    eachSlide(host.document, (id) => {
      host.updateBlock(id, { props: { width: shown } } as never);
    });
  }

  return (
    // contentEditable={false} keeps ProseMirror out of this subtree — without it the
    // editor treats clicks and keystrokes in here as document edits (the same guard
    // the equation block needs).
    <div className="studeo-slide" contentEditable={false} ref={hostRef} style={{ width: `${shown}%` }}>
      <div className="studeo-slide__bar">
        <button
          type="button"
          className="studeo-slide__fold"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand slide ${page}` : `Collapse slide ${page}`}
          onClick={() => editor.updateBlock(block, { props: { collapsed: !collapsed } })}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span className="studeo-slide__page">Slide {page}</span>
          {deck && <span className="studeo-slide__deck">{deck}</span>}
        </button>

        {collapsed && written > 0 && (
          <span className="studeo-slide__count">
            {written} note{written === 1 ? '' : 's'}
          </span>
        )}

        {/* The live size while dragging, so you can land on a round number and match a
            neighbour by eye instead of guessing. */}
        {dragWidth !== null && <span className="studeo-slide__size">{shown}%</span>}

        {!collapsed && (
          <button
            type="button"
            className="studeo-slide__all"
            title="Set every slide in this note to this width"
            aria-label="Set every slide in this note to this width"
            onClick={applyWidthToAll}
          >
            <Scan size={12} />
            Match all
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="studeo-slide__frame" style={{ aspectRatio: `1 / ${aspect || 0.75}` }}>
          {src ? (
            <img
              src={src}
              // Double-click opens the existing full-screen lightbox — NoteEditor
              // listens for IMG double-clicks across the whole editor, so this needs
              // no wiring of its own.
              alt={`Slide ${page}${deck ? ` of ${deck}` : ''}`}
              draggable={false}
              loading="lazy"
              className="studeo-slide__img"
            />
          ) : (
            <p className="studeo-slide__missing">This slide image is missing.</p>
          )}

          {/* Drag the right edge. Same shape as the image resize handle next door: a wide
              invisible hit area with a small visible pill inside it, so the grab zone is
              forgiving while the thing you see stays quiet. */}
          <div
            className="studeo-slide__handle"
            role="separator"
            aria-label={`Slide ${page} width, ${shown} percent`}
            onPointerDown={startResize}
            onDoubleClick={(e) => {
              // Double-click the handle to snap back to the default, the way a window
              // manager restores a resized pane.
              e.stopPropagation();
              editor.updateBlock(block, { props: { width: DEFAULT_WIDTH } });
            }}
          />
        </div>
      )}
    </div>
  );
}

export const slideBlockSpec = createReactBlockSpec(
  {
    type: 'slide',
    content: 'none',
    propSchema: {
      /** studeo-asset:// URL of the rendered page (see main/media.ts). */
      src: { default: '' as string },
      /** 1-based page number, as printed on the deck. */
      page: { default: 0 as number },
      /** Filename of the deck this came from — shown muted, and it keeps two decks in
       *  one note distinguishable when both restart at "Slide 1". */
      deck: { default: '' as string },
      /** height / width, so the space is reserved before the image decodes and the note
       *  doesn't jump around while an import streams in. */
      aspect: { default: 0.75 as number },
      collapsed: { default: false as boolean },
      /** Percentage of the text column this slide occupies. See MIN_WIDTH above. */
      width: { default: DEFAULT_WIDTH as number },
      /** The page's own text. Invisible; it exists so full-text search can find the
       *  lecture by what was ON the slide, not only by what you typed underneath. */
      text: { default: '' as string },
    },
  },
  {
    render: ({ block, editor }) => <SlideView block={block} editor={editor} />,
    // Copying a slide out of the app should carry something an outside tool can use.
    toExternalHTML: ({ block }) => (
      <figure>
        <img src={block.props.src} alt={`Slide ${block.props.page}`} />
        <figcaption>
          Slide {block.props.page}
          {block.props.deck ? ` — ${block.props.deck}` : ''}
        </figcaption>
      </figure>
    ),
  },
)();
