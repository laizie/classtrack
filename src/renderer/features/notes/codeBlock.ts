import { BlockNoteSchema, defaultBlockSpecs, createCodeBlockSpec } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { mathBlockSpec } from './mathBlock';
import { slideBlockSpec } from './slideBlock';

// BlockNote's default code block lists all 48 Shiki languages. We curate the *menu* down to
// the popular ones students actually reach for; each grammar still loads on demand (only when
// a block uses that language), so listing more here doesn't grow the bundle — it just decides
// what the language picker offers. (Note: this Shiki bundle has no `go`/`golang` grammar.)
const supported = codeBlockOptions.supportedLanguages;

// Typed against the real key set, so a typo or a key removed upstream is a compile error.
const STUDENT_LANGUAGES: (keyof typeof supported)[] = [
  'text',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'python',
  'java',
  'c',
  'cpp',
  'csharp',
  'objective-c',
  'php',
  'ruby',
  'rust',
  'swift',
  'kotlin',
  'scala',
  'haskell',
  'lua',
  'r',
  'sql',
  'shellscript', // bash/sh
  'html',
  'css',
  'scss',
  'json',
  'yaml',
  'xml',
  'markdown',
  'latex',
];

// IMPORTANT: in this BlockNote version the code block is configured through the *schema* via
// `createCodeBlockSpec`. Passing a `codeBlock` option to `useCreateBlockNote` is silently
// ignored — which leaves the default spec with no `createHighlighter` (no syntax colours) and
// no `supportedLanguages` (no language picker). So we build the schema here and the editor
// uses it. `codeBlockOptions` supplies the Shiki highlighter (github-dark/light themes); we
// only swap in our curated language menu.
export const studeoSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec({
      ...codeBlockOptions,
      supportedLanguages: Object.fromEntries(
        STUDENT_LANGUAGES.map((key) => [key, supported[key]]),
      ),
    }),
    // Rendered LaTeX equations (see mathBlock.tsx). Registered here because the
    // schema is what the editor is built from — a block spec passed anywhere else
    // is ignored, same trap the code block hit above.
    math: mathBlockSpec,
    // A page of an imported lecture deck, which carries your notes as its children
    // (see slideBlock.tsx). Registered here for the same reason as the equation block.
    slide: slideBlockSpec,
  },
});
