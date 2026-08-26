import { useMemo } from 'react';
import { Flame } from 'lucide-react';
import type { StudySession } from '../../../shared/types';
import {
  buildHeatmap,
  currentStreak,
  totalFocusMinutes,
  focusMinutesSince,
  startOfDay,
  addDays,
  type HeatmapCell,
} from '../../../shared/studyStats';
import { cn } from '../../lib/utils';

const WEEKS = 53;
const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']; // GitHub shows every other row
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Intensity shades blend the Lamplight Amber accent into the inset well, so the
// scale reads as "more lamplight = more focus" and tracks the theme automatically.
function levelStyle(level: 0 | 1 | 2 | 3 | 4): React.CSSProperties {
  if (level === 0) return { backgroundColor: 'var(--inset)' };
  const pct = [0, 28, 50, 74, 100][level];
  return { backgroundColor: `color-mix(in srgb, var(--accent) ${pct}%, var(--inset))` };
}

function hoursLabel(minutes: number): string {
  const h = minutes / 60;
  if (h < 1) return `${Math.round(minutes)} min`;
  return `${h % 1 === 0 ? h : h.toFixed(1)} h`;
}

function cellTitle(cell: HeatmapCell): string {
  const date = cell.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (cell.future) return date;
  const mins = Math.round(cell.minutes);
  return mins === 0 ? `No focus time · ${date}` : `${hoursLabel(cell.minutes)} focused · ${date}`;
}

interface Props {
  sessions: StudySession[];
  /** Compact = smaller cells, no stat header (for tucking into Focus Mode if wanted). */
  compact?: boolean;
}

/** A GitHub-contributions-style grid of focus time, plus streak/total stat chips. */
export default function StudyHeatmap({ sessions, compact = false }: Props) {
  // Everything below is a per-DAY fact, so it should be recomputed when the day turns
  // over — and not more often than that. `new Date()` is a different value on every
  // render, so listing it as a dependency would defeat the memo entirely; leaving it out
  // (which is what these did) went the other way, pinning the grid and the streak to
  // whatever "now" was when `sessions` last changed. Study past midnight and the heatmap
  // stayed anchored to yesterday.
  //
  // A day key is stable within a day and changes exactly once at midnight, which is the
  // granularity these actually want: both buildHeatmap and currentStreak call
  // startOfDay() on whatever they're given, so midnight-today is equivalent to the
  // instant but memoises properly.
  const dayKey = startOfDay(new Date()).getTime();
  const now = useMemo(() => new Date(dayKey), [dayKey]);

  const grid = useMemo(() => buildHeatmap(sessions, WEEKS, now), [sessions, now]);

  const stats = useMemo(() => {
    const weekStart = addDays(startOfDay(now), -now.getDay());
    return {
      streak:  currentStreak(sessions, now),
      total:   totalFocusMinutes(sessions),
      thisWeek: focusMinutesSince(sessions, weekStart),
    };
  }, [sessions, now]);

  // A column is labelled when the 1st of a month falls inside it, so "Mar" sits over
  // the week March actually starts — not over the first week whose *Sunday* happens to
  // be in March, which drifts the label up to six days late. Months are at least four
  // columns apart, so two labels can never collide.
  const monthLabels = grid.map((week) => {
    const first = week.find((cell) => cell.date.getDate() === 1);
    return first ? MONTHS[first.date.getMonth()] : '';
  });

  // Height and width are kept apart because the weekday gutter needs the cell's
  // *height* (to line up with its row) but its own full width — squeezing "Wed" into a
  // 12px-wide box is what clipped those labels away.
  const cellH = compact ? 'h-2.5' : 'h-3';
  const cellW = compact ? 'w-2.5' : 'w-3';
  const gap   = compact ? 'gap-[3px]' : 'gap-1';
  // Wide enough for "Wed" at the caption size, and shared by the month row's spacer so
  // the two rows stay aligned from one number instead of two kept in step by hand.
  const gutter = 'w-8 pr-1.5';

  return (
    <div>
      {!compact && (
        <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          {/* The streak chip may praise a run; it may never display its absence.
              "0 day streak" — or "1" — is the app telling a student who already
              feels behind that they're behind, which is precisely the gamified
              nagging PRODUCT.md rejects. So the chip appears only once there's a
              real run to celebrate (2+ days) and simply isn't there otherwise;
              the honest totals below carry the page on their own. */}
          {stats.streak >= 2 && (
            <Stat value={stats.streak} unit="day streak" flame />
          )}
          <Stat value={hoursLabel(stats.thisWeek)} unit="this week" />
          <Stat value={hoursLabel(stats.total)} unit="all time" />
        </div>
      )}

      <div className="overflow-x-auto pb-1">
        <div className="inline-flex flex-col gap-1">
          {/* Month labels — a spacer stands in for the weekday gutter so the labels
              track their columns exactly. Each sits in a cell-width box and is left to
              overflow to the right (there's a month of empty columns to spill into),
              which keeps every box on the grid's pitch. */}
          <div className="flex gap-1">
            <div className={cn(gutter, 'shrink-0')} aria-hidden />
            <div className={cn('flex', gap)}>
              {monthLabels.map((label, i) => (
                <div key={i} className={cn(cellW, 'shrink-0 text-caption leading-none text-muted')}>
                  {label && <span className="whitespace-nowrap">{label}</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-1">
            {/* Weekday labels — full gutter width, right-aligned against the grid. */}
            <div className={cn('flex shrink-0 flex-col', gutter, gap)}>
              {DAY_LABELS.map((d, i) => (
                <div key={i} className={cn(cellH, 'flex w-full items-center justify-end text-caption leading-none text-muted')}>
                  {d}
                </div>
              ))}
            </div>

            {/* The grid: one flex column per week */}
            <div className={cn('flex', gap)}>
              {grid.map((week, wi) => (
                <div key={wi} className={cn('flex flex-col', gap)}>
                  {week.map(cell => (
                    <div
                      key={cell.key}
                      title={cellTitle(cell)}
                      className={cn(cellH, cellW, 'shrink-0 rounded-sm', cell.future && 'opacity-0')}
                      style={cell.future ? undefined : levelStyle(cell.level)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center justify-end gap-1.5 pt-1 text-caption text-muted">
            <span>Less</span>
            {([0, 1, 2, 3, 4] as const).map(l => (
              <div key={l} className={cn(cellH, cellW, 'rounded-sm')} style={levelStyle(l)} />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, unit, flame = false }: { value: string | number; unit: string; flame?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      {flame && <Flame size={15} className="self-center text-accent-text" fill="currentColor" />}
      <span className="text-xl font-semibold tabular-nums text-ink">{value}</span>
      <span className="text-xs text-muted">{unit}</span>
    </div>
  );
}
