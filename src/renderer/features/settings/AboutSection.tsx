import { useEffect, useState } from 'react';
import { Info, FolderOpen, HardDriveDownload, HardDriveUpload, History, RefreshCw, Eraser } from 'lucide-react';
import { version as appVersion } from '../../../../package.json';
import { SectionHeading, SettingsCard, SettingsRow, CardButton } from './components';
import ConfirmDialog from '../../components/ConfirmDialog';
import type { UpdateCheckResult } from '../../../shared/types';

export default function AboutSection() {
  const [backupState, setBackupState] = useState<'idle' | 'saving' | 'done' | 'failed'>('idle');
  const [backupDetail, setBackupDetail] = useState('');

  const [autoBackups, setAutoBackups] = useState<{ count: number; newestDay: string | null } | null>(null);

  // 'idle' before the first check; afterwards the answer main gave us.
  const [updateState, setUpdateState] = useState<'idle' | 'checking'>('idle');
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);

  const [sweepState, setSweepState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');
  const [sweepDetail, setSweepDetail] = useState('');

  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restoreState, setRestoreState] = useState<'idle' | 'restoring' | 'done' | 'failed'>('idle');
  const [restoreDetail, setRestoreDetail] = useState('');

  // Read once on mount. These snapshots are written by main at launch, so the count
  // can't change while Settings is open — no need to poll or invalidate.
  useEffect(() => {
    let active = true;
    window.api.app.listBackups()
      .then(status => { if (active) setAutoBackups(status); })
      .catch(() => { /* leave it unknown rather than claiming zero */ });
    return () => { active = false; };
  }, []);

  async function handleBackup() {
    setBackupState('saving');
    try {
      const result = await window.api.app.backupData();
      if (result.saved) {
        setBackupState('done');
        setBackupDetail(result.path ?? '');
      } else if (result.error) {
        setBackupState('failed');
        setBackupDetail(result.error);
      } else {
        setBackupState('idle'); // user canceled the save dialog — not an error
      }
    } catch {
      setBackupState('failed');
      setBackupDetail('');
    }
  }

  async function handleSweep() {
    setSweepState('working');
    try {
      const { removed, bytes } = await window.api.app.sweepAssets();
      setSweepState('done');
      setSweepDetail(
        removed === 0
          ? 'Nothing to clean up — every image is still in use.'
          : `Freed ${formatBytes(bytes)} from ${removed} unused image${removed === 1 ? '' : 's'}.`,
      );
    } catch {
      setSweepState('failed');
      setSweepDetail('');
    }
  }

  async function handleCheckUpdates() {
    setUpdateState('checking');
    try {
      setUpdateResult(await window.api.app.checkForUpdates());
    } catch {
      setUpdateResult({ status: 'error', message: "The update check couldn't be started." });
    } finally {
      setUpdateState('idle');
    }
  }

  async function handleRestore() {
    setRestoreConfirmOpen(false);
    setRestoreState('restoring');
    try {
      const result = await window.api.app.restoreData();
      // On success the app relaunches, so we usually never reach the "done" UI —
      // but set it anyway in case the relaunch is delayed.
      if (result.restored) {
        setRestoreState('done');
      } else if (result.error) {
        setRestoreState('failed');
        setRestoreDetail(result.error);
      } else {
        setRestoreState('idle'); // user canceled the file picker — not an error
      }
    } catch {
      setRestoreState('failed');
      setRestoreDetail('');
    }
  }

  // Updates arrive on their own, so this button exists to *answer a question*
  // ("am I current?") — which means every branch has to say something definite.
  const updateDescription =
    updateState === 'checking'   ? 'Asking the update service…'
    : updateResult === null        ? `Studeo checks hourly on its own. Version ${appVersion}.`
    : updateResult.status === 'up-to-date'  ? `You're on the newest version (${appVersion}).`
    : updateResult.status === 'downloading' ? 'A newer version is downloading — you\'ll be asked to restart when it\'s ready.'
    : updateResult.status === 'downloaded'  ? `An update${updateResult.version ? ` (${updateResult.version})` : ''} is ready — restart Studeo to finish installing it.`
    : updateResult.status === 'unsupported' ? 'Updates only run in an installed build, not while developing.'
    : `Couldn't check — ${updateResult.message}`;

  // Bytes as something a person reads. Sizes here are one image to a whole deck, so kB/MB
  // is the whole useful range.
  const formatBytes = (n: number): string =>
    n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`;

  const sweepDescription =
    sweepState === 'done'     ? sweepDetail
    : sweepState === 'failed' ? "Couldn't check for unused images. Please try again."
    : 'Deleting a picture or a slide leaves its file behind. This reclaims the space — anything a note or its history still shows is kept.';

  const backupDescription =
    backupState === 'done'   ? `Saved to ${backupDetail}`
    : backupState === 'failed' ? `Backup failed${backupDetail ? ` — ${backupDetail}` : ''}. Please try again.`
    : 'Save a snapshot of your database (note images are copied alongside it) — a safe copy before big changes';

  // Local YYYY-MM-DD, to compare against the day main filed the newest snapshot under.
  const todayKey = (() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  })();

  const autoBackupDescription =
    autoBackups === null || autoBackups.count === 0
      ? 'Saved on its own once a day, and again before every app update'
      : `${autoBackups.count} kept — newest ${autoBackups.newestDay === todayKey ? 'today' : autoBackups.newestDay}`;

  const restoreDescription =
    restoreState === 'restoring' ? 'Restoring… the app will restart in a moment.'
    : restoreState === 'done'     ? 'Restored — restarting…'
    : restoreState === 'failed'   ? `Restore failed${restoreDetail ? ` — ${restoreDetail}` : ''}. Your data was not changed.`
    : 'Replace your current data with a backup file. A safety copy of your current data is saved first.';

  return (
    <div>
      <SectionHeading>About</SectionHeading>
      <SettingsCard>
        <SettingsRow
          icon={<Info size={17} />}
          label={`Studeo ${appVersion}`}
          description="Local-first — everything you enter stays in a database on this device."
        />
        <SettingsRow
          icon={<RefreshCw size={17} />}
          label="Updates"
          description={updateDescription}
        >
          <CardButton onClick={handleCheckUpdates} disabled={updateState === 'checking'}>
            {updateState === 'checking' ? 'Checking…' : 'Check now'}
          </CardButton>
        </SettingsRow>
        <SettingsRow
          icon={<FolderOpen size={17} />}
          label="Your data"
          description="One SQLite file in your app data folder"
        >
          <CardButton onClick={() => window.api.app.revealData()}>
            Show file
          </CardButton>
        </SettingsRow>
        <SettingsRow
          icon={<HardDriveDownload size={17} />}
          label="Back up"
          description={backupDescription}
        >
          <CardButton onClick={handleBackup} disabled={backupState === 'saving'}>
            {backupState === 'saving' ? 'Saving…' : 'Back up now…'}
          </CardButton>
        </SettingsRow>
        <SettingsRow
          icon={<History size={17} />}
          label="Automatic backups"
          description={autoBackupDescription}
        >
          <CardButton onClick={() => window.api.app.revealBackups()}>
            Show backups
          </CardButton>
        </SettingsRow>
        <SettingsRow
          icon={<Eraser size={17} />}
          label="Clean up unused images"
          description={sweepDescription}
        >
          <CardButton onClick={handleSweep} disabled={sweepState === 'working'}>
            {sweepState === 'working' ? 'Checking…' : 'Clean up'}
          </CardButton>
        </SettingsRow>
        <SettingsRow
          icon={<HardDriveUpload size={17} />}
          label="Restore from backup"
          description={restoreDescription}
        >
          <CardButton
            onClick={() => setRestoreConfirmOpen(true)}
            disabled={restoreState === 'restoring' || restoreState === 'done'}
          >
            {restoreState === 'restoring' ? 'Restoring…' : 'Restore…'}
          </CardButton>
        </SettingsRow>
      </SettingsCard>

      <ConfirmDialog
        isOpen={restoreConfirmOpen}
        title="Restore from a backup?"
        message="This replaces all of your current courses, assignments, notes, and settings with the backup you choose. A safety copy of your current data is saved first, and the app will restart."
        confirmLabel="Restore"
        onConfirm={handleRestore}
        onClose={() => setRestoreConfirmOpen(false)}
      />
    </div>
  );
}
