import { app, BrowserWindow, protocol, dialog, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import { initDb } from './main/db/connection';
import { registerCourseHandlers } from './main/ipc/registerCourseHandlers';
import { registerAssignmentHandlers } from './main/ipc/registerAssignmentHandlers';
import { registerTaskHandlers } from './main/ipc/registerTaskHandlers';
import { registerSubtaskHandlers } from './main/ipc/registerSubtaskHandlers';
import { registerClassMeetingHandlers } from './main/ipc/registerClassMeetingHandlers';
import { registerMeetingExceptionHandlers } from './main/ipc/registerMeetingExceptionHandlers';
import { registerTermHandlers } from './main/ipc/registerTermHandlers';
import { registerStudySessionHandlers } from './main/ipc/registerStudySessionHandlers';
import { registerStudyBlockHandlers } from './main/ipc/registerStudyBlockHandlers';
import { registerNoteHandlers } from './main/ipc/registerNoteHandlers';
import { registerNoteLinkHandlers } from './main/ipc/registerNoteLinkHandlers';
import { registerMediaHandlers } from './main/ipc/registerMediaHandlers';
import { ASSET_SCHEME, registerAssetProtocol } from './main/media';
import { applySessionSecurity, hardenWindow } from './main/security';
import { registerReminderHandlers } from './main/ipc/registerReminderHandlers';
import { registerAppHandlers } from './main/ipc/registerAppHandlers';
import { registerFeedHandlers } from './main/ipc/registerFeedHandlers';
import { registerSyllabusHandlers } from './main/ipc/registerSyllabusHandlers';
import { registerSlideHandlers } from './main/ipc/registerSlideHandlers';
import { startReminderScheduler, setReminderNavigationHandler } from './main/reminders';
import { IPC } from './shared/types';
import type { ReminderNavTarget } from './shared/types';
import { registerSpotifyHandlers, notifyAuthCallback } from './main/ipc/registerSpotifyHandlers';
import { registerAppleMusicHandlers } from './main/ipc/registerAppleMusicHandlers';
import { registerAppleRemindersHandlers } from './main/ipc/registerAppleRemindersHandlers';
import { startAppleRemindersSync, stopAppleRemindersSync } from './main/applereminders';
import { setAuthCompletionHandler } from './main/spotify/spotifyAuth';
import { initAutoUpdater } from './main/updater';
import { initTray, destroyTray } from './main/tray';
import { launchedInBackground } from './main/loginItem';

if (started) {
  app.quit();
}

// Must run before app `ready`: mark our custom scheme as a privileged, secure standard
// scheme so the renderer can load studeo-asset:// images like any normal https resource.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function registerIpcHandlers(): void {
  registerCourseHandlers();
  registerAssignmentHandlers();
  registerTaskHandlers();
  registerSubtaskHandlers();
  registerClassMeetingHandlers();
  registerMeetingExceptionHandlers();
  registerTermHandlers();
  registerStudySessionHandlers();
  registerStudyBlockHandlers();
  registerNoteHandlers();
  registerNoteLinkHandlers();
  registerMediaHandlers();
  registerReminderHandlers();
  registerAppHandlers();
  registerFeedHandlers();
  registerSyllabusHandlers();
  registerSlideHandlers();
  registerSpotifyHandlers();
  registerAppleMusicHandlers();
  registerAppleRemindersHandlers();
}

/**
 * Open the database, or tell the user why we couldn't and get out of the way.
 *
 * Migrations are transactional (see db/connection.ts), so a failure here means the
 * data on disk is intact — we just can't run against a schema we couldn't finish
 * setting up. Without this the throw would escape the `ready` handler, no window
 * would ever be created, and the app would look like it simply doesn't launch.
 * Say what happened and put the data folder one click away so a backup is possible.
 *
 * Returns false when startup must not continue. The caller has to honour that: the
 * "Show data folder" path exits asynchronously, so without the early return the rest
 * of `ready` would go on to open a window against a database that isn't there.
 */
function tryInitDb(): boolean {
  try {
    initDb();
    return true;
  } catch (err) {
    console.error('[DB] Startup failed:', err);
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Studeo',
      message: "Studeo couldn't open your data",
      detail:
        `${err instanceof Error ? err.message : String(err)}\n\n` +
        'Your existing data has not been changed. You can open the data folder to ' +
        'back up studeo.db before trying again.',
      buttons: ['Show data folder', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      shell.openPath(app.getPath('userData')).finally(() => app.exit(1));
    } else {
      app.exit(1);
    }
    return false;
  }
}

// Kept at module scope so the tray's "Open Studeo" can find (or recreate) it.
let mainWindow: BrowserWindow | null = null;

const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1280,
    height: 960,
    minWidth: 900,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses contextBridge + ipcRenderer (both sandbox-safe), and note
      // images load via the studeo-asset:// custom protocol rather than file://, so the
      // renderer can run fully sandboxed — the strongest isolation for untrusted UI.
      sandbox: true,
    },
  });
  mainWindow = win;
  win.on('closed', () => { mainWindow = null; });

  // Resolve the page URL up front: hardenWindow() needs to know exactly which document
  // this window is allowed to be on, so it can refuse every navigation away from it.
  const pageUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? MAIN_WINDOW_VITE_DEV_SERVER_URL
    : pathToFileURL(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      ).href;

  // Guards attach before the load purely so there's no window in which they're absent.
  // (`will-navigate` fires for renderer-initiated navigation, not for this loadURL.)
  hardenWindow(win, pageUrl);
  win.loadURL(pageUrl);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.webContents.openDevTools();
  }

  // Keep the renderer's Focus Mode in sync with OS fullscreen — including the exits
  // it can't initiate itself (Esc, the green traffic-light button, Ctrl+Cmd+F).
  const sendFullscreen = (isFullscreen: boolean) =>
    win.webContents.send('app:fullscreen-changed', { isFullscreen });
  win.on('enter-full-screen', () => sendFullscreen(true));
  win.on('leave-full-screen', () => sendFullscreen(false));
  return win;
};

// Show the main window, recreating it if it was closed (macOS keeps the app
// running with no window). Used by the tray's "Open Studeo". Returns the live
// window so callers (e.g. reminder deep-links) can talk to its webContents.
function showMainWindow(): BrowserWindow {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  return createWindow();
}

// A reminder was clicked in main: bring the app forward and tell the renderer
// where to go. If the window was closed and is loading fresh, wait for the
// renderer to be ready before sending — otherwise the push lands in the void.
function navigateFromReminder(target: ReminderNavTarget): void {
  const win = showMainWindow();
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () =>
      win.webContents.send(IPC.REMINDERS.NAVIGATE, target),
    );
  } else {
    win.webContents.send(IPC.REMINDERS.NAVIGATE, target);
  }
}

app.on('ready', () => {
  app.setAppUserModelId(app.getName());

  // CSP + permission policy for every response this session serves. Must run before
  // the window loads anything.
  applySessionSecurity(MAIN_WINDOW_VITE_DEV_SERVER_URL);

  // Wire up the Spotify localhost callback → renderer notification.
  // The localhost server in spotifyAuth.ts calls this when the user returns
  // from Spotify's auth page; we forward the result to the renderer so
  // useSpotifyAuthListener can invalidate the status query immediately.
  setAuthCompletionHandler(notifyAuthCallback);

  // Everything below needs a working database — bail rather than open a broken window.
  if (!tryInitDb()) return;

  registerAssetProtocol(); // serves studeo-asset:// note images from the data folder
  registerIpcHandlers();
  startReminderScheduler(); // after initDb — the scheduler reads class meetings
  startAppleRemindersSync(); // no-op unless enabled; reads assignments, so after initDb
  setReminderNavigationHandler(navigateFromReminder); // clicked reminders → route the renderer
  // A login start (Windows) comes up with no window: the point is to get the
  // reminder scheduler and the tray running, not to interrupt you at boot. The
  // tray's "Open Studeo" recreates the window on demand. Every other launch —
  // including every launch on macOS, where the OS no longer tells us — opens
  // normally. See loginItem.ts.
  if (!launchedInBackground()) {
    createWindow();
  }
  initTray(showMainWindow); // menu-bar "Up next" item — reads class meetings, so after initDb
  initAutoUpdater(); // checks GitHub for newer published releases (packaged builds only)
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Tear the tray down cleanly on quit (stops the poll, removes the menu-bar item).
app.on('before-quit', () => {
  destroyTray();
  stopAppleRemindersSync();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
