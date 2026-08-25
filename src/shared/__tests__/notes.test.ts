import { describe, it, expect } from 'vitest';
import { blocksToPlainText, noteTitleFromBlocks, plainTextToBlocks } from '../notes';

// A small but realistic BlockNote document covering the shapes the walker must handle:
// styled inline runs, a link, nested children, and a table.
const doc = JSON.stringify([
  {
    id: '1',
    type: 'heading',
    props: { level: 1 },
    content: [{ type: 'text', text: 'Graph Theory', styles: {} }],
    children: [],
  },
  {
    id: '2',
    type: 'paragraph',
    content: [
      { type: 'text', text: 'A graph is a set of ', styles: {} },
      { type: 'text', text: 'vertices', styles: { bold: true } },
      { type: 'text', text: ' and edges. See ', styles: {} },
      { type: 'link', href: 'https://x', content: [{ type: 'text', text: 'docs', styles: {} }] },
    ],
    children: [
      {
        id: '3',
        type: 'paragraph',
        content: [{ type: 'text', text: 'nested note', styles: {} }],
        children: [],
      },
    ],
  },
  {
    id: '4',
    type: 'table',
    content: {
      type: 'tableContent',
      rows: [
        { cells: [[{ type: 'text', text: 'Term', styles: {} }], [{ type: 'text', text: 'Defn', styles: {} }]] },
      ],
    },
    children: [],
  },
]);

describe('blocksToPlainText', () => {
  it('returns "" for an empty document', () => {
    expect(blocksToPlainText('[]')).toBe('');
  });

  it('returns "" for invalid JSON', () => {
    expect(blocksToPlainText('not json')).toBe('');
  });

  it('returns "" when the JSON is not an array', () => {
    expect(blocksToPlainText('{"type":"paragraph"}')).toBe('');
  });

  it('extracts and merges styled inline runs into one line per block', () => {
    const text = blocksToPlainText(doc);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Graph Theory');
    expect(lines[1]).toContain('A graph is a set of vertices and edges. See docs');
  });

  it('includes link text and nested children', () => {
    const text = blocksToPlainText(doc);
    expect(text).toContain('docs');
    expect(text).toContain('nested note');
  });

  it('includes table cell text', () => {
    const text = blocksToPlainText(doc);
    expect(text).toContain('Term');
    expect(text).toContain('Defn');
  });
});

describe('blocksToPlainText — imported slides', () => {
  // A slide is a picture: it has no inline content at all, and everything searchable
  // about the page itself lives on its `text` prop. If the walker skipped props, a note
  // containing a whole lecture deck would be invisible to a search for anything that was
  // printed ON those slides.
  const slideDoc = (props: Record<string, unknown>, children: unknown[] = []) =>
    JSON.stringify([{ id: 's1', type: 'slide', props, children }]);

  it('indexes the text extracted from a slide', () => {
    const json = slideDoc({ src: 'studeo-asset://n/1.webp', page: 4, text: "Dijkstra's algorithm" });
    expect(blocksToPlainText(json)).toBe("Dijkstra's algorithm");
  });

  it('keeps the slide text and the notes written under it together', () => {
    const json = slideDoc(
      { page: 4, text: 'Shortest paths' },
      [
        {
          id: 'c1',
          type: 'bulletListItem',
          content: [{ type: 'text', text: 'greedy, needs non-negative weights', styles: {} }],
          children: [],
        },
      ],
    );
    // One line per top-level block: the slide and its children flatten together, which is
    // what makes a search for either half surface this note.
    expect(blocksToPlainText(json)).toBe('Shortest paths greedy, needs non-negative weights');
  });

  it('is quiet for a slide with no extractable text (a scanned or image-only page)', () => {
    expect(blocksToPlainText(slideDoc({ src: 'studeo-asset://n/1.webp', page: 1 }))).toBe('');
  });

  it('ignores a text prop on any other block type', () => {
    // Deliberately narrow: only `slide` opts its props into the index, so a future block
    // that happens to keep unrelated text in a prop can't silently pollute search.
    const json = JSON.stringify([{ id: 'x', type: 'paragraph', props: { text: 'not indexed' }, content: [], children: [] }]);
    expect(blocksToPlainText(json)).toBe('');
  });

  it('survives a malformed slide block rather than throwing', () => {
    expect(blocksToPlainText(JSON.stringify([{ type: 'slide' }]))).toBe('');
    expect(blocksToPlainText(JSON.stringify([{ type: 'slide', props: null }]))).toBe('');
    expect(blocksToPlainText(JSON.stringify([{ type: 'slide', props: { text: 42 } }]))).toBe('');
  });
});

describe('plainTextToBlocks', () => {
  it('returns an empty document for empty input', () => {
    expect(plainTextToBlocks('')).toBe('[]');
  });

  it('makes one paragraph block per line and round-trips through blocksToPlainText', () => {
    const text = 'first line\nsecond line';
    const json = plainTextToBlocks(text);
    const blocks = JSON.parse(json);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocksToPlainText(json)).toBe(text);
  });

  it('preserves blank lines as empty paragraphs', () => {
    const blocks = JSON.parse(plainTextToBlocks('a\n\nb'));
    expect(blocks).toHaveLength(3);
    expect(blocks[1].content).toEqual([]);
  });
});

describe('noteTitleFromBlocks', () => {
  it('returns the first non-empty line of text', () => {
    expect(noteTitleFromBlocks(doc)).toBe('Graph Theory');
  });

  it('returns "" when there is no text', () => {
    expect(noteTitleFromBlocks('[]')).toBe('');
  });

  it('truncates long first lines with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const blocks = JSON.stringify([
      { id: '1', type: 'paragraph', content: [{ type: 'text', text: long, styles: {} }], children: [] },
    ]);
    const title = noteTitleFromBlocks(blocks, 80);
    expect(title.length).toBe(81); // 80 chars + ellipsis
    expect(title.endsWith('…')).toBe(true);
  });
});
