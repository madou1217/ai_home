'use strict';

// Live progress line for headless runs.
//
// A headless call can sit silent for a long time — a long prompt, a slow
// upstream, a cold CLI — and a single static "Running …" line is
// indistinguishable from a command that failed to start. This animates that
// line and reports time-to-first-byte once output actually begins.
//
// Hard constraint: every byte written here goes to **stderr**, and only when
// stderr is a TTY. stdout belongs to the model's answer alone, and a redirected
// stderr (`2> file`) must not collect animation frames.

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAMES_ASCII = ['|', '/', '-', '\\'];
const FRAME_INTERVAL_MS = 100;
const ANIMATION_ENV_KEY = 'AIH_HEADLESS_SPINNER';

function resolveFrames(platform) {
  return platform === 'win32' ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES;
}

function resolveAnimationEnabled(processObj) {
  const env = (processObj && processObj.env) || {};
  const raw = String(env[ANIMATION_ENV_KEY] || '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  const stderr = processObj && processObj.stderr;
  const usable = Boolean(stderr && typeof stderr.write === 'function' && stderr.isTTY);
  if (['1', 'true', 'yes', 'on'].includes(raw)) return usable;
  return usable;
}

function formatSeconds(elapsedMs) {
  return `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`;
}

// createHeadlessProgress owns one line of stderr for the lifetime of a headless
// run: it draws the spinner, erases it the moment real output arrives, and never
// leaves the cursor on a partial line.
function createHeadlessProgress(options = {}) {
  const processObj = options.processObj || process;
  const label = String(options.label || '').trim();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const frames = resolveFrames(processObj.platform);
  const animated = resolveAnimationEnabled(processObj);

  let timer = null;
  let frameIndex = 0;
  let startedAt = 0;
  let finished = false;

  function writeStderr(text) {
    if (!text) return;
    const stderr = processObj.stderr;
    if (!stderr || typeof stderr.write !== 'function') return;
    try { stderr.write(text); } catch (_error) { /* a closed stderr is not fatal */ }
  }

  function renderFrame() {
    const frame = frames[frameIndex % frames.length];
    frameIndex += 1;
    writeStderr(`\r\x1b[K\x1b[36m[aih]\x1b[0m ${frame} ${label} \x1b[90m${formatSeconds(now() - startedAt)}\x1b[0m`);
  }

  function clearLine() {
    writeStderr('\r\x1b[K');
  }

  function start() {
    if (timer || finished) return;
    startedAt = now();
    if (!animated) {
      // No TTY: one static line, exactly as before, so logs stay greppable.
      console.error(`\x1b[36m[aih]\x1b[0m 🚀 ${label}`);
      return;
    }
    renderFrame();
    timer = setInterval(renderFrame, FRAME_INTERVAL_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stopTimer() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  // First byte from the child: the run is demonstrably alive. Replace the
  // spinner with how long it took, then get out of the way.
  function markFirstOutput() {
    if (finished) return;
    finished = true;
    stopTimer();
    if (!animated) return;
    clearLine();
    writeStderr(`\x1b[36m[aih]\x1b[0m \x1b[32m✔\x1b[0m ${label} \x1b[90m首字节 ${formatSeconds(now() - startedAt)}\x1b[0m\n`);
  }

  // Ended without ever producing output (Ctrl-C, spawn failure, empty
  // response). Erasing the line and stopping there would leave the terminal
  // looking like the command never ran — and drop the shell prompt onto the
  // cleared line. Replace it with a terminal line instead.
  function stop() {
    if (finished) {
      stopTimer();
      return;
    }
    finished = true;
    stopTimer();
    if (!animated) return;
    clearLine();
    writeStderr(`\x1b[36m[aih]\x1b[0m \x1b[33m✖\x1b[0m ${label} \x1b[90m无输出 ${formatSeconds(now() - startedAt)}\x1b[0m\n`);
  }

  return {
    start,
    markFirstOutput,
    stop,
    isAnimated: () => animated
  };
}

module.exports = {
  ANIMATION_ENV_KEY,
  createHeadlessProgress
};
