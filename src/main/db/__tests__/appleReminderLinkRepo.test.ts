import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb } from './helpers';

const mockDb = vi.hoisted(() => ({ current: null as DatabaseSync | null }));

vi.mock('../connection', () => ({
  getDb: () => mockDb.current!,
}));

import { createCourse } from '../repositories/courseRepo';
import { createAssignment } from '../repositories/assignmentRepo';
import {
  listReminderLinks,
  saveReminderLink,
  deleteReminderLink,
} from '../repositories/appleReminderLinkRepo';
import { planReminderSync } from '../../../shared/appleReminderSync';
import type { Assignment, Course } from '../../../shared/types';

/**
 * These tests exist because of a bug the pure planner tests could not see.
 *
 * appleReminderSync.test.ts builds a ReminderLink in memory and compares
 * signatures there, which is the right shape for testing the *decisions*. But
 * the real signature is written to SQLite and read back on the next sync pass,
 * and that round-trip is where it was being destroyed: the separator was NUL,
 * and node:sqlite stores the full string but reads it back truncated at the
 * first NUL. Every signature came back as just the title, never matched, and
 * every mirrored assignment was re-pushed to Reminders on every pass forever.
 *
 * So the assertion that matters is not "the repo stores a string" — it is
 * "a signature that made a full round trip through the database still
 * satisfies the planner". That is the property that broke.
 */

let course: Course;

beforeEach(() => {
  mockDb.current = createTestDb();
  course = createCourse({ name: 'Data Structures', abbreviation: 'CSC 316', color: '#123456' });
});

/** An assignment with the awkward content real ones have: an em dash in the
 *  generated title, a multi-line body, punctuation in the name. */
function seedAssignment(overrides: Partial<Parameters<typeof createAssignment>[0]> = {}): Assignment {
  return createAssignment({
    courseId: course.id,
    name: "Workshop 5 - Map ADT (Kevin's section)",
    type: 'Homework',
    dueDate: '2026-09-25',
    dueTime: null,
    notes: 'Read chapter 9 first.\nBring the handout.',
    ...overrides,
  });
}

const NOW = new Date(2026, 8, 1, 10, 0); // Sep 1 2026, local — inside the horizon

describe('appleReminderLinkRepo', () => {
  it('round-trips a signature byte for byte', () => {
    const assignment = seedAssignment();
    const [planned] = planReminderSync([assignment], [course], [], NOW).create;

    saveReminderLink(assignment.id, 'x-apple-reminder://ABC', planned.signature);
    const [stored] = listReminderLinks();

    // Length first: a truncating driver fails here with a confusingly "equal
    // looking" value, because the surviving prefix is the human-readable title.
    expect(stored.signature.length).toBe(planned.signature.length);
    expect(stored.signature).toBe(planned.signature);
  });

  it('does not re-plan an update for a link that came back from the database', () => {
    // The regression proper. An unchanged assignment whose link was persisted
    // and re-read must produce no work at all — this is what makes an idle sync
    // pass cost zero AppleScript calls.
    const assignment = seedAssignment();
    const [planned] = planReminderSync([assignment], [course], [], NOW).create;
    saveReminderLink(assignment.id, 'x-apple-reminder://ABC', planned.signature);

    const plan = planReminderSync([assignment], [course], listReminderLinks(), NOW);

    expect(plan.update).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.complete).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('still plans an update when the assignment actually changed', () => {
    // The other half: round-tripping must not make the signature so lossy that
    // real edits stop being noticed either.
    const assignment = seedAssignment();
    const [planned] = planReminderSync([assignment], [course], [], NOW).create;
    saveReminderLink(assignment.id, 'x-apple-reminder://ABC', planned.signature);

    const renamed = { ...assignment, name: 'Workshop 5 - Map ADT (revised)' };
    const moved = { ...assignment, due_date: '2026-09-26' };
    const annotated = { ...assignment, notes: 'Different note entirely.' };

    for (const changed of [renamed, moved, annotated]) {
      expect(planReminderSync([changed], [course], listReminderLinks(), NOW).update).toHaveLength(1);
    }
  });

  it('replaces the reminder id and signature for an assignment already linked', () => {
    const assignment = seedAssignment();
    saveReminderLink(assignment.id, 'x-apple-reminder://OLD', 'old-signature');
    saveReminderLink(assignment.id, 'x-apple-reminder://NEW', 'new-signature');

    expect(listReminderLinks()).toEqual([
      { assignment_id: assignment.id, reminder_id: 'x-apple-reminder://NEW', signature: 'new-signature' },
    ]);
  });

  it('forgets one link without disturbing the others', () => {
    const kept = seedAssignment({ name: 'Homework 6' });
    const dropped = seedAssignment({ name: 'Homework 7' });
    saveReminderLink(kept.id, 'x-apple-reminder://KEPT', 'sig-a');
    saveReminderLink(dropped.id, 'x-apple-reminder://DROPPED', 'sig-b');

    deleteReminderLink(dropped.id);

    expect(listReminderLinks().map(l => l.assignment_id)).toEqual([kept.id]);
  });

  it('starts empty and tolerates deleting a link that was never there', () => {
    expect(listReminderLinks()).toEqual([]);
    expect(() => deleteReminderLink('no-such-assignment')).not.toThrow();
  });
});
