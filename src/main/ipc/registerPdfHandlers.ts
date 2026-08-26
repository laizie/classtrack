import { ipcMain, dialog, BrowserWindow } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { IPC, type PickPdfResult } from '../../shared/types';

// Picking and reading the file is main's job — the sandboxed renderer has no filesystem
// access, and shouldn't. Interpreting the file is not: main hands back raw bytes and
// every PDF feature in the app (lecture slides, syllabus import) does its own parsing in
// the renderer.
//
// That split is deliberate on both counts. Rasterizing a page needs a canvas, which main
// doesn't have and shouldn't grow a native dependency to get. And a PDF is a document
// nobody here wrote — parsing one in main would mean parsing untrusted input in a Node
// process with the filesystem in reach and no CSP over it, where the renderer is
// sandboxed and holds pdfjs behind `script-src 'self'`. Main used to extract syllabus
// text itself; it doesn't any more.
//
// Uint8Array survives the IPC boundary as-is: Electron uses the structured clone
// algorithm, which handles typed arrays natively (no base64 round-trip).

// A lecture deck of scanned page images can be genuinely large, so this ceiling is more
// generous than the syllabus handler's 25 MB. It still exists to stop a mis-picked file
// (a video, a disk image renamed .pdf) from being slurped into memory.
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB

export function registerPdfHandlers(): void {
  ipcMain.handle(IPC.PDF.PICK, async (_event, title?: string): Promise<PickPdfResult> => {
    const win = BrowserWindow.getFocusedWindow();
    const options = {
      title: typeof title === 'string' && title ? title : 'Choose a PDF',
      properties: ['openFile' as const],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    };
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (canceled || filePaths.length === 0) return { canceled: true };

    const filePath = filePaths[0];

    if (statSync(filePath).size > MAX_BYTES) {
      throw new Error('That PDF is over 200 MB and was not opened.');
    }

    let data: Uint8Array;
    try {
      data = new Uint8Array(readFileSync(filePath));
    } catch {
      throw new Error("Couldn't read that file. Make sure it's a PDF you have access to.");
    }

    return { canceled: false, data, fileName: path.basename(filePath) };
  });
}
