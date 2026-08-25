import { BookOpen, ClipboardList, CalendarClock, ListTodo, Link2, Sigma, Presentation } from 'lucide-react';
import type { DefaultReactSuggestionItem } from '@blocknote/react';

export interface SlashActions {
  onLinkCourse: () => void;
  onLinkAssignment: () => void;
  onInsertDue: () => void;
  onChecklistToTask: () => void;
  onLinkNotes: () => void;
  onInsertMath: () => void;
  onImportSlides: () => void;
}

/** Studeo-specific slash menu commands, grouped under "Studeo" below the default blocks. */
export function studeoSlashItems(actions: SlashActions): DefaultReactSuggestionItem[] {
  return [
    {
      // First in the group: in a maths-heavy class this is the one you reach for
      // every few lines, where the link commands are once-per-note.
      title: 'Equation',
      group: 'Studeo',
      subtext: 'Write LaTeX, see it rendered',
      aliases: ['math', 'latex', 'equation', 'formula', 'tex', 'katex'],
      icon: <Sigma size={18} />,
      onItemClick: actions.onInsertMath,
    },
    {
      // Second: this is the move you make once at the start of a lecture, and it's the
      // one that sets the whole note up, so it wants to be easy to find.
      title: 'Slides',
      group: 'Studeo',
      subtext: 'Import a slide deck PDF — one block per page, notes underneath',
      aliases: ['slides', 'pdf', 'deck', 'lecture', 'powerpoint', 'ppt', 'import', 'presentation'],
      icon: <Presentation size={18} />,
      onItemClick: actions.onImportSlides,
    },
    {
      title: 'Link course',
      group: 'Studeo',
      subtext: 'Attach this note to a course',
      aliases: ['link', 'course', 'class'],
      icon: <BookOpen size={18} />,
      onItemClick: actions.onLinkCourse,
    },
    {
      title: 'Link assignment',
      group: 'Studeo',
      subtext: 'Attach this note to an assignment',
      aliases: ['link', 'assignment', 'hw'],
      icon: <ClipboardList size={18} />,
      onItemClick: actions.onLinkAssignment,
    },
    {
      title: 'Due date',
      group: 'Studeo',
      subtext: 'Insert a due-date line',
      aliases: ['due', 'deadline', 'date'],
      icon: <CalendarClock size={18} />,
      onItemClick: actions.onInsertDue,
    },
    {
      title: 'Turn into task',
      group: 'Studeo',
      subtext: 'Add this line to your Tasks',
      aliases: ['task', 'todo', 'checklist'],
      icon: <ListTodo size={18} />,
      onItemClick: actions.onChecklistToTask,
    },
    {
      title: 'Link notes',
      group: 'Studeo',
      subtext: 'Insert links to other notes (exam review / study guide)',
      aliases: ['link', 'notes', 'reference', 'study', 'guide'],
      icon: <Link2 size={18} />,
      onItemClick: actions.onLinkNotes,
    },
  ];
}
