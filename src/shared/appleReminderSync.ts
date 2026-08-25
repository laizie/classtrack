import type { Assignment, Course } from './types';

/**
 * Works out what should change in Apple Reminders — and nothing more.
 *
 * The idea: Studeo's assignments are the source of truth, and a dedicated
 * "Studeo" list in Reminders is a mirror of them. iCloud carries that list to
 * your phone, so the phone can notify you (and let you read what the thing
 * actually is) with the laptop shut — which the in-app reminders, living on a
 * poll in the main process, can never do.
 *
 * This module is pure: assignments in, a plan of operations out. No AppleScript,
 * no database, no clock of its own — `now` is a parameter. That's what lets the
 * interesting decisions (what's stale, what's out of range, what got deleted on
 * one side) be unit-tested, leaving the AppleScript layer with nothing to decide.
 */

/** Assignments with no due time land here — early enough to act on that day. */
export const DEFAULT_DUE_HOUR = 9;

/** How far ahead to mirror. Far enough to cover a semester's visible horizon
 *  without filling the list with things you can't act on yet. */
export const HORIZON_DAYS = 60;

/** How long an overdue assignment keeps nagging before it stops being mirrored.
 *  Something a week late is either done or abandoned; keeping it forever turns
 *  the list into a graveyard you stop reading. */
export const OVERDUE_GRACE_DAYS = 7;

/** The local wall-clock instant a reminder should fire, as parts. AppleScript
 *  builds its own date object from these — no timezone round-trip in between. */
export interface ReminderDueParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface PlannedReminder {
  assignmentId: string;
  title: string;
  body: string;
  due: ReminderDueParts;
  /** Everything we push, flattened. Unchanged signature = skip the round-trip. */
  signature: string;
}

/** One row of the mapping between an assignment and the reminder mirroring it. */
export interface ReminderLink {
  assignment_id: string;
  reminder_id: string;
  signature: string;
}

export interface ReminderSyncPlan {
  create: PlannedReminder[];
  update: { reminderId: string; reminder: PlannedReminder }[];
  /** Finished in Studeo → tick it off on the phone rather than delete it. */
  complete: { assignmentId: string; reminderId: string }[];
  /** Deleted, or aged out of the window → remove the mirror entirely. */
  remove: { assignmentId: string; reminderId: string }[];
}

/**
 * What finishing an assignment in Studeo does to its mirrored reminder.
 *
 * `complete` (the default) ticks it off, leaving it in the list under Reminders'
 * "Completed" section — the honest mirror, and reversible: un-completing in
 * Studeo re-opens the same reminder rather than making a second one.
 *
 * `remove` deletes it outright. Worth having because the two apps disagree about
 * what a finished item is for: Studeo keeps completed work because it's the
 * record your grade comes from, whereas a Reminders list is a worklist you want
 * to end the week empty. Un-completing after a removal simply recreates the
 * reminder on the next pass — the link is dropped with it, so nothing is left
 * pointing at something that no longer exists.
 */
export type CompletedAction = 'complete' | 'remove';

/**
 * The signature stored against a link whose reminder has been ticked off.
 *
 * Completing is not a one-shot operation the way creating is: the link is kept
 * on purpose, so that un-completing in Studeo re-opens the same reminder rather
 * than making a second one. But nothing recorded that the tick-off had already
 * happened, so a finished assignment was re-completed on every pass, forever —
 * and because `isDone` is checked before the date window, it never aged out
 * either. One item costs a second or two; a semester's worth of finished work
 * accumulates until it fills the pass budget and the mirror stalls, which is
 * the same failure the signature bug caused by a different route.
 *
 * Storing it in the signature column rather than adding one is deliberate: the
 * column already means "what state did we last push", and this is a state we
 * last pushed. It also gives un-completing the right behaviour for free — the
 * sentinel can never equal a freshly-computed signature, so the assignment
 * coming back to life plans an update, which rewrites the fields *and* clears
 * the completed flag.
 *
 * It cannot collide with a real signature: buildSignature always joins three
 * fields and so always contains two separators, and this contains none.
 */
export const COMPLETED_SIGNATURE = 'completed';

export interface PlanOptions {
  horizonDays?: number;
  overdueGraceDays?: number;
  defaultDueHour?: number;
  completedAction?: CompletedAction;
}

/**
 * Parse "YYYY-MM-DD" as a *local* date.
 *
 * `new Date('2026-08-20')` is parsed as UTC and lands on the 19th once it's
 * rendered west of Greenwich — the same off-by-one that made due filters drop a
 * day (AUDIT H6). Splitting the parts and handing them to the Date constructor
 * keeps everything in local time, which is the only frame due dates mean
 * anything in.
 */
function parseLocalDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(part => parseInt(part, 10));
  return new Date(year, month - 1, day);
}

/** Midnight today, local — so day comparisons ignore the time of day. */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** "CSC 316 — Project 2". The course code leads because that's what identifies it
 *  at a glance in a phone notification, where there's no other context. */
function buildTitle(assignment: Assignment, course: Course | undefined): string {
  const label = course?.abbreviation?.trim() || course?.name?.trim();
  return label ? `${label} — ${assignment.name}` : assignment.name;
}

/** The part you read after tapping in: what kind of thing this is, for which
 *  class, plus whatever you wrote on it in Studeo. */
function buildBody(assignment: Assignment, course: Course | undefined): string {
  const lines = [course ? `${assignment.type} · ${course.name}` : assignment.type];
  if (assignment.notes?.trim()) lines.push('', assignment.notes.trim());
  return lines.join('\n');
}

function buildDueParts(assignment: Assignment, defaultDueHour: number): ReminderDueParts {
  const date = parseLocalDate(assignment.due_date);
  // due_time is "HH:MM" (24h) or null for an all-day assignment.
  const [hour, minute] = assignment.due_time
    ? assignment.due_time.split(':').map(part => parseInt(part, 10))
    : [defaultDueHour, 0];

  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: Number.isFinite(hour) ? hour : defaultDueHour,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

/**
 * The field separator inside a signature.
 *
 * It has to be a character that cannot appear in a title, a note, or a
 * timestamp — otherwise a value could fake a field boundary and make two
 * different reminders collapse to one signature, silently skipping an update.
 * Unit Separator (U+001F) satisfies that, and `remindersScript.ts` already uses
 * it as a field separator for the same reason.
 *
 * It is emphatically *not* NUL, which was the obvious choice and was wrong.
 * A signature is written to SQLite and read back on the next pass, and
 * `node:sqlite` binds strings NUL-terminated: it stores the whole value but
 * reads it back truncated at the first NUL. So every signature came back as
 * just the title, never matched the freshly-computed one, and every mirrored
 * assignment was re-pushed to Reminders on every pass — forever. With enough
 * links those updates consumed the entire pass budget, the create step was
 * never reached, and the mirror froze partway through and began shedding links
 * as calls crept past the per-call timeout.
 *
 * The tests could not see it: they build a link and compare in memory, so the
 * value never crossed the boundary where it was destroyed. That is what
 * appleReminderLinkRepo.test.ts now covers.
 *
 * Written as an escape rather than a literal control character, so this file
 * stays plain text to grep and every other text tool (AUDIT L1).
 */
const SIGNATURE_SEPARATOR = '\u001f';

function buildSignature(title: string, body: string, due: ReminderDueParts): string {
  const stamp = `${due.year}-${due.month}-${due.day}T${due.hour}:${due.minute}`;
  return [title, body, stamp].join(SIGNATURE_SEPARATOR);
}

function planReminder(
  assignment: Assignment,
  course: Course | undefined,
  defaultDueHour: number,
): PlannedReminder {
  const title = buildTitle(assignment, course);
  const body = buildBody(assignment, course);
  const due = buildDueParts(assignment, defaultDueHour);
  return { assignmentId: assignment.id, title, body, due, signature: buildSignature(title, body, due) };
}

/**
 * Diff the assignments against the reminders we've already created.
 *
 * Every assignment falls into one of four states, and the plan is just those
 * four buckets — so the caller executing it has no judgement left to exercise.
 */
export function planReminderSync(
  assignments: Assignment[],
  courses: Course[],
  links: ReminderLink[],
  now: Date,
  options: PlanOptions = {},
): ReminderSyncPlan {
  const {
    horizonDays = HORIZON_DAYS,
    overdueGraceDays = OVERDUE_GRACE_DAYS,
    defaultDueHour = DEFAULT_DUE_HOUR,
    completedAction = 'complete',
  } = options;

  const courseById = new Map(courses.map(course => [course.id, course]));
  const linkByAssignment = new Map(links.map(link => [link.assignment_id, link]));

  const today = startOfDay(now);
  const earliest = addDays(today, -overdueGraceDays);
  const latest = addDays(today, horizonDays);

  const plan: ReminderSyncPlan = { create: [], update: [], complete: [], remove: [] };

  for (const assignment of assignments) {
    const link = linkByAssignment.get(assignment.id);
    // Consumed, so whatever's left at the end refers to assignments that no
    // longer exist — deleted in Studeo since the last sync.
    linkByAssignment.delete(assignment.id);

    const dueDay = parseLocalDate(assignment.due_date);
    const inWindow = dueDay >= earliest && dueDay <= latest;
    const isDone = assignment.status === 'completed';

    if (!link) {
      // Don't mirror something already finished, or outside the window: it would
      // arrive pre-completed or long stale, which is noise either way.
      if (!isDone && inWindow) {
        plan.create.push(planReminder(assignment, courseById.get(assignment.course_id), defaultDueHour));
      }
      continue;
    }

    if (isDone) {
      // `remove` puts it in the same bucket as an aged-out or deleted assignment,
      // which is exactly right: the executor already drops the link when it
      // removes, so un-completing later recreates the reminder from scratch.
      if (completedAction === 'remove') {
        plan.remove.push({ assignmentId: assignment.id, reminderId: link.reminder_id });
        continue;
      }
      // Already ticked off on a previous pass — nothing to say to Reminders.
      // This is what stops a finished assignment being re-completed forever.
      if (link.signature === COMPLETED_SIGNATURE) continue;
      plan.complete.push({ assignmentId: assignment.id, reminderId: link.reminder_id });
      continue;
    }

    if (!inWindow) {
      plan.remove.push({ assignmentId: assignment.id, reminderId: link.reminder_id });
      continue;
    }

    const reminder = planReminder(assignment, courseById.get(assignment.course_id), defaultDueHour);
    if (reminder.signature !== link.signature) {
      plan.update.push({ reminderId: link.reminder_id, reminder });
    }
  }

  // Links whose assignment is gone: delete the mirror so the phone stops showing
  // work that no longer exists.
  for (const link of linkByAssignment.values()) {
    plan.remove.push({ assignmentId: link.assignment_id, reminderId: link.reminder_id });
  }

  return plan;
}
