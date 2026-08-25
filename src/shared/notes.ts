// Pure, dependency-free helpers for notes. NO electron/node imports — this file must
// stay portable so it survives the eventual move to Supabase + a phone client.
//
// A BlockNote document is a JSON array of blocks. Each block roughly looks like:
//   { id, type, props, content, children }
// where `content` is usually an array of inline items ({ type:'text', text, styles }),
// or a string, or (for tables) an object with rows/cells. We deliberately walk it
// defensively rather than importing BlockNote's types: this code runs in the main
// process on every save, and a malformed/changed shape must degrade to "" — never throw.

/** Extract the visible text of a single inline-content value (string | array | item). */
function inlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
        // e.g. a link: { type:'link', content:[ inline... ] }
        if ('content' in o) return inlineText(o.content);
      }
      return '';
    })
    .join('');
}

/**
 * Text a block carries in its *props* rather than its content.
 *
 * An imported lecture slide is a picture, so it has no inline content at all — but it
 * stores the page's own extracted text on a `text` prop precisely so search can reach it.
 * Without this, searching for a term that was on the slide (rather than in what you typed
 * underneath it) would find nothing, which is the wrong answer for a note that literally
 * contains that slide.
 *
 * Matched on the block type rather than on "any prop called text", so a future block that
 * happens to keep unrelated text in a prop isn't silently swept into the search index.
 */
function propsText(b: Record<string, unknown>): string {
  if (b.type !== 'slide') return '';
  const props = b.props;
  if (!props || typeof props !== 'object') return '';
  const text = (props as Record<string, unknown>).text;
  return typeof text === 'string' ? text : '';
}

/** Extract all visible text from one block, including table cells and nested children. */
function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as Record<string, unknown>;
  const parts: string[] = [];

  parts.push(propsText(b));

  const content = b.content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    // Table-style content: { type:'tableContent', rows:[{ cells:[ inline[] ] }] }
    const rows = (content as Record<string, unknown>).rows;
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const cells = (r as Record<string, unknown>)?.cells;
        if (Array.isArray(cells)) for (const cell of cells) parts.push(inlineText(cell));
      }
    }
  } else {
    parts.push(inlineText(content));
  }

  if (Array.isArray(b.children)) {
    for (const child of b.children) parts.push(blockText(child));
  }

  return parts.map((p) => p.trim()).filter(Boolean).join(' ');
}

/**
 * Flatten a serialized BlockNote document to plain text — one line per top-level block.
 * Used to populate notes.content_text for full-text search and future AI. Returns "" for
 * empty/invalid input rather than throwing.
 */
export function blocksToPlainText(contentJson: string): string {
  let blocks: unknown;
  try {
    blocks = JSON.parse(contentJson);
  } catch {
    return '';
  }
  if (!Array.isArray(blocks)) return '';

  const lines: string[] = [];
  for (const block of blocks) {
    const text = blockText(block);
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

/**
 * Convert plain text into a serialized BlockNote document — one paragraph block per line.
 * Used to migrate the legacy plain-text `assignments.notes` field into a real note. Returns
 * "[]" (empty document) for empty input.
 */
export function plainTextToBlocks(text: string): string {
  if (!text) return '[]';
  const blocks = text.split('\n').map((line) => ({
    type: 'paragraph',
    content: line ? [{ type: 'text', text: line, styles: {} }] : [],
  }));
  return JSON.stringify(blocks);
}

/**
 * Derive a fallback title from a note's content — the first non-empty line of text,
 * trimmed and length-capped. Used when the user hasn't given the note an explicit title.
 * Returns "" if the document has no text.
 */
export function noteTitleFromBlocks(contentJson: string, maxLength = 80): string {
  const text = blocksToPlainText(contentJson);
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean);
  if (!firstLine) return '';
  return firstLine.length > maxLength ? firstLine.slice(0, maxLength).trimEnd() + '…' : firstLine;
}
