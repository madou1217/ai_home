'use strict';

// Bound on-disk log size. aih's logs (server.log proxy requests, *.jsonl traces/
// events) are append-only with no built-in retention, so they grow without limit
// (server.log alone ~170MB/day). We cap each file and keep a single previous
// generation, so per-log disk usage is bounded at ~2×maxBytes.

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

function resolveMaxBytes(env) {
  const raw = Number((env || {}).AIH_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

/**
 * Rotate `filePath` when it exceeds `maxBytes`: the current file is renamed to
 * `<filePath>.1` (replacing any older generation) and a fresh file starts on the
 * next append. Safe to call before each append — statSync is cheap and the rename
 * only fires past the cap. Requires no open fd on the file (aih appends via
 * appendFileSync, so this holds).
 *
 * @returns {boolean} whether a rotation happened
 */
function rotateIfOversized(fs, path, filePath, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats || stats.size < maxBytes) return false;
  } catch (_error) {
    return false; // missing/unreadable → nothing to rotate
  }
  const rotated = `${filePath}.1`;
  try {
    fs.rmSync(rotated, { force: true });
  } catch (_error) {}
  try {
    fs.renameSync(filePath, rotated);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Enforce the size cap across every `*.log` / `*.jsonl` file directly under
 * `aiHomeDir`. Intended to run at server startup and on a periodic sweep.
 *
 * @returns {number} number of files rotated
 */
function sweepAihLogs(fs, path, aiHomeDir, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  let entries = [];
  try {
    entries = fs.readdirSync(aiHomeDir);
  } catch (_error) {
    return 0;
  }
  let rotated = 0;
  for (const name of entries) {
    if (!/\.(log|jsonl)$/i.test(name)) continue;
    if (/\.1$/.test(name)) continue; // don't rotate an already-rotated generation
    if (rotateIfOversized(fs, path, path.join(aiHomeDir, name), maxBytes)) rotated += 1;
  }
  return rotated;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  resolveMaxBytes,
  rotateIfOversized,
  sweepAihLogs
};
