import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlannedReminder, ReminderDueParts } from '../../shared/appleReminderSync';

/**
 * The Apple Reminders half of the phone-notification feature: create, update,
 * complete, and delete reminders in one dedicated list via AppleScript.
 *
 * Why Reminders rather than a push service: an item sitting in Reminders is
 * carried to the phone by iCloud, and from then on *the phone* owns the alert.
 * It fires with the laptop shut and off the network, and it can be opened and
 * read — neither of which a push from this process can do, because this process
 * isn't running when the lid is closed.
 *
 * Every value crosses into AppleScript through `argv`, never string
 * interpolation. Assignment names contain apostrophes and quotes routinely, and
 * splicing them into script source would break the script (at best) on perfectly
 * ordinary input. `on run argv` keeps the script text constant and the data out
 * of band — the same reason the repositories use bound parameters instead of
 * building SQL strings.
 *
 * macOS only; every entry point returns a null/empty result elsewhere. The
 * caller guards on process.platform too, so this is belt and braces.
 */

const execFileAsync = promisify(execFile);

/** Reminders is scripted per-item, so a slow call must not wedge the sync. */
const SCRIPT_TIMEOUT_MS = 20_000;

/** The one bulk read gets longer, because it stands in for hundreds of calls. */
const BULK_READ_TIMEOUT_MS = 120_000;

/** The corruption gate. Cheap, but on a list that has already gone wrong even
 *  counting takes a while, and this is the call that prevents making it worse. */
const COUNT_TIMEOUT_MS = 45_000;

export interface ScriptResult {
  ok: boolean;
  /** stdout on success; a short reason on failure (surfaced in Settings). */
  value: string;
}

async function osascript(
  script: string,
  args: string[],
  timeoutMs: number = SCRIPT_TIMEOUT_MS,
): Promise<ScriptResult> {
  if (process.platform !== 'darwin') return { ok: false, value: 'not macOS' };
  try {
    // Full path: a packaged Electron app doesn't inherit the shell's PATH.
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript',
      ['-e', script, ...args],
      { timeout: timeoutMs },
    );
    return { ok: true, value: stdout.trim() };
  } catch (err) {
    // The message matters here, unlike the Apple Music module which can silently
    // return "nothing playing": a refused Automation permission is the single
    // most likely failure, and the user can only fix what they're told about.
    return { ok: false, value: failureReason(err) };
  }
}

/** osascript prefixes stderr with a source position: "104:161: execution error:". */
const POSITION_PREFIX = /^\d+:\d+:\s*/;

/**
 * Pull the actual reason out of an execFile rejection.
 *
 * It has to come from STDERR. execFile builds `err.message` by echoing the
 * command it ran, and the command here is the entire multi-line AppleScript —
 * so the front of that message is script source, not a diagnosis. Reading it
 * reported
 *
 *   "Command failed: /usr/bin/osascript -e on run argv set listName to item 1 of argv"
 *
 * for every single failure: it named neither the problem nor the fix, and it
 * threw away the "(-1743)" that describeFailure() keys the Automation-permission
 * message off, so the one error users actually hit could never be explained.
 * osascript puts the real thing on stderr:
 *
 *   "104:161: execution error: Reminders got an error: … (-1743)"
 */
export function failureReason(err: unknown): string {
  // A timeout kill leaves stderr empty, so it has to be recognised first —
  // otherwise it falls through to the bare command echo. The word "timed out"
  // is what describeFailure() matches on.
  if (typeof err === 'object' && err !== null && 'killed' in err && err.killed === true) {
    return `Reminders timed out after ${SCRIPT_TIMEOUT_MS / 1000}s`;
  }

  // `stderr` is attached by execFile but isn't on the Error type, so it's
  // narrowed by hand rather than cast away.
  const stderr =
    typeof err === 'object' && err !== null && 'stderr' in err && typeof err.stderr === 'string'
      ? err.stderr.trim()
      : '';
  if (stderr) {
    // First line only: osascript repeats the script on the lines below it.
    return stderr.split('\n')[0].replace(POSITION_PREFIX, '').trim();
  }

  // Nothing on stderr means it failed before the script ran (osascript missing,
  // spawn refused). The command echo is still noise — keep the shape, drop the
  // pasted-in script.
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0].replace(/^Command failed: \S+.*$/, 'Could not run osascript').trim();
}

/**
 * Build an AppleScript date from parts.
 *
 * `set day to 1` first is not superstition: setting the month while the current
 * day-of-month is 31 rolls the date into the next month (Jan 31 → "set month to
 * February" → Mar 2). Parking on the 1st makes every assignment order safe.
 */
const DATE_FROM_ARGS = `
  set d to current date
  set day of d to 1
  set year of d to (item 3 of argv) as integer
  set month of d to (item 4 of argv) as integer
  set day of d to (item 5 of argv) as integer
  set hours of d to (item 6 of argv) as integer
  set minutes of d to (item 7 of argv) as integer
  set seconds of d to 0
`;

function dueArgs(due: ReminderDueParts): string[] {
  return [due.year, due.month, due.day, due.hour, due.minute].map(String);
}

/**
 * Make sure the list exists, and confirm we're allowed to talk to Reminders at all.
 *
 * Returns ok:false with the OS error when Automation permission hasn't been
 * granted — the state the user has to resolve in System Settings, and the one
 * thing worth interrupting them about.
 */
export async function ensureList(listName: string): Promise<ScriptResult> {
  return osascript(
    `on run argv
       set listName to item 1 of argv
       tell application "Reminders"
         if not (exists list listName) then
           make new list with properties {name:listName}
         end if
         return "ok"
       end tell
     end run`,
    [listName],
  );
}

/**
 * How many un-ticked reminders the list holds. One Apple Event, so it is the
 * only question that can be asked of a broken list cheaply.
 *
 * This is the gate that makes creation safe. Everything else here scales with
 * the size of the list, and a list that has gone wrong is exactly the one too
 * big to inspect: the first attempt at adoption walked the reminders in a
 * repeat loop, which is one Apple Event per property per item, and took over
 * two minutes on a real (broken) list — so it hit the script timeout every
 * pass, returned nothing, and the sync went on creating duplicates anyway.
 * A fix that only works on a healthy list is not a fix.
 */
export async function countReminders(listName: string): Promise<ScriptResult> {
  return osascript(
    // No `whose` clause. Filtering server-side is what makes Reminders slow:
    // `count of (reminders whose completed is false)` timed out at 25s on a
    // real broken list, while the plain count answered the same list in under
    // two. The total is the better signal here anyway — ticked-off duplicates
    // are still wreckage.
    `on run argv
       tell application "Reminders"
         tell list (item 1 of argv)
           return (count of reminders) as text
         end tell
       end tell
     end run`,
    [listName],
    COUNT_TIMEOUT_MS,
  );
}

/** Field/record separators — control characters, so a reminder title containing
 *  a comma, tab or newline can't desync the two columns. */
const UNIT = String.fromCharCode(31);
const RECORD = String.fromCharCode(30);

/**
 * Every un-ticked reminder's id and title, for adoption.
 *
 * Asks for each property across the whole collection at once — `id of every
 * reminder`, then `name of every reminder` — which is two Apple Events rather
 * than two per item. On the broken list that took the per-item version past
 * 120s, this returns in ~87s; on a healthy one (roughly one reminder per
 * assignment) it is a few seconds. It gets a longer timeout than the per-item
 * calls precisely because it replaces hundreds of them.
 */
export async function listRemindersInList(listName: string): Promise<ScriptResult> {
  return osascript(
    // Three whole-collection property fetches, and the completed flag filtered
    // on this side. Asking Reminders to filter (`whose completed is false`) cost
    // more than fetching the extra column and discarding it: 87s versus 52s on
    // the same 1066-item list.
    `on run argv
       set listName to item 1 of argv
       tell application "Reminders"
         tell list listName
           set theIds to id of every reminder
           set theNames to name of every reminder
           set theDone to completed of every reminder
         end tell
       end tell
       set AppleScript's text item delimiters to (character id 31)
       set out to (theIds as text) & (character id 30) & (theNames as text) & (character id 30) & (theDone as text)
       set AppleScript's text item delimiters to ""
       return out
     end run`,
    [listName],
    BULK_READ_TIMEOUT_MS,
  );
}

/** Parse what listRemindersInList returns into title -> id (first wins). */
export function parseReminderIndex(stdout: string): Map<string, string> {
  const index = new Map<string, string>();
  const [idBlock, nameBlock, doneBlock] = stdout.split(RECORD);
  if (idBlock === undefined || nameBlock === undefined || doneBlock === undefined) return index;

  const ids = idBlock.split(UNIT);
  const names = nameBlock.split(UNIT);
  const done = doneBlock.split(UNIT);
  // Three columns fetched as three separate calls: if they disagree the pairing
  // is guesswork, and a wrong pairing links an assignment to someone else's
  // reminder. Refuse rather than guess — the caller treats an empty index as
  // "couldn't check", which is the safe direction.
  if (ids.length !== names.length || ids.length !== done.length) return index;

  for (let i = 0; i < ids.length; i++) {
    // A ticked-off reminder is not something to adopt: linking an assignment to
    // it would show the work as already done.
    if (done[i].trim() === 'true') continue;
    const id = ids[i].trim();
    const title = names[i].trim();
    // First wins: with duplicates present, adopting the oldest is the one that
    // has been carried to the phone longest.
    if (id && title && !index.has(title)) index.set(title, id);
  }
  return index;
}

/** Create one reminder; resolves with the new reminder's id for the link table. */
export async function createReminder(listName: string, reminder: PlannedReminder): Promise<ScriptResult> {
  return osascript(
    `on run argv
       set listName to item 1 of argv
       set theName to item 2 of argv
       ${DATE_FROM_ARGS}
       set theBody to item 8 of argv
       tell application "Reminders"
         set theList to list listName
         -- "remind me date" is the property that actually alerts; "due date" alone
         -- files it under a day without ever notifying. Both are set so the item
         -- sorts correctly *and* speaks up.
         set r to make new reminder at end of theList with properties {name:theName, body:theBody, due date:d, remind me date:d}
         return id of r
       end tell
     end run`,
    [listName, reminder.title, ...dueArgs(reminder.due), reminder.body],
  );
}

/**
 * Update an existing reminder in place.
 *
 * Scoped to our own list rather than searching every reminder the user owns:
 * `whose id is` walks the collection, and walking one class list is cheap while
 * walking a life's worth of reminders is not.
 *
 * All four fields are set in ONE `set properties` rather than four assignments.
 * Reminders charges per Apple Event, not per byte, and the cost is startling:
 * measured on a real list, four separate sets took ~14s and the single batched
 * set took ~5s for exactly the same result. That is the difference between an
 * update comfortably inside SCRIPT_TIMEOUT_MS and one sitting close enough to
 * the ceiling that ordinary load — iCloud syncing, Reminders.app in the
 * foreground — pushes it over, at which point the call is killed, the caller
 * assumes the reminder is gone, and the link is dropped.
 *
 * `completed:false` is in that record because the planner only ever asks for an
 * update on an assignment that is *not* done, so an update is always also the
 * un-complete path. Without it, finishing an assignment and then re-opening it
 * left the reminder ticked off on the phone forever: the fields were rewritten
 * but the flag that hides it from the list was not. It costs nothing to include
 * — it is the same single Apple Event either way.
 */
export async function updateReminder(
  listName: string,
  reminderId: string,
  reminder: PlannedReminder,
): Promise<ScriptResult> {
  return osascript(
    `on run argv
       set listName to item 1 of argv
       set theName to item 2 of argv
       ${DATE_FROM_ARGS}
       set theBody to item 8 of argv
       set theId to item 9 of argv
       tell application "Reminders"
         tell list listName
           set r to first reminder whose id is theId
           set properties of r to {name:theName, body:theBody, due date:d, remind me date:d, completed:false}
         end tell
         return "ok"
       end tell
     end run`,
    [listName, reminder.title, ...dueArgs(reminder.due), reminder.body, reminderId],
  );
}

/** Tick it off rather than delete it — finished work should read as finished. */
export async function completeReminder(listName: string, reminderId: string): Promise<ScriptResult> {
  return osascript(
    `on run argv
       set listName to item 1 of argv
       set theId to item 2 of argv
       tell application "Reminders"
         tell list listName
           set completed of (first reminder whose id is theId) to true
         end tell
         return "ok"
       end tell
     end run`,
    [listName, reminderId],
  );
}

/**
 * Delete the entire list, in one call.
 *
 * The repair path for a mirror that has already gone wrong. Deleting the
 * duplicates individually would be the surgical option, but at ~5-12s per
 * round-trip a few hundred of them is half an hour of scripting; dropping the
 * list is a single call and the next sync rebuilds it from the assignments,
 * which are the source of truth anyway.
 *
 * Safe only because the list is ours: the sync owns a list called "Studeo" and
 * nothing else, precisely so that the worst it can do is mismanage its own
 * mirror (see LIST_NAME in index.ts).
 */
export async function deleteList(listName: string): Promise<ScriptResult> {
  return osascript(
    `on run argv
       set listName to item 1 of argv
       tell application "Reminders"
         if exists list listName then delete list listName
         return "ok"
       end tell
     end run`,
    [listName],
    // The repair runs against the worst list the app will ever see — a
    // thousand-item one is exactly why someone reaches for it — so it gets the
    // long timeout rather than the per-item one.
    BULK_READ_TIMEOUT_MS,
  );
}

export async function deleteReminder(listName: string, reminderId: string): Promise<ScriptResult> {
  return osascript(
    `on run argv
       set listName to item 1 of argv
       set theId to item 2 of argv
       tell application "Reminders"
         tell list listName
           delete (first reminder whose id is theId)
         end tell
         return "ok"
       end tell
     end run`,
    [listName, reminderId],
  );
}
