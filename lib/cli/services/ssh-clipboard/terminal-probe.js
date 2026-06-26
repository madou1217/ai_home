'use strict';

const {
  buildOsc52ClipboardReadQuery,
  buildOsc5522ClipboardListMimeTypesQuery,
  buildOsc5522ClipboardReadMimeQuery,
  buildOsc5522ClipboardReadImageQuery,
  OSC5522_IMAGE_MIME_TYPES,
  OSC5522_TEXT_IMAGE_MIME_TYPES,
  buildTerminalClipboardPasteEventsModeSequence,
  buildTerminalClipboardPasteEventsSupportQuery,
  createTerminalClipboardImageParser
} = require('./terminal-clipboard');
const { DEFAULT_MAX_BYTES } = require('./frames');

function parsePositiveInteger(value, fallback) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function parseSshClipboardProbeArgs(args = [], env = {}) {
  const tokens = Array.isArray(args) ? args.map((item) => String(item || '')) : [];
  const action = String(tokens[1] || 'probe').trim() || 'probe';
  const options = {
    action,
    help: false,
    json: false,
    pasteEvent: false,
    timeoutMs: parsePositiveInteger(env.AIH_SSH_CLIP_PROBE_TIMEOUT_MS, 1200),
    maxBytes: parsePositiveInteger(env.AIH_SSH_CLIP_MAX_BYTES, DEFAULT_MAX_BYTES)
  };

  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--json') {
      options.json = true;
    } else if (token === '--paste-event' || token === '--wait-paste') {
      options.pasteEvent = true;
    } else if (token === '--timeout-ms') {
      options.timeoutMs = parsePositiveInteger(tokens[index + 1], options.timeoutMs);
      index += 1;
    } else if (token === '--max-bytes' || token === '--clip-max-bytes') {
      options.maxBytes = parsePositiveInteger(tokens[index + 1], options.maxBytes);
      index += 1;
    } else if (token === '--help' || token === '-h' || token === 'help') {
      options.help = true;
    }
  }

  return options;
}

function showSshClipboardProbeHelp(write) {
  write(`
\x1b[36mAI Home SSH Clipboard Probe\x1b[0m - Strict zero-client terminal clipboard diagnostics

\x1b[33mUsage:\x1b[0m
  aih ssh-clipboard probe [--json] [--timeout-ms 1200]
  aih ssh-clipboard probe --paste-event [--json] [--timeout-ms 10000]

\x1b[33mWhat it does:\x1b[0m
  Runs inside a normal SSH session and asks the current terminal for clipboard
  image data using terminal protocols only: OSC 5522, 5522 paste-events support,
  and OSC 52 image/data-url reads. It does not use clip-agent, RemoteForward,
  scp, or an SSH wrapper.

  --paste-event enables OSC 5522 paste-events and waits for you to paste an
  image in this same terminal, then reads the one-shot paste token.
`);
}

function isTruthyTty(stream) {
  return Boolean(stream && stream.isTTY);
}

function getErrorCode(error) {
  return String((error && error.code) || (error && error.message) || error || 'unknown_error');
}

function setRawMode(stdin, enabled) {
  if (!stdin || typeof stdin.setRawMode !== 'function') return null;
  const previous = typeof stdin.isRaw === 'boolean' ? stdin.isRaw : null;
  try {
    stdin.setRawMode(enabled);
  } catch (_error) {
    return previous;
  }
  return previous;
}

function restoreRawMode(stdin, previous) {
  if (typeof previous !== 'boolean') return;
  setRawMode(stdin, previous);
}

function classifyPasteEventsSupport(result) {
  if (!result || !result.pasteEventsSupport) return null;
  return {
    status: 'ok',
    supported: Boolean(result.pasteEventsSupport.supported),
    enabled: Boolean(result.pasteEventsSupport.enabled),
    state: result.pasteEventsSupport.state
  };
}

function summarizeImage(image) {
  return {
    status: 'ok',
    mimeType: image.mimeType,
    byteLength: image.byteLength,
    sha256: image.sha256
  };
}

function classifyImageRead(result) {
  if (!result) return null;
  if (Array.isArray(result.images) && result.images.length > 0) {
    return summarizeImage(result.images[0]);
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    return {
      status: 'error',
      error: getErrorCode(result.errors[0])
    };
  }
  return null;
}

function classifyMimeList(result) {
  if (!result) return null;
  if (Array.isArray(result.mimeLists) && result.mimeLists.length > 0) {
    const seen = new Set();
    const mimeTypes = result.mimeLists
      .flat()
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
      .filter((value) => {
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
      });
    return {
      status: 'ok',
      mimeTypes
    };
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    return {
      status: 'error',
      error: getErrorCode(result.errors[0])
    };
  }
  return null;
}

function chooseImageMimeType(mimeTypes) {
  const available = Array.isArray(mimeTypes)
    ? mimeTypes.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  return OSC5522_IMAGE_MIME_TYPES.find((mimeType) => available.includes(mimeType))
    || available.find((mimeType) => OSC5522_IMAGE_MIME_TYPES.includes(mimeType))
    || OSC5522_TEXT_IMAGE_MIME_TYPES.find((mimeType) => available.includes(mimeType))
    || '';
}

function shouldWrapTerminalQueryForTmux(env = {}) {
  if (!String(env.TMUX || '').trim()) return false;
  return String(env.AIH_SSH_TERMINAL_CLIPBOARD_TMUX_PASSTHROUGH || '1') !== '0';
}

function waitForTerminalResponse(options = {}) {
  const stdin = options.stdin;
  const stdout = options.stdout;
  const parser = options.parser;
  const sequence = String(options.sequence || '');
  const classify = typeof options.classify === 'function' ? options.classify : () => null;
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 1200);
  const setTimeoutImpl = options.setTimeout || setTimeout;
  const clearTimeoutImpl = options.clearTimeout || clearTimeout;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeoutImpl(timer);
        timer = null;
      }
      if (stdin && typeof stdin.off === 'function') {
        stdin.off('data', onData);
      } else if (stdin && typeof stdin.removeListener === 'function') {
        stdin.removeListener('data', onData);
      }
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value || { status: 'timeout' });
    };

    function onData(data) {
      try {
        const result = parser.consume(data);
        const value = classify(result);
        if (value) finish(value);
      } catch (error) {
        finish({ status: 'error', error: getErrorCode(error) });
      }
    }

    if (!stdin || typeof stdin.on !== 'function' || !stdout || typeof stdout.write !== 'function') {
      finish({ status: 'error', error: 'terminal_stream_unavailable' });
      return;
    }

    stdin.on('data', onData);
    try {
      stdout.write(sequence);
    } catch (error) {
      finish({ status: 'error', error: getErrorCode(error) });
      return;
    }

    timer = setTimeoutImpl(() => finish({ status: 'timeout' }), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function collectPasteRequestDetails(request) {
  const mimeType = String(request && request.mimeType || '').trim().toLowerCase();
  return {
    mimeType,
    mimeTypes: Array.isArray(request && request.mimeTypes)
      ? request.mimeTypes.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [mimeType].filter(Boolean),
    loc: String(request && request.loc || ''),
    passwordKey: String(request && request.passwordKey || 'pw')
  };
}

function waitForPasteEventImage(options = {}) {
  const stdin = options.stdin;
  const stdout = options.stdout;
  const stderr = options.stderr;
  const parser = options.parser;
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 10000);
  const tmuxPassthrough = Boolean(options.tmuxPassthrough);
  const setTimeoutImpl = options.setTimeout || setTimeout;
  const clearTimeoutImpl = options.clearTimeout || clearTimeout;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let pasteRequest = null;
    let advertisedMimeTypes = [];
    let phase = 'paste_event';

    const cleanup = () => {
      if (timer) {
        clearTimeoutImpl(timer);
        timer = null;
      }
      if (stdin && typeof stdin.off === 'function') {
        stdin.off('data', onData);
      } else if (stdin && typeof stdin.removeListener === 'function') {
        stdin.removeListener('data', onData);
      }
      try {
        if (stdout && typeof stdout.write === 'function') {
          stdout.write(buildTerminalClipboardPasteEventsModeSequence({
            enabled: false,
            tmuxPassthrough
          }));
        }
      } catch (_error) {}
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value || { status: 'timeout', phase });
    };

    function resetTimer(nextPhase) {
      phase = nextPhase;
      if (timer) clearTimeoutImpl(timer);
      timer = setTimeoutImpl(() => finish({ status: 'timeout', phase }), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    function sendPasteReadRequest(request) {
      pasteRequest = collectPasteRequestDetails(request);
      resetTimer('paste_event_read');
      const wrote = stdout.write(buildOsc5522ClipboardReadMimeQuery({
        mimeType: request && request.mimeType,
        loc: request && request.loc,
        pw: request && request.pw,
        passwordKey: request && request.passwordKey,
        name: request && request.name,
        tmuxPassthrough
      }));
      if (wrote === false) {
        finish({
          status: 'error',
          error: 'terminal_write_failed',
          phase,
          mimeTypes: advertisedMimeTypes,
          request: pasteRequest
        });
      }
    }

    function onData(data) {
      try {
        const result = parser.consume(data);
        if (Array.isArray(result.pasteRequests) && result.pasteRequests.length > 0) {
          const request = result.pasteRequests[0];
          advertisedMimeTypes = Array.isArray(request.mimeTypes)
            ? request.mimeTypes.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
            : [request.mimeType].filter(Boolean);
          sendPasteReadRequest(request);
          return;
        }
        if (Array.isArray(result.unsupportedPasteNotifications) && result.unsupportedPasteNotifications.length > 0) {
          const notification = result.unsupportedPasteNotifications[0];
          advertisedMimeTypes = Array.isArray(notification.mimeTypes)
            ? notification.mimeTypes.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
            : [];
          finish({
            status: 'error',
            error: 'paste_event_unsupported_mime',
            phase,
            mimeTypes: advertisedMimeTypes
          });
          return;
        }
        if (Array.isArray(result.images) && result.images.length > 0) {
          finish({
            status: 'ok',
            mimeTypes: advertisedMimeTypes,
            request: pasteRequest,
            image: summarizeImage(result.images[0])
          });
          return;
        }
        if (Array.isArray(result.textPastes) && result.textPastes.length > 0) {
          finish({
            status: 'error',
            error: 'paste_event_text_only',
            mimeTypes: advertisedMimeTypes,
            request: pasteRequest
          });
          return;
        }
        if (Array.isArray(result.errors) && result.errors.length > 0) {
          finish({
            status: 'error',
            error: getErrorCode(result.errors[0]),
            phase,
            mimeTypes: advertisedMimeTypes,
            request: pasteRequest
          });
        }
      } catch (error) {
        finish({
          status: 'error',
          error: getErrorCode(error),
          phase,
          mimeTypes: advertisedMimeTypes,
          request: pasteRequest
        });
      }
    }

    if (!stdin || typeof stdin.on !== 'function' || !stdout || typeof stdout.write !== 'function') {
      finish({ status: 'error', error: 'terminal_stream_unavailable' });
      return;
    }

    stdin.on('data', onData);
    try {
      if (stderr && typeof stderr.write === 'function') {
        stderr.write('\x1b[33m[aih ssh-clipboard]\x1b[0m paste an image in this terminal now...\n');
      }
      stdout.write(buildTerminalClipboardPasteEventsModeSequence({
        enabled: true,
        tmuxPassthrough
      }));
    } catch (error) {
      finish({ status: 'error', error: getErrorCode(error), phase });
      return;
    }
    resetTimer('paste_event');
  });
}

function buildProbeSummary(result) {
  const imageByOsc5522 = result.osc5522 && result.osc5522.status === 'ok';
  const imageByOsc52 = result.osc52 && result.osc52.status === 'ok';
  const imageByPasteEvent = result.pasteEvent
    && result.pasteEvent.status === 'ok'
    && result.pasteEvent.image
    && result.pasteEvent.image.status === 'ok';
  return {
    supported: Boolean(imageByPasteEvent || imageByOsc5522 || imageByOsc52),
    reason: imageByPasteEvent
      ? 'osc5522_paste_event_image_data'
      : (imageByOsc5522
      ? 'osc5522_image_data'
      : (imageByOsc52 ? 'osc52_image_or_data_url' : 'no_terminal_image_data'))
  };
}

function formatProbeStatus(value) {
  if (!value) return 'unknown';
  if (value.status === 'ok' && typeof value.supported === 'boolean') {
    return value.supported ? `supported (state ${value.state})` : `unsupported (state ${value.state})`;
  }
  if (value.status === 'ok' && Array.isArray(value.mimeTypes)) {
    return value.mimeTypes.length > 0 ? value.mimeTypes.join(', ') : 'empty';
  }
  if (value.status === 'ok') return `${value.mimeType || 'image'} ${value.byteLength || 0} bytes`;
  if (value.status === 'error') return `error: ${value.error}`;
  return value.status || 'unknown';
}

function printHumanProbeResult(result, write) {
  write('AIH strict zero-client SSH clipboard probe');
  write(`SSH session: ${result.sshSession ? 'yes' : 'no'}`);
  write(`TTY: stdin=${result.tty.stdin ? 'yes' : 'no'} stdout=${result.tty.stdout ? 'yes' : 'no'}`);
  write(`5522 paste-events: ${formatProbeStatus(result.pasteEvents)}`);
  if (result.pasteEvent && result.pasteEvent.status !== 'skipped') {
    const image = result.pasteEvent.image || result.pasteEvent;
    write(`5522 paste-event image: ${formatProbeStatus(image)}`);
  }
  write(`OSC 5522 MIME list: ${formatProbeStatus(result.mimeTypes)}`);
  write(`OSC 5522 image read: ${formatProbeStatus(result.osc5522)}`);
  write(`OSC 52 image/data-url read: ${formatProbeStatus(result.osc52)}`);
  write(`Result: ${result.zeroClient.supported ? 'terminal returned image data' : 'terminal did not return image data'} (${result.zeroClient.reason})`);
}

async function runSshClipboardProbeCommand(rawArgs = [], deps = {}) {
  const processObj = deps.processObj || process;
  const consoleImpl = deps.consoleImpl || console;
  const env = processObj.env || {};
  const parsed = parseSshClipboardProbeArgs(rawArgs, env);
  if (parsed.help || parsed.action === '--help' || parsed.action === '-h' || parsed.action === 'help') {
    showSshClipboardProbeHelp((line) => consoleImpl.log(line));
    return 0;
  }
  if (parsed.action !== 'probe') {
    consoleImpl.error(`\x1b[31m[aih ssh-clipboard]\x1b[0m unknown action: ${parsed.action}`);
    showSshClipboardProbeHelp((line) => consoleImpl.error(line));
    return 1;
  }

  const stdin = processObj.stdin;
  const stdout = processObj.stdout;
  const result = {
    ok: true,
    sshSession: Boolean(String(env.SSH_CONNECTION || '').trim() || String(env.SSH_TTY || '').trim()),
    tty: {
      stdin: isTruthyTty(stdin),
      stdout: isTruthyTty(stdout)
    },
    pasteEvents: { status: 'skipped' },
    pasteEvent: { status: 'skipped' },
    mimeTypes: { status: 'skipped' },
    osc5522: { status: 'skipped' },
    osc52: { status: 'skipped' },
    zeroClient: { supported: false, reason: 'not_run' }
  };

  if (!result.tty.stdin || !result.tty.stdout) {
    result.ok = false;
    result.zeroClient = { supported: false, reason: 'tty_required' };
  } else {
    const previousRawMode = setRawMode(stdin, true);
    try {
      const tmuxPassthrough = shouldWrapTerminalQueryForTmux(env);
      const parser = createTerminalClipboardImageParser({ maxBytes: parsed.maxBytes });
      const timeoutOptions = {
        stdin,
        stdout,
        parser,
        timeoutMs: parsed.timeoutMs,
        setTimeout: deps.setTimeout,
        clearTimeout: deps.clearTimeout
      };
      result.pasteEvents = await waitForTerminalResponse({
        ...timeoutOptions,
        sequence: buildTerminalClipboardPasteEventsSupportQuery({ tmuxPassthrough }),
        classify: classifyPasteEventsSupport
      });
      if (parsed.pasteEvent) {
        result.pasteEvent = await waitForPasteEventImage({
          stdin,
          stdout,
          stderr: processObj.stderr,
          parser,
          timeoutMs: parsed.timeoutMs,
          tmuxPassthrough,
          setTimeout: deps.setTimeout,
          clearTimeout: deps.clearTimeout
        });
        result.zeroClient = buildProbeSummary(result);
        return finalizeSshClipboardProbeResult(result, parsed, processObj, consoleImpl);
      }
      result.mimeTypes = await waitForTerminalResponse({
        ...timeoutOptions,
        sequence: buildOsc5522ClipboardListMimeTypesQuery({
          id: `aih-probe-mimes-${Date.now()}`,
          tmuxPassthrough
        }),
        classify: classifyMimeList
      });
      const imageMimeType = result.mimeTypes.status === 'ok'
        ? chooseImageMimeType(result.mimeTypes.mimeTypes)
        : '';
      result.osc5522 = imageMimeType
        ? await waitForTerminalResponse({
          ...timeoutOptions,
          sequence: buildOsc5522ClipboardReadMimeQuery({
            id: `aih-probe-image-${Date.now()}`,
            mimeType: imageMimeType,
            name: 'AIH clipboard probe',
            tmuxPassthrough
          }),
          classify: classifyImageRead
        })
        : await waitForTerminalResponse({
          ...timeoutOptions,
          sequence: buildOsc5522ClipboardReadImageQuery({
            id: `aih-probe-image-${Date.now()}`,
            tmuxPassthrough
          }),
          classify: classifyImageRead
        });
      if (result.osc5522.status === 'error' && result.mimeTypes.status === 'ok' && imageMimeType) {
        result.osc5522.requestedMimeType = imageMimeType;
      } else if (result.osc5522.status === 'ok' && imageMimeType) {
        result.osc5522.requestedMimeType = imageMimeType;
      }
      result.osc52 = result.osc5522.status === 'ok'
        ? { status: 'skipped' }
        : await waitForTerminalResponse({
          ...timeoutOptions,
          sequence: buildOsc52ClipboardReadQuery({ selection: 'c', tmuxPassthrough }),
          classify: classifyImageRead
        });
      result.zeroClient = buildProbeSummary(result);
    } finally {
      restoreRawMode(stdin, previousRawMode);
    }
  }

  return finalizeSshClipboardProbeResult(result, parsed, processObj, consoleImpl);
}

function finalizeSshClipboardProbeResult(result, parsed, processObj, consoleImpl) {
  if (parsed.json) {
    processObj.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const write = (line) => {
      const stream = processObj.stderr && typeof processObj.stderr.write === 'function'
        ? processObj.stderr
        : processObj.stdout;
      stream.write(`${line}\n`);
    };
    printHumanProbeResult(result, write);
  }

  return result.ok ? 0 : 1;
}

module.exports = {
  buildProbeSummary,
  parseSshClipboardProbeArgs,
  runSshClipboardProbeCommand,
  showSshClipboardProbeHelp,
  waitForPasteEventImage,
  waitForTerminalResponse
};
