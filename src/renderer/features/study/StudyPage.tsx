import { useEffect } from 'react';
import { Play, Pause, RotateCcw, SkipForward, Timer, Music2, Maximize2, Activity } from 'lucide-react';
import {
  useTimerStore, FOCUS_OPTIONS, BREAK_OPTIONS,
  PHASE_LABELS, PHASE_COLORS, formatClock,
  type Phase,
} from '../../store/useTimerStore';
import FocusListPanel from './FocusListPanel';
import AppleMusicStudyPanel from '../applemusic/AppleMusicStudyPanel';
import SpotifyStudyPanel from '../spotify/SpotifyStudyPanel';
import AutoNowPlaying from '../music/AutoNowPlaying';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils';
import StudySessionsNotesCard from './StudySessionsNotesCard';
import { contrastTextColor } from '../../lib/colors';
import StudyHeatmap from './StudyHeatmap';
import ProgressRing from './ProgressRing';
import { useFocusStore } from '../../store/useFocusStore';
import { useStudySessions } from '../../lib/queries/useStudySessions';

// ── Study technique presets ───────────────────────────────────────────────────

interface Technique {
  id: string;
  label: string;
  focusMins: number;
  breakMins: number;
  desc: string;
}

const TECHNIQUES: Technique[] = [
  {
    id:        'pomodoro',
    label:     'Pomodoro',
    focusMins: 25,
    breakMins: 5,
    desc:      '25 min focus · 5 min break — the classic method to stay consistently productive',
  },
  {
    id:        '5217',
    label:     '52 / 17',
    focusMins: 52,
    breakMins: 17,
    desc:      '52 min deep work · 17 min break — based on research into top performers',
  },
  {
    id:        'deepwork',
    label:     'Deep Work',
    focusMins: 90,
    breakMins: 20,
    desc:      '90 min focus · 20 min break — aligned with the brain\'s ultradian rhythm',
  },
  {
    id:        'custom',
    label:     'Custom',
    focusMins: 0,
    breakMins: 0,
    desc:      'Set your own focus and break durations below',
  },
];

function detectTechnique(focusMins: number, breakMins: number): string {
  const match = TECHNIQUES.find(t => t.id !== 'custom' && t.focusMins === focusMins && t.breakMins === breakMins);
  return match?.id ?? 'custom';
}

// ── Constants ─────────────────────────────────────────────────────────────────
// (Phase labels/colors and the clock formatter live in useTimerStore so the
// sidebar chip and window title stay in sync with this page.)

// Shared segmented-control styling so every selector on this screen speaks one
// visual language — white-on-track when selected — matching the phase tabs.
const SEG_GROUP = 'flex flex-wrap gap-1 p-1 bg-inset rounded-lg';
function segBtn(active: boolean): string {
  return cn(
    'px-3 py-1.5 text-xs rounded-md font-medium transition-colors',
    active
      ? 'bg-surface text-ink shadow-sm'
      : 'text-ink-soft hover:bg-surface-hi',
  );
}

// ── Music study column ────────────────────────────────────────────────────────

function MusicStudyColumn() {
  const { musicMode } = useSettingsStore();

  if (!musicMode) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-center h-full">
        <div className="w-10 h-10 rounded-full bg-inset flex items-center justify-center">
          <Music2 size={18} className="text-muted" />
        </div>
        <div>
          <p className="text-sm font-medium text-ink-soft">No music selected</p>
          <p className="text-xs text-muted mt-1">
            Choose Apple Music, Spotify, or Now Playing in Settings
          </p>
        </div>
        <Link
          to="/settings"
          className="mt-1 px-4 py-2 rounded-lg bg-accent text-accent-ink text-sm font-medium hover:bg-accent-deep active:scale-[0.98] transition-colors"
        >
          Open Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {musicMode === 'spotify'      ? <SpotifyStudyPanel />
        : musicMode === 'apple_music' ? <AppleMusicStudyPanel />
        : <AutoNowPlaying tone="surface" size="panel" />}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StudyPage() {
  const {
    phase, isRunning, timeLeft, autoAdvance, focusSecs, breakSecs, longBreakSecs,
    setPhase, start, pause, reset, skip, toggleAutoAdvance,
    setFocusMins, setBreakMins,
    customTechnique, setCustomTechnique,
  } = useTimerStore();

  const totalSecs =
    phase === 'focus' ? focusSecs : phase === 'long_break' ? longBreakSecs : breakSecs;
  const focusMins = focusSecs / 60;
  const breakMins = breakSecs / 60;

  // Derived, never stored: the durations are the source of truth, plus one
  // persisted "user chose Custom" flag. Local state here went stale on
  // remount (navigate away + back snapped Custom back to a preset).
  const techniqueId = customTechnique ? 'custom' : detectTechnique(focusMins, breakMins);

  function applyTechnique(t: Technique) {
    setCustomTechnique(t.id === 'custom');
    if (t.id !== 'custom') {
      setFocusMins(t.focusMins);
      setBreakMins(t.breakMins);
    }
  }

  // The countdown itself is driven app-wide from Layout (useTimerDriver), so it
  // survives navigation. Here we only wire up keyboard control while on this screen.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (isRunning) pause(); else start();
      } else if (e.key === 'r' || e.key === 'R') {
        reset();
      } else if (e.key === 's' || e.key === 'S') {
        skip();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isRunning, pause, start, reset, skip]);

  const color           = PHASE_COLORS[phase];
  const activeTechnique = TECHNIQUES.find(t => t.id === techniqueId) ?? TECHNIQUES[0];
  const { data: studySessions = [] } = useStudySessions();

  return (
    <div className="p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-ink">Study</h1>
          <button
            onClick={() => useFocusStore.getState().open()}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-sm hover:bg-accent-deep active:scale-[0.98] transition-colors"
          >
            <Maximize2 size={15} />
            Enter Focus Mode
          </button>
        </div>

        <div className="flex flex-col lg:flex-row gap-5">

          {/* ── Timer card ───────────────────────────────────────────────────── */}
          <div className="bg-surface border border-line rounded-2xl shadow-sm p-6 w-full lg:w-[360px] shrink-0 flex flex-col items-center">

            {/* Card header */}
            <div className="flex items-center gap-2 mb-5 self-start">
              <Timer size={14} className="text-muted" />
              <h2 className="text-sm font-semibold text-ink-soft tracking-tight">
                Focus Timer
              </h2>
            </div>

            {/* Technique selector */}
            <div className="w-full mb-5">
              <p className="text-xs font-medium text-muted uppercase tracking-wide mb-2">
                Technique
              </p>
              {/* 2×2 grid — a single-row track wraps lopsidedly in this narrow card */}
              <div className="grid grid-cols-2 gap-1 p-1 bg-inset rounded-lg">
                {TECHNIQUES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => applyTechnique(t)}
                    className={segBtn(techniqueId === t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {activeTechnique.id !== 'custom' && (
                <p className="mt-2 text-xs text-muted leading-relaxed">
                  {activeTechnique.desc}
                </p>
              )}
            </div>

            {/* Phase tabs — just Focus and Break. A long break is granted automatically
                every 4th focus session; while one is running, the Break tab relabels to
                "Long break" rather than existing as a third button nobody selects. */}
            <div className="flex items-center gap-1 p-1 bg-inset rounded-lg mb-7 self-stretch justify-center">
              {(['focus', 'short_break'] as Phase[]).map(p => {
                const isBreakTab   = p === 'short_break';
                const inLongBreak  = phase === 'long_break';
                const isActive     = phase === p || (isBreakTab && inLongBreak);
                return (
                  <button
                    key={p}
                    onClick={() => {
                      // Clicking the already-active Break tab during a long break
                      // shouldn't downgrade it to a short one.
                      if (isBreakTab && inLongBreak) return;
                      setPhase(p);
                    }}
                    className={cn(
                      'flex-1 px-4 py-1.5 text-sm rounded-md transition-colors',
                      isActive
                        ? 'bg-surface text-ink shadow-sm font-medium'
                        : 'text-muted hover:bg-surface-hi'
                    )}
                  >
                    {isBreakTab && inLongBreak ? 'Long break' : PHASE_LABELS[p]}
                  </button>
                );
              })}
            </div>

            {/* Progress ring */}
            <div className="relative flex items-center justify-center mb-7">
              <ProgressRing phase={phase} timeLeft={timeLeft} totalSecs={totalSecs} />
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                {/* Ink digits, always AA on the white card; the ring and Start
                    button carry the phase color. */}
                <span className="text-5xl lg:text-display font-semibold tabular-nums tracking-tight text-ink">
                  {formatClock(timeLeft)}
                </span>
                <span className="text-xs text-muted mt-1">
                  {PHASE_LABELS[phase]}
                </span>
              </div>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-4 mb-4">
              <button
                onClick={reset}
                title="Reset"
                className="p-2.5 text-muted hover:text-ink-soft rounded-full hover:bg-surface-hi transition-colors"
              >
                <RotateCcw size={17} />
              </button>
              <button
                onClick={isRunning ? pause : start}
                className="flex items-center gap-2 px-8 py-3 rounded-full font-medium text-sm shadow-sm transition-all hover:opacity-90 active:scale-95"
                style={{ backgroundColor: color, color: contrastTextColor(color) }}
              >
                {isRunning ? <Pause size={15} /> : <Play size={15} />}
                {isRunning ? 'Pause' : 'Start'}
              </button>
              {/* Skip fills the slot that was an empty spacer holding Start centred. */}
              <button
                onClick={skip}
                title={phase === 'focus' ? "Skip to break — keeps the minutes you've put in" : 'Skip the break — back to focus'}
                aria-label={phase === 'focus' ? 'Skip to break' : 'Skip break'}
                className="p-2.5 text-muted hover:text-ink-soft rounded-full hover:bg-surface-hi transition-colors"
              >
                <SkipForward size={17} />
              </button>
            </div>

            {/* Keyboard hint */}
            <p className="text-center text-xs text-muted mb-4">
              <kbd className="px-1.5 py-0.5 rounded border border-stone-200 dark:border-line font-sans">Space</kbd>
              <span className="mx-1.5">start / pause</span>·
              <kbd className="ml-1.5 px-1.5 py-0.5 rounded border border-stone-200 dark:border-line font-sans">R</kbd>
              <span className="mx-1.5">reset</span>·
              <kbd className="ml-1.5 px-1.5 py-0.5 rounded border border-stone-200 dark:border-line font-sans">S</kbd>
              <span className="ml-1.5">skip</span>
            </p>

            {/* Auto-advance */}
            <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-muted mb-4">
              <input
                type="checkbox"
                checked={autoAdvance}
                onChange={toggleAutoAdvance}
                className="accent-stone-600 dark:accent-[#e2a53b]"
              />
              Auto-advance to next phase
            </label>

            {/* Custom duration pickers */}
            {techniqueId === 'custom' && (
              <div className="w-full space-y-3 pt-3 border-t border-line">
                <div className="flex items-center gap-3">
                  <span className="w-10 text-xs text-muted shrink-0 text-right">Focus</span>
                  <div className={SEG_GROUP}>
                    {FOCUS_OPTIONS.map(m => (
                      <button key={m} onClick={() => setFocusMins(m)} className={segBtn(focusMins === m)}>
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-10 text-xs text-muted shrink-0 text-right">Break</span>
                  <div className={SEG_GROUP}>
                    {BREAK_OPTIONS.map(m => (
                      <button key={m} onClick={() => setBreakMins(m)} className={segBtn(breakMins === m)}>
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Music card ────────────────────────────────────────────────────── */}
          <div className="bg-surface border border-line rounded-2xl shadow-sm p-6 w-full lg:flex-1 flex flex-col">
            <MusicStudyColumn />
          </div>

        </div>

        {/* ── Focus list card ───────────────────────────────────────────────── */}
        <div className="mt-5 bg-surface border border-line rounded-2xl shadow-sm p-6">
          <FocusListPanel />
        </div>

        {/* ── Study activity heatmap ────────────────────────────────────────── */}
        <div className="mt-5 bg-surface border border-line rounded-2xl shadow-sm p-6">
          <div className="mb-5 flex items-center gap-2">
            <Activity size={14} className="text-muted" />
            <h2 className="text-sm font-semibold text-ink-soft tracking-tight">Study activity</h2>
          </div>
          <StudyHeatmap sessions={studySessions} />
        </div>

        {/* ── Recent sessions + notes ───────────────────────────────────────── */}
        <div className="mt-5 bg-surface border border-line rounded-2xl shadow-sm p-6">
          <StudySessionsNotesCard />
        </div>

      </div>
    </div>
  );
}
