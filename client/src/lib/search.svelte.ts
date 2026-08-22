/**
 * Search-query state with ASYMMETRIC debouncing.
 *
 * Growing a query (typing/pasting) applies immediately — the result set only
 * shrinks, so re-rendering is cheap and the UI feels instant. Shrinking a
 * query (backspace) applies after a short idle delay — the result set grows
 * back toward the full list, and that DOM/image churn is exactly what made
 * backspacing feel awful on phones.
 *
 * `applied` is also gated by a minimum character count: below it, callers
 * treat the search as inactive (show everything).
 */
const DEFAULT_SHRINK_MS = 200;

export function createDebouncedQuery(minChars = 2, shrinkMs = DEFAULT_SHRINK_MS) {
  let raw = $state('');
  let applied = $state('');
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    get raw() {
      return raw;
    },
    set raw(v: string) {
      raw = v;
      // "Growing" = at least as long as what's applied → apply now.
      if (v.trim().length >= applied.trim().length) {
        cancelTimer();
        applied = v;
        return;
      }
      // Shrinking: coalesce rapid backspaces into one delayed apply.
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          applied = raw;
        }, shrinkMs);
      }
    },
    get applied() {
      return applied;
    },
    /** True when the applied query has enough characters to filter on. */
    get active() {
      return applied.trim().length >= minChars;
    },
    cancel() {
      cancelTimer();
    },
  };
}
