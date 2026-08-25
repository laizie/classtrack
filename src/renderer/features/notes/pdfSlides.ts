// PDF → slide images, renderer-side.
//
// Why here and not in main: rasterizing a page means drawing it to a canvas, and main has
// no canvas by design — main/pdf/extractPdfText.ts installs a no-op DOMMatrix stub
// specifically so pdfjs never pulls in the native @napi-rs/canvas. The renderer, being a
// real browser, already has everything pdfjs needs. So main reads the file (filesystem
// access stays on the trusted side) and this module turns those bytes into pictures.
//
// Unlike the main-process extractor, this one DOES use a worker: rasterizing is heavy, and
// on the UI thread a 60-page deck would freeze the window for the whole import.

import * as pdfjs from 'pdfjs-dist';
// Vite's `?url` gives us a real URL to the worker bundle, which is what pdfjs wants —
// importing the module itself would bundle it into the main chunk and never run it as a
// worker. The `.mjs` worker is an ES module, hence `type: 'module'` on pdfjs's side.
// eslint-disable-next-line import/no-unresolved -- Vite-only `?url` suffix; resolved at build time
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Target width, in device pixels, for a rendered slide.
 *
 * A 4:3 slide at this width is legible zoomed to full screen without being wasteful —
 * a lecture deck is mostly flat colour and large type, which encodes very cheaply. The
 * scale we hand pdfjs is derived from this and the page's own size, so a big page and a
 * small page come out the same width rather than the same zoom.
 */
const TARGET_WIDTH = 1600;

/**
 * WebP, not PNG or JPEG. Slides are the worst case for both of the obvious choices: PNG
 * balloons on any slide holding a photo or a gradient, and JPEG smears the text and thin
 * diagram lines that are the entire point of a slide. WebP handles both, and Chromium
 * (so, Electron) encodes it natively. It's already in the media allowlist.
 */
const IMAGE_TYPE = 'image/webp';
const IMAGE_QUALITY = 0.82;
const IMAGE_EXT = 'webp';

export interface RenderedSlide {
  /** 1-based page number, as printed on the deck. */
  page: number;
  /** WebP bytes for the rendered page, ready for window.api.media.save. */
  data: Uint8Array;
  ext: string;
  /** height / width of the rendered page, so the block can reserve space before load. */
  aspect: number;
  /** The page's selectable text, or '' for an image-only page. Feeds note search. */
  text: string;
}

export interface SlideRenderProgress {
  page: number;
  total: number;
}

/** Turn one pdfjs page into WebP bytes at TARGET_WIDTH. */
async function rasterizePage(page: pdfjs.PDFPageProxy): Promise<{ data: Uint8Array; aspect: number }> {
  // viewport at scale 1 gives the page's natural size; scale so width lands on target.
  // Slides that are already small get scaled UP, which is what you want — the source is
  // vector, so there's real detail to recover.
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: TARGET_WIDTH / base.width });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);

  // A PDF page carries no background of its own, and an unpainted canvas is transparent —
  // which, once saved as WebP and shown in a dark theme, reads as a black rectangle with
  // black text on it. `background` makes pdfjs paint paper-white underneath first.
  // (We pass `canvas` rather than `canvasContext`: since v5 the context form is the
  // legacy one, and passing both is what the API docs tell you not to do.)
  //
  // `intent: 'print'` is load-bearing, and not about printing. pdfjs decides how to drive
  // its render loop from this one flag — `useRequestAnimationFrame: !intentPrint`. Under
  // the default 'display' intent it advances the drawing one requestAnimationFrame at a
  // time, and a hidden window fires no animation frames: minimise Studeo, switch spaces,
  // or fully cover it mid-import and the render promise simply never settles. Importing a
  // long deck is *precisely* when you go and do something else, so that stall is the
  // normal path, not an edge case. 'print' switches the loop to microtasks, which run
  // regardless of visibility — and it's the honest description of the job anyway: we're
  // rasterizing a static page for later reading, not driving an interactive viewer.
  // It renders faster too, no longer capped at one chunk per frame.
  await page.render({ canvas, viewport, background: '#ffffff', intent: 'print' }).promise;

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, IMAGE_TYPE, IMAGE_QUALITY),
  );
  if (!blob) throw new Error('Could not encode a slide image.');

  // Free the backing store now rather than waiting for GC — 60 of these at 1600px is a
  // lot of memory to leave lying around mid-import.
  canvas.width = 0;
  canvas.height = 0;

  return {
    data: new Uint8Array(await blob.arrayBuffer()),
    aspect: viewport.height / viewport.width,
  };
}

/** Plain text of a page, on one line per visual line — same EOL trick as the main-process
 *  extractor. Stored on the slide block so full-text search can find a lecture by what was
 *  on the slide, not just by what you typed underneath it. */
async function pageText(page: pdfjs.PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  let line = '';
  const lines: string[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue; // marked-content items carry no text
    line += item.str;
    if (item.hasEOL) {
      lines.push(line);
      line = '';
    } else {
      line += ' ';
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join('\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

/**
 * Render every page of a PDF to a slide image.
 *
 * Pages are done one at a time and handed to `onSlide` as they finish, so the import can
 * stream into the note instead of appearing all at once at the end — a 60-page deck takes
 * a while, and watching it fill in is far better than watching a spinner. Sequential is
 * deliberate: pdfjs shares one worker, so rendering in parallel wouldn't be faster, and
 * it would multiply peak memory by the number of pages in flight.
 *
 * `signal` lets the dialog's Cancel button stop a long import; already-rendered slides
 * stay in the note.
 */
export async function renderPdfSlides(
  data: Uint8Array,
  onSlide: (slide: RenderedSlide, progress: SlideRenderProgress) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<number> {
  // pdfjs takes ownership of the buffer it's given and detaches it. The caller may still
  // want its bytes (and a detached array throws on read), so hand over a copy.
  const loadingTask = pdfjs.getDocument({ data: data.slice(), useSystemFonts: true });
  const doc = await loadingTask.promise;

  try {
    const total = doc.numPages;
    for (let pageNum = 1; pageNum <= total; pageNum++) {
      if (signal?.aborted) return pageNum - 1;

      const page = await doc.getPage(pageNum);
      try {
        const { data: bytes, aspect } = await rasterizePage(page);
        const text = await pageText(page);
        await onSlide(
          { page: pageNum, data: bytes, ext: IMAGE_EXT, aspect, text },
          { page: pageNum, total },
        );
      } finally {
        // Release the page's own render resources before moving to the next one.
        page.cleanup();
      }
    }
    return total;
  } finally {
    await loadingTask.destroy();
  }
}

/** Page count without rendering anything — used to size the progress bar up front. */
export async function pdfPageCount(data: Uint8Array): Promise<number> {
  const loadingTask = pdfjs.getDocument({ data: data.slice(), useSystemFonts: true });
  try {
    const doc = await loadingTask.promise;
    return doc.numPages;
  } finally {
    await loadingTask.destroy();
  }
}
