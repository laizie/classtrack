import { ipcMain, shell, dialog, BrowserWindow, app } from 'electron';
import { rmSync, existsSync, readdirSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { IPC } from '../../shared/types';
import { SETTING_KEYS } from '../../shared/settingsKeys';
import { parseBackupFileName } from '../../shared/backupRotation';
import { backupsDir } from '../db/backups';
import { getLoginItemState, setOpenAtLogin } from '../loginItem';
import { getDb, getDbPath, closeDb, snapshotInto, validateBackupFile } from '../db/connection';
import { getAssetsRoot, sweepOrphanAssets } from '../media';
import { getAllSettings, setSetting } from '../settings';
import { collectAssetRefs } from '../../shared/notes';
import { listAllContentJson } from '../db/repositories/noteRepo';
import { listAllVersionContentJson } from '../db/repositories/noteVersionRepo';
import { checkForUpdatesNow } from '../updater';

// The allowlist itself lives in shared/settingsKeys.ts so main and the renderer read the
// same list instead of two hand-synced copies. A Set for the O(1) membership check here.
const ALLOWED_SETTING_KEYS = new Set<string>(SETTING_KEYS);

// App-level utilities for a local-first app: let the user see exactly where
// their data lives, and take a backup copy of it on demand.

export function registerAppHandlers(): void {
  ipcMain.handle(IPC.APP.REVEAL_DATA, () => {
    shell.showItemInFolder(getDbPath());
  });

  // Updates install themselves in the background, which is quiet but unverifiable:
  // there's no way to tell "already up to date" from "the updater is broken". This
  // is the on-demand answer.
  ipcMain.handle(IPC.APP.CHECK_UPDATES, () => checkForUpdatesNow());

  // Preferences persistence. GET is synchronous (ipcMain.on + event.returnValue) so the
  // preload can read it before the renderer paints — e.g. the theme applies with no flash.
  ipcMain.on(IPC.APP.GET_SETTINGS, (event) => {
    event.returnValue = getAllSettings();
  });

  ipcMain.handle(IPC.APP.SET_SETTING, (_event, key: string, value: string) => {
    // The allowlist is the security boundary: IPC input is untrusted, so we never write
    // an arbitrary key. But dropping unknown keys *silently* turned a one-word typo into
    // an invisible product bug — 'canvasFeedUrl' was written by the Import page and
    // discarded here for however long, so the feed URL was simply never remembered and
    // nothing anywhere said so. Refusing is still right; refusing quietly is not.
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      console.warn(`[settings] Ignoring unknown key "${key}" — add it to SETTING_KEYS if it's real.`);
      return;
    }
    if (typeof value !== 'string') {
      console.warn(`[settings] Ignoring non-string value for "${key}" (got ${typeof value}).`);
      return;
    }
    setSetting(key, value);
  });

  // True OS fullscreen for Focus Mode. The HTML Fullscreen API can leave the window
  // chrome visible; driving the BrowserWindow directly hides the title bar entirely.
  // We resolve the window from the calling webContents so this is window-correct.
  ipcMain.handle(IPC.APP.SET_FULLSCREEN, (event, on: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setFullScreen(Boolean(on));
  });

  ipcMain.handle(IPC.APP.GET_FULLSCREEN, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
  });

  ipcMain.handle(IPC.APP.BACKUP_DATA, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const today = new Date().toISOString().slice(0, 10);
    const options = {
      title: 'Back up Studeo data',
      defaultPath: `Studeo-backup-${today}.db`,
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
    };
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return { saved: false };

    try {
      // VACUUM INTO writes a consistent single-file snapshot even in WAL mode
      // (a plain file copy could catch the db mid-write). It refuses to
      // overwrite, so clear the target the save dialog already confirmed.
      rmSync(filePath, { force: true });
      getDb().prepare('VACUUM INTO ?').run(filePath);

      // Note images live outside the .db file, so a db-only backup would lose them on
      // restore. Copy the asset folder next to the backup (e.g. "…-backup-2026-06-13-assets/")
      // whenever there are any. Sibling folder rather than a zip — no archive dependency.
      const assetsRoot = getAssetsRoot();
      if (existsSync(assetsRoot) && readdirSync(assetsRoot).length > 0) {
        const assetsTarget = filePath.replace(/\.db$/i, '') + '-assets';
        rmSync(assetsTarget, { recursive: true, force: true });
        cpSync(assetsRoot, assetsTarget, { recursive: true });
      }

      return { saved: true, path: filePath };
    } catch (err) {
      return { saved: false, error: err instanceof Error ? err.message : 'Backup failed' };
    }
  });

  // Reclaim image files nothing points at any more. Deleting a picture or a slide from a
  // note leaves its file on disk — only deleting the whole note cleans up — so this is the
  // one thing that ever gets that space back.
  //
  // The reference set is gathered from every note (archived included) AND every stored
  // version, because both can still be put back on screen. Over-collecting is the safe
  // error here: a missed reference means a file is deleted while something still shows it.
  ipcMain.handle(IPC.APP.SWEEP_ASSETS, () => {
    const referenced = new Set<string>();
    for (const json of [...listAllContentJson(), ...listAllVersionContentJson()]) {
      for (const ref of collectAssetRefs(json)) referenced.add(ref);
    }
    return sweepOrphanAssets(referenced);
  });

  // Automatic backups run on their own in the main process (see db/backups.ts).
  // These two exist so Settings can show they're working and put the folder one
  // click away — a safety net you can't see is one you won't trust in a crisis.
  ipcMain.handle(IPC.APP.LIST_BACKUPS, () => {
    const dir = backupsDir();
    const names = existsSync(dir) ? readdirSync(dir) : [];

    let count = 0;
    let newestDay: string | null = null;
    for (const name of names) {
      const parsed = parseBackupFileName(name);
      if (!parsed) continue; // ignore anything we didn't write
      count += 1;
      if (newestDay === null || parsed.day > newestDay) newestDay = parsed.day;
    }
    return { count, newestDay };
  });

  ipcMain.handle(IPC.APP.REVEAL_BACKUPS, async () => {
    // Created on demand: on a fresh install nothing has been backed up yet, and
    // opening a folder that doesn't exist just fails silently.
    const dir = backupsDir();
    mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  // "Start at login". Not stored in settings.json on purpose — the OS owns this
  // value and the user can change it outside the app, so we always ask it.
  ipcMain.handle(IPC.APP.GET_LOGIN_ITEM, () => getLoginItemState());

  ipcMain.handle(IPC.APP.SET_LOGIN_ITEM, (_event, enabled: unknown) => {
    // IPC input is untrusted; coerce rather than hand anything to the OS API.
    return setOpenAtLogin(enabled === true);
  });

  // Restore is the inverse of backup, and the one action that overwrites all
  // current data — so it validates the chosen file, snapshots the current data
  // first (recoverable), swaps the file, then relaunches for a clean re-init.
  ipcMain.handle(IPC.APP.RESTORE_DATA, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Restore Studeo data from a backup',
      properties: ['openFile' as const],
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
    };
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (canceled || filePaths.length === 0) return { restored: false, canceled: true };

    const backupPath = filePaths[0];

    // 1. Make sure this is actually a Studeo database before touching anything.
    try {
      validateBackupFile(backupPath);
    } catch (err) {
      return { restored: false, error: err instanceof Error ? err.message : 'Invalid backup file' };
    }

    const dbPath = getDbPath();
    const assetsRoot = getAssetsRoot();

    try {
      // 2. Safety net: snapshot the CURRENT data before we overwrite it, so a
      //    mistaken restore is itself recoverable. Best-effort on the assets.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const snapshotPath = path.join(path.dirname(dbPath), `studeo-pre-restore-${stamp}.db`);
      rmSync(snapshotPath, { force: true });
      snapshotInto(snapshotPath);
      if (existsSync(assetsRoot) && readdirSync(assetsRoot).length > 0) {
        cpSync(assetsRoot, snapshotPath.replace(/\.db$/i, '') + '-assets', { recursive: true });
      }

      // 3. Swap in the backup. Close the connection first so the file handle is
      //    released, and drop the stale WAL sidecars so they can't be replayed
      //    on top of the restored file.
      closeDb();
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      cpSync(backupPath, dbPath);

      // Restore note images if the backup carried its sibling "…-assets" folder.
      const backupAssets = backupPath.replace(/\.db$/i, '') + '-assets';
      if (existsSync(backupAssets)) {
        rmSync(assetsRoot, { recursive: true, force: true });
        cpSync(backupAssets, assetsRoot, { recursive: true });
      }
    } catch (err) {
      return { restored: false, error: err instanceof Error ? err.message : 'Restore failed' };
    }

    // 4. Relaunch so everything re-initializes from the restored file (migrations
    //    re-run, renderer caches rebuild). Delay briefly so this reply reaches the
    //    renderer before the window is torn down.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 400);
    return { restored: true };
  });
}
