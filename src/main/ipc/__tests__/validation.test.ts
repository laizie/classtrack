import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb } from '../../db/__tests__/helpers';
import { invoke, resetHandlers } from './harness';

const mockDb = vi.hoisted(() => ({ current: null as DatabaseSync | null }));

vi.mock('electron', async () => {
  const { ipcMainStub } = await import('./harness');
  return { ipcMain: ipcMainStub };
});
vi.mock('../../db/connection', () => ({
  getDb: () => mockDb.current!,
}));

import { IPC } from '../../../shared/types';
import type { Assignment, Course, Task } from '../../../shared/types';
import { registerAssignmentHandlers } from '../registerAssignmentHandlers';
import { registerTaskHandlers } from '../registerTaskHandlers';
import { registerCourseHandlers } from '../registerCourseHandlers';
import { createCourse } from '../../db/repositories/courseRepo';

let courseId: string;

beforeEach(() => {
  mockDb.current = createTestDb();
  resetHandlers();
  registerAssignmentHandlers();
  registerTaskHandlers();
  registerCourseHandlers();
  courseId = createCourse({ name: 'CS 101', abbreviation: 'CS', color: '#6393e1' }).id;
});

// The renderer is untrusted UI: "the dropdown can only produce valid values" is exactly
// the assumption main isn't allowed to make. The realistic source of a surprise value is
// the ICS importer or the syllabus parser, not an attacker — but the boundary is the
// boundary either way.

describe('assignment handlers', () => {
  const valid = () => ({ courseId, name: 'Lab 1', dueDate: '2026-03-10' });

  it('creates a valid assignment', async () => {
    const a = await invoke<Assignment>(IPC.ASSIGNMENTS.CREATE, valid());
    expect(a.name).toBe('Lab 1');
    expect(a.status).toBe('not_started');
  });

  it.each([
    ['missing courseId', { name: 'x', dueDate: '2026-03-10' }, /courseId/],
    ['blank name',       { courseId: 'c', name: '   ', dueDate: '2026-03-10' }, /name is required/],
    ['missing dueDate',  { courseId: 'c', name: 'x' }, /dueDate/],
  ])('rejects %s', async (_label, input, message) => {
    await expect(invoke(IPC.ASSIGNMENTS.CREATE, input)).rejects.toThrow(message);
  });

  it('rejects a type outside the enum', async () => {
    await expect(invoke(IPC.ASSIGNMENTS.CREATE, { ...valid(), type: 'Midterm' }))
      .rejects.toThrow(/type must be one of/);
  });

  it('rejects a status outside the enum', async () => {
    await expect(invoke(IPC.ASSIGNMENTS.CREATE, { ...valid(), status: 'done' }))
      .rejects.toThrow(/status must be one of/);
  });

  it('rejects a malformed dueTime but accepts a real one', async () => {
    await expect(invoke(IPC.ASSIGNMENTS.CREATE, { ...valid(), dueTime: '25:00' }))
      .rejects.toThrow(/HH:MM/);
    await expect(invoke(IPC.ASSIGNMENTS.CREATE, { ...valid(), dueTime: '9:5' }))
      .rejects.toThrow(/HH:MM/);
    const ok = await invoke<Assignment>(IPC.ASSIGNMENTS.CREATE, { ...valid(), dueTime: '09:05' });
    expect(ok.due_time).toBe('09:05');
  });

  it('rejects nonsense grades', async () => {
    await expect(invoke(IPC.ASSIGNMENTS.CREATE, { ...valid(), score: -1 }))
      .rejects.toThrow(/score/);
    await expect(invoke(IPC.ASSIGNMENTS.CREATE, { ...valid(), pointsPossible: 0 }))
      .rejects.toThrow(/pointsPossible/);
  });

  describe('createMany', () => {
    it('rejects a non-array and an empty array', async () => {
      await expect(invoke(IPC.ASSIGNMENTS.CREATE_MANY, 'nope')).rejects.toThrow(/non-empty array/);
      await expect(invoke(IPC.ASSIGNMENTS.CREATE_MANY, [])).rejects.toThrow(/non-empty array/);
    });

    it('caps the batch size', async () => {
      const many = Array.from({ length: 501 }, () => valid());
      await expect(invoke(IPC.ASSIGNMENTS.CREATE_MANY, many)).rejects.toThrow(/max 500/);
    });

    it('validates every row, not just the first', async () => {
      await expect(invoke(IPC.ASSIGNMENTS.CREATE_MANY, [valid(), { ...valid(), name: '  ' }]))
        .rejects.toThrow(/every row/);
    });

    it('saves nothing when one row is bad — the batch is atomic', async () => {
      await expect(
        invoke(IPC.ASSIGNMENTS.CREATE_MANY, [valid(), { ...valid(), type: 'Bogus' }]),
      ).rejects.toThrow();
      expect(await invoke<Assignment[]>(IPC.ASSIGNMENTS.LIST)).toHaveLength(0);
    });

    it('applies grade validation too (the batch path used to skip it)', async () => {
      await expect(invoke(IPC.ASSIGNMENTS.CREATE_MANY, [{ ...valid(), score: -5 }]))
        .rejects.toThrow(/score/);
    });
  });

  it('delete returns a snapshot, and restore puts it back', async () => {
    const a = await invoke<Assignment>(IPC.ASSIGNMENTS.CREATE, valid());
    const snap = await invoke(IPC.ASSIGNMENTS.DELETE, a.id);
    expect(snap).not.toBeNull();
    expect(await invoke<Assignment[]>(IPC.ASSIGNMENTS.LIST)).toHaveLength(0);

    await invoke(IPC.ASSIGNMENTS.RESTORE, snap);
    const back = await invoke<Assignment[]>(IPC.ASSIGNMENTS.LIST);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(a.id); // same id — linked notes resolve again
  });

  it('refuses to restore a malformed snapshot', async () => {
    await expect(invoke(IPC.ASSIGNMENTS.RESTORE, { assignment: { id: 'x' } }))
      .rejects.toThrow(/Nothing to restore/);
  });
});

describe('task handlers', () => {
  it('rejects a status outside the enum', async () => {
    await expect(invoke(IPC.TASKS.CREATE, { name: 'Laundry', dueDate: '2026-03-10', status: 'done' }))
      .rejects.toThrow(/status must be one of/);
  });

  it('accepts a valid status', async () => {
    const t = await invoke<Task>(IPC.TASKS.CREATE, {
      name: 'Laundry', dueDate: '2026-03-10', status: 'completed',
    });
    expect(t.status).toBe('completed');
    // Creating something already done still stamps when — the update path guarantees it too.
    expect(t.completed_at).not.toBeNull();
  });

  it('validates every row of a batch', async () => {
    await expect(invoke(IPC.TASKS.CREATE_MANY, [
      { name: 'ok', dueDate: '2026-03-10' },
      { name: 'bad', dueDate: '2026-03-10', status: 'nope' },
    ])).rejects.toThrow(/status must be one of/);
  });
});

describe('course handlers', () => {
  it('rejects a colour that is not a hex value', async () => {
    // It's rendered straight into CSS, so a truthiness check was never enough.
    for (const color of ['red', '#63', 'rgb(1,2,3)', 'red; background: url(evil)']) {
      await expect(invoke(IPC.COURSES.CREATE, { name: 'X', abbreviation: 'X', color }))
        .rejects.toThrow(/hex color/);
    }
  });

  it('accepts a hex colour in either case', async () => {
    const c = await invoke<Course>(IPC.COURSES.CREATE, {
      name: 'Physics', abbreviation: 'PHY', color: '#6393E1',
    });
    expect(c.color).toBe('#6393E1');
  });

  it('validates grade sections thoroughly', async () => {
    const bad: [string, unknown][] = [
      ['not an array',      'nope'],
      ['missing name',      [{ weight: 10, score: null }]],
      ['weight over 100',   [{ name: 'Exams', weight: 101, score: null }]],
      ['negative weight',   [{ name: 'Exams', weight: -1, score: null }]],
      ['score out of band', [{ name: 'Exams', weight: 10, score: 200 }]],
    ];
    for (const [, gradeSections] of bad) {
      await expect(invoke(IPC.COURSES.UPDATE, courseId, { gradeSections })).rejects.toThrow();
    }
  });

  it('accepts a well-formed grade breakdown', async () => {
    const updated = await invoke<Course>(IPC.COURSES.UPDATE, courseId, {
      gradeSections: [{ name: 'Exams', weight: 60, score: 88 }],
    });
    expect(JSON.parse(updated.grade_weights!)).toEqual([{ name: 'Exams', weight: 60, score: 88 }]);
  });
});
