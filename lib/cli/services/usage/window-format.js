'use strict';

// Shared usage-window formatter for codex/claude. Both providers expose the
// same per-window entry shape ({ window, remainingPct, windowMinutes, resetIn }),
// so `aih <p> ls`, `aih <p> usage`, and the PTY title tag all speak one
// language here. Universal rule: only windows that actually carry a numeric
// remainingPct are shown, ordered shortest-first (5h before 7days). codex may
// not return a 5h window — it is simply omitted, never faked.
//
// gemini/agy use model lists rather than time windows, so these helpers return
// nothing for them and callers keep their own model formatting.

const WINDOW_CAPABLE_KINDS = new Set(['codex_oauth_status', 'claude_oauth_usage']);

function getOrderedUsageWindows(cache) {
  if (!cache || typeof cache !== 'object') return [];
  if (!WINDOW_CAPABLE_KINDS.has(cache.kind)) return [];
  if (!Array.isArray(cache.entries)) return [];
  return cache.entries
    .filter((entry) => entry && typeof entry.remainingPct === 'number' && Number.isFinite(entry.remainingPct))
    .map((entry) => ({
      window: String(entry.window || '').trim(),
      remainingPct: Math.max(0, Math.min(100, Number(entry.remainingPct))),
      windowMinutes: Number(entry.windowMinutes) || 0,
      resetIn: String(entry.resetIn || '').trim()
    }))
    .filter((entry) => entry.window)
    .sort((left, right) => left.windowMinutes - right.windowMinutes);
}

// One inline string for `ls` / the PTY title.
//   compact (title): "5h:91% 7days:52%"
//   default (ls):    "5h: 91.0% / 7days: 52.0%"
function formatUsageWindows(cache, options = {}) {
  const windows = getOrderedUsageWindows(cache);
  if (!windows.length) return '';
  if (options.compact) {
    return windows.map((w) => `${w.window}:${Math.round(w.remainingPct)}%`).join(' ');
  }
  return windows.map((w) => `${w.window}: ${w.remainingPct.toFixed(1)}%`).join(' / ');
}

// One line per window for the detailed `usage` view: "5h: 91.0% (resets in 4h)".
// Unlike the compact ls/title views, this keeps windows that carry no numeric
// figure (e.g. codex team-plan fallback rows), since `usage` is the diagnostic
// surface where that context matters.
function formatUsageWindowLines(cache) {
  if (!cache || typeof cache !== 'object') return [];
  if (!WINDOW_CAPABLE_KINDS.has(cache.kind) || !Array.isArray(cache.entries)) return [];
  return cache.entries
    .slice()
    .sort((left, right) => (Number(left.windowMinutes) || 0) - (Number(right.windowMinutes) || 0))
    .map((entry) => {
      const window = String(entry && entry.window || '').trim();
      if (typeof entry.remainingPct === 'number' && Number.isFinite(entry.remainingPct)) {
        const pct = Math.max(0, Math.min(100, Number(entry.remainingPct)));
        const reset = entry.resetIn ? ` (resets in ${String(entry.resetIn).trim()})` : '';
        return `${window}: ${pct.toFixed(1)}%${reset}`;
      }
      return window;
    })
    .filter(Boolean);
}

module.exports = {
  getOrderedUsageWindows,
  formatUsageWindows,
  formatUsageWindowLines
};
