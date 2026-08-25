import { describe, it, expect } from 'vitest';
import { planReminderSync, COMPLETED_SIGNATURE, type ReminderLink } from '../appleReminderSync';
import type { Assignment, AssignmentType, Course } from '../types';

const NOW = new Date(2026, 7, 15, 10, 0); // Aug 15 2026, local

function course(id: string, abbreviation: string, name = `${abbreviation} course`): Course {
  return {
    id, name, abbreviation, color: '#123456',
    building: null, term_id: 't1', grade_weights: null, created_at: '2026-08-01',
  };
}

function assign(
  id: string,
  dueDate: string,
  overrides: Partial<Assignment> = {},
): Assignment {
  return {
    id, course_id: 'c1', name: `Task ${id}`, type: 'Homework' as AssignmentType,
    status: 'not_started', due_date: dueDate, due_time: null, notes: null,
    score: null, points_possible: null, completed_at: null, created_at: '2026-08-01',
    ...overrides,
  };
}

const COURSES = [course('c1', 'CSC 316'), course('c2', 'BIO 181')];

function link(assignmentId: string, signature: string, reminderId = `rem-${assignmentId}`): ReminderLink {
  return { assignment_id: assignmentId, reminder_id: reminderId, signature };
}

/** The signature the planner would produce for an assignment with no link yet. */
function signatureFor(assignment: Assignment, courses = COURSES): string {
  const [created] = planReminderSync([assignment], courses, [], NOW).create;
  return created.signature;
}

describe('creating', () => {
  it('mirrors an upcoming assignment, course code first', () => {
    const plan = planReminderSync([assign('a', '2026-08-20')], COURSES, [], NOW);

    expect(plan.create).toHaveLength(1);
    expect(plan.create[0].title).toBe('CSC 316 — Task a');
    expect(plan.create[0].due).toEqual({ year: 2026, month: 8, day: 20, hour: 9, minute: 0 });
    expect(plan.update).toEqual([]);
  });

  it('uses the due time when there is one', () => {
    const plan = planReminderSync([assign('a', '2026-08-20', { due_time: '23:59' })], COURSES, [], NOW);
    expect(plan.create[0].due).toMatchObject({ hour: 23, minute: 59 });
  });

  it('puts the type, course, and your own notes in the body — the bit you read after tapping', () => {
    const plan = planReminderSync(
      [assign('a', '2026-08-20', { type: 'Exam', notes: 'ch. 4-6, closed book' })],
      COURSES, [], NOW,
    );
    expect(plan.create[0].body).toBe('Exam · CSC 316 course\n\nch. 4-6, closed book');
  });

  it('falls back to the bare name when the course is missing', () => {
    const plan = planReminderSync([assign('a', '2026-08-20', { course_id: 'gone' })], COURSES, [], NOW);
    expect(plan.create[0].title).toBe('Task a');
  });

  it('does not mirror something already finished, or beyond the horizon', () => {
    const plan = planReminderSync(
      [
        assign('done', '2026-08-20', { status: 'completed' }),
        assign('far', '2027-01-01'),
      ],
      COURSES, [], NOW,
    );
    expect(plan.create).toEqual([]);
    expect(plan.complete).toEqual([]); // never linked, so nothing to tick off
  });

  it('still mirrors something recently overdue — that is when you most need it', () => {
    const plan = planReminderSync([assign('late', '2026-08-13')], COURSES, [], NOW);
    expect(plan.create).toHaveLength(1);
  });

  it('stops mirroring an assignment left undone past the grace period', () => {
    const plan = planReminderSync([assign('ancient', '2026-07-01')], COURSES, [], NOW);
    expect(plan.create).toEqual([]);
  });
});

describe('updating', () => {
  it('skips an assignment whose reminder is already correct', () => {
    const assignment = assign('a', '2026-08-20');
    const plan = planReminderSync([assignment], COURSES, [link('a', signatureFor(assignment))], NOW);

    expect(plan).toEqual({ create: [], update: [], complete: [], remove: [] });
  });

  it('updates when the due date moves', () => {
    const original = assign('a', '2026-08-20');
    const moved = assign('a', '2026-08-27');
    const plan = planReminderSync([moved], COURSES, [link('a', signatureFor(original))], NOW);

    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].reminderId).toBe('rem-a');
    expect(plan.update[0].reminder.due.day).toBe(27);
    expect(plan.create).toEqual([]); // updated in place, not duplicated
  });

  it('updates when the name or notes change', () => {
    const original = assign('a', '2026-08-20');
    const renamed = assign('a', '2026-08-20', { name: 'Project 2 (revised)' });
    const annotated = assign('a', '2026-08-20', { notes: 'submit on Canvas' });

    expect(planReminderSync([renamed], COURSES, [link('a', signatureFor(original))], NOW).update).toHaveLength(1);
    expect(planReminderSync([annotated], COURSES, [link('a', signatureFor(original))], NOW).update).toHaveLength(1);
  });
});

describe('finishing and removing', () => {
  it('ticks off a linked assignment that got completed, rather than deleting it', () => {
    const assignment = assign('a', '2026-08-20');
    const done = assign('a', '2026-08-20', { status: 'completed' });
    const plan = planReminderSync([done], COURSES, [link('a', signatureFor(assignment))], NOW);

    expect(plan.complete).toEqual([{ assignmentId: 'a', reminderId: 'rem-a' }]);
    expect(plan.remove).toEqual([]);
  });

  it('removes the mirror when an assignment is deleted in Studeo', () => {
    const plan = planReminderSync([], COURSES, [link('gone', 'whatever')], NOW);
    expect(plan.remove).toEqual([{ assignmentId: 'gone', reminderId: 'rem-gone' }]);
  });

  it('removes the mirror when an unfinished assignment ages out', () => {
    const plan = planReminderSync([assign('stale', '2026-07-01')], COURSES, [link('stale', 'sig')], NOW);
    expect(plan.remove).toEqual([{ assignmentId: 'stale', reminderId: 'rem-stale' }]);
  });

  // Completing keeps the link on purpose, so the planner needs some way to tell
  // "finished" from "finished and already ticked off". Without one it re-issued
  // the same complete on every pass, for the life of the assignment.
  it('does not tick off a reminder it has already ticked off', () => {
    const done = assign('a', '2026-08-20', { status: 'completed' });
    const plan = planReminderSync([done], COURSES, [link('a', COMPLETED_SIGNATURE)], NOW);

    expect(plan.complete).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.create).toEqual([]);
  });

  it('keeps a finished assignment quiet even long after it aged out', () => {
    // isDone is checked before the date window, so a completed link never
    // reaches the aged-out branch — it would have re-completed forever.
    const old = assign('a', '2026-01-05', { status: 'completed' });
    const plan = planReminderSync([old], COURSES, [link('a', COMPLETED_SIGNATURE)], NOW);

    expect(plan.complete).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('re-opens the reminder when a finished assignment is un-completed', () => {
    // The sentinel can never equal a freshly-computed signature, so coming back
    // to life plans an update — which rewrites the fields and clears the flag.
    const reopened = assign('a', '2026-08-20');
    const plan = planReminderSync([reopened], COURSES, [link('a', COMPLETED_SIGNATURE)], NOW);

    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].reminderId).toBe('rem-a');
    expect(plan.complete).toEqual([]);
  });

  it('still removes a ticked-off mirror when the assignment is deleted', () => {
    // The sentinel must not make a link unreachable: the assignment is gone, so
    // the reminder has to go too, ticked off or not.
    const plan = planReminderSync([], COURSES, [link('a', COMPLETED_SIGNATURE)], NOW);
    expect(plan.remove).toEqual([{ assignmentId: 'a', reminderId: 'rem-a' }]);
  });

  it("still deletes a ticked-off mirror under completedAction 'remove'", () => {
    const done = assign('a', '2026-08-20', { status: 'completed' });
    const plan = planReminderSync(
      [done], COURSES, [link('a', COMPLETED_SIGNATURE)], NOW, { completedAction: 'remove' },
    );
    expect(plan.remove).toEqual([{ assignmentId: 'a', reminderId: 'rem-a' }]);
  });
});

describe("completedAction: 'remove'", () => {
  // The opt-in behaviour: finishing an assignment clears it out of the Reminders
  // list entirely, instead of leaving it ticked off under Completed.
  const REMOVE = { completedAction: 'remove' } as const;

  it('deletes the mirror instead of ticking it off', () => {
    const assignment = assign('a', '2026-08-20');
    const done = assign('a', '2026-08-20', { status: 'completed' });
    const plan = planReminderSync([done], COURSES, [link('a', signatureFor(assignment))], NOW, REMOVE);

    expect(plan.remove).toEqual([{ assignmentId: 'a', reminderId: 'rem-a' }]);
    expect(plan.complete).toEqual([]);
  });

  it('still creates and updates unfinished work as normal', () => {
    const fresh = assign('new', '2026-08-20');
    const moved = assign('m', '2026-08-25');
    const plan = planReminderSync(
      [fresh, moved], COURSES, [link('m', 'a-stale-signature')], NOW, REMOVE,
    );

    expect(plan.create.map(r => r.assignmentId)).toEqual(['new']);
    expect(plan.update).toHaveLength(1);
    expect(plan.remove).toEqual([]);
  });

  it('does not resurrect a completed assignment whose link is already gone', () => {
    // This is the state the previous pass leaves behind: the reminder was deleted
    // and its link dropped with it. Without the existing "already done → skip"
    // guard, every later sync would recreate the reminder and delete it again.
    const done = assign('a', '2026-08-20', { status: 'completed' });
    const plan = planReminderSync([done], COURSES, [], NOW, REMOVE);

    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('recreates the reminder if the assignment is un-completed later', () => {
    // Un-ticking it in Studeo leaves an unfinished, in-window assignment with no
    // link — which is exactly the "create" case, so the reminder comes back.
    const reopened = assign('a', '2026-08-20');
    const plan = planReminderSync([reopened], COURSES, [], NOW, REMOVE);

    expect(plan.create.map(r => r.assignmentId)).toEqual(['a']);
  });

  it('defaults to ticking off when no action is given', () => {
    const assignment = assign('a', '2026-08-20');
    const done = assign('a', '2026-08-20', { status: 'completed' });
    const plan = planReminderSync([done], COURSES, [link('a', signatureFor(assignment))], NOW);

    expect(plan.complete).toHaveLength(1);
    expect(plan.remove).toEqual([]);
  });
});

describe('dates are local, not UTC', () => {
  it('keeps the due day the user typed', () => {
    // new Date('2026-08-20') parses as UTC and renders as the 19th anywhere west
    // of Greenwich — the off-by-one that AUDIT H6 found in the due filters.
    const plan = planReminderSync([assign('a', '2026-08-20')], COURSES, [], NOW);
    expect(plan.create[0].due).toMatchObject({ month: 8, day: 20 });
  });

  it('treats the horizon boundary by day, not by hour', () => {
    // 60 days out from Aug 15 is Oct 14. A late-evening "now" must not push it over.
    const lateEvening = new Date(2026, 7, 15, 23, 59);
    const plan = planReminderSync([assign('edge', '2026-10-14')], COURSES, [], lateEvening);
    expect(plan.create).toHaveLength(1);
  });
});

describe('a realistic mixed sync', () => {
  it('sorts every assignment into exactly one bucket', () => {
    const unchanged = assign('u', '2026-08-20');
    const moved = assign('m', '2026-08-21');

    const plan = planReminderSync(
      [
        unchanged,
        assign('m', '2026-08-28'),                              // link exists, date moved
        assign('d', '2026-08-22', { status: 'completed' }),     // finished
        assign('n', '2026-08-25', { course_id: 'c2' }),         // brand new
        assign('old', '2026-06-01'),                            // aged out, linked
      ],
      COURSES,
      [
        link('u', signatureFor(unchanged)),
        link('m', signatureFor(moved)),
        link('d', 'any'),
        link('old', 'any'),
        link('deleted', 'any'),                                 // assignment is gone
      ],
      NOW,
    );

    expect(plan.create.map(r => r.assignmentId)).toEqual(['n']);
    expect(plan.update.map(u => u.reminder.assignmentId)).toEqual(['m']);
    expect(plan.complete.map(c => c.assignmentId)).toEqual(['d']);
    expect(plan.remove.map(r => r.assignmentId).sort()).toEqual(['deleted', 'old']);
  });
});
