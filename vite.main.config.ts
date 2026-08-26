import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // These modules are provided by Electron at runtime — Vite must not
      // try to bundle them. 'electron' is the Electron API; 'node:*' are
      // Node built-ins (including node:sqlite which is compiled into Node).
      //
      // pdfjs-dist used to be listed here as external, on the assumption that it would
      // be required from the packaged app's node_modules at runtime. There is no
      // node_modules in the packaged app — forge/vite ship a self-contained bundle — so
      // that import could only ever fail once installed, and every syllabus import in a
      // release build did. Main no longer touches pdfjs at all: PDFs are read as bytes
      // here and parsed in the renderer, which bundles pdfjs properly. Anything added to
      // this list must be something Electron or the OS provides at runtime, not just a
      // package.json dependency.
      // @coooookies/windows-smtc-monitor is a prebuilt native (.node) addon loaded
      // at runtime from node_modules on Windows only (see windowsMediaSession.ts).
      // Vite must not try to bundle it — the binary can't be inlined.
      external: ['electron', /^node:/, /^@coooookies\/windows-smtc-monitor/],
    },
  },
});
