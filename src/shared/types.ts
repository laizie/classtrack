// ─── Domain models ────────────────────────────────────────────────────────────
// These mirror the SQLite table shapes exactly (snake_case column names).

export interface Term {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
}

export interface Course {
  id: string;
  name: string;
  abbreviation: string;
  color: string;
  building: string | null;
  term_id: string | null;
  /** JSON GradeSection[] — custom grade sections with weights/scores. Parse with
   *  parseGradeSections() in shared/grades.ts (also reads the legacy {type: weight} shape). */
  grade_weights: string | null;
  created_at: string;
}

// A custom grade section in a course's grading scheme: a named bucket with a
// weight and (once you have it) your score. Stored as a JSON array in
// courses.grade_weights. Lets a syllabus model "Exam 1 / Exam 2 / Final / …"
// that the fixed assignment types can't express.
export interface GradeSection {
  id: string;
  name: string;
  /** Relative weight percent — normalized over the total, need not sum to 100. */
  weight: number;
  /** Your achieved score (0–100), or null when not graded/taken yet. */
  score: number | null;
}

// Fixed list from PRD §7 — only change here, never as ad-hoc strings.
export type AssignmentType =
  | 'Assignment'
  | 'Homework'
  | 'Quiz'
  | 'Exam'
  | 'Project'
  | 'Lab'
  | 'Reading'
  | 'Paper';

export const ASSIGNMENT_TYPES: AssignmentType[] = [
  'Assignment', 'Homework', 'Quiz', 'Exam',
  'Project', 'Lab', 'Reading', 'Paper',
];

export type AssignmentStatus = 'not_started' | 'in_progress' | 'completed';

export const ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  'not_started', 'in_progress', 'completed',
];

export interface Assignment {
  id: string;
  course_id: string;
  name: string;
  type: AssignmentType;
  status: AssignmentStatus;
  due_date: string;
  /** Optional time of day, "HH:MM" (24h). Null = all-day. Affects display + intra-day
   *  sort only; the date still governs urgency (see shared/deadlines.ts). */
  due_time: string | null;
  notes: string | null;
  /** Grade earned ("18 out of 20"). Both null until the user records one. */
  score: number | null;
  points_possible: number | null;
  /** ISO/UTC timestamp of when status last became 'completed'; null otherwise.
   *  Set/cleared by the repo on status transitions — never authored directly.
   *  Powers time-windowed views like the Weekly Review's "what got done". */
  completed_at: string | null;
  created_at: string;
}

// A checklist step inside an assignment ("Essay" → outline, draft, revise).
export interface Subtask {
  id: string;
  assignment_id: string;
  name: string;
  completed: 0 | 1; // SQLite has no boolean type
  sort_order: number;
  created_at: string;
}

export interface Task {
  id: string;
  name: string;
  status: AssignmentStatus;
  due_date: string;
  /** ISO/UTC timestamp of when status last became 'completed'; null otherwise.
   *  Set/cleared by the repo on status transitions (mirrors Assignment). */
  completed_at: string | null;
  created_at: string;
}

export interface ClassMeeting {
  id: string;
  course_id: string;
  day_of_week: number; // 0 = Sunday … 6 = Saturday
  start_time: string;  // "09:35"
  end_time: string;    // "10:50"
  location: string | null;
}

// A one-off change to a recurring class meeting: "no class Nov 26" (cancelled)
// or "moved to 2 PM in Room 110 that day" (moved). The recurring rule stays
// untouched; exceptions override single occurrences by date.
export type MeetingExceptionKind = 'cancelled' | 'moved';

export interface MeetingException {
  id: string;
  meeting_id: string;
  date: string; // YYYY-MM-DD of the affected occurrence
  kind: MeetingExceptionKind;
  new_start_time: string | null; // "HH:MM" — only set when kind = 'moved'
  new_end_time: string | null;
  new_location: string | null;
}

// A point-in-time snapshot of a note's document, for restore.
export interface NoteVersion {
  id: string;
  note_id: string;
  content_json: string;
  created_at: string;
}

// A block-based note (Notion-like). content_json is the BlockNote document (an array
// of blocks, serialized). content_text is a derived plaintext flattening of it, kept by
// the repo for search/AI — never authored directly. parent_note_id nests sub-pages.
export interface Note {
  id: string;
  title: string;
  content_json: string;
  content_text: string;
  icon: string | null;
  parent_note_id: string | null;
  /** Optional YYYY-MM-DD; places the note on its class Timeline. Null = a freeform Page. */
  note_date: string | null;
  /** Global pin: 1 surfaces the note in the "Pinned" section. (See note_links.is_pinned for
   *  the separate per-entity pin.) */
  is_pinned: 0 | 1;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

// A note plus the id of the course it's filed under (null for a loose note). Used by
// cross-class lists (e.g. the Notes landing page) to color-code a note by its class —
// the color/abbreviation themselves are looked up from the already-loaded course list.
export interface NoteWithCourse extends Note {
  course_id: string | null;
}

// The Studeo entities a note can be attached to. Kept as a fixed set; the DB CHECK
// constraint and the IPC handler both validate against it.
export type NoteLinkEntity =
  | 'course'
  | 'assignment'
  | 'class_meeting'
  | 'study_session'
  | 'term';

export const NOTE_LINK_ENTITIES: NoteLinkEntity[] = [
  'course', 'assignment', 'class_meeting', 'study_session', 'term',
];

export interface NoteLink {
  id: string;
  note_id: string;
  entity_type: NoteLinkEntity;
  entity_id: string;
  /** Only for class_meeting links: the dated lecture (YYYY-MM-DD). Null otherwise. */
  occurrence_date: string | null;
  is_pinned: 0 | 1;
  created_at: string;
}

// A note as seen through one of its links — the note's fields plus the link that attaches
// it to the entity being viewed (so the embed can pin/unpin and order by pin).
export interface EntityNote extends Note {
  link_id: string;
  is_pinned: 0 | 1;
}

export interface StudySession {
  id: string;
  started_at: string;
  duration_seconds: number;
  kind: 'focus' | 'short_break' | 'long_break';
  course_id: string | null;
  /** One-line intention set in Focus Mode before the block started. */
  intention: string | null;
  /** One-line reflection jotted right after the block ended. */
  reflection: string | null;
}

export type StudyBlockStatus = 'planned' | 'done' | 'skipped';

// A planned study session written onto the calendar by exam back-planning.
export interface StudyBlock {
  id: string;
  assignment_id: string | null;
  course_id: string | null;
  title: string;
  scheduled_date: string;        // 'YYYY-MM-DD' (local), all-day
  duration_minutes: number;
  status: StudyBlockStatus;
  created_at: string;
}

// Everything a course owned at the moment it was deleted — enough to put it
// back exactly (same ids everywhere) when the user hits Undo. Returned by
// courses.delete, accepted by courses.restore.
export interface CourseSnapshot {
  course: Course;
  assignments: Assignment[];
  subtasks: Subtask[];
  classMeetings: ClassMeeting[];
  meetingExceptions: MeetingException[];
  studyBlocks: StudyBlock[];
  /** Sessions that pointed at the course. Deleting nulls their course_id
   *  (study history survives the course); restoring re-links them. */
  studySessionIds: string[];
  noteLinks: NoteLink[];
}

/**
 * Everything that dies with a single assignment, captured so Undo can put it back
 * with the SAME ids — which is what makes notes linked to it resolve again.
 *
 * The old Undo re-created the assignment through the normal create path, so it came
 * back with a fresh id and lost its steps, its planned study blocks, its note links,
 * its original created_at and its completed_at. The toast said "Undo", which a user
 * reasonably reads as "put it back". Mirrors CourseSnapshot, which already did this
 * properly.
 */
export interface AssignmentSnapshot {
  assignment: Assignment;
  subtasks: Subtask[];
  studyBlocks: StudyBlock[];
  noteLinks: NoteLink[];
}

// ─── Input types ──────────────────────────────────────────────────────────────
// Separate from the domain models so we never accidentally pass DB row shapes
// as creation inputs (different fields, no id/created_at yet).

/** State of the Apple Reminders mirror, for the Settings row that drives it. */
export interface AppleRemindersStatus {
  /** macOS only — Reminders is scripted through AppleScript. */
  supported: boolean;
  enabled: boolean;
  syncing: boolean;
  /** ISO/UTC timestamp of the last completed pass, or null if it hasn't run. */
  lastSyncAt: string | null;
  /** Human-readable reason the last pass didn't fully succeed, or null. */
  lastError: string | null;
  /** How many assignments currently have a reminder mirroring them. */
  mirrored: number;
  /** Opt-in: delete a mirrored reminder when its assignment is completed, rather
   *  than ticking it off and leaving it in the list. See CompletedAction in
   *  shared/appleReminderSync.ts for why both behaviours are reasonable. */
  removeCompleted: boolean;
  /** The Reminders list Studeo owns. Fixed, so the sync can never manage a list
   *  the user filled with their own items. */
  listName: string;
}

export interface ReminderConfig {
  enabled: boolean;
  /** Minutes before a class meeting's start time to fire the notification. */
  leadMinutes: number;
  /** Daily due-date digest: one notification listing what's due today & tomorrow. */
  dueDigestEnabled: boolean;
  /** Local time ("HH:MM", 24h) at which the daily due digest fires. */
  dueDigestTime: string;
}

/**
 * Where a clicked desktop reminder should take the user. Main builds this when a
 * notification fires and pushes it to the renderer on click; the renderer maps it
 * to a route. A discriminated union so adding a new destination is type-checked
 * end to end (main must set `view`, the renderer must handle it).
 */
export type ReminderNavTarget =
  | { view: 'course'; courseId: string } // class reminder → that course's page
  | { view: 'this-week' };               // due digest → the This Week list

export interface CreateStudySessionInput {
  startedAt: string;        // ISO timestamp (UTC) — when the session began
  durationSeconds: number;
  kind: 'focus' | 'short_break' | 'long_break';
  courseId?: string;
  intention?: string;
}

export interface UpdateStudySessionInput {
  reflection?: string | null;
  intention?: string | null;
}

export interface CreateStudyBlockInput {
  assignmentId?: string | null;
  courseId?: string | null;
  title: string;
  scheduledDate: string;         // 'YYYY-MM-DD'
  durationMinutes: number;
}

export interface UpdateStudyBlockInput {
  status?: StudyBlockStatus;
  scheduledDate?: string;
}

export interface CreateCourseInput {
  name: string;
  abbreviation: string;
  color: string;
  building?: string;
  termId?: string;
}

export interface UpdateCourseInput {
  name?: string;
  abbreviation?: string;
  color?: string;
  building?: string | null;
  termId?: string | null;
  /** Custom grade sections (name + weight + score); null clears the scheme. */
  gradeSections?: GradeSection[] | null;
}

export interface CreateAssignmentInput {
  courseId: string;
  name: string;
  type?: AssignmentType;
  status?: AssignmentStatus;
  dueDate: string;
  /** Optional "HH:MM" (24h) time of day; omit/null for an all-day due date. */
  dueTime?: string | null;
  notes?: string;
  score?: number | null;
  pointsPossible?: number | null;
}

export interface UpdateAssignmentInput {
  name?: string;
  type?: AssignmentType;
  status?: AssignmentStatus;
  dueDate?: string;
  /** "HH:MM" (24h) to set a time, or null to clear it back to all-day. */
  dueTime?: string | null;
  notes?: string | null;
  score?: number | null;
  pointsPossible?: number | null;
}

export interface CreateSubtaskInput {
  assignmentId: string;
  name: string;
}

export interface UpdateSubtaskInput {
  name?: string;
  completed?: boolean;
}

export interface CreateTaskInput {
  name: string;
  status?: AssignmentStatus;
  dueDate: string;
}

export interface UpdateTaskInput {
  name?: string;
  status?: AssignmentStatus;
  dueDate?: string;
}

export interface CreateNoteInput {
  title?: string;
  /** BlockNote document, serialized. Defaults to an empty document ('[]'). */
  contentJson?: string;
  icon?: string;
  parentNoteId?: string;
  /** YYYY-MM-DD; places the note on a class Timeline. */
  noteDate?: string;
}

export interface UpdateNoteInput {
  title?: string;
  /** When provided, the repo recomputes content_text from it. */
  contentJson?: string;
  icon?: string | null;
  parentNoteId?: string | null;
  /** YYYY-MM-DD to place on the Timeline, or null to move it back to Pages. */
  noteDate?: string | null;
  /** true = pin globally (Pinned section); false = unpin. */
  pinned?: boolean;
  /** true = move to trash (sets archived_at); false = restore (clears it). */
  archived?: boolean;
}

export interface CreateNoteLinkInput {
  noteId: string;
  entityType: NoteLinkEntity;
  entityId: string;
  /** Only for class_meeting: pins the note to one dated lecture (YYYY-MM-DD). */
  occurrenceDate?: string;
}

export interface SaveMediaInput {
  /** The note the image belongs to — its bytes are stored under this note's folder. */
  noteId: string;
  /** File extension (no dot), e.g. "png". Validated against an image whitelist in main. */
  ext: string;
  data: Uint8Array;
}

export interface CreateMeetingExceptionInput {
  meetingId: string;
  date: string; // YYYY-MM-DD
  kind: MeetingExceptionKind;
  newStartTime?: string;
  newEndTime?: string;
  newLocation?: string;
}

export interface CreateClassMeetingInput {
  courseId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  location?: string;
}

export interface UpdateClassMeetingInput {
  dayOfWeek?: number;
  startTime?: string;
  endTime?: string;
  location?: string | null;
}

export interface CreateTermInput {
  name: string;
  startDate?: string;
  endDate?: string;
}

export interface UpdateTermInput {
  name?: string;
  startDate?: string | null;
  endDate?: string | null;
}

// ─── Spotify types ────────────────────────────────────────────────────────────

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: string[];
  albumName: string;
  albumArt: string | null;
  durationMs: number;
  uri: string;
}

export interface SpotifyPlaybackState {
  isPlaying: boolean;
  track: SpotifyTrack | null;
  progressMs: number;
  volumePercent: number;
  deviceName: string | null;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  trackCount: number;
  uri: string;
}

export type SpotifyConnectionStatus =
  | { connected: false; clientIdConfigured: boolean }
  | { connected: true; displayName: string; email: string };

// ─── Apple Music types ────────────────────────────────────────────────────────

export interface AppleMusicTrack {
  id: string;
  name: string;
  artistName: string;
  albumName: string;
  artworkUrl: string | null;
  durationMs: number;
}

export interface AppleMusicPlaylist {
  id: string;
  name: string;
  description: string | null;
  artworkUrl: string | null;
  trackCount: number;
  isLibrary: boolean;
}

export interface AppleMusicStatus {
  /** Is a controllable Apple Music session available right now? */
  running: boolean;
  /** macOS Automation permission granted (always true on Windows — SMTC needs no grant). */
  authorized: boolean;
  /** macOS can list playlists & search the library; Windows (SMTC) can only show now-playing. */
  canBrowseLibrary: boolean;
}

// ─── IPC channel names ────────────────────────────────────────────────────────
// Defined once as constants so main/preload/renderer all use the exact same
// string — a typo anywhere would be a compile error instead of a silent bug.

/** What one manual "check for updates" round trip found.
 *  - `unsupported`  — a dev build: not packaged or signed, so the OS updater can't run.
 *  - `up-to-date`   — the service has no release newer than this build.
 *  - `downloading`  — a newer release exists and is downloading in the background;
 *                     the app offers to restart once it's ready.
 *  - `downloaded`   — a build is already staged, waiting for a restart.
 *  - `error`        — the check couldn't be completed. */
export type UpdateCheckResult =
  | { status: 'unsupported' }
  | { status: 'up-to-date' }
  | { status: 'downloading' }
  | { status: 'downloaded'; version?: string }
  | { status: 'error'; message: string };

export const IPC = {
  COURSES: {
    LIST:    'courses:list',
    GET:     'courses:get',
    CREATE:  'courses:create',
    UPDATE:  'courses:update',
    DELETE:  'courses:delete',
    RESTORE: 'courses:restore',
  },
  ASSIGNMENTS: {
    LIST:        'assignments:list',
    CREATE:      'assignments:create',
    CREATE_MANY: 'assignments:create-many',
    UPDATE:      'assignments:update',
    DELETE:      'assignments:delete',
    RESTORE:     'assignments:restore',
  },
  SUBTASKS: {
    LIST:   'subtasks:list',
    CREATE: 'subtasks:create',
    UPDATE: 'subtasks:update',
    DELETE: 'subtasks:delete',
  },
  TASKS: {
    LIST:        'tasks:list',
    CREATE:      'tasks:create',
    CREATE_MANY: 'tasks:create-many',
    UPDATE:      'tasks:update',
    DELETE:      'tasks:delete',
  },
  CLASS_MEETINGS: {
    LIST:   'class_meetings:list',
    CREATE: 'class_meetings:create',
    UPDATE: 'class_meetings:update',
    DELETE: 'class_meetings:delete',
  },
  MEETING_EXCEPTIONS: {
    LIST:   'meeting_exceptions:list',
    CREATE: 'meeting_exceptions:create',
    DELETE: 'meeting_exceptions:delete',
  },
  TERMS: {
    LIST:   'terms:list',
    CREATE: 'terms:create',
    UPDATE: 'terms:update',
    DELETE: 'terms:delete',
  },
  STUDY_SESSIONS: {
    LIST:   'study_sessions:list',
    CREATE: 'study_sessions:create',
    UPDATE: 'study_sessions:update',
    DELETE: 'study_sessions:delete',
    RESTORE: 'study_sessions:restore',
  },
  STUDY_BLOCKS: {
    LIST:        'study_blocks:list',
    CREATE_MANY: 'study_blocks:create-many',
    UPDATE:      'study_blocks:update',
    DELETE:      'study_blocks:delete',
    DELETE_FOR_ASSIGNMENT: 'study_blocks:delete-for-assignment',
  },
  NOTES: {
    LIST:            'notes:list',
    LIST_WITH_COURSE:'notes:list-with-course',
    LIST_LOOSE:      'notes:list-loose',
    CHILDREN:        'notes:children',
    GET:             'notes:get',
    SEARCH:          'notes:search',
    CREATE:          'notes:create',
    UPDATE:          'notes:update',
    DELETE:          'notes:delete',
    LIST_VERSIONS:   'notes:list-versions',
    RESTORE_VERSION: 'notes:restore-version',
  },
  NOTE_LINKS: {
    LIST_FOR_NOTE:    'note_links:list-for-note',
    NOTES_FOR_ENTITY: 'note_links:notes-for-entity',
    CREATE:           'note_links:create',
    SET_PINNED:       'note_links:set-pinned',
    DELETE:           'note_links:delete',
  },
  MEDIA: {
    SAVE: 'media:save',
  },
  REMINDERS: {
    CONFIGURE: 'reminders:configure',
    TEST:      'reminders:test',
    // main → renderer push: deep-link target when a reminder is clicked.
    NAVIGATE:  'reminders:navigate',
  },
  APP: {
    REVEAL_DATA:    'app:reveal-data',
    BACKUP_DATA:    'app:backup-data',
    RESTORE_DATA:   'app:restore-data',
    LIST_BACKUPS:   'app:list-backups',
    REVEAL_BACKUPS: 'app:reveal-backups',
    GET_LOGIN_ITEM: 'app:get-login-item',
    SET_LOGIN_ITEM: 'app:set-login-item',
    GET_SETTINGS:   'app:get-settings',
    SET_SETTING:    'app:set-setting',
    SET_FULLSCREEN: 'app:set-fullscreen',
    GET_FULLSCREEN: 'app:get-fullscreen',
    CHECK_UPDATES:  'app:check-updates',
    SWEEP_ASSETS:   'app:sweep-assets',
  },
  APPLE_REMINDERS: {
    STATUS:               'apple_reminders:status',
    SET_ENABLED:          'apple_reminders:set-enabled',
    SET_REMOVE_COMPLETED: 'apple_reminders:set-remove-completed',
    SYNC_NOW:             'apple_reminders:sync-now',
    REBUILD:              'apple_reminders:rebuild',
  },
  FEEDS: {
    FETCH_ICS: 'feeds:fetch-ics',
  },
  PDF: {
    PICK: 'pdf:pick',
  },
  APPLE_MUSIC: {
    STATUS:         'apple_music:status',
    PLAYBACK:       'apple_music:playback',
    PLAY:           'apple_music:play',
    PAUSE:          'apple_music:pause',
    NEXT:           'apple_music:next',
    PREVIOUS:       'apple_music:previous',
    PLAYLISTS:      'apple_music:playlists',
    PLAY_PLAYLIST:  'apple_music:play-playlist',
    SEARCH_LIBRARY: 'apple_music:search-library',
    PLAY_TRACK:     'apple_music:play-track',
  },
  SPOTIFY: {
    STATUS:           'spotify:status',
    SET_CLIENT_ID:    'spotify:set-client-id',
    CONNECT:          'spotify:connect',
    DISCONNECT:       'spotify:disconnect',
    PLAYBACK:         'spotify:playback',
    PLAY:             'spotify:play',
    PAUSE:            'spotify:pause',
    NEXT:             'spotify:next',
    PREVIOUS:         'spotify:previous',
    QUEUE:            'spotify:queue',
    VOLUME:           'spotify:volume',
    USER_PLAYLISTS:   'spotify:user-playlists',
    SEARCH_PLAYLISTS: 'spotify:search-playlists',
  },
} as const;

/**
 * Result of picking a PDF. Main hands back raw BYTES, never an interpretation of them:
 * every PDF feature parses in the renderer, which has a canvas for rasterizing pages and
 * is sandboxed for reading a document nobody here wrote. Main does only the part that
 * requires it — touching the filesystem.
 */
export type PickPdfResult =
  | { canceled: true }
  | { canceled: false; data: Uint8Array; fileName: string };

// ─── window.api contract ──────────────────────────────────────────────────────
// This interface is implemented by preload.ts and consumed by the renderer.
// Keeping it in shared/ means both sides are typed against the same shape.

export interface WindowApi {
  courses: {
    list(): Promise<Course[]>;
    get(id: string): Promise<Course | null>;
    create(input: CreateCourseInput): Promise<Course>;
    update(id: string, input: UpdateCourseInput): Promise<Course>;
    /** Deletes the course and everything it owns; returns a snapshot for Undo
     *  (null when the id didn't exist, so there's nothing to take back). */
    delete(id: string): Promise<CourseSnapshot | null>;
    /** Puts a deleted course back exactly as it was (the Undo action). */
    restore(snapshot: CourseSnapshot): Promise<Course>;
  };
  assignments: {
    list(filters?: { courseId?: string; status?: AssignmentStatus }): Promise<Assignment[]>;
    create(input: CreateAssignmentInput): Promise<Assignment>;
    /** Atomic batch insert — all rows save or none do (Day-One Setup). */
    createMany(inputs: CreateAssignmentInput[]): Promise<Assignment[]>;
    update(id: string, input: UpdateAssignmentInput): Promise<Assignment>;
    /** Returns everything it removed, so Undo can restore it exactly. Null if the id was already gone. */
    delete(id: string): Promise<AssignmentSnapshot | null>;
    restore(snapshot: AssignmentSnapshot): Promise<Assignment>;
  };
  subtasks: {
    list(filters?: { assignmentId?: string }): Promise<Subtask[]>;
    create(input: CreateSubtaskInput): Promise<Subtask>;
    update(id: string, input: UpdateSubtaskInput): Promise<Subtask>;
    delete(id: string): Promise<void>;
  };
  tasks: {
    list(): Promise<Task[]>;
    create(input: CreateTaskInput): Promise<Task>;
    /** Atomic batch insert — all rows save or none do (recurring task series). */
    createMany(inputs: CreateTaskInput[]): Promise<Task[]>;
    update(id: string, input: UpdateTaskInput): Promise<Task>;
    delete(id: string): Promise<void>;
  };
  classMeetings: {
    list(filters?: { courseId?: string }): Promise<ClassMeeting[]>;
    create(input: CreateClassMeetingInput): Promise<ClassMeeting>;
    update(id: string, input: UpdateClassMeetingInput): Promise<ClassMeeting>;
    delete(id: string): Promise<void>;
  };
  meetingExceptions: {
    list(filters?: { meetingId?: string }): Promise<MeetingException[]>;
    /** Creating a second exception for the same meeting+date replaces the first. */
    create(input: CreateMeetingExceptionInput): Promise<MeetingException>;
    delete(id: string): Promise<void>;
  };
  terms: {
    list(): Promise<Term[]>;
    create(input: CreateTermInput): Promise<Term>;
    update(id: string, input: UpdateTermInput): Promise<Term>;
    delete(id: string): Promise<void>;
  };
  studySessions: {
    list(): Promise<StudySession[]>;
    create(input: CreateStudySessionInput): Promise<StudySession>;
    /** Attach an intention/reflection to an already-logged session. */
    update(id: string, input: UpdateStudySessionInput): Promise<StudySession>;
    /** Remove a mis-logged session. Returns the row so Undo can put it back. */
    delete(id: string): Promise<StudySession | null>;
    restore(session: StudySession): Promise<StudySession>;
  };
  studyBlocks: {
    list(): Promise<StudyBlock[]>;
    /** Atomic batch insert of a generated study plan — all rows save or none do. */
    createMany(inputs: CreateStudyBlockInput[]): Promise<StudyBlock[]>;
    update(id: string, input: UpdateStudyBlockInput): Promise<StudyBlock>;
    delete(id: string): Promise<void>;
    /** Clear an exam's existing plan before regenerating it (the "Replace" flow). */
    deleteForAssignment(assignmentId: string): Promise<void>;
  };
  notes: {
    /** Defaults to non-archived notes; pass { archived: true } for the trash. */
    list(filters?: { archived?: boolean }): Promise<Note[]>;
    /** Non-archived notes, newest first, each tagged with its course id (null = loose). */
    listWithCourse(): Promise<NoteWithCourse[]>;
    /** Top-level notes not attached to any course (the "Loose notes" bucket). */
    listLoose(): Promise<Note[]>;
    /** Direct sub-pages of a note (the Pages tree). */
    children(parentId: string): Promise<Note[]>;
    get(id: string): Promise<Note | null>;
    /** Full-text search over title + content_text (non-archived only). */
    search(query: string): Promise<Note[]>;
    create(input: CreateNoteInput): Promise<Note>;
    update(id: string, input: UpdateNoteInput): Promise<Note>;
    delete(id: string): Promise<void>;
    /** Recent saved snapshots of a note's document, newest first. */
    listVersions(noteId: string): Promise<NoteVersion[]>;
    /** Restore a note to a snapshot (snapshots the current content first so it's reversible). */
    restoreVersion(noteId: string, versionId: string): Promise<Note>;
  };
  noteLinks: {
    /** The links attached to one note (for the editor's link bar). */
    listForNote(noteId: string): Promise<NoteLink[]>;
    /** The notes attached to one entity (for per-entity embeds), pinned first. occurrenceDate
        scopes to a single dated lecture for class_meeting links. */
    notesForEntity(entityType: NoteLinkEntity, entityId: string, occurrenceDate?: string): Promise<EntityNote[]>;
    /** Linking the same note+entity twice is a no-op and returns the existing link. */
    create(input: CreateNoteLinkInput): Promise<NoteLink>;
    /** Pin/unpin a note on an entity (e.g. a course "home" page). Keyed by the link id. */
    setPinned(linkId: string, pinned: boolean): Promise<void>;
    delete(id: string): Promise<void>;
  };
  media: {
    /** Persist image bytes for a note; resolves to a studeo-asset:// URL to render it. */
    save(input: SaveMediaInput): Promise<string>;
  };
  reminders: {
    configure(config: ReminderConfig): Promise<void>;
    /** Fire a sample desktop notification so the user can verify permissions. */
    /** `shown` is false when the OS suppressed it — notifications off, or Focus on. */
    test(): Promise<{ supported: boolean; shown: boolean }>;
    /** Subscribe to deep-link requests pushed from main when a reminder is
     *  clicked. Returns an unsubscribe function. */
    onNavigate(cb: (target: ReminderNavTarget) => void): () => void;
  };
  app: {
    /** Highlight the database file in Finder / Explorer. */
    revealData(): Promise<void>;
    /** Ask the update service now instead of waiting for the hourly check. */
    checkForUpdates(): Promise<UpdateCheckResult>;
    /** Save-dialog + consistent snapshot of the database. saved=false means canceled. */
    backupData(): Promise<{ saved: boolean; path?: string; error?: string }>;
    /** Open-dialog + validate + (after a safety snapshot of current data) replace the live
     *  database with a chosen backup, then relaunch. On success the app restarts, so the
     *  promise only resolves with restored=false (canceled or error). */
    restoreData(): Promise<{ restored: boolean; canceled?: boolean; error?: string }>;
    /** How many automatic snapshots are on disk, and the local day (YYYY-MM-DD) of the
     *  newest — so Settings can show that the rolling backups are actually running. */
    /** Reclaim note images nothing references any more. Returns what was freed. */
    sweepAssets(): Promise<{ removed: number; bytes: number }>;
    listBackups(): Promise<{ count: number; newestDay: string | null }>;
    /** Open the automatic-backups folder in Finder / Explorer. */
    revealBackups(): Promise<void>;
    /** Whether Studeo starts at login, read from the OS (which can change it behind our
     *  back). `supported` is false in dev and on Linux, where we can't register it. */
    getLoginItem(): Promise<{ supported: boolean; openAtLogin: boolean }>;
    /** Turn the login item on/off; resolves with the state the OS actually ended up in. */
    setLoginItem(enabled: boolean): Promise<{ supported: boolean; openAtLogin: boolean }>;
    /** All saved UI preferences, read synchronously at preload time so they can be applied
     *  before first paint (e.g. theme, with no flash). Keys absent until first set. */
    initialSettings: Record<string, string>;
    /** Persist a UI preference in the main process so it survives a full quit/relaunch. */
    setSetting(key: string, value: string): Promise<void>;
    /** Put the window into (or out of) true OS fullscreen — no title bar/chrome.
     *  Used by Focus Mode for an immersive, distraction-free environment. */
    setFullscreen(on: boolean): Promise<void>;
    /** Whether the window is currently in OS fullscreen. */
    isFullscreen(): Promise<boolean>;
    /** Subscribe to fullscreen changes (covers the OS exit gestures: Esc, green button,
     *  Ctrl+Cmd+F), so the UI stays in sync. Returns a cleanup function. */
    onFullscreenChange(cb: (isFullscreen: boolean) => void): () => void;
  };
  feeds: {
    /** Fetch a remote .ics calendar feed by URL (done in main; returns raw text). */
    fetchIcs(url: string): Promise<{ text: string }>;
  };
  pdf: {
    /** Open-dialog + read a PDF, returning its raw bytes for the renderer to
     *  rasterize or extract text from. `title` labels the file dialog. Rejects if
     *  the file is unreadable or over the size ceiling. */
    pick(title?: string): Promise<PickPdfResult>;
  };
  /** Mirrors upcoming assignments into an Apple Reminders list, which iCloud carries
   *  to the phone — the only path that alerts you with the laptop shut. */
  appleReminders: {
    status():                        Promise<AppleRemindersStatus>;
    setEnabled(enabled: boolean):    Promise<AppleRemindersStatus>;
    /** Delete the mirrored reminder on completion instead of ticking it off. */
    setRemoveCompleted(remove: boolean): Promise<AppleRemindersStatus>;
    /** Force a pass now instead of waiting for the interval. */
    syncNow():                       Promise<AppleRemindersStatus>;
    /** Delete the mirrored list and forget every link, so the next sync rebuilds
     *  it. The repair for a list that already accumulated duplicates. */
    rebuild():                       Promise<AppleRemindersStatus>;
  };
  appleMusic: {
    status():                        Promise<AppleMusicStatus>;
    playback():                      Promise<{ isPlaying: boolean; progressMs: number; track: AppleMusicTrack | null } | null>;
    play():                          Promise<{ ok: boolean; error?: string }>;
    pause():                         Promise<{ ok: boolean; error?: string }>;
    next():                          Promise<{ ok: boolean; error?: string }>;
    previous():                      Promise<{ ok: boolean; error?: string }>;
    playlists():                     Promise<AppleMusicPlaylist[]>;
    playPlaylist(id: string):        Promise<{ ok: boolean; error?: string }>;
    searchLibrary(query: string):    Promise<AppleMusicTrack[]>;
    playTrack(databaseId: string):   Promise<{ ok: boolean; error?: string }>;
  };
  spotify: {
    status(): Promise<SpotifyConnectionStatus>;
    setClientId(clientId: string): Promise<{ ok: boolean }>;
    /** `ok:false` with a reason when this system has no secure store for the token. */
    connect(clientId: string): Promise<{ ok: boolean; error?: string }>;
    disconnect(): Promise<{ ok: boolean }>;
    playback(): Promise<SpotifyPlaybackState | null>;
    play(contextUri?: string): Promise<{ ok: boolean; error?: string }>;
    pause(): Promise<{ ok: boolean; error?: string }>;
    next(): Promise<{ ok: boolean; error?: string }>;
    previous(): Promise<{ ok: boolean; error?: string }>;
    /** Upcoming tracks (the "Up next" queue). Empty when unavailable. */
    queue(): Promise<SpotifyTrack[]>;
    volume(percent: number): Promise<{ ok: boolean; error?: string }>;
    userPlaylists(): Promise<SpotifyPlaylist[]>;
    searchPlaylists(query: string): Promise<SpotifyPlaylist[]>;
    onAuthCallback(cb: (success: boolean) => void): () => void;
  };
}
