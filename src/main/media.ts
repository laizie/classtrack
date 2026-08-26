import { app, protocol } from 'electron';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Note images live as real files on disk under the app's data folder — never base64-inlined
// into the document JSON (that would bloat every note read). They're served back to the
// renderer through a custom `studeo-asset://` protocol rather than file:// — file:// is
// blocked/awkward under hardened webPreferences, and a scoped custom scheme lets us serve
// ONLY this directory (no path-traversal into the rest of the disk).

export const ASSET_SCHEME = 'studeo-asset';

// A note id is a UUID. We validate against this before touching the filesystem so a crafted
// id can't escape the assets root.
const UUID_RE = /^[0-9a-f-]{36}$/i;

// Whitelisted image extensions and their MIME types. Anything else is rejected on save.
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

function assetsRoot(): string {
  return path.join(app.getPath('userData'), 'note-assets');
}

function normalizeExt(ext: string): string {
  const clean = ext.replace(/^\./, '').toLowerCase();
  return clean in MIME ? clean : '';
}

/**
 * Persist image bytes for a note and return the stable URL to reference it by.
 * Throws on an invalid note id or unsupported extension (validated again in the handler).
 */
export function saveMedia(noteId: string, ext: string, data: Uint8Array): string {
  if (!UUID_RE.test(noteId)) throw new Error('Invalid note id');
  const safeExt = normalizeExt(ext);
  if (!safeExt) throw new Error(`Unsupported image type: ${ext}`);

  const dir = path.join(assetsRoot(), noteId);
  mkdirSync(dir, { recursive: true });

  const filename = `${crypto.randomUUID()}.${safeExt}`;
  writeFileSync(path.join(dir, filename), Buffer.from(data));

  return `${ASSET_SCHEME}://${noteId}/${filename}`;
}

/** Remove a note's entire asset folder (called when the note is deleted). No-op if absent. */
export function deleteNoteAssets(noteId: string): void {
  if (!UUID_RE.test(noteId)) return;
  rmSync(path.join(assetsRoot(), noteId), { recursive: true, force: true });
}

export function getAssetsRoot(): string {
  return assetsRoot();
}

// Resolve a studeo-asset:// URL to an on-disk path, refusing anything that would escape the
// assets root (path-traversal guard).
function resolveAssetPath(requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  const noteId = decodeURIComponent(url.hostname);
  const filename = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!UUID_RE.test(noteId) || !filename) return null;

  const root = assetsRoot();
  const candidate = path.normalize(path.join(root, noteId, filename));
  // Must stay strictly inside the assets root.
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  return candidate;
}

/** Register the protocol handler. Call once, after app `ready`. */
export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, (request) => {
    const filePath = resolveAssetPath(request.url);
    if (!filePath || !existsSync(filePath)) {
      return new Response(null, { status: 404 });
    }
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const body = readFileSync(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        // SVG is in the allowlist, and an SVG is a document that can carry <script>.
        // Rendered through <img> — which is the only way notes use it — that script
        // never runs, so this isn't a live hole. But "only ever <img>" is a property of
        // today's code, not of the format, and one <object> or a direct navigation would
        // change it. A CSP on the asset response itself makes it inert whatever loads it,
        // which keeps the format usable instead of dropping SVG support to be safe.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        // Never let the browser second-guess the type we just declared.
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}

/**
 * Delete asset files that no note points at any more, and report what was reclaimed.
 *
 * Why this is needed at all: assets are only ever cleaned up when an entire note is
 * deleted (deleteNoteAssets, above). Delete an image or a slide *inside* a note you keep
 * and the file stays on disk forever, with nothing left referencing it. That was a slow
 * drip when a note held two or three images; a slide deck makes it sixty files in one
 * undo.
 *
 * `referenced` must be the complete set of "<noteId>/<filename>" keys from EVERY document
 * that can still be shown — live notes, archived notes (archive is a recoverable trash,
 * not a delete), and every row in note_versions. That last one is the easy thing to
 * forget and the expensive thing to get wrong: restoring a two-week-old version of a
 * lecture note has to bring its slides back with it, and it can't if the sweep decided
 * they were garbage because the current document no longer mentions them.
 *
 * Nothing outside the assets root is ever touched, and a directory is removed only once
 * it is empty.
 */
export function sweepOrphanAssets(referenced: Set<string>): { removed: number; bytes: number } {
  const root = assetsRoot();
  if (!existsSync(root)) return { removed: 0, bytes: 0 };

  let removed = 0;
  let bytes = 0;

  for (const noteDir of readdirSync(root)) {
    // Anything that isn't a note-id folder didn't come from us — leave it alone.
    if (!UUID_RE.test(noteDir)) continue;
    const dirPath = path.join(root, noteDir);
    if (!statSync(dirPath).isDirectory()) continue;

    for (const file of readdirSync(dirPath)) {
      if (referenced.has(`${noteDir.toLowerCase()}/${file}`)) continue;
      const filePath = path.join(dirPath, file);
      try {
        bytes += statSync(filePath).size;
        rmSync(filePath, { force: true });
        removed++;
      } catch {
        // A file that vanished under us, or one we can't stat, is not worth failing over.
      }
    }

    // Tidy up a folder whose note is long gone.
    try {
      if (readdirSync(dirPath).length === 0) rmSync(dirPath, { recursive: true, force: true });
    } catch {
      /* leave it */
    }
  }

  return { removed, bytes };
}
