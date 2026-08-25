import { createReactBlockSpec } from '@blocknote/react';
import { ChevronDown, ChevronRight } from 'lucide-react';

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
      /** The page's own text. Invisible; it exists so full-text search can find the
       *  lecture by what was ON the slide, not only by what you typed underneath. */
      text: { default: '' as string },
    },
  },
  {
    render: ({ block, editor }) => {
      const { src, page, deck, aspect, collapsed } = block.props;
      const written = noteCount(block.children);

      return (
        // contentEditable={false} keeps ProseMirror out of this subtree — without it the
        // editor treats clicks and keystrokes in here as document edits (the same guard
        // the equation block needs).
        <div className="studeo-slide" contentEditable={false}>
          <button
            type="button"
            className="studeo-slide__bar"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand slide ${page}` : `Collapse slide ${page}`}
            onClick={() => editor.updateBlock(block, { props: { collapsed: !collapsed } })}
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <span className="studeo-slide__page">Slide {page}</span>
            {deck && <span className="studeo-slide__deck">{deck}</span>}
            {collapsed && written > 0 && (
              <span className="studeo-slide__count">
                {written} note{written === 1 ? '' : 's'}
              </span>
            )}
          </button>

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
            </div>
          )}
        </div>
      );
    },
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
