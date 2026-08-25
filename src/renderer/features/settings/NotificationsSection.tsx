import { useEffect, useState } from 'react';
import { Bell, Hourglass, CalendarCheck, Clock, Power, Smartphone, CheckCheck } from 'lucide-react';
import { useSettingsStore } from '../../store/useSettingsStore';
import type { AppleRemindersStatus } from '../../../shared/types';
import { SectionHeading, SettingsCard, SettingsRow, PillGroup, Toggle, CardButton, SETTINGS_INPUT } from './components';

const REMINDER_LEAD_OPTIONS = [5, 10, 15, 30] as const;

/**
 * What the phone row says about itself.
 *
 * An error outranks everything: this feature fails silently by nature (a sync
 * that didn't happen looks exactly like one with nothing to do), and the most
 * likely failure — macOS withholding Automation permission — needs the user to
 * go and fix something. Never let a count sit there implying all is well.
 */
function phoneDescription(status: AppleRemindersStatus): string {
  if (status.lastError) return status.lastError;
  if (status.syncing) return 'Syncing with Reminders…';

  if (!status.enabled) {
    return `Puts what's coming up in a "${status.listName}" list in Reminders — iCloud carries it to your phone, so it alerts you with the laptop closed`;
  }

  if (!status.lastSyncAt) return `Waiting for the first sync into "${status.listName}"`;

  const synced = new Date(status.lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const count = status.mirrored === 1 ? '1 assignment' : `${status.mirrored} assignments`;
  return `${count} in "${status.listName}" · last synced ${synced}`;
}

export default function NotificationsSection() {
  const {
    classRemindersEnabled, setClassRemindersEnabled,
    reminderLeadMinutes, setReminderLeadMinutes,
    dueDigestEnabled, setDueDigestEnabled,
    dueDigestTime, setDueDigestTime,
  } = useSettingsStore();

  const [testState, setTestState] = useState<'idle' | 'sent' | 'suppressed' | 'unsupported'>('idle');

  // Start-at-login lives in the OS, not in our settings — read it from there on mount
  // and after every change, so this switch shows what's actually true even if it was
  // turned off in System Settings.
  const [loginItem, setLoginItem] = useState<{ supported: boolean; openAtLogin: boolean }>({
    supported: false, openAtLogin: false,
  });

  useEffect(() => {
    let active = true;
    window.api.app.getLoginItem()
      .then(state => { if (active) setLoginItem(state); })
      .catch(() => { /* leave it off and disabled rather than guess */ });
    return () => { active = false; };
  }, []);

  // The Apple Reminders mirror. Status comes from main (it owns the sync), and every
  // call returns the whole status, so there's one place the row's copy comes from.
  const [phone, setPhone] = useState<AppleRemindersStatus | null>(null);

  /**
   * Poll while this section is on screen.
   *
   * The sync runs on its own timer in main, so the row's copy goes stale the
   * moment a pass changes anything — and it was only ever fetched on mount and
   * after the user pressed something. Leaving Settings open meant sitting on a
   * failure that had since resolved itself, or worse, on a success while a sync
   * was quietly failing. The row's whole job is to not let a stale count imply
   * all is well, and it was doing exactly that.
   *
   * Ten seconds against a five-minute sync is deliberate overkill: the call
   * reads in-memory state plus one small SELECT, and the pass it is watching for
   * can start at any moment. The interval is torn down with the section, so it
   * costs nothing on every other screen.
   */
  useEffect(() => {
    let active = true;
    const read = () => {
      window.api.appleReminders.status()
        .then(status => { if (active) setPhone(status); })
        .catch(() => { /* row stays hidden rather than showing a broken control */ });
    };
    read();
    const timer = setInterval(read, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  async function handlePhoneToggle(enabled: boolean) {
    // Enabling kicks off a sync in main, which can take a few seconds on the first
    // pass; show the pending state immediately rather than a dead toggle.
    setPhone(current => (current ? { ...current, enabled, syncing: enabled } : current));
    try {
      setPhone(await window.api.appleReminders.setEnabled(enabled));
    } catch {
      setPhone(await window.api.appleReminders.status().catch(() => phone));
    }
  }

  async function handleRemoveCompleted(remove: boolean) {
    // Main re-syncs on this change, so show the pending state for the same reason
    // the enable toggle does — the first pass can take a few seconds.
    setPhone(current => (current ? { ...current, removeCompleted: remove, syncing: true } : current));
    try {
      setPhone(await window.api.appleReminders.setRemoveCompleted(remove));
    } catch {
      setPhone(await window.api.appleReminders.status().catch(() => phone));
    }
  }

  async function handlePhoneSync() {
    setPhone(current => (current ? { ...current, syncing: true } : current));
    try {
      setPhone(await window.api.appleReminders.syncNow());
    } catch {
      setPhone(await window.api.appleReminders.status().catch(() => phone));
    }
  }

  /**
   * Throw the mirrored list away and let the next sync rebuild it.
   *
   * Confirmed rather than immediate: this deletes reminders that iCloud has
   * already carried to the phone, which is not something to discover after the
   * fact. The repair exists because a sync that lost track of what it created
   * used to make a fresh copy every five minutes, and nothing links the strays.
   */
  async function handlePhoneRebuild() {
    const ok = window.confirm(
      `This deletes the "${phone?.listName ?? 'Studeo'}" list from Reminders — on this Mac and, ` +
      'through iCloud, on your phone — and rebuilds it from your assignments on the next sync.\n\n' +
      'Use this if the list has filled up with duplicates. Anything you added to it by hand will be lost.',
    );
    if (!ok) return;
    setPhone(current => (current ? { ...current, syncing: true } : current));
    try {
      setPhone(await window.api.appleReminders.rebuild());
      await handlePhoneSync();
    } catch {
      setPhone(await window.api.appleReminders.status().catch(() => phone));
    }
  }

  async function handleLoginItemChange(enabled: boolean) {
    try {
      setLoginItem(await window.api.app.setLoginItem(enabled));
    } catch {
      setLoginItem(await window.api.app.getLoginItem().catch(() => loginItem));
    }
  }

  async function handleTest() {
    try {
      const { supported, shown } = await window.api.reminders.test();
      setTestState(!supported ? 'unsupported' : shown ? 'sent' : 'suppressed');
    } catch {
      setTestState('unsupported');
    }
  }

  return (
    <div className="mb-8">
      <SectionHeading>Notifications</SectionHeading>
      <SettingsCard>
        <SettingsRow
          icon={<Bell size={17} />}
          label="Remind me before class"
          description="Desktop notification before each scheduled class time"
        >
          <Toggle checked={classRemindersEnabled} onChange={setClassRemindersEnabled} />
        </SettingsRow>
        {classRemindersEnabled && (
          <SettingsRow
            icon={<Hourglass size={17} />}
            label="Lead time"
            description="How early the reminder fires"
          >
            <PillGroup
              options={REMINDER_LEAD_OPTIONS}
              value={reminderLeadMinutes}
              onChange={setReminderLeadMinutes}
              suffix=" min"
            />
          </SettingsRow>
        )}
        <SettingsRow
          icon={<CalendarCheck size={17} />}
          label="Daily due-date digest"
          description="One notification listing what's due today and tomorrow"
        >
          <Toggle checked={dueDigestEnabled} onChange={setDueDigestEnabled} />
        </SettingsRow>
        {dueDigestEnabled && (
          <SettingsRow
            icon={<Clock size={17} />}
            label="Digest time"
            description="When the daily digest arrives"
          >
            <input
              type="time"
              value={dueDigestTime}
              onChange={e => setDueDigestTime(e.target.value)}
              aria-label="Daily digest time"
              className={SETTINGS_INPUT}
            />
          </SettingsRow>
        )}
        {/* The only path that reaches you with the laptop shut: Reminders items are
            carried to the phone by iCloud, and the phone does the alerting. */}
        {phone?.supported && (
          <SettingsRow
            icon={<Smartphone size={17} />}
            label="Send assignments to my phone"
            description={phoneDescription(phone)}
          >
            <div className="flex items-center gap-3">
              {phone.enabled && (
                <>
                  {/* Repair, not routine — it's destructive, so it stays quiet
                      next to the action people actually reach for. */}
                  <CardButton onClick={handlePhoneRebuild} disabled={phone.syncing}>
                    Rebuild list
                  </CardButton>
                  <CardButton onClick={handlePhoneSync} disabled={phone.syncing}>
                    {phone.syncing ? 'Syncing…' : 'Sync now'}
                  </CardButton>
                </>
              )}
              <Toggle checked={phone.enabled} onChange={handlePhoneToggle} disabled={phone.syncing} />
            </div>
          </SettingsRow>
        )}
        {/* Nested under the row above and only shown while the mirror is on — it's a
            detail of how the mirror behaves, meaningless on its own, and follows the
            same reveal-when-relevant pattern as lead time and digest time. */}
        {phone?.supported && phone.enabled && (
          <SettingsRow
            icon={<CheckCheck size={17} />}
            label="Clear finished work from the list"
            description={
              phone.removeCompleted
                ? `Completing an assignment deletes it from "${phone.listName}"`
                : `Completing an assignment ticks it off, leaving it under Completed in "${phone.listName}"`
            }
          >
            <Toggle
              checked={phone.removeCompleted}
              onChange={handleRemoveCompleted}
              disabled={phone.syncing}
            />
          </SettingsRow>
        )}
        {/* Reminders and the menu-bar "Up next" item only run while Studeo is open,
            so this is the switch that decides whether they survive a restart. */}
        <SettingsRow
          icon={<Power size={17} />}
          label="Start Studeo when I log in"
          description={
            loginItem.supported
              ? 'Reminders only run while Studeo is open — this keeps them working after a restart'
              : import.meta.env.DEV
                ? 'Unavailable while running in development — works in the installed app'
                : 'Not available on this system'
          }
        >
          <Toggle
            checked={loginItem.openAtLogin}
            onChange={handleLoginItemChange}
            disabled={!loginItem.supported}
          />
        </SettingsRow>
        {/* Test row — reminders are silent failures by nature; let the user
            prove notifications actually reach their screen before relying on them. */}
        <div className="flex items-center justify-between gap-4 px-5 py-3">
          <p className="text-xs text-muted" aria-live="polite">
            {testState === 'sent'
              // In dev the app runs under the stock Electron binary, so macOS
              // lists it as "Electron" in notification settings, not "Studeo".
              ? 'Sent — you should have seen it just now.'
              : testState === 'suppressed'
                // The OS took it and never displayed it, which is a different problem
                // from "this platform can't do notifications" and has a different fix.
                ? `Sent, but your system didn't display it. Check System Settings → Notifications → ${import.meta.env.DEV ? 'Electron' : 'Studeo'}, and that Focus is off.`
                : testState === 'unsupported'
                  ? "Desktop notifications aren't available on this system."
                  : 'Not sure notifications will show up?'}
          </p>
          <CardButton onClick={handleTest}>Send a test</CardButton>
        </div>
      </SettingsCard>
    </div>
  );
}
