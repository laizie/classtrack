import { useEffect } from 'react';
import { Presentation } from 'lucide-react';

export interface SlideImportState {
  deck: string;
  page: number;
  total: number;
}

/**
 * Progress while a deck is being rasterized.
 *
 * Importing 60 pages takes real time, so this exists to answer "is it stuck?" — it names
 * the deck, counts pages, and can be stopped. Slides appear in the note as they finish
 * rather than all at once at the end, so cancelling keeps whatever already landed; the
 * copy says so, because a Cancel button that might silently discard your last two minutes
 * of waiting is one nobody dares press.
 *
 * There's deliberately no close-on-backdrop-click and no Escape-to-close: both are easy to
 * hit by accident, and here they'd mean "stop the thing I asked for". Stopping is the
 * explicit button.
 */
export default function SlideImportDialog({
  state,
  onCancel,
}: {
  state: SlideImportState;
  onCancel: () => void;
}) {
  // Pages are counted before rendering starts, so `total` is known up front and the bar is
  // truthful rather than an indeterminate spinner.
  const pct = state.total > 0 ? Math.round((state.page / state.total) * 100) : 0;

  // Put the caret back where it was once the import finishes, so you carry on typing in
  // the note instead of having to click back into it.
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    return () => active?.focus?.();
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[22vh]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30 animate-fade" />
      <div className="relative mx-4 w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl animate-pop">
        <div className="flex items-center gap-2.5">
          <Presentation size={16} className="shrink-0 text-accent-text" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{state.deck || 'Importing slides'}</p>
            <p className="text-xs text-muted tabular-nums">
              {state.total > 0 ? `Slide ${state.page} of ${state.total}` : 'Reading the deck…'}
            </p>
          </div>
        </div>

        <div
          className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-inset"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Slide import progress"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[11px] leading-tight text-muted">Slides already added stay in your note.</p>
          <button
            onClick={onCancel}
            className="shrink-0 rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-hi hover:text-ink transition-colors"
          >
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}
