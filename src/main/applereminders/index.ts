import { listAssignments } from '../db/repositories/assignmentRepo';
import { listCourses } from '../db/repositories/courseRepo';
import {
  listReminderLinks,
  saveReminderLink,
  deleteReminderLink,
} from '../db/repositories/appleReminderLinkRepo';
import { planReminderSync, COMPLETED_SIGNATURE } from '../../shared/appleReminderSync';
import { createSyncScheduler } from './syncScheduler';
import type { AppleRemindersStatus } from '../../shared/types';
import { getSetting, setSetting } from '../settings';
import {
  ensureList,
  createReminder,
  updateReminder,
  completeReminder,
  deleteReminder,
  listRemindersInList,
  parseReminderIndex,
  countReminders,
  deleteList,
} from './remindersScript';

/**
 * Mirrors upcoming assignments into Apple Reminders so they reach the phone.
 *
 * The problem this solves: everything else that notifies you in Studeo runs on a
 * poll inside this process, so it all stops the moment the lid closes. Handing
 * the items to Reminders moves the alarm onto a device that's always awake, and
 * gives you something you can open and read rather than a notification you
 * dismissed on the way to class.
 *
 * The decision-making lives in shared/appleReminderSync.ts and is unit-tested.
 * This module is the plumbing around it: settings, a timer, and turning a plan
 * into AppleScript calls.
 */

/**
 * A dedicated list, not one the user picks.
 *
 * This is a safety property rather than a shortcut: the sync deletes and
 * completes items in whatever list it owns. Pointed at an existing list it would
 * be capable of ticking off (or removing) reminders it didn't create. Owning a
 * list called "Studeo" means the worst it can do is mismanage its own mirror.
 */
const LIST_NAME = 'Studeo';

const SETTING_KEY = 'appleRemindersEnabled';

/** Opt-in: delete a mirrored reminder when its assignment is completed instead of
 *  ticking it off. Off by default — completing is the reversible behaviour, and a
 *  setting that deletes things should be chosen, not inherited. */
const REMOVE_COMPLETED_KEY = 'appleRemindersRemoveCompleted';

/** Assignments change at human speed; five minutes is well inside "before I
 *  notice". A sync with nothing to do costs zero AppleScript calls (see below),
 *  so the idle case is just a SQLite read. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long to wait after an assignment changes before syncing.
 *
 * The interval above is the backstop; this is what makes the mirror feel
 * attached to what you just did. Ten seconds is long enough that Day-One Setup
 * — a semester entered a row at a time — produces one pass rather than thirty,
 * and short enough that ticking something off and reaching for your phone finds
 * it already done. The ceiling stops a long stream of edits deferring the pass
 * forever; a pass with nothing to do costs no AppleScript calls, so an early
 * one is cheap.
 */
const CHANGE_QUIET_MS = 10 * 1000;
const CHANGE_MAX_WAIT_MS = 60 * 1000;

/**
 * Two limits that turn "wedged forever" into "stopped, and said why".
 *
 * Every item in the plan is its own osascript process, awaited one at a time,
 * and each can burn the full 20s script timeout. So a pass whose calls are all
 * failing slowly — Reminders wedged, or an Automation consent prompt sitting
 * unanswered behind the window and eating each call until it's killed — costs
 * 20s × every item in the plan. With a semester's assignments that is a Settings
 * row reading "Syncing…" for a quarter of an hour, which is indistinguishable
 * from a hang and was being reported as one.
 *
 * ensureList already had this instinct ("one clear message beats twenty
 * identical ones"); the item loops just never honoured it.
 *
 * Stopping early is safe because the pass is resumable by construction: links
 * are written to the DB as each item succeeds, and the plan is recomputed from
 * scratch next time, so an abandoned pass costs nothing but the work not yet
 * done.
 */
const MAX_CONSECUTIVE_FAILURES = 3;
const PASS_BUDGET_MS = 90 * 1000;

/**
 * Should the pass stop early? Pure so it can be tested without a Reminders.app.
 *
 * Consecutive, not total: an occasional failure among successes is the
 * self-healing path (a reminder deleted on the phone), and must not stop a pass
 * that is otherwise working. A *run* of them means the next call will fail too.
 */
/**
 * Is the list too big to be a mirror of these assignments?
 *
 * The mirror holds at most one reminder per assignment, so a list far larger
 * than the assignment count is not a mirror any more — it is the wreckage of
 * the duplicate bug, and adding to it makes the cleanup worse. The slack is
 * generous because legitimate drift exists (an assignment deleted while its
 * reminder is still ticked off, a reminder added by hand), and because being
 * wrong in this direction only costs a sync.
 *
 * Cheap on purpose: `count of reminders` is one Apple Event. Every richer
 * question about a broken list is too slow to ask — which is how the first
 * attempt at this failed, timing out and letting creation proceed regardless.
 */
export function mirrorLooksCorrupt(remindersInList: number, assignmentCount: number): boolean {
  return remindersInList > assignmentCount * 2 + 20;
}

export function shouldAbortPass(
  consecutiveFailures: number,
  elapsedMs: number,
): 'failures' | 'budget' | null {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return 'failures';
  if (elapsedMs >= PASS_BUDGET_MS) return 'budget';
  return null;
}

let interval: NodeJS.Timeout | null = null;
let syncing = false;
let lastSyncAt: string | null = null;
let lastError: string | null = null;
/** The list only has to be checked once per run, and only when there's work. */
let listVerified = false;

function supported(): boolean {
  return process.platform === 'darwin';
}

function isEnabled(): boolean {
  return getSetting(SETTING_KEY) === 'true';
}

function removesCompleted(): boolean {
  return getSetting(REMOVE_COMPLETED_KEY) === 'true';
}

export function getAppleRemindersStatus(): AppleRemindersStatus {
  return {
    supported: supported(),
    enabled: supported() && isEnabled(),
    syncing,
    lastSyncAt,
    lastError,
    mirrored: supported() ? listReminderLinks().length : 0,
    listName: LIST_NAME,
    removeCompleted: removesCompleted(),
  };
}

/**
 * Run one sync pass.
 *
 * Ordering is deliberate: removals and completions first, creations last. If the
 * run dies partway (permission revoked, Reminders wedged), the list is left
 * having shed stale items rather than having gained duplicates — the failure
 * that's easy to live with rather than the one that needs manual cleanup.
 */
export async function syncAppleReminders(): Promise<AppleRemindersStatus> {
  if (!supported() || !isEnabled()) return getAppleRemindersStatus();
  // A slow AppleScript pass can outlast the interval; overlapping runs would
  // plan against the same links twice and create duplicates.
  if (syncing) return getAppleRemindersStatus();

  syncing = true;
  try {
    await runSyncPass();
  } catch (err) {
    lastError = describeFailure(err instanceof Error ? err.message : String(err));
  } finally {
    syncing = false;
  }
  // Built after the flag is cleared, so a finished sync doesn't report itself as
  // still running — the Settings row reads this to decide between "Syncing…" and
  // the real result, and would otherwise sit on the pending copy forever.
  return getAppleRemindersStatus();
}

/**
 * One pass. Records its outcome in lastSyncAt / lastError and returns nothing —
 * the caller owns the in-flight flag and builds the status once, after clearing it.
 */
async function runSyncPass(): Promise<void> {
  const plan = planReminderSync(
    listAssignments(), listCourses(), listReminderLinks(), new Date(),
    { completedAction: removesCompleted() ? 'remove' : 'complete' },
  );
  const empty =
    plan.create.length === 0 && plan.update.length === 0 &&
    plan.complete.length === 0 && plan.remove.length === 0;

  // Nothing to do: return without touching AppleScript at all. This is what
  // keeps a five-minute interval from launching Reminders.app all day.
  if (empty && listVerified) {
    lastSyncAt = new Date().toISOString();
    lastError = null;
    return;
  }

  const listReady = await ensureList(LIST_NAME);
  if (!listReady.ok) {
    // Almost always Automation permission. Stop here rather than fail once per
    // item — one clear message beats twenty identical ones.
    lastError = describeFailure(listReady.value);
    return;
  }
  listVerified = true;

  let firstFailure: string | null = null;
  const noteFailure = (reason: string) => {
    if (!firstFailure) firstFailure = describeFailure(reason);
  };

  // Shared by every loop below: a run of failures, or a pass that has outstayed
  // its budget, ends the pass instead of grinding through the rest at 20s each.
  const startedAt = Date.now();
  let consecutiveFailures = 0;
  let stopped: 'failures' | 'budget' | null = null;
  /** Record one item's outcome; returns false when the pass should stop. */
  const step = (ok: boolean, reason?: string): boolean => {
    if (ok) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (reason) noteFailure(reason);
    }
    stopped = shouldAbortPass(consecutiveFailures, Date.now() - startedAt);
    return stopped === null;
  };

  for (const { assignmentId, reminderId } of plan.remove) {
    const result = await deleteReminder(LIST_NAME, reminderId);
    // Gone from Reminders already is the outcome we wanted, so drop the link
    // either way — leaving it would retry this delete forever.
    deleteReminderLink(assignmentId);
    if (!step(result.ok, result.value)) break;
  }

  for (const { assignmentId, reminderId } of plan.complete) {
    if (stopped) break;
    const result = await completeReminder(LIST_NAME, reminderId);
    // Keep the link on success: the assignment still exists, and if it's
    // un-completed later the next sync updates this same reminder instead of
    // adding one. On failure it was most likely deleted on the phone — forget it.
    //
    // The signature becomes the sentinel, which is what makes this a one-shot:
    // without it the planner has no way to tell "finished" from "finished and
    // already ticked off", and re-issues the same complete on every pass.
    if (result.ok) saveReminderLink(assignmentId, reminderId, COMPLETED_SIGNATURE);
    else deleteReminderLink(assignmentId);
    if (!step(result.ok, result.value)) break;
  }

  for (const { reminderId, reminder } of plan.update) {
    if (stopped) break;
    const result = await updateReminder(LIST_NAME, reminderId, reminder);
    if (result.ok) {
      saveReminderLink(reminder.assignmentId, reminderId, reminder.signature);
    } else {
      // The reminder we recorded is unreachable. Dropping the link makes the
      // next pass recreate it, which is how a delete-on-phone self-heals.
      deleteReminderLink(reminder.assignmentId);
    }
    if (!step(result.ok, result.value)) break;
  }

  // Adopt before creating. A create that is killed after `make new reminder` but
  // before it returns the id leaves a reminder we have no link for, and the next
  // pass would make another one — the runaway that turned 125 assignments into
  // 316 reminders. One read of the list lets an orphan be reclaimed instead of
  // duplicated, and it also recovers everything the old code already stranded.
  let adoptable = new Map<string, string>();
  if (plan.create.length > 0 && !stopped) {
    // Cheap question first. If the list is already wreckage, creating more is
    // the one thing guaranteed to make it worse, and the user needs telling
    // rather than a mirror that quietly keeps growing.
    const counted = await countReminders(LIST_NAME);
    const inList = counted.ok ? Number.parseInt(counted.value, 10) : NaN;
    if (Number.isFinite(inList) && mirrorLooksCorrupt(inList, listAssignments().length)) {
      lastSyncAt = new Date().toISOString();
      lastError =
        `"${LIST_NAME}" holds ${inList} reminders for ${listAssignments().length} assignments, ` +
        'so Studeo has stopped adding to it. Use "Rebuild list" to clear it and mirror them again.';
      return;
    }

    const existing = await listRemindersInList(LIST_NAME);
    if (existing.ok) {
      adoptable = parseReminderIndex(existing.value);
    } else {
      // Couldn't read what's there. Creating blind is how the duplicates
      // happened, so skip creation this pass and try again on the next one —
      // removals, completions and updates above have already been applied.
      lastSyncAt = new Date().toISOString();
      lastError = firstFailure ?? 'Could not read the Reminders list, so nothing new was added this time.';
      return;
    }
  }

  for (const reminder of plan.create) {
    if (stopped) break;

    const orphan = adoptable.get(reminder.title);
    if (orphan) {
      // Already in the list under this title. Record the link and let the next
      // pass update it if the details differ — cheaper and safer than a create,
      // and it can't produce a duplicate.
      saveReminderLink(reminder.assignmentId, orphan, '');
      adoptable.delete(reminder.title);
      step(true);
      continue;
    }

    const result = await createReminder(LIST_NAME, reminder);
    const ok = result.ok && Boolean(result.value);
    if (ok) {
      saveReminderLink(reminder.assignmentId, result.value, reminder.signature);
    }
    if (!step(ok, result.value || 'Reminders did not return an id')) break;
  }

  lastSyncAt = new Date().toISOString();
  // A stopped pass reports WHY it stopped, on top of the failure that caused it.
  // "Syncing…" that simply never ends is the one outcome with no next step in it.
  lastError =
    stopped === 'budget'
      ? 'Reminders is responding slowly — synced what it could, and will pick up the rest shortly.'
      : stopped === 'failures'
        ? `${firstFailure ?? 'Reminders kept refusing'} — stopped after ${MAX_CONSECUTIVE_FAILURES} failures in a row rather than retrying every item.`
        : firstFailure;
}

/**
 * Throw the mirror away and start over.
 *
 * For a list that has already accumulated duplicates — the failure mode fixed
 * by adoption, after it has happened. Adoption stops the growth and reclaims
 * one reminder per assignment, but the extra copies are unreachable: nothing
 * links them, so nothing will ever clean them up.
 *
 * Deletes the list (one call) and forgets every link, so the next pass rebuilds
 * from the assignments. Destructive by design, hence user-initiated only —
 * never on a timer, and never as part of a sync.
 */
export async function rebuildAppleRemindersMirror(): Promise<AppleRemindersStatus> {
  if (!supported() || !isEnabled()) return getAppleRemindersStatus();
  if (syncing) return getAppleRemindersStatus();

  syncing = true;
  try {
    const dropped = await deleteList(LIST_NAME);
    if (!dropped.ok) {
      lastError = describeFailure(dropped.value);
      return getAppleRemindersStatus();
    }
    // Only after the list is actually gone: clearing links first would strand
    // every reminder in it if the delete then failed — the exact bug this is
    // here to repair.
    for (const link of listReminderLinks()) deleteReminderLink(link.assignment_id);
    listVerified = false;
    lastError = null;
    lastSyncAt = null;
  } catch (err) {
    lastError = describeFailure(err instanceof Error ? err.message : String(err));
  } finally {
    syncing = false;
  }
  return getAppleRemindersStatus();
}

/**
 * Turn raw osascript noise into something a person can act on.
 *
 * The permission case is worth naming explicitly: macOS reports it as error
 * -1743, which tells the user nothing, and the fix is three levels deep in
 * System Settings.
 */
function describeFailure(raw: string): string {
  if (/-1743|not authorized|not allowed/i.test(raw)) {
    return 'macOS blocked access to Reminders. Allow Studeo → Reminders in System Settings → Privacy & Security → Automation, then sync again.';
  }
  if (/-1728|Can’t get|Can't get/i.test(raw)) {
    return 'A reminder Studeo created is missing — it will be recreated on the next sync.';
  }
  if (/timed out|ETIMEDOUT/i.test(raw)) {
    return 'Reminders stopped responding. Try again in a moment.';
  }
  return raw.slice(0, 200);
}

/** Enable or disable the mirror, persisting the choice, and sync immediately on. */
export async function setAppleRemindersEnabled(enabled: boolean): Promise<AppleRemindersStatus> {
  setSetting(SETTING_KEY, enabled ? 'true' : 'false');
  lastError = null;

  if (enabled) {
    // Arm the interval WITHOUT its own kick-off pass, then await ours. Doing both
    // meant the fire-and-forget pass claimed the in-flight guard and this call
    // returned an untouched status — leaving the Settings row reading "Syncing…"
    // with nothing ever arriving to correct it.
    armInterval();
    return syncAppleReminders();
  }

  stopAppleRemindersSync();
  // Links are deliberately kept. Existing reminders stay in the list (deleting a
  // pile of the user's reminders on a toggle would be a rude surprise), and
  // keeping the mapping means switching back on updates them instead of creating
  // a second copy of everything.
  return getAppleRemindersStatus();
}

/**
 * Choose what completing an assignment does to its reminder, then act on it now.
 *
 * The immediate sync is the point of the setting, not a nicety: switching it on
 * is a statement about the reminders already sitting ticked-off in the list, and
 * waiting up to five minutes to clear them reads as the toggle not having worked.
 * Assignments completed while it was on keep no link, so switching it back off
 * changes nothing retroactively — there is no deleted reminder to restore.
 */
export async function setAppleRemindersRemoveCompleted(remove: boolean): Promise<AppleRemindersStatus> {
  setSetting(REMOVE_COMPLETED_KEY, remove ? 'true' : 'false');
  if (!supported() || !isEnabled()) return getAppleRemindersStatus();
  return syncAppleReminders();
}

/**
 * Debounced "an assignment changed" trigger. Call it from anywhere that mutates
 * assignments; it decides whether that's worth a pass and when.
 *
 * Guarded on enabled/supported at fire time rather than request time, so a
 * change made in the seconds after the mirror is switched off doesn't sync.
 */
const changeScheduler = createSyncScheduler(
  () => { if (supported() && isEnabled()) void syncAppleReminders(); },
  { quietMs: CHANGE_QUIET_MS, maxWaitMs: CHANGE_MAX_WAIT_MS, isBusy: () => syncing },
);

/**
 * Tell the mirror an assignment was added, completed, edited or removed.
 *
 * Cheap and safe to call on every mutation: it coalesces, it no-ops when the
 * mirror is off, and it waits out any pass already running.
 */
export function notifyAssignmentsChanged(): void {
  if (!supported() || !isEnabled()) return;
  changeScheduler.request();
}

/** Start the recurring pass. Separate from the kick-off so a caller that intends to
 *  await its own sync doesn't race a fire-and-forget one for the in-flight guard. */
function armInterval(): void {
  if (interval) return;
  interval = setInterval(() => { void syncAppleReminders(); }, SYNC_INTERVAL_MS);
}

/** Called at app launch: catch up on whatever changed while Studeo was closed,
 *  then settle into the interval. Nothing awaits this, so it stays fire-and-forget. */
export function startAppleRemindersSync(): void {
  if (!supported() || !isEnabled()) return;
  armInterval();
  void syncAppleReminders();
}

export function stopAppleRemindersSync(): void {
  // A queued change-triggered pass would otherwise fire after the mirror was
  // switched off, or during shutdown.
  changeScheduler.cancel();
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
