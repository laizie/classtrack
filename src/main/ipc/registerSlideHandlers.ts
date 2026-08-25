import { ipcMain, dialog, BrowserWindow } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { IPC, type PickPdfResult } from '../../shared/types';

// Picking and reading the file is main's job — the sandboxed renderer has no filesystem
// access, and shouldn't. But unlike the syllabus handler next door, we do NOT extract
// anything here: the renderer wants pictures of the pages, and rasterizing a PDF page
// needs a canvas. Main has none on purpose (extractPdfText.ts stubs DOMMatrix so pdfjs
// never reaches for the native @napi-rs/canvas), so main hands over the bytes and the
// renderer — a real browser, with a real canvas — draws the pages.
//
// Uint8Array survives the IPC boundary as-is: Electron uses the structured clone
// algorithm, which handles typed arrays natively (no base64 round-trip).

// A lecture deck of scanned page images can be genuinely large, so this ceiling is more
// generous than the syllabus handler's 25 MB. It still exists to stop a mis-picked file
// (a video, a disk image renamed .pdf) from being slurped into memory.
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB

export function registerSlideHandlers(): void {
  ipcMain.handle(IPC.SLIDES.PICK_PDF, async (): Promise<PickPdfResult> => {
    const win = BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Choose a slides PDF',
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
