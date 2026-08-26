import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// media.ts asks Electron where the user-data folder is. Point that at a throwaway temp
// directory so the sweep runs against a real disk — this function deletes files, and a
// test that mocked the filesystem would prove almost nothing about it.
// `getPath` is read lazily (only when a sweep runs), which is what makes this safe
// despite vi.mock being hoisted above the declaration.
let userDataDir = '';
vi.mock('electron', () => ({ app: { getPath: () => userDataDir }, protocol: { handle: () => undefined } }));

import { sweepOrphanAssets, getAssetsRoot } from '../media';

const NOTE_A = '11111111-1111-4111-8111-111111111111';
const NOTE_B = '22222222-2222-4222-8222-222222222222';

/** Write a file of `size` bytes into a note's asset folder. */
function putAsset(noteId: string, name: string, size = 10): void {
  const dir = path.join(getAssetsRoot(), noteId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), 'x'.repeat(size));
}

const exists = (noteId: string, name: string) =>
  existsSync(path.join(getAssetsRoot(), noteId, name));

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(tmpdir(), 'studeo-media-test-'));
});
afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe('sweepOrphanAssets', () => {
  it('deletes only what nothing references, and reports the bytes freed', () => {
    putAsset(NOTE_A, 'keep.webp', 100);
    putAsset(NOTE_A, 'orphan.webp', 250);

    const result = sweepOrphanAssets(new Set([`${NOTE_A}/keep.webp`]));

    expect(exists(NOTE_A, 'keep.webp')).toBe(true);
    expect(exists(NOTE_A, 'orphan.webp')).toBe(false);
    expect(result).toEqual({ removed: 1, bytes: 250 });
  });

  it('keeps a file referenced only by an old version snapshot', () => {
    // The whole point of feeding note_versions into the reference set: the current
    // document has dropped this slide, but restoring a two-week-old version has to
    // bring it back.
    putAsset(NOTE_A, 'dropped-from-current.webp');
    const result = sweepOrphanAssets(new Set([`${NOTE_A}/dropped-from-current.webp`]));
    expect(exists(NOTE_A, 'dropped-from-current.webp')).toBe(true);
    expect(result.removed).toBe(0);
  });

  it('removes a whole folder once every file in it is unreferenced', () => {
    putAsset(NOTE_B, 'a.png');
    putAsset(NOTE_B, 'b.png');
    sweepOrphanAssets(new Set());
    expect(existsSync(path.join(getAssetsRoot(), NOTE_B))).toBe(false);
  });

  it('matches note-id folders case-insensitively', () => {
    // Asset URLs are written by the app, but a folder restored from a backup on a
    // case-preserving filesystem can come back in a different case. Deleting a live
    // image because of that would be an unpleasant surprise.
    putAsset(NOTE_A.toUpperCase(), 'keep.webp');
    sweepOrphanAssets(new Set([`${NOTE_A}/keep.webp`]));
    expect(exists(NOTE_A.toUpperCase(), 'keep.webp')).toBe(true);
  });

  it('leaves folders that are not note ids alone', () => {
    const stray = path.join(getAssetsRoot(), 'not-a-note-id');
    mkdirSync(stray, { recursive: true });
    writeFileSync(path.join(stray, 'something.txt'), 'hi');

    sweepOrphanAssets(new Set());

    expect(existsSync(path.join(stray, 'something.txt'))).toBe(true);
  });

  it('is a no-op when nothing has ever been saved', () => {
    expect(sweepOrphanAssets(new Set())).toEqual({ removed: 0, bytes: 0 });
    expect(readdirSync(userDataDir)).not.toContain('note-assets');
  });
});
